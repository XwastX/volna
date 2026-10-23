"""Мост между веб-интерфейсом (JS) и Python.

JS вызывает api.call(id, метод, json-аргументы), ответ приходит сигналом reply(id, json).
Состояние плеера и прогресс задач Python сам шлёт сигналом event(имя, json).
"""
from __future__ import annotations

import json
import time
import traceback

import requests
from PySide6.QtCore import QObject, Qt, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QColor, QDesktopServices, QImage
from PySide6.QtWidgets import QFileDialog

from .. import __version__
from ..config import cache_dir, settings
from ..db import Database, artist_key, norm
from ..feed import Feed
from ..library import import_sc_link, import_sc_profile
from ..matcher import match_pending
from .. import lyrics as lyrics_mod
from ..recommender import MODES, MOODS as WAVE_MOODS, ColdStart, Wave
from ..soundcloud import SoundCloud
from ..spotify_import import import_export, import_public_link
from . import workers
from .player import Player
from .workers import run_bg

MOODS = [
    ("Ночной лоуфай", "lofi night"),
    ("Фонк", "phonk"),
    ("Пост-панк", "russian post punk"),
    ("Инди", "indie"),
    ("Хип-хоп", "hip hop"),
    ("Электроника", "electronic"),
    ("Аниме OST", "anime ost"),
    ("Джаз", "jazz"),
]


def slim(t: dict | None) -> dict | None:
    """Только то, что нужно интерфейсу."""
    if not t:
        return None
    src = t.get("sources") or ("sc" if t.get("sc_id") else "")
    return {
        "id": t.get("id"),
        "title": t.get("title") or "",
        "artist": t.get("artist") or "",
        "art": t.get("artwork_url") or "",
        "dur": t.get("duration_ms") or 0,
        "liked": bool(t.get("liked")),
        "sc": "sc" in src.split(",") or bool(t.get("sc_id")),
        "sp": "spotify" in src,
        "ym": bool(t.get("ym_id")),
        "off": bool(t.get("offline")),
        "missing": not t.get("ym_id") and (t.get("match_status") == "failed" or t.get("playable") == 0),
        "pending": not t.get("ym_id") and not t.get("sc_id") and t.get("match_status") != "failed",
        "url": t.get("permalink_url") or "",
        "ak": t.get("artist_key") or artist_key(t.get("artist") or ""),
    }


def art_hi(url: str) -> str:
    return url.replace("-t300x300.", "-t500x500.") if url else url


def dominant_color(data: bytes) -> str | None:
    """Самый «живой» цвет обложки: насыщенный и не слишком тёмный."""
    img = QImage.fromData(data)
    if img.isNull():
        return None
    img = img.scaled(24, 24, Qt.AspectRatioMode.IgnoreAspectRatio, Qt.TransformationMode.SmoothTransformation)
    buckets: dict[int, list] = {}
    for y in range(img.height()):
        for x in range(img.width()):
            c = QColor(img.pixel(x, y))
            h, s, v, _ = c.getHsvF()
            if v < 0.15:
                continue
            key = int((h if h >= 0 else 0) * 18)
            w = (s ** 1.5) * (0.4 + v)
            b = buckets.setdefault(key, [0.0, 0.0, 0.0, 0.0, 0.0])
            b[0] += w
            b[1] += c.redF() * w
            b[2] += c.greenF() * w
            b[3] += c.blueF() * w
            b[4] += s * w
    if not buckets:
        return None
    w, r, g, bl, s = max(buckets.values(), key=lambda b: b[0])
    if w <= 0 or s / w < 0.12:
        return None  # почти серая обложка — оставляем фирменный цвет
    c = QColor.fromRgbF(r / w, g / w, bl / w)
    h, s_, v, _ = c.getHsvF()
    c = QColor.fromHsvF(max(h, 0), min(1, max(s_, 0.45)), min(1, max(v, 0.75)))
    return c.name()


SETTING_KEYS = {"lastfm_scrobble": bool, "lastfm_love": bool, "update_repo": str, "update_auto": bool, "ui": dict, "crossfade": float, "normalize": bool, "eq": list, "eq_on": bool, "close_to_tray": bool,
                "discord_on": bool, "discord_id": str, "wave_mood": str,
                "offline_liked": bool, "party_skip": bool}
