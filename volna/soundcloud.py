"""Клиент SoundCloud через публичный (веб) API api-v2.

Ключ client_id берётся так же, как это делает сайт soundcloud.com и yt-dlp:
со страницы сайта и её JS-бандлов. Это неофициальный способ — SoundCloud может
поменять что-то в любой момент, тогда ключ просто перевыпускается автоматически.
Доступны только публичные треки; треки SoundCloud Go+ (превью 30 сек) пропускаются.
"""
from __future__ import annotations

import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin

import requests
from requests.adapters import HTTPAdapter

from .config import cache_dir, settings

API = "https://api-v2.soundcloud.com"
SITE = "https://soundcloud.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

_SCRIPT_RE = re.compile(r'<script[^>]+src="(https://[^"]+\.js)"')
_CLIENT_ID_RE = re.compile(r'client_id\s*[:=]\s*"([0-9a-zA-Z]{32})"')
_CLIENT_ID_RE2 = re.compile(r'[?&]client_id=([0-9a-zA-Z]{32})')


class SoundCloudError(Exception):
    pass


class NotStreamable(SoundCloudError):
    pass


def _year(s) -> int:
    m = re.match(r"(\d{4})", str(s or ""))
    return int(m.group(1)) if m else 0


def parse_track(t: dict) -> dict | None:
    """Приводит JSON трека SoundCloud к плоскому словарю приложения."""
    if not t or t.get("kind", "track") != "track" or "id" not in t or not t.get("title"):
        return None
    user = t.get("user") or {}
    title = (t.get("title") or "").strip()
    pub = (t.get("publisher_metadata") or {}).get("artist") or ""
    artist = pub.strip()
    if not artist:
        # Частый формат на SC: «Артист - Название», залитый не самим артистом
        m = re.match(r"^(.{1,80}?)\s+[-–—]\s+(.+)$", title)
        if m:
            artist, title = m.group(1).strip(), m.group(2).strip()
        else:
            artist = (user.get("username") or "").strip()
    transcodings = (t.get("media") or {}).get("transcodings") or []
    full = [x for x in transcodings if not x.get("snipped")
            and "encrypted" not in ((x.get("format") or {}).get("protocol") or "")]
    policy = (t.get("policy") or "").upper()
    playable = bool(full) and policy not in ("SNIP", "BLOCK") and t.get("streamable", True) is not False
    art = t.get("artwork_url") or user.get("avatar_url") or ""
    if art:
        art = art.replace("-large.", "-t300x300.")
    return {
        "sc_id": int(t["id"]),
        "title": title,
        "artist": artist,
        "duration_ms": int(t.get("full_duration") or t.get("duration") or 0),
        "genre": (t.get("genre") or "").strip(),
        "tags": (t.get("tag_list") or "").strip(),
        "artwork_url": art,
        "permalink_url": t.get("permalink_url") or "",
        "sc_user_id": user.get("id"),
        "playable": playable,
        "playback_count": t.get("playback_count") or 0,
        "year": _year(t.get("release_date") or t.get("display_date") or t.get("created_at")),
        "likes_count": t.get("likes_count") or t.get("favoritings_count") or 0,
    }


