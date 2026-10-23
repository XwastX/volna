"""SQLite-хранилище: треки, плейлисты, события прослушивания.

Каждый поток получает своё соединение (sqlite3 не любит шаринг между потоками).
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import unicodedata
from pathlib import Path
from typing import Iterable

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sc_id         INTEGER UNIQUE,
    spotify_uri   TEXT UNIQUE,
    title         TEXT NOT NULL,
    artist        TEXT NOT NULL DEFAULT '',
    artist_key    TEXT NOT NULL DEFAULT '',
    album         TEXT NOT NULL DEFAULT '',
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    genre         TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '',
    artwork_url   TEXT NOT NULL DEFAULT '',
    permalink_url TEXT NOT NULL DEFAULT '',
    sc_user_id    INTEGER,
    playable      INTEGER,              -- 1 = полный трек, 0 = только превью/недоступен, NULL = неизвестно
    match_status  TEXT NOT NULL DEFAULT 'none',  -- для треков Spotify: none / matched / failed
    in_library    INTEGER NOT NULL DEFAULT 0,
    liked         INTEGER NOT NULL DEFAULT 0,
    disliked      INTEGER NOT NULL DEFAULT 0,
    sources       TEXT NOT NULL DEFAULT '',     -- 'sc', 'spotify', 'sc,spotify'
    added_at      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tracks_artist ON tracks(artist_key);
CREATE INDEX IF NOT EXISTS ix_tracks_lib ON tracks(in_library);

CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    source     TEXT NOT NULL,   -- sc / spotify / local
    ext_id     TEXT UNIQUE,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
);

CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL,  -- play / complete / skip / like / dislike / history
    ts       REAL NOT NULL,
    ms       INTEGER NOT NULL DEFAULT 0,
    context  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_events_track ON events(track_id);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);

-- когда две строки одного трека склеиваются, старый id переадресуется на новый
CREATE TABLE IF NOT EXISTS merged (
    old_id INTEGER PRIMARY KEY,
    new_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lyrics (
    track_id   INTEGER PRIMARY KEY,
    payload    TEXT NOT NULL,
    fetched_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS related_cache (
    sc_id      INTEGER PRIMARY KEY,
    fetched_at REAL NOT NULL,
    payload    TEXT NOT NULL
);
"""

_FEAT_RE = re.compile(r"(?:\s+|\s*[\(\[]\s*)(?:feat\.?|ft\.?|featuring|prod\.?(?: by)?)\s.*$", re.I)
_PUNCT_RE = re.compile(r"[^\w\s]", re.U)
_SPACE_RE = re.compile(r"\s+")


