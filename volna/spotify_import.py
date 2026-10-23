"""Импорт библиотеки Spotify без API.

Два способа:
1. Выгрузка данных аккаунта (spotify.com → Аккаунт → Конфиденциальность → «Скачать данные»).
   Приходит ZIP с YourLibrary.json, Playlist*.json, StreamingHistory*.json —
   оттуда берём лайки, плейлисты и историю прослушиваний.
2. Ссылка на публичный плейлист/альбом — читаем embed-страницу open.spotify.com
   (неофициально, обычно отдаёт до ~100 треков).
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests

from .db import Database

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
HISTORY_TOP_N = 600  # сколько самых слушаемых треков из истории завести в базу


def _iter_json_files(path: Path):
    """Отдаёт (имя_файла, распарсенный_json) из ZIP-архива или папки."""
    if path.is_file() and path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                if name.lower().endswith(".json"):
                    try:
                        with z.open(name) as f:
                            yield Path(name).name, json.load(io.TextIOWrapper(f, encoding="utf-8-sig"))
                    except (ValueError, UnicodeDecodeError):
                        continue
    elif path.is_dir():
        for p in path.rglob("*.json"):
            try:
                yield p.name, json.loads(p.read_text(encoding="utf-8-sig"))
            except (ValueError, UnicodeDecodeError, OSError):
                continue
    elif path.is_file() and path.suffix.lower() == ".json":
        yield path.name, json.loads(path.read_text(encoding="utf-8-sig"))
    else:
        raise ValueError("Укажи ZIP-архив выгрузки Spotify, папку с ним или JSON-файл")


def _parse_ts(value: str) -> float:
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S.%fZ"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc).timestamp()
        except (ValueError, TypeError):
            continue
    return 0.0


def import_export(db: Database, path: str | Path, progress=None) -> dict:
    path = Path(path)
    stats = {"liked": 0, "playlists": 0, "playlist_tracks": 0, "history_tracks": 0}
    history: dict[tuple[str, str], dict] = defaultdict(lambda: {"ms": 0, "plays": 0, "skips": 0,
                                                               "last": 0.0, "uri": None, "album": ""})
    files = list(_iter_json_files(path))
    if not files:
        raise ValueError("В выгрузке не нашлось JSON-файлов")
    for i, (name, data) in enumerate(files):
        lname = name.lower()
        if progress:
            progress(i / max(1, len(files)), f"Читаю {name}")
        if lname.startswith("yourlibrary") and isinstance(data, dict):
            for t in data.get("tracks") or []:
                title, artist = t.get("track"), t.get("artist")
                if title and artist:
                    db.upsert_spotify_track(t.get("uri"), title, artist, t.get("album") or "",
                                            in_library=True, liked=True)
                    stats["liked"] += 1
        elif lname.startswith("playlist") and isinstance(data, dict):
            for pl in data.get("playlists") or []:
                ids = []
                for it in pl.get("items") or []:
                    tr = it.get("track") or {}
                    title, artist = tr.get("trackName"), tr.get("artistName")
                    if title and artist:
                        ids.append(db.upsert_spotify_track(tr.get("trackUri"), title, artist,
                                                           tr.get("albumName") or "", in_library=True))
                if ids:
                    name_ = pl.get("name") or "Плейлист Spotify"
                    db.upsert_playlist(name_, "spotify", f"spotify-export:{name_}", ids)
                    stats["playlists"] += 1
                    stats["playlist_tracks"] += len(ids)
        elif (lname.startswith("streaminghistory") or lname.startswith("streaming_history_audio")) \
                and isinstance(data, list):
            for h in data:
                title = h.get("trackName") or h.get("master_metadata_track_name")
                artist = h.get("artistName") or h.get("master_metadata_album_artist_name")
                if not title or not artist:
                    continue  # подкасты и пр.
                ms = int(h.get("msPlayed") or h.get("ms_played") or 0)
                rec = history[(artist, title)]
                rec["ms"] += ms
                rec["album"] = rec["album"] or h.get("master_metadata_album_album_name") or ""
                rec["uri"] = rec["uri"] or h.get("spotify_track_uri")
                if ms >= 30_000:
                    rec["plays"] += 1
                if h.get("skipped") or ms < 15_000:
                    rec["skips"] += 1
                rec["last"] = max(rec["last"], _parse_ts(h.get("endTime") or h.get("ts") or ""))

    if history:
        top = sorted(history.items(), key=lambda kv: kv[1]["ms"], reverse=True)[:HISTORY_TOP_N]
        rows = []
        for (artist, title), rec in top:
            if rec["plays"] == 0:
                continue
            tid = db.upsert_spotify_track(rec["uri"], title, artist, rec["album"], in_library=False)
            rows.append((tid, "history", rec["last"] or 0, rec["ms"],
                         f"plays={rec['plays']};skips={rec['skips']}"))
        # повторный импорт не должен удваивать историю
        db.execute("DELETE FROM events WHERE kind='history'")
        db.log_many(rows)
        stats["history_tracks"] = len(rows)
    if progress:
        progress(1.0, "Готово")
    return stats


_SPOTIFY_URL_RE = re.compile(r"open\.spotify\.com/(?:intl-\w+/)?(?:embed/)?(playlist|album|track)/([A-Za-z0-9]+)")


def import_public_link(db: Database, url: str) -> dict:
    m = _SPOTIFY_URL_RE.search(url)
    if not m:
        raise ValueError("Это не похоже на ссылку open.spotify.com на плейлист, альбом или трек")
    kind, sid = m.groups()
    try:
        html = requests.get(f"https://open.spotify.com/embed/{kind}/{sid}",
                            headers={"User-Agent": UA}, timeout=20).text
    except requests.RequestException as e:
        raise ValueError(f"Нет связи с Spotify: {e}") from e
    mm = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.+?)</script>', html, re.S)
    if not mm:
        raise ValueError("Spotify не отдал данные плейлиста (возможно, он приватный)")
    data = json.loads(mm.group(1))
    entity = (((data.get("props") or {}).get("pageProps") or {}).get("state") or {}).get("data", {}).get("entity") or {}
    name = entity.get("name") or entity.get("title") or "Spotify"
    items = entity.get("trackList") or []
    if kind == "track" and not items:
        items = [{"uri": entity.get("uri"), "title": entity.get("name") or entity.get("title"),
                  "subtitle": ", ".join(a.get("name", "") for a in entity.get("artists") or []),
                  "duration": entity.get("duration")}]
    ids = []
    for it in items:
        title = it.get("title")
        artist = (it.get("subtitle") or "").replace(" ", " ")
        if title and artist:
            ids.append(db.upsert_spotify_track(it.get("uri"), title, artist, "",
                                               int(it.get("duration") or 0), in_library=True))
    if not ids:
        raise ValueError("В плейлисте не нашлось треков")
    if kind != "track":
        db.upsert_playlist(name, "spotify", f"spotify:{kind}:{sid}", ids)
    return {"name": name, "tracks": len(ids)}