class SoundCloud:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json", "Origin": SITE,
                               "Referer": SITE + "/"})
        adapter = HTTPAdapter(pool_connections=10, pool_maxsize=24)
        self.s.mount("https://", adapter)
        self._client_id = settings().get("sc_client_id") or ""
        self._cid_lock = threading.Lock()
        self._cid_refreshed_at = 0.0
        self._dl_locks: dict[int, threading.Lock] = {}
        self._dl_guard = threading.Lock()

    # --- client_id --------------------------------------------------------
    def client_id(self, refresh: bool = False) -> str:
        with self._cid_lock:
            if self._client_id and not refresh:
                return self._client_id
            self._client_id = self._scrape_client_id()
            self._cid_refreshed_at = time.time()
            settings().set("sc_client_id", self._client_id)
            return self._client_id

    def _refresh_after_denied(self, used: str, status: int) -> str | None:
        """Перевыпуск ключа после 401/403. Только если ключ ещё тот же (другой поток мог уже обновить)
        и не чаще раза в минуту — 403 бывает и просто «трек закрыт в регионе»."""
        with self._cid_lock:
            if self._client_id and self._client_id != used:
                return self._client_id
            if time.time() - self._cid_refreshed_at < 60 and status == 403:
                return None
        return self.client_id(refresh=True)

    def _scrape_client_id(self) -> str:
        try:
            html = self.s.get(SITE + "/", timeout=15, headers={"Accept": "text/html"}).text
        except requests.RequestException as e:
            raise SoundCloudError(f"Нет связи с soundcloud.com: {e}") from e
        m = _CLIENT_ID_RE2.search(html)
        if m:
            return m.group(1)
        # ключ обычно лежит в одном из последних бандлов
        for src in reversed(_SCRIPT_RE.findall(html)):
            try:
                js = self.s.get(src, timeout=15).text
            except requests.RequestException:
                continue
            m = _CLIENT_ID_RE.search(js) or _CLIENT_ID_RE2.search(js)
            if m:
                return m.group(1)
        raise SoundCloudError("Не удалось получить client_id SoundCloud (сайт поменял разметку?)")

    # --- HTTP -------------------------------------------------------------
    def get(self, path_or_url: str, params: dict | None = None, *, _retry: bool = True) -> dict:
        url = path_or_url if path_or_url.startswith("http") else API + path_or_url
        p = dict(params or {})
        if "client_id=" not in url:
            p["client_id"] = self.client_id()
        m_used = _CLIENT_ID_RE2.search(url)
        used = p.get("client_id") or (m_used.group(1) if m_used else "")
        for attempt in range(3):
            try:
                r = self.s.get(url, params=p, timeout=20)
            except requests.RequestException as e:
                if attempt == 2:
                    raise SoundCloudError(f"Сеть: {e}") from e
                time.sleep(1 + attempt)
                continue
            if r.status_code in (401, 403) and _retry:
                # ключ протух — берём новый и пробуем ещё раз
                new_id = self._refresh_after_denied(used, r.status_code)
                if not new_id:
                    raise SoundCloudError("Доступ запрещён (403) — трек закрыт в твоём регионе или удалён")
                url = re.sub(r"client_id=[0-9a-zA-Z]+", f"client_id={new_id}", url)
                if "client_id" in p:
                    p["client_id"] = new_id
                return self.get(url, p, _retry=False)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 + attempt * 2)
                continue
            if r.status_code in (401, 403):
                raise SoundCloudError(f"Доступ запрещён ({r.status_code})")
            if r.status_code == 404:
                raise SoundCloudError("Не найдено (404)")
            if not r.ok:
                raise SoundCloudError(f"SoundCloud ответил {r.status_code}")
            return r.json()
        raise SoundCloudError("SoundCloud не отвечает, попробуй позже")

    def _paged(self, path: str, params: dict, limit_total: int) -> list[dict]:
        out: list[dict] = []
        data = self.get(path, params)
        while True:
            out.extend(data.get("collection") or [])
            nxt = data.get("next_href")
            if not nxt or len(out) >= limit_total:
                break
            data = self.get(nxt)
        return out[:limit_total]

    # --- методы -----------------------------------------------------------
    def search_tracks(self, q: str, limit: int = 30) -> list[dict]:
        data = self.get("/search/tracks", {"q": q, "limit": limit, "linked_partitioning": 1})
        return [p for p in (parse_track(t) for t in data.get("collection") or []) if p]

    def search_users(self, q: str, limit: int = 5) -> list[dict]:
        data = self.get("/search/users", {"q": q, "limit": limit})
        return data.get("collection") or []

    def resolve(self, url: str) -> dict:
        return self.get("/resolve", {"url": url.strip()})

    def tracks_by_ids(self, ids: list[int]) -> list[dict]:
        out = []
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            data = self.get("/tracks", {"ids": ",".join(map(str, chunk))})
            items = data if isinstance(data, list) else data.get("collection", [])
            out += [p for p in (parse_track(t) for t in items) if p]
        return out

    def related(self, sc_id: int, limit: int = 30) -> list[dict]:
        data = self.get(f"/tracks/{sc_id}/related", {"limit": limit, "linked_partitioning": 1})
        return [p for p in (parse_track(t) for t in data.get("collection") or []) if p]

    def user_likes(self, user_id: int, limit_total: int = 2000) -> list[dict]:
        items = self._paged(f"/users/{user_id}/likes", {"limit": 200, "linked_partitioning": 1}, limit_total)
        return [p for p in (parse_track(i.get("track")) for i in items if i.get("track")) if p]

    def user_tracks(self, user_id: int, limit_total: int = 200) -> list[dict]:
        items = self._paged(f"/users/{user_id}/tracks", {"limit": 50, "linked_partitioning": 1}, limit_total)
        return [p for p in (parse_track(i) for i in items) if p]

    def user_playlists(self, user_id: int) -> list[dict]:
        """Плейлисты пользователя (созданные им) + лайкнутые плейлисты, в сыром виде."""
        own = self._paged(f"/users/{user_id}/playlists", {"limit": 50, "linked_partitioning": 1}, 500)
        liked_items = self._paged(f"/users/{user_id}/likes", {"limit": 200, "linked_partitioning": 1}, 2000)
        liked = [i["playlist"] for i in liked_items if i.get("playlist")]
        seen, out = set(), []
        for p in own + liked:
            if p.get("id") not in seen:
                seen.add(p.get("id"))
                out.append(p)
        return out

    def playlist_full(self, playlist: dict) -> tuple[str, list[dict]]:
        """Возвращает (название, треки). Догружает «заглушки» треков по id."""
        if not playlist.get("tracks"):
            playlist = self.get(f"/playlists/{playlist['id']}")
        raw = playlist.get("tracks") or []
        full = {t["id"]: parse_track(t) for t in raw if t.get("title")}
        stubs = [t["id"] for t in raw if not t.get("title")]
        if stubs:
            for p in self.tracks_by_ids(stubs):
                full[p["sc_id"]] = p
        ordered = [full.get(t["id"]) for t in raw]
        return playlist.get("title") or "Плейлист", [t for t in ordered if t]

    # --- воспроизведение --------------------------------------------------
    def stream_file(self, sc_id: int, progress=None) -> Path:
        # один трек качается только одним потоком (предзагрузка + нажатие «дальше»)
        with self._dl_guard:
            lock = self._dl_locks.setdefault(sc_id, threading.Lock())
        with lock:
            return self._stream_file(sc_id, progress)

    def _stream_file(self, sc_id: int, progress=None) -> Path:
        """Скачивает трек во временный кэш и возвращает путь к файлу.

        Скачивание целиком (а не стрим) нужно, потому что SoundCloud отдаёт HLS,
        а локальный файл гарантированно играет в Qt на любой системе.
        """
        for ext in (".mp3", ".m4a", ".ogg", ".ts"):
            p = cache_dir() / f"{sc_id}{ext}"
            if p.exists() and p.stat().st_size > 50_000:
                os.utime(p)
                return p
        data = self.get(f"/tracks/{sc_id}")
        transcodings = (data.get("media") or {}).get("transcodings") or []
        usable = [t for t in transcodings if not t.get("snipped")
                  and "encrypted" not in ((t.get("format") or {}).get("protocol") or "")]
        if not usable:
            raise NotStreamable("Трек недоступен для прослушивания (Go+ или закрыт правообладателем)")

        def rank(t):
            fmt = t.get("format") or {}
            proto, mime = fmt.get("protocol", ""), fmt.get("mime_type", "")
            codec = 0 if "mpeg" in mime else 1 if ("mp4" in mime or "aac" in mime) else 2
            return (0 if proto == "progressive" else 1, codec)

        last_err: Exception | None = None
        for tc in sorted(usable, key=rank):
            try:
                params = {}
                if data.get("track_authorization"):
                    params["track_authorization"] = data["track_authorization"]
                info = self.get(tc["url"], params)
                media_url = info.get("url")
                if not media_url:
                    continue
                fmt = tc.get("format") or {}
                if fmt.get("protocol") == "progressive":
                    return self._download_progressive(sc_id, media_url, progress)
                return self._download_hls(sc_id, media_url, fmt.get("mime_type", ""), progress)
            except (SoundCloudError, requests.RequestException, OSError) as e:
                last_err = e
        raise NotStreamable(f"Не удалось получить поток: {last_err}")

    def _download_progressive(self, sc_id: int, url: str, progress) -> Path:
        dst = cache_dir() / f"{sc_id}.mp3"
        tmp = dst.with_name(f"{sc_id}.{uuid.uuid4().hex}.part")
        with self.s.get(url, stream=True, timeout=30) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            done = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(64 * 1024):
                    f.write(chunk)
                    done += len(chunk)
                    if progress and total:
                        progress(done / total)
        os.replace(tmp, dst)
        prune_cache()
        return dst

    def _download_hls(self, sc_id: int, url: str, mime: str, progress) -> Path:
        text = self.s.get(url, timeout=20).text
        if "#EXT-X-STREAM-INF" in text:  # мастер-плейлист — берём первый вариант
            variant = next(ln for ln in text.splitlines() if ln and not ln.startswith("#"))
            url = urljoin(url, variant.strip())
            text = self.s.get(url, timeout=20).text
        init_uri, segs = None, []
        for ln in text.splitlines():
            ln = ln.strip()
            if ln.startswith("#EXT-X-KEY") and "METHOD=NONE" not in ln:
                raise NotStreamable("Поток зашифрован")
            if ln.startswith("#EXT-X-MAP"):
                m = re.search(r'URI="([^"]+)"', ln)
                if m:
                    init_uri = urljoin(url, m.group(1))
            elif ln and not ln.startswith("#"):
                segs.append(urljoin(url, ln))
        if not segs:
            raise NotStreamable("Пустой HLS-плейлист")
        if "ogg" in mime or "opus" in mime:
            ext = ".ogg"
        elif "mpeg" in mime and init_uri is None:
            ext = ".mp3"
        elif init_uri or "mp4" in mime or "aac" in mime:
            ext = ".m4a"
        else:
            ext = ".ts"
        if init_uri is None and ext == ".m4a" and "mp4" not in mime and "ogg" not in mime:
            ext = ".ts"  # AAC в MPEG-TS
        parts: list[bytes | None] = [None] * len(segs)
        done = [0]
        lock = threading.Lock()

        def fetch(i: int):
            for attempt in range(3):
                try:
                    r = self.s.get(segs[i], timeout=20)
                    r.raise_for_status()
                    parts[i] = r.content
                    break
                except requests.RequestException:
                    if attempt == 2:
                        raise
                    time.sleep(0.5)
            with lock:
                done[0] += 1
                if progress:
                    progress(done[0] / len(segs))

        with ThreadPoolExecutor(max_workers=6) as ex:
            list(ex.map(fetch, range(len(segs))))
        dst = cache_dir() / f"{sc_id}{ext}"
        tmp = dst.with_name(f"{sc_id}.{uuid.uuid4().hex}.part")
        with open(tmp, "wb") as f:
            if init_uri:
                f.write(self.s.get(init_uri, timeout=20).content)
            for b in parts:
                f.write(b or b"")
        os.replace(tmp, dst)
        prune_cache()
        return dst


def prune_cache(max_bytes: int = 400 * 1024 * 1024) -> None:
    """Держит кэш треков в пределах лимита — удаляет давно не игравшие."""
    files = [p for p in cache_dir().iterdir() if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    total = 0
    for p in files:
        size = p.stat().st_size
        total += size
        if total > max_bytes or p.suffix == ".part" and time.time() - p.stat().st_mtime > 3600:
            try:
                p.unlink()
            except OSError:
                pass


_sc: SoundCloud | None = None


def sc() -> SoundCloud:
    global _sc
    if _sc is None:
        _sc = SoundCloud()
    return _sc