def norm(text: str) -> str:
    """Нормализация для сравнения строк: регистр, диакритика, пунктуация, feat."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace("ё", "е")
    text = _FEAT_RE.sub("", text)
    text = _PUNCT_RE.sub(" ", text)
    return _SPACE_RE.sub(" ", text).strip()


def artist_key(artist: str) -> str:
    """Ключ основного исполнителя (первый из списка)."""
    first = re.split(r",|&| x | и | and |;|/", artist or "", maxsplit=1, flags=re.I)[0]
    return norm(first)


class Database:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = str(path or DB_PATH())
        self._local = threading.local()
        self._write_lock = threading.RLock()
        with self.conn() as c:
            c.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Безопасные миграции старых баз: только добавляем колонки/индексы."""
        with self._write_lock:
            c = self.conn()
            cols = {r["name"] for r in c.execute("PRAGMA table_info(tracks)").fetchall()}
            if "ym_id" not in cols:
                # SQLite не умеет ADD COLUMN ... UNIQUE — уникальность даёт индекс (NULL не мешают)
                c.execute("ALTER TABLE tracks ADD COLUMN ym_id TEXT")
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_tracks_ym ON tracks(ym_id)")
            # 0.6: год выпуска и популярность (для «Музыкальной ДНК»), файл для офлайна
            for col, decl in (("year", "INTEGER"), ("plays", "INTEGER"), ("offline", "TEXT NOT NULL DEFAULT ''")):
                if col not in cols:
                    c.execute(f"ALTER TABLE tracks ADD COLUMN {col} {decl}")
            c.execute("CREATE INDEX IF NOT EXISTS ix_tracks_offline ON tracks(offline)")
            c.commit()

    # --- соединение -------------------------------------------------------
    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30)
            c.row_factory = sqlite3.Row
            # LIKE в SQLite не понимает регистр кириллицы — сравниваем через Python
            c.create_function("pylower", 1, lambda s: (s or "").lower().replace("ё", "е"), deterministic=True)
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA foreign_keys=ON")
            self._local.conn = c
        return c

    def query(self, sql: str, args: Iterable = ()) -> list[dict]:
        return [dict(r) for r in self.conn().execute(sql, tuple(args)).fetchall()]

    def one(self, sql: str, args: Iterable = ()) -> dict | None:
        r = self.conn().execute(sql, tuple(args)).fetchone()
        return dict(r) if r else None

    def execute(self, sql: str, args: Iterable = ()) -> sqlite3.Cursor:
        with self._write_lock:
            c = self.conn()
            cur = c.execute(sql, tuple(args))
            c.commit()
            return cur

    # --- треки ------------------------------------------------------------
    def upsert_sc_track(self, t: dict, *, in_library: bool = False, liked: bool = False) -> int:
        """Сохраняет трек SoundCloud (словарь из soundcloud.parse_track). Возвращает локальный id."""
        with self._write_lock:
            c = self.conn()
            row = c.execute("SELECT id, in_library, liked FROM tracks WHERE sc_id=?", (t["sc_id"],)).fetchone()
            fields = dict(
                title=t["title"], artist=t["artist"], artist_key=artist_key(t["artist"]),
                duration_ms=t.get("duration_ms") or 0, genre=t.get("genre") or "",
                tags=t.get("tags") or "", artwork_url=t.get("artwork_url") or "",
                permalink_url=t.get("permalink_url") or "", sc_user_id=t.get("sc_user_id"),
                playable=1 if t.get("playable") else 0,
            )
            if row:
                sets = ", ".join(f"{k}=?" for k in fields)
                c.execute(
                    f"UPDATE tracks SET {sets}, in_library=max(in_library, ?), liked=max(liked, ?) WHERE id=?",
                    (*fields.values(), int(in_library), int(liked), row["id"]),
                )
                tid = row["id"]
                self._add_source(c, tid, "sc")
            else:
                cols = ", ".join(fields)
                qs = ", ".join("?" for _ in fields)
                cur = c.execute(
                    f"INSERT INTO tracks (sc_id, {cols}, in_library, liked, sources, added_at)"
                    f" VALUES (?, {qs}, ?, ?, 'sc', ?)",
                    (t["sc_id"], *fields.values(), int(in_library), int(liked), time.time()),
                )
                tid = cur.lastrowid
            self._set_meta(c, tid, t)
            c.commit()
            return tid

    @staticmethod
    def _set_meta(c: sqlite3.Connection, tid: int, t: dict) -> None:
        """Год и число прослушиваний — только если источник их знает (не затираем известное нулями)."""
        year = int(t.get("year") or 0)
        plays = int(t.get("playback_count") or 0)
        if 1900 < year < 2100:
            c.execute("UPDATE tracks SET year=? WHERE id=?", (year, tid))
        if plays > 0:
            c.execute("UPDATE tracks SET plays=? WHERE id=?", (plays, tid))

    def set_offline(self, tid: int, name: str) -> None:
        self.execute("UPDATE tracks SET offline=? WHERE id=?", (name or "", self.resolve(tid)))

    def offline_tracks(self) -> list[dict]:
        return self.query("SELECT * FROM tracks WHERE offline!='' ORDER BY liked DESC, added_at DESC")

    def upsert_spotify_track(self, uri: str | None, title: str, artist: str, album: str = "",
                             duration_ms: int = 0, *, in_library: bool = True, liked: bool = False) -> int:
        with self._write_lock:
            c = self.conn()
            row = None
            if uri:
                row = c.execute("SELECT id FROM tracks WHERE spotify_uri=?", (uri,)).fetchone()
            if row is None:
                # тот же трек мог прийти без uri (история) — ищем по названию+артисту
                row = c.execute(
                    "SELECT id FROM tracks WHERE artist_key=? AND lower(title)=lower(?) AND sources LIKE '%spotify%'",
                    (artist_key(artist), title),
                ).fetchone()
            if row:
                tid = row["id"]
                c.execute(
                    "UPDATE tracks SET in_library=max(in_library, ?), liked=max(liked, ?),"
                    " spotify_uri=coalesce(spotify_uri, ?), album=CASE WHEN album='' THEN ? ELSE album END,"
                    " duration_ms=CASE WHEN duration_ms=0 THEN ? ELSE duration_ms END WHERE id=?",
                    (int(in_library), int(liked), uri, album, duration_ms, tid),
                )
                self._add_source(c, tid, "spotify")
            else:
                cur = c.execute(
                    "INSERT INTO tracks (spotify_uri, title, artist, artist_key, album, duration_ms,"
                    " in_library, liked, sources, added_at) VALUES (?,?,?,?,?,?,?,?, 'spotify', ?)",
                    (uri, title, artist, artist_key(artist), album, duration_ms,
                     int(in_library), int(liked), time.time()),
                )
                tid = cur.lastrowid
            c.commit()
            return tid

    def upsert_ym_track(self, t: dict, *, in_library: bool = False, liked: bool = False) -> int:
        """Сохраняет трек Яндекс Музыки (словарь из yandex.parse_track). Возвращает локальный id.

        Сначала ищем строку с тем же ym_id, потом — тот же трек, пришедший из SoundCloud/Spotify
        (тот же основной артист + название, длительность близкая), и дописываем в неё ym_id.
        """
        ym_id = str(t["ym_id"])
        title, artist = t.get("title") or "", t.get("artist") or ""
        dur = int(t.get("duration_ms") or 0)
        with self._write_lock:
            c = self.conn()
            row = c.execute("SELECT id FROM tracks WHERE ym_id=?", (ym_id,)).fetchone()
            if row is None:
                row = self._find_same_track(c, title, artist, dur)
            if row:
                tid = row["id"]
                c.execute(
                    "UPDATE tracks SET ym_id=?, in_library=max(in_library, ?), liked=max(liked, ?),"
                    " album=CASE WHEN album='' THEN ? ELSE album END,"
                    " genre=CASE WHEN genre='' THEN ? ELSE genre END,"
                    " artwork_url=CASE WHEN artwork_url='' THEN ? ELSE artwork_url END,"
                    " duration_ms=CASE WHEN duration_ms=0 THEN ? ELSE duration_ms END WHERE id=?",
                    (ym_id, int(in_library), int(liked), t.get("album") or "", t.get("genre") or "",
                     t.get("artwork_url") or "", dur, tid),
                )
                self._add_source(c, tid, "yandex")
            else:
                tid = c.execute(
                    "INSERT INTO tracks (ym_id, title, artist, artist_key, album, duration_ms, genre, artwork_url,"
                    " in_library, liked, sources, added_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'yandex', ?)",
                    (ym_id, title, artist, artist_key(artist), t.get("album") or "", dur, t.get("genre") or "",
                     t.get("artwork_url") or "", int(in_library), int(liked), time.time()),
                ).lastrowid
            self._set_meta(c, tid, t)
            c.commit()
            return tid

    @staticmethod
    def _find_same_track(c: sqlite3.Connection, title: str, artist: str, dur: int):
        """Строка того же трека без ym_id: тот же артист, то же название, длительность ±5 с."""
        key, nt = artist_key(artist), norm(title)
        if not key or not nt:
            return None
        rows = c.execute(
            "SELECT id, title, duration_ms FROM tracks WHERE artist_key=? AND ym_id IS NULL"
            " ORDER BY (sc_id IS NULL), id", (key,)).fetchall()
        for r in rows:
            if norm(r["title"]) != nt:
                continue
            d = r["duration_ms"] or 0
            if dur and d and abs(d - dur) > 5000:
                continue
            return r
        return None

    def track_by_ym(self, ym_id) -> dict | None:
        return self.one("SELECT * FROM tracks WHERE ym_id=?", (str(ym_id),))

    @staticmethod
    def _add_source(c: sqlite3.Connection, tid: int, src: str) -> None:
        r = c.execute("SELECT sources FROM tracks WHERE id=?", (tid,)).fetchone()
        parts = [p for p in (r["sources"] or "").split(",") if p]
        if src not in parts:
            parts.append(src)
            c.execute("UPDATE tracks SET sources=? WHERE id=?", (",".join(sorted(parts)), tid))

    def attach_match(self, spotify_track_id: int, sc: dict) -> int:
        """Привязывает найденный на SoundCloud трек к треку из Spotify.

        Если такой sc_id уже есть отдельной строкой — сливаем строки в одну.
        """
        with self._write_lock:
            c = self.conn()
            existing = c.execute("SELECT id FROM tracks WHERE sc_id=?", (sc["sc_id"],)).fetchone()
            if existing and existing["id"] != spotify_track_id:
                other = existing["id"]
                for tbl, col in (("events", "track_id"),):
                    c.execute(f"UPDATE {tbl} SET {col}=? WHERE {col}=?", (spotify_track_id, other))
                c.execute(
                    "UPDATE OR IGNORE playlist_tracks SET track_id=? WHERE track_id=?", (spotify_track_id, other)
                )
                c.execute("DELETE FROM playlist_tracks WHERE track_id=?", (other,))
                o = c.execute("SELECT in_library, liked, disliked, offline FROM tracks WHERE id=?", (other,)).fetchone()
                c.execute("DELETE FROM tracks WHERE id=?", (other,))
                c.execute("INSERT OR REPLACE INTO merged VALUES (?,?)", (other, spotify_track_id))
                c.execute("UPDATE merged SET new_id=? WHERE new_id=?", (spotify_track_id, other))
                c.execute(
                    "UPDATE tracks SET in_library=max(in_library,?), liked=max(liked,?), disliked=max(disliked,?),"
                    " offline=CASE WHEN offline='' THEN ? ELSE offline END WHERE id=?",
                    (o["in_library"], o["liked"], o["disliked"], o["offline"] or "", spotify_track_id),
                )
            c.execute(
                "UPDATE tracks SET sc_id=?, artwork_url=?, permalink_url=?, sc_user_id=?, genre=?, tags=?,"
                " playable=?, match_status='matched',"
                " duration_ms=CASE WHEN duration_ms=0 THEN ? ELSE duration_ms END WHERE id=?",
                (sc["sc_id"], sc.get("artwork_url") or "", sc.get("permalink_url") or "", sc.get("sc_user_id"),
                 sc.get("genre") or "", sc.get("tags") or "", 1 if sc.get("playable") else 0,
                 sc.get("duration_ms") or 0, spotify_track_id),
            )
            self._add_source(c, spotify_track_id, "sc")
            self._set_meta(c, spotify_track_id, sc)
            c.commit()
            return spotify_track_id

    def resolve(self, tid: int) -> int:
        """Актуальный id трека (на случай, если строку склеили с другой)."""
        r = self.conn().execute("SELECT new_id FROM merged WHERE old_id=?", (tid,)).fetchone()
        return r["new_id"] if r else tid

    def mark_match_failed(self, track_id: int) -> None:
        self.execute("UPDATE tracks SET match_status='failed' WHERE id=?", (track_id,))

    def track(self, tid: int) -> dict | None:
        return self.one("SELECT * FROM tracks WHERE id=?", (self.resolve(tid),))

    def track_by_sc(self, sc_id: int) -> dict | None:
        return self.one("SELECT * FROM tracks WHERE sc_id=?", (sc_id,))

    def library(self, source: str = "all", search: str = "", liked_only: bool = False) -> list[dict]:
        sql = "SELECT * FROM tracks WHERE in_library=1"
        args: list = []
        if source in ("sc", "spotify", "yandex"):
            sql += " AND sources LIKE ?"
            args.append(f"%{source}%")
        if liked_only:
            sql += " AND liked=1"
        if search:
            sql += " AND (pylower(title) LIKE ? OR pylower(artist) LIKE ?)"
            q = search.lower().replace("ё", "е").replace("%", "")
            args += [f"%{q}%", f"%{q}%"]
        sql += " ORDER BY added_at DESC, id DESC"
        return self.query(sql, args)

    def unmatched_spotify(self, limit: int = 10_000) -> list[dict]:
        return self.query(
            "SELECT * FROM tracks WHERE sc_id IS NULL AND sources LIKE '%spotify%' AND match_status='none'"
            " ORDER BY in_library DESC, id LIMIT ?",
            (limit,),
        )

    def set_like(self, tid: int, liked: bool) -> None:
        tid = self.resolve(tid)
        if liked:
            self.execute("UPDATE tracks SET liked=1, disliked=0, in_library=1 WHERE id=?", (tid,))
        else:
            self.execute("UPDATE tracks SET liked=0 WHERE id=?", (tid,))
        self.log(tid, "like" if liked else "unlike")

    def set_dislike(self, tid: int, disliked: bool = True) -> None:
        tid = self.resolve(tid)
        self.execute("UPDATE tracks SET disliked=?, liked=CASE WHEN ? THEN 0 ELSE liked END WHERE id=?",
                     (int(disliked), int(disliked), tid))
        if disliked:
            self.log(tid, "dislike")

    def add_to_library(self, tid: int) -> None:
        self.execute("UPDATE tracks SET in_library=1 WHERE id=?", (self.resolve(tid),))

    # --- плейлисты --------------------------------------------------------
    def upsert_playlist(self, name: str, source: str, ext_id: str | None, track_ids: list[int]) -> int:
        with self._write_lock:
            c = self.conn()
            row = c.execute("SELECT id FROM playlists WHERE ext_id=?", (ext_id,)).fetchone() if ext_id else None
            if row:
                pid = row["id"]
                c.execute("UPDATE playlists SET name=? WHERE id=?", (name, pid))
                c.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (pid,))
            else:
                pid = c.execute(
                    "INSERT INTO playlists (name, source, ext_id, created_at) VALUES (?,?,?,?)",
                    (name, source, ext_id, time.time()),
                ).lastrowid
            seen = set()
            pos = 0
            for tid in track_ids:
                r = c.execute("SELECT new_id FROM merged WHERE old_id=?", (tid,)).fetchone()
                tid = r["new_id"] if r else tid
                if tid in seen:
                    continue
                seen.add(tid)
                c.execute("INSERT INTO playlist_tracks VALUES (?,?,?)", (pid, tid, pos))
                pos += 1
            c.commit()
            return pid

    def playlists(self) -> list[dict]:
        return self.query(
            "SELECT p.*, count(pt.track_id) AS n FROM playlists p"
            " LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id GROUP BY p.id ORDER BY p.name COLLATE NOCASE"
        )

    def playlist_tracks(self, pid: int) -> list[dict]:
        return self.query(
            "SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id"
            " WHERE pt.playlist_id=? ORDER BY pt.position",
            (pid,),
        )

    def delete_playlist(self, pid: int) -> None:
        self.execute("DELETE FROM playlists WHERE id=?", (pid,))

    # --- события ----------------------------------------------------------
    def log(self, tid: int, kind: str, ms: int = 0, context: str = "", ts: float | None = None) -> None:
        tid = self.resolve(tid)
        try:
            self.execute(
                "INSERT INTO events (track_id, kind, ts, ms, context) VALUES (?,?,?,?,?)",
                (tid, kind, ts if ts is not None else time.time(), ms, context),
            )
        except sqlite3.IntegrityError:
            pass  # трек удалён — событие не важно

    def log_many(self, rows: list[tuple]) -> None:
        """rows: (track_id, kind, ts, ms, context)"""
        with self._write_lock:
            c = self.conn()
            c.executemany("INSERT INTO events (track_id, kind, ts, ms, context) VALUES (?,?,?,?,?)", rows)
            c.commit()

    def recent_track_ids(self, seconds: float) -> set[int]:
        since = time.time() - seconds
        return {r["track_id"] for r in self.query(
            "SELECT DISTINCT track_id FROM events WHERE ts>=? AND kind IN ('play','complete','skip')", (since,)
        )}

    # --- кэш related ------------------------------------------------------
    def get_related(self, sc_id: int, max_age: float = 3 * 86400) -> list[dict] | None:
        r = self.one("SELECT * FROM related_cache WHERE sc_id=?", (sc_id,))
        if r and time.time() - r["fetched_at"] < max_age:
            return json.loads(r["payload"])
        return None

    def put_related(self, sc_id: int, tracks: list[dict]) -> None:
        self.execute(
            "INSERT OR REPLACE INTO related_cache (sc_id, fetched_at, payload) VALUES (?,?,?)",
            (sc_id, time.time(), json.dumps(tracks, ensure_ascii=False)),
        )

    # --- подборки и статистика -------------------------------------------
    def recent_played(self, limit: int = 20) -> list[dict]:
        return self.query(
            "SELECT t.*, max(e.ts) AS last_ts FROM events e JOIN tracks t ON t.id=e.track_id"
            " WHERE e.kind IN ('play','complete') AND t.disliked=0 GROUP BY t.id ORDER BY last_ts DESC LIMIT ?",
            (limit,))

    def recently_added(self, limit: int = 20) -> list[dict]:
        return self.query("SELECT * FROM tracks WHERE in_library=1 ORDER BY added_at DESC, id DESC LIMIT ?", (limit,))

    def forgotten(self, limit: int = 20, days: int = 30) -> list[dict]:
        """Лайкнутые треки, которые давно (или никогда здесь) не играли."""
        since = time.time() - days * 86400
        return self.query(
            "SELECT t.* FROM tracks t WHERE t.liked=1 AND coalesce(t.playable,1)=1 AND t.match_status!='failed'"
            " AND NOT EXISTS (SELECT 1 FROM events e WHERE e.track_id=t.id AND e.ts>=?"
            "  AND e.kind IN ('play','complete','skip')) ORDER BY random() LIMIT ?", (since, limit))

    def _listen_rows(self, since: float) -> str:
        """SQL-подзапрос: (track_id, ms, plays) — прослушивания в приложении + история Spotify."""
        hist = "" if since > 0 else (
            " UNION ALL SELECT track_id, ms,"
            " CAST(coalesce(nullif(substr(context, 7, instr(context||';', ';')-7), ''), '1') AS INTEGER)"
            " FROM events WHERE kind='history'")
        return (f"SELECT track_id, ms, 1 AS plays FROM events WHERE kind IN ('complete','skip')"
                f" AND ts>={since}{hist}")

    def top_artists(self, since: float = 0, limit: int = 12) -> list[dict]:
        rows = self.query(
            f"SELECT t.artist_key AS key, max(t.artist) AS name, sum(l.ms) AS ms, sum(l.plays) AS plays,"
            f" count(DISTINCT t.id) AS tracks FROM ({self._listen_rows(since)}) l JOIN tracks t ON t.id=l.track_id"
            f" WHERE t.artist_key!='' GROUP BY t.artist_key ORDER BY ms DESC LIMIT ?", (limit,))
        for r in rows:
            r["art"] = self.artist_art(r["key"])
        return rows

    def top_tracks(self, since: float = 0, limit: int = 20) -> list[dict]:
        return self.query(
            f"SELECT t.*, sum(l.ms) AS listened_ms, sum(l.plays) AS plays FROM ({self._listen_rows(since)}) l"
            f" JOIN tracks t ON t.id=l.track_id GROUP BY t.id ORDER BY listened_ms DESC LIMIT ?", (limit,))

    def listen_totals(self, since: float = 0) -> dict:
        r = self.one(
            f"SELECT coalesce(sum(l.ms),0) AS ms, coalesce(sum(l.plays),0) AS plays, count(DISTINCT l.track_id) AS tracks,"
            f" count(DISTINCT t.artist_key) AS artists FROM ({self._listen_rows(since)}) l JOIN tracks t ON t.id=l.track_id")
        return r

    def by_hour(self, since: float = 0) -> list[int]:
        """Минуты прослушивания по часам суток (местное время)."""
        hours = [0] * 24
        for r in self.query("SELECT ts, ms FROM events WHERE kind IN ('complete','skip') AND ts>=?", (since,)):
            hours[time.localtime(r["ts"]).tm_hour] += r["ms"] // 60000
        return hours

    def top_genres(self, since: float = 0, limit: int = 10) -> list[dict]:
        acc: dict[str, float] = {}
        for r in self.query(
                f"SELECT t.genre, sum(l.ms) AS ms FROM ({self._listen_rows(since)}) l JOIN tracks t ON t.id=l.track_id"
                f" WHERE t.genre!='' GROUP BY lower(t.genre)"):
            g = r["genre"].strip().lower()
            acc[g] = acc.get(g, 0) + r["ms"]
        return [{"name": k, "ms": v} for k, v in sorted(acc.items(), key=lambda kv: -kv[1])[:limit]]

    def artist_art(self, key: str) -> str:
        r = self.one("SELECT artwork_url FROM tracks WHERE artist_key=? AND artwork_url!=''"
                     " ORDER BY liked DESC, in_library DESC LIMIT 1", (key,))
        return r["artwork_url"] if r else ""

    def artist_tracks(self, key: str) -> list[dict]:
        return self.query(
            "SELECT t.*, (SELECT count(*) FROM events e WHERE e.track_id=t.id AND e.kind IN ('complete','play')) AS plays"
            " FROM tracks t WHERE t.artist_key=? AND t.disliked=0 ORDER BY t.in_library DESC, plays DESC, t.liked DESC",
            (key,))

    def artist_listen(self, key: str) -> dict:
        r = self.one(
            f"SELECT coalesce(sum(l.ms),0) AS ms, coalesce(sum(l.plays),0) AS plays FROM ({self._listen_rows(0)}) l"
            f" JOIN tracks t ON t.id=l.track_id WHERE t.artist_key=?", (key,))
        r["liked"] = self.one("SELECT count(*) AS n FROM tracks WHERE artist_key=? AND liked=1", (key,))["n"]
        return r

    # --- свои плейлисты ---------------------------------------------------
    def create_playlist(self, name: str) -> int:
        return self.execute("INSERT INTO playlists (name, source, ext_id, created_at) VALUES (?, 'local', NULL, ?)",
                            (name.strip() or "Новый плейлист", time.time())).lastrowid

    def rename_playlist(self, pid: int, name: str) -> None:
        self.execute("UPDATE playlists SET name=? WHERE id=?", (name.strip() or "Без названия", pid))

    def add_to_playlist(self, pid: int, tid: int) -> bool:
        tid = self.resolve(tid)
        with self._write_lock:
            c = self.conn()
            pos = c.execute("SELECT coalesce(max(position)+1, 0) FROM playlist_tracks WHERE playlist_id=?",
                            (pid,)).fetchone()[0]
            cur = c.execute("INSERT OR IGNORE INTO playlist_tracks VALUES (?,?,?)", (pid, tid, pos))
            c.execute("UPDATE tracks SET in_library=1 WHERE id=?", (tid,))
            c.commit()
            return cur.rowcount > 0

    def remove_from_playlist(self, pid: int, tid: int) -> None:
        self.execute("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?", (pid, self.resolve(tid)))

    def reorder_playlist(self, pid: int, track_ids: list[int]) -> None:
        with self._write_lock:
            c = self.conn()
            for pos, tid in enumerate(track_ids):
                c.execute("UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?", (pos, pid, tid))
            c.commit()

    def playlist(self, pid: int) -> dict | None:
        return self.one("SELECT p.*, (SELECT count(*) FROM playlist_tracks WHERE playlist_id=p.id) AS n"
                        " FROM playlists p WHERE p.id=?", (pid,))

    # --- тексты -------------------------------------------------------------
    def get_lyrics(self, tid: int, max_age: float = 30 * 86400) -> dict | None:
        r = self.one("SELECT * FROM lyrics WHERE track_id=?", (self.resolve(tid),))
        if not r:
            return None
        data = json.loads(r["payload"])
        # «не нашлось» перепроверяем раз в неделю — тексты в базу добавляют люди
        if not data.get("found") and time.time() - r["fetched_at"] > 7 * 86400:
            return None
        if time.time() - r["fetched_at"] > max_age:
            return None
        return data

    def put_lyrics(self, tid: int, data: dict) -> None:
        self.execute("INSERT OR REPLACE INTO lyrics (track_id, payload, fetched_at) VALUES (?,?,?)",
                     (self.resolve(tid), json.dumps(data, ensure_ascii=False), time.time()))

    # --- итоги ----------------------------------------------------------------
    def recap(self, since: float) -> dict:
        """Данные для «Итогов» за период (только прослушивания в приложении)."""
        totals = self.listen_totals(since)
        days = self.one("SELECT count(DISTINCT date(ts, 'unixepoch', 'localtime')) AS d FROM events"
                        " WHERE kind IN ('complete','skip','play') AND ts>=?", (since,))["d"]
        first_seen = self.query(
            "SELECT t.artist_key AS key, min(e.ts) AS first FROM events e JOIN tracks t ON t.id=e.track_id"
            " WHERE e.kind IN ('complete','skip','play') GROUP BY t.artist_key")
        new_artists = sum(1 for r in first_seen if r["first"] >= since)
        hours = self.by_hour(since)
        peak = max(range(24), key=lambda h: hours[h]) if any(hours) else None
        night = sum(hours[h] for h in (0, 1, 2, 3, 4, 5, 23))
        likes = self.one("SELECT count(*) AS n FROM events WHERE kind='like' AND ts>=?", (since,))["n"]
        busiest = self.one(
            "SELECT date(ts, 'unixepoch', 'localtime') AS day, sum(ms) AS ms FROM events"
            " WHERE kind IN ('complete','skip') AND ts>=? GROUP BY day ORDER BY ms DESC LIMIT 1", (since,))
        return {"totals": totals, "days": days, "new_artists": new_artists, "peak_hour": peak,
                "night_min": night, "total_min": sum(hours), "likes": likes, "busiest": busiest,
                "artists": self.top_artists(since, 5), "tracks": self.top_tracks(since, 5),
                "genres": self.top_genres(since, 3)}

    def stats(self) -> dict:
        r = self.one(
            "SELECT count(*) AS total, sum(in_library) AS lib, sum(liked) AS liked,"
            " sum(CASE WHEN sources LIKE '%spotify%' AND sc_id IS NULL AND match_status='none' THEN 1 ELSE 0 END) AS pending,"
            " sum(CASE WHEN match_status='failed' THEN 1 ELSE 0 END) AS failed,"
            " sum(CASE WHEN offline!='' THEN 1 ELSE 0 END) AS offline FROM tracks"
        )
        return {k: (v or 0) for k, v in r.items()}