SETTING_DEFAULTS = {"lastfm_scrobble": True, "lastfm_love": True, "update_repo": "XwastX/volna", "update_auto": True, "ui": {}, "crossfade": 4.0, "normalize": True, "eq": [0.0] * 10, "eq_on": False, "close_to_tray": True,
                    "discord_on": False, "discord_id": "", "wave_mood": "",
                    "offline_liked": False, "party_skip": True}


try:  # расширения моста живут в отдельных файлах (Яндекс Музыка, Last.fm и т.д.)
    from .bridge_yandex import YandexAPI
except ImportError:  # noqa: E722
    class YandexAPI:  # type: ignore[no-redef]
        pass
try:
    from .bridge_extra import ExtraAPI
except ImportError:
    class ExtraAPI:  # type: ignore[no-redef]
        pass
from .bridge_more import MoreAPI


class Bridge(YandexAPI, ExtraAPI, MoreAPI, QObject):
    event = Signal(str, str)
    reply = Signal(int, str)
    tint = Signal(str)

    def __init__(self, db: Database, sc: SoundCloud, player: Player, window):
        super().__init__(window)
        self.db, self.sc, self.player, self.win = db, sc, player, window
        self._match_task = None
        self._stop_match = False
        self._tint_req = 0
        self.context = ""
        self.feed = Feed(db, sc)
        self._avatars: dict[str, str] = {}
        player.track_changed.connect(self._on_track)
        player.playing_changed.connect(lambda on: self.emit("playing", on))
        player.position_changed.connect(lambda p, d: self.emit("position", {"pos": p, "dur": d}))
        player.loading.connect(lambda on, f: self.emit("loading", {"on": on, "frac": f}))
        player.error.connect(lambda m: self.emit("toast", {"text": m, "kind": "error"}))
        player.queue_changed.connect(self._on_queue)
        if hasattr(player, "spectrum"):
            player.spectrum.connect(lambda bands: self.event.emit("spectrum", json.dumps([round(b, 3) for b in bands])))
        # таймер сна
        self._sleep_timer = QTimer(self, singleShot=True)
        self._sleep_timer.timeout.connect(self._sleep_fire)
        self._sleep_end = 0.0
        self._sleep_track = False
        self._fade: QTimer | None = None
        player.stopped_after.connect(self._sleep_stopped_after)
        for hook in ("_init_yandex", "_init_extra", "_init_more"):   # инициализация расширений
            if hasattr(self, hook):
                getattr(self, hook)()

    # ------------------------------------------------------------------
    def emit(self, name: str, data) -> None:
        self.event.emit(name, json.dumps(data, ensure_ascii=False))

    @Slot(int, str, str)
    def call(self, rid: int, method: str, args: str) -> None:
        fn = getattr(self, "api_" + method, None)
        try:
            a = json.loads(args or "{}")
            if fn is None:
                raise ValueError(f"нет метода {method}")
            res = fn(rid, **a)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._reply(rid, error=str(e))
            return
        if res is not _ASYNC:
            self._reply(rid, data=res)

    def _reply(self, rid: int, data=None, error: str | None = None) -> None:
        self.reply.emit(rid, json.dumps({"ok": error is None, "data": data, "error": error}, ensure_ascii=False))

    def _bg(self, rid: int, fn, progress_task: str | None = None):
        """Выполнить fn в фоне и ответить на запрос rid."""
        def on_prog(frac, text):
            self.emit("progress", {"task": progress_task, "frac": frac, "text": text})

        run_bg(fn, lambda r: self._reply(rid, data=r), lambda e: self._reply(rid, error=e),
               on_prog if progress_task else None)
        return _ASYNC

    # --- плеер -> интерфейс ------------------------------------------------
    def _on_track(self, t) -> None:
        s = slim(t)
        if s:
            s["artHi"] = art_hi(s["art"])
        self.emit("track", s)
        self._on_queue()
        self._tint_req += 1
        req = self._tint_req
        url = (t or {}).get("artwork_url") or ""
        if not url:
            self.emit("tint", None)
            return

        def work():
            r = requests.get(url, timeout=10)
            r.raise_for_status()
            return dominant_color(r.content)

        def got(c):
            if req == self._tint_req:
                self.emit("tint", c)
                self.tint.emit(c or "#a8bcff")
        run_bg(work, got, lambda _e: None)

    def _on_queue(self) -> None:
        p = self.player
        q = p.queue_state()
        self.emit("queue", {"wave": p.in_wave, "mode": p.wave.mode if p.wave else None,
                            "items": [slim(t) for t in p.upcoming(8)],
                            "user": [slim(t) for t in q["user"]], "next": [slim(t) for t in q["next"]],
                            "ctx": "Моя волна" if p.in_wave else self.context})

    # --- общее --------------------------------------------------------------
    def api_init(self, rid):
        return {
            "version": __version__,
            "stats": self.db.stats(),
            "volume": settings().get("volume", 70),
            "mode": settings().get("wave_mode", "mix"),
            "modes": [{"key": k, "label": v["label"]} for k, v in MODES.items()],
            "moods": [{"label": a, "query": b} for a, b in MOODS],
            "scProfile": settings().get("sc_profile_url", ""),
            "track": slim(self.player.current),
            "waveMoods": [{"key": k, "label": v["label"]} for k, v in WAVE_MOODS.items()],
            "waveMood": settings().get("wave_mood") or "",
            "engine": getattr(self.player, "engine_name", "qt"),
            "offline": bool(getattr(self.player, "offline_only", False)),
        }

    def api_stats(self, rid):
        return self.db.stats()

    def api_open_url(self, rid, url: str):
        if url.startswith("https://"):
            QDesktopServices.openUrl(QUrl(url))
        return True

    # --- библиотека -----------------------------------------------------------
    def api_library(self, rid, source="all", search="", liked=False):
        return [slim(t) for t in self.db.library(source=source, search=search, liked_only=liked)]

    def api_playlists(self, rid):
        out = []
        pls = sorted(self.db.playlists(), key=lambda p: (p["source"] != "local", -p["created_at"]))
        for pl in pls:
            arts = [r["artwork_url"] for r in self.db.query(
                "SELECT t.artwork_url FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id"
                " WHERE pt.playlist_id=? AND t.artwork_url!='' ORDER BY pt.position LIMIT 4", (pl["id"],))]
            out.append({"id": pl["id"], "name": pl["name"], "source": pl["source"], "n": pl["n"], "arts": arts})
        return out

    def api_playlist(self, rid, pid: int):
        return [slim(t) for t in self.db.playlist_tracks(pid)]

    def api_search(self, rid, q: str):
        db, sc = self.db, self.sc

        def work():
            if "soundcloud.com/" in q:
                r = import_sc_link(db, sc, q)
                return {"added": r, "rows": []}
            rows = []
            for t in sc.search_tracks(q, limit=40):
                if not t["playable"]:
                    continue
                row = db.track_by_sc(t["sc_id"]) or db.track(db.upsert_sc_track(t))
                rows.append(slim(row))
            return {"rows": rows}
        return self._bg(rid, work)

    def after_like(self, t: dict | None, liked: bool) -> None:
        """Лайк поставлен в приложении — передаём во внешние сервисы (Last.fm, Яндекс)."""
        if not t:
            return
        if hasattr(self, "lastfm_love"):
            self.lastfm_love(t, liked)
        if hasattr(self, "ym_like_hook"):
            self.ym_like_hook(t, liked)
        if hasattr(self, "offline_like_hook"):
            self.offline_like_hook(t, liked)

    def api_like(self, rid, id: int, liked: bool):
        self.db.set_like(id, liked)
        self.after_like(self.db.track(id), liked)
        cur = self.player.current
        if cur and self.db.resolve(cur["id"]) == self.db.resolve(id):
            cur["liked"] = int(liked)
            self.emit("track", {**slim(cur), "artHi": art_hi(cur.get("artwork_url") or "")})
            if liked and self.player.wave:
                w = self.player.wave
                run_bg(lambda: w.on_like(cur), lambda _r: self._on_queue())
        return liked

    # --- воспроизведение -----------------------------------------------------
    def api_play(self, rid, ids: list, index: int = 0, context: str = ""):
        self.context = context
        rows = [self.db.track(i) for i in ids]
        rows = [r for r in rows if r]
        if rows:
            index = min(index, len(rows) - 1)
            if hasattr(self, "offline_filter"):
                rows, index = self.offline_filter(rows, index)
            self.player.play_list(rows, index)
        return True

    def api_toggle(self, rid):
        self.player.toggle()
        return True

    def api_next(self, rid):
        self.player.next()
        return True

    def api_prev(self, rid):
        self.player.prev()
        return True

    def api_seek(self, rid, ms: int):
        self.player.seek(int(ms))
        return True

    def api_volume(self, rid, v: int):
        self.player.set_volume(int(v))
        return True

    def api_like_current(self, rid):
        liked = self.player.like_current()
        self.after_like(self.player.current, liked)
        return liked

    def api_dislike_current(self, rid):
        self.player.dislike_current()
        return True

    def api_wave(self, rid, mode: str | None = None, query: str | None = None, from_id: int | None = None):
        if mode:
            settings().set("wave_mode", mode)
        if hasattr(self, "offline_wave") and self.offline_wave():
            return {"cold": False, "offline": True}
        mode = settings().get("wave_mode", "mix")
        wave = (self.ym_make_wave(mode, settings().get("wave_mood") or None) if hasattr(self, "ym_make_wave")
                else Wave(self.db, self.sc, mode, mood=settings().get("wave_mood") or None))
        if hasattr(self, "lastfm_candidates") and hasattr(wave, "extra_candidates"):
            wave.extra_candidates = self.lastfm_candidates
        from_track = self.db.track(from_id) if from_id else None

        def work():
            try:
                wave.start(from_track=from_track, query=query)
            except ColdStart:
                return {"cold": True}
            return {"cold": False}

        def done(r):
            if not r["cold"]:
                self.player.play_wave(wave)
            self._reply(rid, data=r)

        run_bg(work, done, lambda e: self._reply(rid, error=e))
        return _ASYNC

    def api_set_mode(self, rid, mode: str):
        settings().set("wave_mode", mode)
        return mode

    # --- импорт ------------------------------------------------------------
    def api_import_sc_profile(self, rid, url: str):
        settings().set("sc_profile_url", url)
        db, sc = self.db, self.sc
        return self._bg(rid, lambda progress: import_sc_profile(db, sc, url, progress), "sc")

    def api_import_sc_link(self, rid, url: str):
        db, sc = self.db, self.sc
        return self._bg(rid, lambda: import_sc_link(db, sc, url))

    def api_import_spotify_zip(self, rid):
        path, _ = QFileDialog.getOpenFileName(self.win, "Выгрузка Spotify", "", "Архив или JSON (*.zip *.json)")
        if not path:
            return None
        db = self.db
        return self._bg(rid, lambda progress: import_export(db, path, progress), "spotify")

    def api_import_spotify_link(self, rid, url: str):
        db = self.db
        return self._bg(rid, lambda: import_public_link(db, url))

    def api_match(self, rid, stop: bool = False):
        if stop:
            self._stop_match = True
            return {"stopping": True}
        if self._match_task is not None:
            return {"running": True}
        if self.db.stats()["pending"] == 0:
            return {"found": 0, "failed": 0, "total": 0}
        self._stop_match = False
        db, sc = self.db, self.sc

        def work(progress):
            return match_pending(db, sc, progress=progress,
                                 should_stop=lambda: self._stop_match or workers.SHUTDOWN)

        def done(r):
            self._match_task = None
            self._reply(rid, data=r)

        def fail(e):
            self._match_task = None
            self._reply(rid, error=e)

        self._match_task = run_bg(work, done, fail,
                                  lambda f, t: self.emit("progress", {"task": "match", "frac": f, "text": t}))
        return _ASYNC

    # --- главная -------------------------------------------------------------
    def api_home(self, rid):
        db = self.db
        h = time.localtime().tm_hour
        greet = ("Доброй ночи" if h < 5 else "Доброе утро" if h < 12 else "Добрый день" if h < 18
                 else "Добрый вечер" if h < 23 else "Доброй ночи")
        month = time.time() - 30 * 86400
        artists = db.top_artists(month, 12)
        if len(artists) < 4:
            artists = db.top_artists(0, 12)
        liked_n = db.one("SELECT count(*) AS n FROM tracks WHERE liked=1")["n"]
        pls = self.api_playlists(rid)
        return {
            "greet": greet,
            "empty": db.stats()["lib"] == 0,
            "liked": liked_n,
            "playlists": pls[:7],
            "recent": [slim(t) for t in db.recent_played(16)],
            "artists": [{"key": a["key"], "name": a["name"], "art": a["art"], "ms": a["ms"]} for a in artists],
            "forgotten": [slim(t) for t in db.forgotten(16)],
            "added": [slim(t) for t in db.recently_added(16)],
            "moods": [{"label": a, "query": b} for a, b in MOODS],
        }

    def api_mixes(self, rid, force: bool = False):
        feed = self.feed

        def work():
            return [{k: m[k] for k in ("key", "title", "sub", "arts")} | {"n": len(m["ids"])}
                    for m in feed.mixes(force)]
        return self._bg(rid, work)

    def api_mix(self, rid, key: str):
        db, feed = self.db, self.feed

        def work():
            for m in feed.mixes():
                if m["key"] == key:
                    return {"title": m["title"], "sub": m["sub"], "arts": m["arts"],
                            "rows": [slim(t) for t in (db.track(i) for i in m["ids"]) if t]}
            raise ValueError("Микс устарел — обнови главную")
        return self._bg(rid, work)

    # --- артист ----------------------------------------------------------------
    def api_artist(self, rid, key: str):
        rows = self.db.artist_tracks(key)
        name = rows[0]["artist"] if rows else key
        st = self.db.artist_listen(key)
        return {"key": key, "name": name, "art": self.db.artist_art(key), "avatar": self._avatars.get(key, ""),
                "listened_ms": st["ms"], "plays": st["plays"], "liked": st["liked"],
                "mine": [slim(t) for t in rows if t["in_library"]], "known": len(rows)}

    def api_artist_online(self, rid, key: str, name: str):
        """Популярное у артиста на SoundCloud, похожие артисты и аватар — из сети."""
        db, sc = self.db, self.sc

        def work():
            found = [t for t in sc.search_tracks(name, limit=50)
                     if t["playable"] and artist_key(t["artist"]) == key]
            found.sort(key=lambda t: -(t.get("playback_count") or 0))
            top = []
            for t in found[:10]:
                row = db.track_by_sc(t["sc_id"]) or db.track(db.upsert_sc_track(t))
                top.append(slim(row))
            avatar = self._avatars.get(key, "")
            if not avatar:
                try:
                    for u in sc.search_users(name, 5):
                        if norm(u.get("username") or "") == norm(name) or norm(u.get("full_name") or "") == norm(name):
                            avatar = (u.get("avatar_url") or "").replace("-large.", "-t500x500.")
                            break
                except Exception:  # noqa: BLE001
                    pass
                self._avatars[key] = avatar
            similar: dict[str, dict] = {}
            seeds = [t for t in found[:3]] or []
            for t in seeds:
                for c in self.feed._related(t["sc_id"]):
                    a = artist_key(c["artist"])
                    if a and a != key and a not in similar:
                        similar[a] = {"key": a, "name": c["artist"], "art": c["artwork_url"]}
            return {"top": top, "avatar": avatar, "similar": list(similar.values())[:10]}
        return self._bg(rid, work)

    # --- статистика ------------------------------------------------------------
    def api_stats_page(self, rid, period: str = "month"):
        since = {"week": time.time() - 7 * 86400, "month": time.time() - 30 * 86400}.get(period, 0)
        db = self.db
        tops = db.top_tracks(since, 10)
        return {
            "totals": db.listen_totals(since),
            "artists": db.top_artists(since, 10),
            "tracks": [slim(t) | {"ms": t["listened_ms"], "plays": t["plays"]} for t in tops],
            "hours": db.by_hour(since),
            "genres": db.top_genres(since, 10),
        }

    # --- свои плейлисты ---------------------------------------------------------
    def api_playlist_create(self, rid, name: str, add: int | None = None):
        pid = self.db.create_playlist(name)
        if add:
            self.db.add_to_playlist(pid, add)
        return pid

    def api_playlist_rename(self, rid, pid: int, name: str):
        self.db.rename_playlist(pid, name)
        return True

    def api_playlist_delete(self, rid, pid: int):
        self.db.delete_playlist(pid)
        return True

    def api_playlist_add(self, rid, pid: int, id: int):
        return self.db.add_to_playlist(pid, id)

    def api_playlist_remove(self, rid, pid: int, id: int):
        self.db.remove_from_playlist(pid, id)
        return True

    def api_playlist_reorder(self, rid, pid: int, ids: list):
        self.db.reorder_playlist(pid, [int(i) for i in ids])
        return True

    def api_playlist_info(self, rid, pid: int):
        p = self.db.playlist(pid)
        if not p:
            raise ValueError("Плейлист не найден")
        arts = [r["artwork_url"] for r in self.db.query(
            "SELECT t.artwork_url FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id"
            " WHERE pt.playlist_id=? AND t.artwork_url!='' ORDER BY pt.position LIMIT 4", (pid,))]
        return {"id": p["id"], "name": p["name"], "source": p["source"], "n": p["n"], "arts": arts}

    # --- очередь ---------------------------------------------------------------
    def api_play_next(self, rid, id: int):
        if hasattr(self, "party_intercept") and self.party_intercept("next", tid=int(id)):
            return True
        t = self.db.track(id)
        if t:
            self.player.play_next(t)
        return True

    def api_enqueue(self, rid, id: int):
        if hasattr(self, "party_intercept") and self.party_intercept("enqueue", tid=int(id)):
            return True
        t = self.db.track(id)
        if t:
            self.player.enqueue(t)
        return True

    def api_queue_remove(self, rid, kind: str, i: int):
        if kind == "user" and hasattr(self, "party_intercept") and self.party_intercept("remove", i=int(i)):
            return True
        self.player.queue_remove(kind, int(i))
        return True

    def api_queue_move(self, rid, kind: str, src: int, dst: int):
        if kind == "user" and hasattr(self, "party_intercept") and self.party_intercept("move"):
            return True
        self.player.queue_move(kind, int(src), int(dst))
        return True

    def api_queue_jump(self, rid, kind: str, i: int):
        self.player.queue_jump(kind, int(i))
        return True

    def api_queue(self, rid):
        self._on_queue()
        return True

    # --- тексты песен -----------------------------------------------------------
    def api_lyrics(self, rid, id: int):
        db = self.db
        t = db.track(id)
        if not t:
            return {"found": False, "synced": [], "plain": ""}
        cached = db.get_lyrics(t["id"])
        if cached is not None:
            return cached

        def work():
            data = lyrics_mod.fetch(t["title"], t["artist"], t.get("duration_ms") or 0)
            db.put_lyrics(t["id"], data)
            return data
        return self._bg(rid, work)

    # --- итоги ----------------------------------------------------------------
    def api_recap(self, rid, period: str = "month"):
        now = time.time()
        since = now - (365 if period == "year" else 30) * 86400
        r = self.db.recap(since)
        r["artists"] = [{"key": a["key"], "name": a["name"], "art": art_hi(a["art"]), "ms": a["ms"], "plays": a["plays"]}
                        for a in r["artists"]]
        r["tracks"] = [slim(t) | {"ms": t["listened_ms"], "plays": t["plays"], "artHi": art_hi(t.get("artwork_url") or "")}
                       for t in r["tracks"]]
        r["period"] = period
        return r

    # --- таймер сна ------------------------------------------------------------
    def api_sleep(self, rid, minutes: float | None = None, track: bool = False, cancel: bool = False):
        self._sleep_reset()
        if not cancel:
            if track and self.player.current:
                self._sleep_track = True
                self.player.set_stop_after(True)
            elif minutes:
                self._sleep_end = time.time() + float(minutes) * 60
                self._sleep_timer.start(int(float(minutes) * 60 * 1000))
        state = self._sleep_state()
        self.emit("sleep", state)
        return state

    def _sleep_reset(self) -> None:
        """Выключить таймер и вернуть сохранённую громкость, если шло затухание."""
        self._sleep_timer.stop()
        self._sleep_end = 0.0
        if self._sleep_track:
            self.player.set_stop_after(False)
        self._sleep_track = False
        if self._fade:
            self._fade.stop()
            self._fade = None
            self.player.audio_volume_preview(settings().get("volume", 70))

    def _sleep_state(self) -> dict:
        if self._sleep_track:
            return {"on": True, "track": True}
        if self._sleep_end:
            return {"on": True, "end": self._sleep_end * 1000}
        return {"on": False}

    def _sleep_stopped_after(self) -> None:
        self._sleep_track = False
        self.emit("sleep", {"on": False, "done": True})

    def _sleep_fire(self) -> None:
        """Плавно приглушаем ~15 с, ставим паузу и возвращаем громкость (в настройках она не меняется)."""
        steps = 30
        state = {"i": 0}
        self._fade = QTimer(self, interval=500)

        def tick():
            state["i"] += 1
            vol = settings().get("volume", 70)   # если пользователь крутил громкость — берём новую
            if state["i"] >= steps:
                if self._fade:
                    self._fade.stop()
                self._fade = None
                self.player.sleep_pause()
                self.player.audio_volume_preview(vol)
                self._sleep_end = 0.0
                self.emit("sleep", {"on": False, "done": True})
                return
            self.player.audio_volume_preview(vol * (1 - state["i"] / steps))

        self._fade.timeout.connect(tick)
        self._fade.start()

    # --- настройки ---------------------------------------------------------------
    def api_settings_get(self, rid):
        out = {k: settings().get(k, SETTING_DEFAULTS[k]) for k in SETTING_KEYS}
        out["engine"] = getattr(self.player, "engine_name", "qt")
        out["discord_status"] = self.win.discord.status if hasattr(self.win, "discord") else ""
        out["mini_on"] = bool(hasattr(self.win, "mini") and self.win.mini.isVisible())
        media = getattr(self.win, "media", None)
        hot = getattr(self.win, "hotkeys", None)
        out["media"] = "smtc" if media and media.ok else "hotkeys" if hot and hot.ok else ""
        out["sleep"] = self._sleep_state()
        return out

    def api_settings_set(self, rid, key: str, value):
        if key not in SETTING_KEYS:
            raise ValueError("Неизвестная настройка")
        typ = SETTING_KEYS[key]
        if typ is dict:
            value = dict(value or {})
        elif typ is list:
            value = [max(-12.0, min(12.0, float(x))) for x in value][:10]
        elif typ is float:
            value = max(0.0, min(12.0, float(value)))
        else:
            value = typ(value)
        settings().set(key, value)
        if key in ("crossfade", "normalize", "eq", "eq_on") and hasattr(self.player, "apply_audio_settings"):
            self.player.apply_audio_settings()
        if key.startswith("discord") and hasattr(self.win, "discord"):
            self.win.discord.update(self.player.current, True, self.player.mp.position())
        return value

    def api_mini(self, rid):
        return self.win.toggle_mini() if hasattr(self.win, "toggle_mini") else False

    def api_cache_info(self, rid):
        files = [p for p in cache_dir().iterdir() if p.is_file()]
        return {"mb": round(sum(p.stat().st_size for p in files) / 1048576, 1), "files": len(files)}

    def api_cache_clear(self, rid):
        n = 0
        cur = (self.player.current or {}).get("sc_id")
        for p in cache_dir().iterdir():
            ymid = (self.player.current or {}).get("ym_id")
            if p.is_file() and p.suffix != ".json" and not (cur and p.name.startswith(f"{cur}.")) \
                    and not (ymid and p.name.startswith(f"ym_{ymid}.")):
                try:
                    p.unlink()
                    n += 1
                except OSError:
                    pass
        return n

    def api_ping(self, rid):
        return time.time()


_ASYNC = object()
