"""Мост: методы Яндекс Музыки для веб-интерфейса (миксин к Bridge).

Bridge наследует YandexAPI и в конце __init__ вызывает self._init_yandex().
make_wave() вызывается из bridge.api_wave; лайки приходят через Bridge.after_like → ym_like_hook().
"""
from __future__ import annotations

from ..config import settings
from ..recommender import Wave
from .workers import run_bg

try:
    from .. import yandex as Y
except Exception as _e:  # noqa: BLE001 — без модуля Яндекса всё остальное работает
    print("yandex module unavailable:", _e)
    Y = None


def _lib_ok() -> bool:
    """Библиотека установлена? Без импорта: он занимает ~0.3 с, а мы в GUI-потоке."""
    if Y is None:
        return False
    try:
        import importlib.util  # noqa: PLC0415
        return importlib.util.find_spec("yandex_music") is not None
    except (ImportError, ValueError):
        return False


def _async():
    from .bridge import _ASYNC  # noqa: PLC0415 — bridge к этому моменту уже загружен
    return _ASYNC


def _slim(t):
    from .bridge import slim  # noqa: PLC0415
    return slim(t)


def make_wave(bridge, mode: str, mood: str | None):
    """Волна для api_wave: «Моя волна» Яндекса, если выбрана и есть вход, иначе своя."""
    ym = getattr(bridge, "ym", None)
    if Y is not None and ym is not None and Y.wave_source() == "yandex" and ym.logged_in:
        return Y.YandexWave(bridge.db, ym, mode, mood)
    return Wave(bridge.db, bridge.sc, mode, mood=mood)


def ym_like(bridge, track: dict | None, liked: bool) -> None:
    """Лайк в приложении → лайк в Яндексе (в фоне, ошибки только в лог)."""
    ym = getattr(bridge, "ym", None)
    if not track or ym is None or not ym.logged_in:
        return
    ym_id = track.get("ym_id")
    if not ym_id and track.get("id") is not None:
        row = bridge.db.track(track["id"])
        ym_id = row and row.get("ym_id")
    if not ym_id:
        return

    def fail(msg):
        print("ym like:", msg)
        if "войди" in msg or "Вход" in msg:
            bridge.emit("ym", {"logged": False})
    run_bg(lambda: ym.like(ym_id, bool(liked)), None, fail)


class YandexAPI:
    """Миксин с api_ym_*; self — Bridge (db, sc, player, win, emit, _bg, _reply)."""

    def _init_yandex(self) -> None:
        self.ym = Y.ym() if Y is not None else None
        if self.ym is not None and getattr(self.player, "ym", None) is None:
            self.player.ym = self.ym
        self._ym_dialog = None

    # --- состояние -------------------------------------------------------------
    def _ym_flags(self) -> dict:
        return {"available": _lib_ok(), "prefer": Y.prefer_yandex() if Y else True,
                "waveSource": Y.wave_source() if Y else "volna"}

    def _ym_require(self):
        if self.ym is None or not _lib_ok():
            raise ValueError("Не установлена библиотека yandex-music — запусти run.bat ещё раз")
        return self.ym

    def api_ym_status(self, rid):
        flags = self._ym_flags()
        ym = self.ym
        if ym is None or not ym.logged_in or not flags["available"]:
            return {**flags, "logged": False}

        def work():
            try:
                return {**flags, **ym.account()}
            except Y.YandexAuthError as e:
                return {**flags, "logged": False, "error": str(e)}
            except Y.YandexError as e:   # нет сети — вход сохранён, просто без данных аккаунта
                return {**flags, "logged": True, "name": "Яндекс", "offline": True, "error": str(e)}
        return self._bg(rid, work)

    # --- вход ----------------------------------------------------------------------
    def api_ym_login(self, rid):
        """Окно входа (GUI-поток). Ответ придёт после закрытия окна: данные аккаунта или None."""
        ym = self._ym_require()
        from .yandex_login import YandexLoginDialog  # noqa: PLC0415 — WebEngine грузим только тут
        if self._ym_dialog is not None:
            self._ym_dialog.raise_()
            self._ym_dialog.activateWindow()
            raise ValueError("Окно входа уже открыто")
        dlg = YandexLoginDialog(self.win)
        self._ym_dialog = dlg

        def finished(_code):
            self._ym_dialog = None
            token = dlg.token
            dlg.deleteLater()
            if not token:
                self._reply(rid, data=None)
                return

            def done(info):
                self._reply(rid, data=info)
                self.emit("ym", info)
            run_bg(lambda: ym.login(token), done, lambda e: self._reply(rid, error=e))

        dlg.finished.connect(finished)
        dlg.open()
        return _async()

    def api_ym_token(self, rid, token: str):
        ym = self._ym_require()

        def work():
            info = ym.login(token)
            return info
        return self._bg(rid, work)

    def api_ym_logout(self, rid):
        if self.ym is not None:
            self.ym.logout()
        if Y is not None and isinstance(self.player.wave, Y.YandexWave):
            self.player.stop_wave()
        self.emit("ym", {"logged": False})
        return {**self._ym_flags(), "logged": False}

    # --- импорт и поиск -------------------------------------------------------------
    def api_ym_import(self, rid):
        ym, db = self._ym_require(), self.db
        if not ym.logged_in:
            raise ValueError(Y.NOT_LOGGED_MSG)
        return self._bg(rid, lambda progress: ym.import_all(db, progress), "ym")

    def api_ym_search(self, rid, q: str, limit: int = 30):
        ym, db = self._ym_require(), self.db
        if not ym.logged_in:
            raise ValueError(Y.NOT_LOGGED_MSG)

        def work():
            rows = []
            for p in ym.search(q, limit=limit):
                rows.append(_slim(db.track(db.upsert_ym_track(p))))
            return {"rows": rows}
        return self._bg(rid, work)

    # --- настройки ------------------------------------------------------------------
    def api_ym_set(self, rid, key: str, value):
        if key == "ym_prefer":
            value = bool(value)
            self.player._prefetched.clear()   # следующий трек мог быть заготовлен из другого источника
        elif key == "wave_source":
            value = "yandex" if value == "yandex" else "volna"
            if value == "yandex" and (self.ym is None or not self.ym.logged_in):
                raise ValueError("Чтобы включить волну Яндекса, сначала войди в Яндекс Музыку")
        else:
            raise ValueError("Неизвестная настройка")
        settings().set(key, value)
        return value

    def api_ym_wave_source(self, rid, source: str | None = None):
        """Прочитать (без аргумента) или переключить источник «Моей волны»."""
        if source is not None:
            return self.api_ym_set(rid, "wave_source", source)
        return Y.wave_source() if Y else "volna"

    # --- то же самое для bridge.py как методы (если удобнее, чем функции модуля) -------
    def ym_make_wave(self, mode: str, mood: str | None):
        return make_wave(self, mode, mood)

    def ym_like_hook(self, track: dict | None, liked: bool) -> None:
        """Bridge.after_like вызывает это сам — лайки из списка, плеера, мини-плеера и медиаклавиш."""
        ym_like(self, track, liked)
