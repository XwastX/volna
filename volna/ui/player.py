"""Плеер: очередь (список или волна), загрузка потока, учёт прослушиваний.

Звук — собственный движок volna.audio (кроссфейд, gapless, нормализация, EQ, спектр).
Если он недоступен (нет PyAV/sounddevice/numpy/scipy или не открылось устройство),
плеер прозрачно работает на QMediaPlayer, как раньше.
"""
from __future__ import annotations

import os

from PySide6.QtCore import QObject, QUrl, Signal
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

from .. import offline
from ..config import settings
from ..db import Database
from ..matcher import find_on_soundcloud
from ..recommender import Wave
from ..soundcloud import SoundCloud
from .workers import run_bg

try:
    from .. import audio as _audio
except Exception as _e:  # noqa: BLE001 — без движка играем через Qt
    print("audio engine import failed:", _e)
    _audio = None

COMPLETE_RATIO = 0.85


def _default_ym():
    """Клиент Яндекс Музыки, если модуль доступен (без yandex-music плеер работает как раньше)."""
    try:
        from .. import yandex  # noqa: PLC0415
        return yandex.ym()
    except Exception as e:  # noqa: BLE001
        print("yandex unavailable:", e)
        return None


class Player(QObject):
    track_changed = Signal(object)      # dict трека или None
    playing_changed = Signal(bool)
    position_changed = Signal(int, int)  # pos, duration (мс)
    loading = Signal(bool, float)       # идёт загрузка, доля
    error = Signal(str)
    queue_changed = Signal()
    stopped_after = Signal()            # «пауза после этого трека» сработала
    spectrum = Signal(list)             # 48 полос 0..1, ~30 раз в секунду (только движок volna)

    def __init__(self, db: Database, client: SoundCloud, parent=None):
        super().__init__(parent)
        self.db, self.sc = db, client
        self.audio = None             # QAudioOutput — только в режиме Qt
        self.mp = None                # AudioEngine или QMediaPlayer (одинаковый интерфейс)
        self.engine_name = "qt"
        self.stop_after_current = False   # таймер сна «в конце трека»
        self._hold = False                # таймер сна поставил паузу — не запускать догрузившийся трек
        if _audio is not None and os.environ.get("VOLNA_AUDIO", "").lower() != "qt" \
                and settings().get("audio_engine", "volna") != "qt":
            try:
                self.mp = _audio.AudioEngine(self)
                self.engine_name = "volna"
            except Exception as e:  # noqa: BLE001 — нет устройства/зависимостей → Qt
                print("audio engine unavailable, using QMediaPlayer:", e)
                self.mp = None
        if self.mp is None:
            self._make_qt_player()
        self._wire()
        self._apply_volume(settings().get("volume", 70))
        self.apply_audio_settings()

        self._prep: dict | None = None     # следующий трек, отданный движку для перехода
        self._prep_req = 0
        self._wave_carry: dict | None = None  # трек, уже взятый из волны заранее
        self._cur_path: str | None = None

        self.user_queue: list[dict] = []  # «играть следующим» / «добавить в очередь» — важнее всего
        self.items: list[dict] = []   # обычная очередь
        self.index = -1
        self.wave: Wave | None = None
        self.wave_history: list[dict] = []
        self.current: dict | None = None
        self._req = 0                 # номер запроса, чтобы игнорировать устаревшие загрузки
        self._fail_streak = 0
        self._prefetched: set = set()
        self.ym = _default_ym()       # Яндекс Музыка (None — только SoundCloud)
        self.offline_only = bool(settings().get("offline_mode", False))

    # --- звук -----------------------------------------------------------
    def _make_qt_player(self) -> None:
        self.audio = QAudioOutput(self)
        self.mp = QMediaPlayer(self)
        self.mp.setAudioOutput(self.audio)
        self.engine_name = "qt"

    def _wire(self) -> None:
        mp = self.mp
        mp.positionChanged.connect(lambda p: self.position_changed.emit(p, self._duration()))
        mp.playbackStateChanged.connect(
            lambda s: self.playing_changed.emit(s == QMediaPlayer.PlaybackState.PlayingState))
        mp.mediaStatusChanged.connect(self._on_status)
        mp.errorOccurred.connect(lambda _e, msg: self._fail(f"Ошибка воспроизведения: {msg}"))
        if self.engine_name == "volna":
            mp.spectrum.connect(self.spectrum)
            mp.aboutToFinish.connect(self._on_about_to_finish)
            mp.trackSwitched.connect(self._on_switched)
            mp.fatal.connect(self._fallback_to_qt)

    def _apply_volume(self, v) -> None:
        try:
            v = max(0, min(100, int(v)))
        except (TypeError, ValueError):
            v = 70
        if self.engine_name == "volna":
            self.mp.setVolume(v / 100)
        elif self.audio is not None:
            self.audio.setVolume(v / 100)

    def apply_audio_settings(self) -> None:
        """Перечитать настройки звука (crossfade, normalize, eq, eq_on) и отдать движку."""
        if self.engine_name != "volna":
            return
        st = settings()
        try:
            self.mp.set_crossfade(float(st.get("crossfade", 4.0)))
            self.mp.set_normalize(bool(st.get("normalize", True)))
            eq = st.get("eq", [0.0] * 10)
            self.mp.set_eq(eq if isinstance(eq, (list, tuple)) else [0.0] * 10, bool(st.get("eq_on", False)))
        except Exception as e:  # noqa: BLE001 — кривые настройки не должны ломать плеер
            print("apply_audio_settings:", e)

    def _fallback_to_qt(self, why: str = "") -> None:
        """Движок потерял устройство насовсем — переезжаем на QMediaPlayer с той же позиции."""
        if self.engine_name != "volna":
            return
        print("audio engine failed, switching to QMediaPlayer:", why)
        old = self.mp
        pos = old.position()
        was_playing = old.playbackState() == QMediaPlayer.PlaybackState.PlayingState
        for sig in (old.positionChanged, old.playbackStateChanged, old.mediaStatusChanged,
                    old.errorOccurred, old.spectrum, old.aboutToFinish, old.trackSwitched, old.fatal):
            try:
                sig.disconnect()
            except (RuntimeError, TypeError):
                pass
        try:
            old.close()
        except Exception:  # noqa: BLE001
            pass
        old.deleteLater()
        self._prep = None
        self._make_qt_player()
        self._wire()
        self._apply_volume(settings().get("volume", 70))
        if self.current and self._cur_path:
            self.mp.setSource(QUrl.fromLocalFile(self._cur_path))
            if pos > 0:
                self.mp.setPosition(pos)
            if was_playing:
                self.mp.play()

    def _set_source(self, path, track: dict | None) -> None:
        self._cur_path = str(path)
        url = QUrl.fromLocalFile(str(path))
        if self.engine_name == "volna":
            self.mp.setSource(url, duration_hint_ms=(track or {}).get("duration_ms") or None)
        else:
            self.mp.setSource(url)

    # ------------------------------------------------------------------
    @property
    def in_wave(self) -> bool:
        return self.wave is not None

    def _duration(self) -> int:
        d = self.mp.duration()
        if d <= 0 and self.current:
            d = self.current.get("duration_ms") or 0
        return d

    def play_list(self, tracks: list[dict], start: int = 0) -> None:
        self._hold = False
        self._fail_streak = 0
        self._finish_current(manual=True)
        self._unprepare()
        self._wave_carry = None
        self.wave = None
        self.items = list(tracks)
        self.index = max(0, min(start, len(self.items) - 1))
        self.queue_changed.emit()
        self._prefetched.clear()
        if self.items:
            self._load(self.items[self.index])

    def play_wave(self, wave: Wave) -> None:
        self._hold = False
        """Волна уже запущена (wave.start вызван в фоне)."""
        self._fail_streak = 0
        self._finish_current(manual=True)
        self._unprepare()
        self._wave_carry = None
        self.wave = wave
        self.items, self.index = [], -1
        self.wave_history = []
        self._next_from_wave()

    def stop_wave(self) -> None:
        self._unprepare()
        self._wave_carry = None
        self.wave = None
        self.queue_changed.emit()

    # --- таймер сна ---------------------------------------------------------
    def set_stop_after(self, on: bool) -> None:
        self.stop_after_current = on
        if on:
            self._unprepare()   # не готовим переход на следующий трек

    def sleep_pause(self) -> None:
        """Пауза от таймера сна: и текущий трек, и тот, что ещё догружается, не заиграют."""
        self._hold = True
        self.mp.pause()

    def audio_volume_preview(self, v: float) -> None:
        """Громкость без сохранения в настройки (плавное затухание таймера сна)."""
        self._apply_volume(max(0, min(100, int(round(v)))))

    def toggle(self) -> None:
        self._hold = False
        if self.mp.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self.mp.pause()
        elif self.current:
            self.mp.play()

    def next(self) -> None:
        self._hold = False
        self._fail_streak = 0
        self._finish_current(manual=True)
        self._unprepare()
        self._advance()

    def prev(self) -> None:
        self._hold = False
        if self.mp.position() > 4000:
            self.mp.setPosition(0)
            return
        self._unprepare()
        if self.wave:
            if len(self.wave_history) >= 2:
                self._finish_current(manual=True)
                self.wave_history.pop()
                self._load(self.wave_history[-1])
            return
        if self.index > 0:
            self._finish_current(manual=True)
            self.index -= 1
            self._load(self.items[self.index])

    def seek(self, ms: int) -> None:
        self.mp.setPosition(ms)

    def set_volume(self, v: int) -> None:
        self._apply_volume(v)
        settings().set("volume", v)

    def upcoming(self, n: int = 6) -> list[dict]:
        rest = self.wave.peek(n) if self.wave else self.items[self.index + 1:self.index + 1 + n]
        return (self.user_queue + rest)[:n]

    # --- очередь ----------------------------------------------------------
    def queue_state(self, n: int = 60) -> dict:
        return {
            "user": list(self.user_queue),
            "next": self.wave.peek(20) if self.wave else self.items[self.index + 1:self.index + 1 + n],
            "wave": self.in_wave,
        }

    def play_next(self, track: dict) -> None:
        self._unprepare()
        self.user_queue.insert(0, track)
        self.queue_changed.emit()
        if not self.current:
            self._advance()

    def enqueue(self, track: dict) -> None:
        if not self.user_queue:
            self._unprepare()     # новый трек станет следующим — переподготовим
        self.user_queue.append(track)
        self.queue_changed.emit()
        if not self.current:
            self._advance()

    def queue_remove(self, kind: str, i: int) -> None:
        self._unprepare()
        if kind == "user" and 0 <= i < len(self.user_queue):
            self.user_queue.pop(i)
        elif kind == "next":
            if self.wave:
                self.wave.remove_at(i)
            elif 0 <= self.index + 1 + i < len(self.items):
                self.items.pop(self.index + 1 + i)
        self.queue_changed.emit()

    def queue_move(self, kind: str, src: int, dst: int) -> None:
        if kind == "user":
            lst, off = self.user_queue, 0
        elif kind == "next" and not self.wave:
            lst, off = self.items, self.index + 1
        else:
            return
        a, b = off + src, off + dst
        if 0 <= a < len(lst) and 0 <= b < len(lst):
            self._unprepare()
            lst.insert(b, lst.pop(a))
            self.queue_changed.emit()

    def queue_jump(self, kind: str, i: int) -> None:
        self._hold = False
        """Сыграть трек из очереди сразу (всё, что было до него, пропускается)."""
        self._finish_current(manual=True)
        self._unprepare()
        if kind == "user" and 0 <= i < len(self.user_queue):
            t = self.user_queue.pop(i)
            self.queue_changed.emit()
            self._load(t)
        elif kind == "next" and not self.wave and 0 <= self.index + 1 + i < len(self.items):
            self.index += 1 + i
            self.queue_changed.emit()
            self._load(self.items[self.index])
        elif kind == "next" and self.wave:
            self._wave_carry = None   # заранее взятый трек тоже пропускается
            for _ in range(i):
                self.wave.remove_at(0)
            self._next_from_wave()

    # --- реакции --------------------------------------------------------
    def like_current(self) -> bool:
        t = self.current
        if not t:
            return False
        row = self.db.track(t["id"]) or t
        new = not row["liked"]
        self.db.set_like(t["id"], new)
        t["liked"] = int(new)
        if new and self.wave:
            w = self.wave
            run_bg(lambda: w.on_like(t), lambda _: self.queue_changed.emit())
        return new

    def dislike_current(self) -> None:
        t = self.current
        if not t:
            return
        self.db.set_dislike(t["id"], True)
        t["_logged"] = True  # дизлайк уже записан, скип не нужен
        self._unprepare()
        if self.wave:
            w = self.wave
            self.mp.pause()
            # сначала волна выкидывает похожее из очереди, потом берём следующий
            run_bg(lambda: w.on_dislike(t), lambda _: self.next(), lambda _: self.next())
        else:
            self.next()

    # ------------------------------------------------------------------
    def _advance(self) -> None:
        if self.user_queue:
            t = self.user_queue.pop(0)
            self.queue_changed.emit()
            self._load(t)
        elif self.wave:
            self._next_from_wave()
        elif self.index + 1 < len(self.items):
            self.index += 1
            self._load(self.items[self.index])
        else:
            self.mp.stop()
            self.current = None
            self.track_changed.emit(None)

    def _next_from_wave(self) -> None:
        w = self.wave
        self._req += 1
        req = self._req
        if self._wave_carry is not None:
            t, self._wave_carry = self._wave_carry, None
            self.wave_history.append(t)
            self.queue_changed.emit()
            self._load(t)
            return
        self.loading.emit(True, 0.0)

        def got(t):
            if req != self._req or self.wave is not w:
                return
            if t is None:
                self.loading.emit(False, 0)
                self.error.emit("Волне не из чего выбирать — добавь музыку в библиотеку")
                return
            self.wave_history.append(t)
            self.queue_changed.emit()
            self._load(t)

        run_bg(w.next_track, got, self._fail)

    def _finish_current(self, manual: bool, dur: int | None = None) -> None:
        try:
            self._finish_current_inner(manual, dur)
        except Exception as e:  # noqa: BLE001 — учёт прослушивания не должен ломать кнопку «дальше»
            print("finish_current:", e)

    def _finish_current_inner(self, manual: bool, dur_override: int | None = None) -> None:
        t = self.current
        if not t or t.get("_logged"):
            return
        t["_logged"] = True
        full = dur_override or self._duration()
        pos = self.mp.position() if manual else full
        dur = full or 1
        completed = (not manual) or pos >= dur * COMPLETE_RATIO
        if pos < 1500 and manual:
            return  # даже не начал слушать — не считаем
        if self.wave and t in self.wave_history:
            w = self.wave
            run_bg(lambda: w.on_finished(t, pos, completed))  # wave.lock может быть занят подбором
        else:
            self.db.log(t["id"], "complete" if completed else "skip", pos, "list")

    def _load(self, t: dict) -> None:
        self._req += 1
        req = self._req
        self._unprepare()
        self.mp.stop()
        self._prep = None
        t = dict(t)
        t.pop("_logged", None)
        if self.wave and self.wave_history and self.wave_history[-1].get("id") == t.get("id"):
            self.wave_history[-1] = t
        self.current = t
        self.track_changed.emit(t)
        self.loading.emit(True, 0.0)

        def work(progress):
            tr = t
            path = self._fetch(tr, progress)
            return tr, path

        def done(res):
            if req != self._req:
                return
            tr, path = res
            self.current.update(tr)
            fresh = self.db.track(tr["id"])  # лайк мог измениться, пока трек грузился
            if fresh:
                self.current["liked"] = fresh["liked"]
            self._fail_streak = 0
            self.loading.emit(False, 1.0)
            self.track_changed.emit(self.current)
            self._set_source(path, self.current)
            if not self._hold:
                self.mp.play()
            self.db.log(tr["id"], "play", 0, "wave" if self.wave else "list")
            self._prefetch()

        def fail(msg):
            if req != self._req:
                return
            self._fail(msg)

        run_bg(work, done, fail, lambda f, _txt: req == self._req and self.loading.emit(True, f))

    def _prefetch(self) -> None:
        """Заранее качаем следующий трек, чтобы переключение было мгновенным."""
        nxt = self.upcoming(1)
        if not nxt:
            return
        t = dict(nxt[0])
        key = ("ym", str(t["ym_id"])) if self._use_ym(t) else t.get("sc_id")
        if not key or key in self._prefetched:
            return   # трек без источника (Spotify без пары) не ищем заранее
        self._prefetched.add(key)
        run_bg(lambda: self._fetch(t), self._analyze, on_error=lambda _m: None)

    def _analyze(self, path) -> None:
        """Громкость предзагруженного трека считаем заранее — к переходу она уже известна."""
        if self.engine_name == "volna" and path:
            try:
                self.mp.analyze(str(path))
            except Exception as e:  # noqa: BLE001
                print("analyze:", e)

    # --- откуда брать звук ---------------------------------------------------
    def _use_ym(self, tr: dict) -> bool:
        """Играть ли трек из Яндекса: есть ym_id, есть вход и (настройка «предпочитать» или нет пары на SC)."""
        ym = self.ym
        if ym is None or not tr.get("ym_id"):
            return False
        try:
            if not ym.logged_in:
                return False
            from ..yandex import prefer_yandex  # noqa: PLC0415
            return prefer_yandex() or not tr.get("sc_id")
        except Exception:  # noqa: BLE001
            return False

    def _fetch(self, tr: dict, progress=None, force_net: bool = False):
        """Единая точка: локальный файл для трека. Яндекс → при сбое SoundCloud. Фоновый поток.

        progress(доля, текст) — как у run_bg; может быть None.
        """
        off = self._offline_file(tr)
        if off:
            return off
        if self.offline_only and not force_net:
            raise RuntimeError(f"«{tr.get('title', '')}» не скачан — в офлайн-режиме играют только скачанные треки")
        prog = (lambda f: progress(f, "")) if progress else None
        ym_err = None
        if self._use_ym(tr):
            try:
                return self.ym.stream_file(tr["ym_id"], prog)
            except Exception as e:  # noqa: BLE001 — Яндекс не дал трек: пробуем SoundCloud
                ym_err = e
                print("yandex stream failed, fallback to SoundCloud:", e)
        if ym_err is not None and not tr.get("sc_id"):
            # трек из Яндекса: ищем пару на SoundCloud, но не помечаем его «нет на SC» навсегда
            if progress:
                progress(0.0, "Ищу на SoundCloud")
            cand = find_on_soundcloud(self.sc, tr["title"], tr["artist"], tr.get("duration_ms") or 0)
            if not cand:
                raise RuntimeError(f"{str(ym_err).rstrip('.')}. На SoundCloud трек тоже не нашёлся.")
            self.db.attach_match(tr["id"], cand)
            tr.update(self.db.track(tr["id"]))
            return self.sc.stream_file(tr["sc_id"], prog)
        try:
            self._resolve(tr, progress)
            return self.sc.stream_file(tr["sc_id"], prog)
        except Exception:
            # «предпочитать Яндекс» выключено, но SoundCloud подвёл — последняя попытка через Яндекс
            ym = self.ym
            if ym_err is None and tr.get("ym_id") and ym is not None and ym.logged_in:
                return ym.stream_file(tr["ym_id"], prog)
            raise

    def _offline_file(self, tr: dict):
        """Скачанный для офлайна файл трека (смотрим свежую строку в базе — словарь мог устареть)."""
        try:
            row = self.db.track(self.db.resolve(int(tr["id"]))) if tr.get("id") else None
        except Exception:  # noqa: BLE001
            row = None
        return offline.file_for(row or tr)

    def _resolve(self, tr: dict, progress=None) -> None:
        """Трек из Spotify, ещё не найден на SoundCloud — ищем сейчас (фоновый поток)."""
        if tr.get("sc_id"):
            return
        if progress:
            progress(0.0, "Ищу на SoundCloud")
        cand = find_on_soundcloud(self.sc, tr["title"], tr["artist"], tr.get("duration_ms") or 0)
        if not cand:
            if tr.get("ym_id"):   # трек из Яндекса: не помечаем «нет нигде», просто нужен вход
                raise RuntimeError(f"«{tr['artist']} — {tr['title']}» есть только в Яндекс Музыке — "
                                   "войди в Яндекс в настройках, чтобы его слушать")
            self.db.mark_match_failed(tr["id"])
            raise RuntimeError(f"«{tr['artist']} — {tr['title']}» не нашёлся на SoundCloud")
        self.db.attach_match(tr["id"], cand)
        tr.update(self.db.track(tr["id"]))

    # --- кроссфейд / gapless ---------------------------------------------
    def _peek_next(self):
        """Что заиграет после текущего — без изменения очередей: (вид, трек, индекс)."""
        if self.user_queue:
            return "user", self.user_queue[0], None
        if self.wave:
            return "wave", self._wave_carry, None
        if self.index + 1 < len(self.items):
            return "list", self.items[self.index + 1], self.index + 1
        return None

    def _unprepare(self) -> None:
        """Очередь поменялась — подготовленный переход больше не актуален."""
        self._prep_req += 1
        if self.engine_name != "volna":
            return
        p = self._prep
        if p is None:
            self.mp.clear_next()
            return
        if self.mp.clear_next():
            self._prep = None
            if p["kind"] == "wave" and self.wave is not None:
                self._wave_carry = p["orig"]  # взят из волны — не теряем, сыграет следующим
        # иначе переход уже начался: trackSwitched придёт и зафиксирует его

    def _on_about_to_finish(self) -> None:
        if self.engine_name != "volna" or self._prep is not None or not self.current or self.stop_after_current:
            return
        nxt = self._peek_next()
        if not nxt:
            return
        kind, t, idx = nxt
        self._prep_req += 1
        req = self._prep_req
        if kind == "wave" and t is None:
            w = self.wave

            def got(tr):
                if self.wave is not w or tr is None:
                    return
                if self._wave_carry is None:
                    self._wave_carry = tr
                if req == self._prep_req and self._wave_carry is tr:
                    self._prepare(req, "wave", tr, None)

            run_bg(w.next_track, got, lambda _m: None)
            return
        self._prepare(req, kind, t, idx)

    def _prepare(self, req: int, kind: str, orig: dict, idx) -> None:
        def work():
            tr = dict(orig)
            tr.pop("_logged", None)
            return tr, self._fetch(tr)

        def done(res):
            if req != self._prep_req or not self.current:
                return
            tr, path = res
            if self.mp.queue_next(str(path), duration_hint_ms=tr.get("duration_ms") or None):
                self._prep = {"kind": kind, "orig": orig, "track": tr, "index": idx, "path": str(path)}

        # ошибка — молчим: на EOF обычный переход сам покажет её и пропустит трек
        run_bg(work, done, lambda _m: None)

    def _on_switched(self, path: str, prev_ms: int) -> None:
        """Движок уже играет подготовленный трек (кроссфейд начался или gapless-стык)."""
        p = self._prep
        if p is None or p["path"] != path:
            return
        self._prep = None
        self._prep_req += 1
        self._fail_streak = 0
        self._finish_current(manual=False, dur=prev_ms or None)  # доиграл до кроссфейда = прослушан
        kind, orig = p["kind"], p["orig"]
        t = dict(p["track"])
        t.pop("_logged", None)
        if kind == "user":
            for i, x in enumerate(self.user_queue):
                if x is orig:
                    self.user_queue.pop(i)
                    break
        elif kind == "list":
            i = p["index"]
            if not (i is not None and i < len(self.items) and self.items[i] is orig):
                i = next((j for j, x in enumerate(self.items) if x is orig), None)
            if i is not None:
                self.index = i
        elif kind == "wave":
            if self._wave_carry is orig:
                self._wave_carry = None
            self.wave_history.append(t)
        self._req += 1                    # устаревшие загрузки больше не трогают плеер
        self._cur_path = path
        self.current = t
        try:
            fresh = self.db.track(t["id"])
            if fresh:
                t["liked"] = fresh["liked"]
            self.db.log(t["id"], "play", 0, "wave" if self.wave else "list")
        except Exception as e:  # noqa: BLE001
            print("switch log:", e)
        self.loading.emit(False, 1.0)
        self.track_changed.emit(t)
        self.queue_changed.emit()
        self._prefetch()

    def _on_status(self, status) -> None:
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self._finish_current(manual=False)
            if self.stop_after_current:
                self.stop_after_current = False
                self.mp.pause()
                self.mp.setPosition(0)
                self.stopped_after.emit()
                return
            self._advance()

    def _fail(self, msg: str) -> None:
        self.loading.emit(False, 0)
        self.error.emit(msg)
        self._fail_streak += 1
        # битый трек — пропускаем, но не уходим в бесконечный цикл
        if self.current and self._fail_streak < 4:
            if self.current:
                self.current["_logged"] = True
            self._advance()
