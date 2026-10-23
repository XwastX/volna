"""Расширение моста: Last.fm, умные плейлисты, обмен плейлистами, обновления."""
from __future__ import annotations

import random
import threading
import time
from pathlib import Path

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtGui import QDesktopServices, QGuiApplication
from PySide6.QtWidgets import QApplication, QFileDialog

from .. import share, smart, updater
from ..config import settings
from ..db import artist_key
from ..lastfm import LastFM
from .workers import run_bg

MIN_SCROBBLE_MS = 30_000


def _bg_thread(fn, *args) -> None:
    threading.Thread(target=fn, args=args, daemon=True).start()


class ExtraAPI:
    # ------------------------------------------------------------------
    def _init_extra(self) -> None:
        self.lastfm = LastFM()
        smart.ensure(self.db)
        self._scr = None          # {"track", "start", "played", "last_pos"}
        p = self.player
        p.track_changed.connect(self._scr_track)
        p.position_changed.connect(self._scr_pos)
        if self.lastfm.scrobbling():
            _bg_thread(self.lastfm.flush)   # отправить то, что не ушло в прошлый раз
        if settings().get("update_auto", True) and updater.is_installed():
            QTimer.singleShot(8000, self._update_auto)

    # --- Last.fm: учёт прослушивания ---------------------------------------
    def _scr_finish(self) -> None:
        s = self._scr
        self._scr = None
        if not s:
            return
        dur = s["track"].get("duration_ms") or 0
        need = min(dur / 2, 240_000) if dur else 240_000
        if dur >= MIN_SCROBBLE_MS and s["played"] >= need:
            _bg_thread(self.lastfm.scrobble, dict(s["track"]), s["start"])

    def _scr_track(self, t) -> None:
        if t and self._scr and self._scr["track"].get("id") == t.get("id"):
            self._scr["track"].update(t)     # тот же трек догрузился — не новое прослушивание
            return
        self._scr_finish()
        if t:
            self._scr = {"track": dict(t), "start": time.time(), "played": 0, "last_pos": 0}
            if self.lastfm.scrobbling():
                _bg_thread(self.lastfm.now_playing, dict(t))

    def _scr_pos(self, pos: int, _dur: int) -> None:
        s = self._scr
        if not s:
            return
        delta = pos - s["last_pos"]
        if 0 < delta < 3000:          # перемотка вперёд не засчитывается
            s["played"] += delta
        s["last_pos"] = pos

    def lastfm_candidates(self, seeds: list[int]) -> list:
        """Для волны: треки похожих артистов (Last.fm) — расширяют подбор за пределы /related SoundCloud."""
        if not self.lastfm.key or not seeds or random.random() < 0.4:
            return []
        row = self.db.track_by_sc(random.choice(seeds))
        if not row:
            return []
        names = self.lastfm.similar_artists(row["artist"])[:8]
        out = []
        for name in random.sample(names, min(2, len(names))):
            try:
                found = [t for t in self.sc.search_tracks(name, limit=12)
                         if t["playable"] and artist_key(t["artist"]) == artist_key(name)][:5]
            except Exception:  # noqa: BLE001
                continue
            if found:
                out.append((row["sc_id"], found))
        return out

    # --- Last.fm: API ------------------------------------------------------
    def api_lfm_status(self, rid):
        lf = self.lastfm
        info = {"configured": lf.configured(), "logged": lf.logged_in(), "user": lf.user,
                "scrobble": bool(settings().get("lastfm_scrobble", True)), "pending": lf.pending(),
                "key": lf.key[:6] + "…" if lf.key else ""}
        if not lf.logged_in():
            return info

        def work():
            return info | {"profile": lf.user_info()}
        return self._bg(rid, work)

    def api_lfm_set(self, rid, key: str, secret: str):
        key, secret = key.strip(), secret.strip()
        if len(key) != 32 or len(secret) != 32:
            raise ValueError("Ключ и секрет Last.fm — это строки из 32 символов. Скопируй их со страницы своего API-аккаунта")
        settings().set("lastfm_key", key)
        settings().set("lastfm_secret", secret)
        self.lastfm.logout()
        return True

    def api_lfm_login(self, rid):
        lf = self.lastfm

        def work():
            return lf.begin_auth()

        def done(url):
            QDesktopServices.openUrl(QUrl(url))
            self._reply(rid, data={"url": url})
        run_bg(work, done, lambda e: self._reply(rid, error=e))
        from .bridge import _ASYNC  # noqa: PLC0415 — избегаем циклического импорта
        return _ASYNC

    def api_lfm_finish(self, rid):
        lf = self.lastfm
        return self._bg(rid, lambda: {"user": lf.finish_auth()})

    def api_lfm_logout(self, rid):
        self.lastfm.logout()
        return True

    def lastfm_love(self, t: dict, loved: bool) -> None:
        if self.lastfm.logged_in() and settings().get("lastfm_love", True):
            _bg_thread(self.lastfm.love, dict(t), loved)

    # --- умные плейлисты ---------------------------------------------------
    def api_smart_schema(self, rid):
        return smart.schema()

    def api_smart_list(self, rid):
        db = self.db
        return self._bg(rid, lambda: smart.list_all(db))   # на большой медиатеке считается заметное время

    def api_smart_get(self, rid, sid: int):
        from .bridge import slim  # noqa: PLC0415
        sp = smart.get(self.db, int(sid))
        if not sp:
            raise ValueError("Умный плейлист не найден")
        rows = smart.query(self.db, sp["rules"])
        return sp | {"rows": [slim(t) for t in rows],
                     "arts": [t["artwork_url"] for t in rows if t.get("artwork_url")][:4]}

    def api_smart_preview(self, rid, rules: dict):
        rows = smart.query(self.db, rules)
        return {"n": len(rows), "arts": [t["artwork_url"] for t in rows if t.get("artwork_url")][:4],
                "sample": [f"{t['artist']} — {t['title']}" for t in rows[:5]]}

    def api_smart_save(self, rid, name: str, rules: dict, sid: int | None = None):
        name = (name or "").strip() or "Умный плейлист"
        return smart.save(self.db, name[:100], rules, int(sid) if sid else None)

    def api_smart_delete(self, rid, sid: int):
        smart.delete(self.db, int(sid))
        return True

    # --- обмен с друзьями ---------------------------------------------------
    def _share_tracks(self, kind: str, key) -> tuple[str, list[dict]]:
        db = self.db
        if kind == "liked":
            return "Любимые треки", db.library(liked_only=True)
        if kind == "smart":
            sp = smart.get(db, int(key))
            return (sp["name"], smart.query(db, sp["rules"])) if sp else ("", [])
        p = db.playlist(int(key))
        return (p["name"], db.playlist_tracks(int(key))) if p else ("", [])

    def api_share_code(self, rid, kind: str = "playlist", key=None):
        name, rows = self._share_tracks(kind, key)
        if not rows:
            raise ValueError("Делиться нечем — плейлист пустой")
        code = share.pack(self.db, name, rows)
        QGuiApplication.clipboard().setText(code)
        return {"code": code, "tracks": len(rows), "name": name, "chars": len(code)}

    def api_share_file(self, rid, kind: str = "playlist", key=None):
        name, rows = self._share_tracks(kind, key)
        if not rows:
            raise ValueError("Делиться нечем — плейлист пустой")
        safe = "".join(c for c in name if c not in '\\/:*?"<>|')[:60] or "playlist"
        path, _ = QFileDialog.getSaveFileName(self.win, "Сохранить плейлист", f"{safe}.volna", "Плейлист Volna (*.volna)")
        if not path:
            return None
        Path(path).write_text(share.pack(self.db, name, rows), encoding="utf-8")
        return {"path": path, "tracks": len(rows)}

    def api_share_import(self, rid, code: str | None = None):
        if not code:
            path, _ = QFileDialog.getOpenFileName(self.win, "Открыть плейлист", "", "Плейлист Volna (*.volna);;Все файлы (*)")
            if not path:
                return None
            code = Path(path).read_text(encoding="utf-8", errors="ignore")
        db = self.db
        return self._bg(rid, lambda: share.import_code(db, code))   # тысячи треков — не в GUI-потоке

    def scrobble_on_quit(self) -> None:
        """При выходе засчитываем текущий трек, если его уже достаточно послушали."""
        try:
            self._scr_finish()
        except Exception:  # noqa: BLE001
            pass

    def api_clipboard(self, rid):
        return QGuiApplication.clipboard().text()[:200_000]

    # --- обновления ---------------------------------------------------------
    def api_update_check(self, rid):
        return self._bg(rid, updater.check)

    def api_update_install(self, rid, url: str = ""):
        if not updater.is_installed():
            raise ValueError("Ты запускаешь Volna из исходников (run.bat) — обнови файлы проекта, установщик не нужен")

        def work(progress):
            updater.download_and_run(progress)
            return True

        def done(_):
            self._reply(rid, data=True)
            QTimer.singleShot(800, lambda: (self.win.quit_app() if hasattr(self.win, "quit_app")
                                            else QApplication.instance().quit()))
        run_bg(work, done, lambda e: self._reply(rid, error=e),
               lambda f, t: self.emit("progress", {"task": "update", "frac": f, "text": t}))
        from .bridge import _ASYNC  # noqa: PLC0415
        return _ASYNC

    def _update_auto(self) -> None:
        def ok(info):
            if info.get("available"):
                self.emit("update", info)
        run_bg(updater.check, ok, lambda _e: None)
