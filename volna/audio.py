"""Собственный аудиодвижок Volna: кроссфейд, gapless, нормализация громкости, эквалайзер, спектр.

Устройство:
* ``_Stream`` — один файл. Поток-декодер (PyAV) читает пакеты, приводит звук к float32 stereo
  с частотой устройства и складывает куски в очередь (deque — атомарные append/popleft, без
  блокировок с аудиоколбэком). Перемотка — через «эпоху»: старые куски колбэк просто выбрасывает.
* ``AudioEngine`` — QObject в GUI-потоке. Колбэк ``sounddevice.OutputStream`` смешивает текущий
  поток и затухающие, применяет нормализацию, эквалайзер, громкость и мягкий лимитер.
  Сигналы Qt испускаются только из GUI-потока (опрос по QTimer).
* Интерфейс повторяет нужную плееру часть QMediaPlayer (setSource/play/pause/stop/position/...).

Если чего-то не хватает (PyAV, numpy, scipy, PortAudio) или не открылось устройство вывода,
конструктор бросает ``AudioUnavailable`` — плеер тогда работает на QMediaPlayer.
"""
from __future__ import annotations

import json
import math
import os
import queue
import threading
import time
from collections import deque
from pathlib import Path

from PySide6.QtCore import QCoreApplication, QObject, QTimer, QUrl, Signal
from PySide6.QtMultimedia import QMediaPlayer

try:
    import av
    import numpy as np
    from scipy.signal import sosfilt
    IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001 — любая проблема с зависимостями = откат на Qt
    av = np = sosfilt = None
    IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

try:
    import sounddevice as sd
except Exception as _e:  # noqa: BLE001 — на Linux без libportaudio бросает OSError
    sd = None
    SD_ERROR = f"{type(_e).__name__}: {_e}"
else:
    SD_ERROR = ""

AVAILABLE = av is not None

# Тесты подменяют вывод: фабрика с сигнатурой sounddevice.OutputStream(**kwargs).
STREAM_FACTORY = None

PS = QMediaPlayer.PlaybackState
MS = QMediaPlayer.MediaStatus

EQ_FREQS = (31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)
EQ_Q = 1.0
TARGET_LUFS = -14.0
GAIN_MIN_DB, GAIN_MAX_DB = -12.0, 9.0
LIMIT_TH = 10 ** (-1 / 20)       # мягкий лимитер начинается с -1 dBFS
SPEC_N = 2048
SPEC_BANDS = 48
POLL_MS = 33


class AudioUnavailable(RuntimeError):
    pass


def db_to_lin(db: float) -> float:
    return 10.0 ** (db / 20.0)


# ======================================================================
# Эквалайзер
# ======================================================================
def design_eq(gains, sr: int):
    """10 пиковых бикавдов (RBJ). Возвращает (sos, предусиление) или (None, 1.0), если всё по нулям."""
    g = [max(-12.0, min(12.0, float(x))) for x in (list(gains) + [0.0] * 10)[:10]]
    if all(abs(x) < 0.05 for x in g):
        return None, 1.0
    sos = np.zeros((10, 6))
    for i, (f, gain) in enumerate(zip(EQ_FREQS, g)):
        f = min(f, sr * 0.45)
        a = 10 ** (gain / 40)
        w0 = 2 * math.pi * f / sr
        alpha = math.sin(w0) / (2 * EQ_Q)
        cw = math.cos(w0)
        b0, b1, b2 = 1 + alpha * a, -2 * cw, 1 - alpha * a
        a0, a1, a2 = 1 + alpha / a, -2 * cw, 1 - alpha / a
        sos[i] = (b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0)
    # запас под подъём, чтобы лимитер не работал постоянно
    pre = db_to_lin(-0.5 * max(0.0, max(g)))
    return sos, pre


# ======================================================================
# Спектр
# ======================================================================
class SpectrumAnalyzer:
    """FFT по последним SPEC_N сэмплам → 48 логарифмических полос 0..1 со сглаживанием."""

    def __init__(self, sr: int, n: int = SPEC_N, bands: int = SPEC_BANDS,
                 fmin: float = 32.0, fmax: float = 16000.0):
        self.n = n
        self.win = np.hanning(n)
        self.scale = 2.0 / self.win.sum()
        freqs = np.fft.rfftfreq(n, 1.0 / sr)
        edges = np.geomspace(fmin, min(fmax, sr * 0.48), bands + 1)
        self.ranges = []
        for lo_f, hi_f in zip(edges[:-1], edges[1:]):
            lo = int(np.searchsorted(freqs, lo_f))
            hi = max(lo + 1, int(np.searchsorted(freqs, hi_f)))
            self.ranges.append((min(lo, len(freqs) - 1), min(hi, len(freqs))))
        centers = np.sqrt(edges[:-1] * edges[1:])
        self.tilt = 3.0 * np.log2(centers / 1000.0)   # +3 дБ/октава: у музыки верх тише
        self.vals = np.zeros(bands)

    def compute(self, mono) -> list:
        mag = np.abs(np.fft.rfft(mono[-self.n:] * self.win)) * self.scale
        peak = np.array([mag[lo:hi].max() for lo, hi in self.ranges])
        db = 20 * np.log10(peak + 1e-9) + self.tilt
        v = np.clip((db + 66.0) / 60.0, 0.0, 1.0)
        up = v > self.vals
        self.vals += (v - self.vals) * np.where(up, 0.65, 0.18)
        return [round(float(x), 3) for x in self.vals]

    def decay(self) -> list | None:
        if not self.vals.any():
            return None
        self.vals *= 0.8
        self.vals[self.vals < 0.004] = 0.0
        return [round(float(x), 3) for x in self.vals]


# ======================================================================
# Громкость (интегральная, BS.1770 с гейтингом)
# ======================================================================
_K_SOS = None


def _k_sos():
    global _K_SOS
    if _K_SOS is None:  # коэффициенты K-фильтра для 48 кГц из ITU-R BS.1770
        _K_SOS = np.array([
            [1.53512485958697, -2.69169618940638, 1.19839281085285, 1.0, -1.69065929318241, 0.73248077421585],
            [1.0, -2.0, 1.0, 1.0, -1.99004745483398, 0.99007225036621],
        ])
    return _K_SOS


def measure_lufs(path, max_seconds: float = 900.0, stop=None) -> float | None:
    """Интегральная громкость файла в LUFS (None — тишина). Быстрое декодирование целиком."""
    sr = 48000
    sub = sr // 10                                      # 100 мс
    sos = _k_sos()
    zi = np.zeros((2, 2, 2))
    energies: list[float] = []
    acc = np.zeros(0)
    with av.open(str(path)) as c:
        st = c.streams.audio[0]
        rs = av.AudioResampler(format="flt", layout="stereo", rate=sr)
        total = 0

        def feed(frames):
            nonlocal zi, acc, total
            for f in frames:
                x = f.to_ndarray().reshape(-1, 2).astype(np.float64)
                y, zi = sosfilt(sos, x, axis=0, zi=zi)
                e = (y * y).sum(axis=1)
                acc = np.concatenate([acc, e])
                total += len(x)
                k = len(acc) // sub
                if k:
                    energies.extend(acc[:k * sub].reshape(k, sub).mean(axis=1).tolist())
                    acc = acc[k * sub:]

        for packet in c.demux(st):
            if stop is not None and stop():
                return None
            try:
                feed(r for fr in packet.decode() for r in rs.resample(fr))
            except av.FFmpegError:
                continue
            if total > max_seconds * sr:
                break
        try:
            feed(rs.resample(None))
        except (av.FFmpegError, ValueError):
            pass
    e = np.array(energies)
    if len(e) < 4:
        return None
    blocks = np.convolve(e, np.ones(4) / 4, mode="valid")    # 400 мс, перекрытие 75%
    lk = -0.691 + 10 * np.log10(blocks + 1e-12)
    blocks = blocks[lk > -70.0]
    if not len(blocks):
        return None
    rel = -0.691 + 10 * np.log10(blocks.mean()) - 10.0
    blocks = blocks[(-0.691 + 10 * np.log10(blocks)) > rel]
    if not len(blocks):
        return None
    return float(-0.691 + 10 * np.log10(blocks.mean()))


def gain_db_for(lufs: float | None) -> float:
    if lufs is None:
        return 0.0
    return max(GAIN_MIN_DB, min(GAIN_MAX_DB, TARGET_LUFS - lufs))


class LoudnessCache:
    """Фоновый подсчёт громкости + кэш в cache_dir()/loudness.json (ключ — имя файла)."""

    MAX_ITEMS = 5000

    def __init__(self, cache_path: Path | None = None):
        self._path = cache_path
        self._data: dict | None = None
        self._lock = threading.Lock()
        self._q: queue.Queue = queue.Queue()
        self._waiters: dict[str, list] = {}
        self._thread: threading.Thread | None = None

    def _file(self) -> Path:
        if self._path is None:
            from .config import cache_dir
            self._path = cache_dir() / "loudness.json"
        return self._path

    def _load(self) -> dict:
        if self._data is None:
            try:
                with open(self._file(), "r", encoding="utf-8") as f:
                    self._data = dict(json.load(f))
            except (OSError, ValueError, TypeError):
                self._data = {}
        return self._data

    @staticmethod
    def _key(path) -> tuple[str, int]:
        p = Path(path)
        try:
            size = p.stat().st_size
        except OSError:
            size = -1
        return p.name, size

    def cached(self, path):
        """(найдено, lufs) — без декодирования."""
        name, size = self._key(path)
        with self._lock:
            v = self._load().get(name)
        if isinstance(v, list) and len(v) == 2 and v[1] == size:
            return True, v[0]
        return False, None

    def _store(self, path, lufs) -> None:
        name, size = self._key(path)
        with self._lock:
            d = self._load()
            d.pop(name, None)
            d[name] = [None if lufs is None else round(lufs, 2), size]
            while len(d) > self.MAX_ITEMS:
                d.pop(next(iter(d)))
            try:
                tmp = self._file().with_suffix(".tmp")
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(d, f)
                os.replace(tmp, self._file())
            except OSError as e:
                print("loudness cache:", e)

    def request(self, path, callback=None) -> None:
        """Посчитать громкость в фоне; callback(lufs) вызывается из фонового потока."""
        ok, lufs = self.cached(path)
        if ok:
            if callback:
                callback(lufs)
            return
        key = str(path)
        with self._lock:
            lst = self._waiters.get(key)
            if lst is not None:
                if callback:
                    lst.append(callback)
                return
            self._waiters[key] = [callback] if callback else []
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._worker, daemon=True, name="volna-loudness")
                self._thread.start()
        self._q.put(key)

    def _worker(self) -> None:
        while True:
            try:
                key = self._q.get(timeout=30)
            except queue.Empty:
                with self._lock:
                    if self._q.empty():
                        self._thread = None
                        return
                continue
            ok, lufs = self.cached(key)
            if not ok:
                try:
                    lufs = measure_lufs(key)
                    self._store(key, lufs)
                except Exception as e:  # noqa: BLE001 — битый файл: просто без нормализации
                    print("loudness:", e)
                    lufs = None
            with self._lock:
                cbs = self._waiters.pop(key, [])
            for cb in cbs:
                try:
                    cb(lufs)
                except Exception as e:  # noqa: BLE001
                    print("loudness callback:", e)


loudness = LoudnessCache()


# ======================================================================
# Поток одного файла
# ======================================================================
class _Stream:
    def __init__(self, path: str, sr: int, buffer_s: float, duration_hint_ms: int | None = None):
        self.path = str(path)
        self.sr = sr
        self.max_buffer = int(buffer_s * sr)
        self.chunks: deque = deque()            # (epoch, start_frame, ndarray[k,2] float32)
        self.produced = 0                       # пишет только декодер
        self.consumed = 0                       # пишет только колбэк
        self.epoch = 0                          # меняет GUI при перемотке
        self._seek_lock = threading.Lock()
        self._seek_req: int | None = None
        self.pos = 0                            # кадры, позиция воспроизведения
        self.eof_epoch = -1
        self.eof_frame: int | None = None
        self.duration_frames: int | None = int(duration_hint_ms * sr / 1000) if duration_hint_ms else None
        self.error: str | None = None
        self.opened = False
        self.gain = 1.0                         # нормализация (линейная), ползёт к gain_target
        self.gain_target = 1.0
        self.lufs_known = False
        self.lufs: float | None = None
        self.fade_in: list | None = None        # [pos, len] — нарастание при кроссфейде
        self.atf_sent = False
        self.stop_flag = False
        # состояние читателя (только колбэк)
        self._arr = None
        self._off = 0
        self._start = 0
        self._arr_epoch = 0
        self.thread = threading.Thread(target=self._run, daemon=True, name="volna-decode")
        self.thread.start()

    # --- GUI ------------------------------------------------------------
    def seek(self, frames: int) -> None:
        frames = max(0, int(frames))
        with self._seek_lock:
            self._seek_req = frames
            self.epoch += 1
        self.pos = frames
        self.atf_sent = False

    def close(self) -> None:
        self.stop_flag = True

    def has_data(self) -> bool:
        return bool(self.chunks) or self._arr is not None or self.finished()

    def end_frame(self) -> int | None:
        if self.eof_epoch == self.epoch:
            return self.eof_frame
        return self.duration_frames

    def remaining_exact(self) -> int | None:
        """Сколько осталось до конца, если декодер уже дошёл до EOF (точно), иначе None."""
        if self.eof_epoch == self.epoch and self.eof_frame is not None:
            return self.eof_frame - self.pos
        return None

    def remaining_estimate(self) -> int | None:
        end = self.end_frame()
        return None if end is None else end - self.pos

    # --- колбэк ---------------------------------------------------------
    def finished(self) -> bool:
        return self.eof_epoch == self.epoch and not self.chunks and self._arr is None

    def read_into(self, dst) -> int:
        n = len(dst)
        k = 0
        ep = self.epoch
        if self._arr is not None and self._arr_epoch != ep:
            self._arr = None
        while k < n:
            if self._arr is None:
                try:
                    e, start, arr = self.chunks.popleft()
                except IndexError:
                    break
                self.consumed += len(arr)
                if e != ep:
                    continue
                self._arr, self._off, self._start, self._arr_epoch = arr, 0, start, e
            arr = self._arr
            take = min(n - k, len(arr) - self._off)
            dst[k:k + take] = arr[self._off:self._off + take]
            k += take
            self._off += take
            self.pos = self._start + self._off
            if self._off >= len(arr):
                self._arr = None
        return k

    # --- декодер --------------------------------------------------------
    def _run(self) -> None:
        try:
            self._decode_loop()
        except Exception as e:  # noqa: BLE001 — ошибка файла не должна ронять приложение
            if not self.opened:
                self.error = f"{type(e).__name__}: {e}"
            else:   # середина файла — считаем, что он кончился
                print("decode:", e)
                self.eof_frame = self._feed_pos
                self.eof_epoch = self._feed_epoch

    def _decode_loop(self) -> None:
        self._feed_pos = 0
        self._feed_epoch = 0
        c = av.open(self.path)
        try:
            st = c.streams.audio[0]
            tb = st.time_base
            if st.start_time is not None and tb is not None:
                t0 = float(st.start_time * tb)
            elif c.start_time is not None:
                t0 = c.start_time / 1e6
            else:
                t0 = 0.0
            dur = None
            if st.duration and tb is not None:
                dur = float(st.duration * tb)
            elif c.duration:
                dur = c.duration / 1e6
            if dur and dur > 0:
                self.duration_frames = int(dur * self.sr)
            self.opened = True
            self._feed(c, st, t0)
        finally:
            c.close()

    def _feed(self, c, st, t0: float) -> None:
        sr = self.sr

        def new_rs():
            return av.AudioResampler(format="flt", layout="stereo", rate=sr)

        rs = new_rs()
        pit = c.demux(st)
        skip_to = 0
        need_stamp = True
        eof = False
        errors = 0

        def push(frames_out):
            for of in frames_out:
                a = of.to_ndarray().reshape(-1, 2)
                n = len(a)
                if n == 0:
                    continue
                start = self._feed_pos
                self._feed_pos += n
                if self._feed_pos <= skip_to:
                    continue
                if start < skip_to:
                    a = a[skip_to - start:]
                    start = skip_to
                self.chunks.append((self._feed_epoch, start, np.array(a, dtype=np.float32)))
                self.produced += len(a)

        def decode(packet):
            nonlocal need_stamp, rs
            for fr in packet.decode():
                if need_stamp and fr.time is not None:
                    self._feed_pos = max(0, int(round((float(fr.time) - t0) * sr)))
                    need_stamp = False
                try:
                    push(rs.resample(fr))
                except ValueError:      # формат поменялся посреди файла
                    rs = new_rs()
                    push(rs.resample(fr))

        while not self.stop_flag:
            with self._seek_lock:
                req = self._seek_req
                self._seek_req = None
                ep = self.epoch
            if req is not None:
                self._feed_epoch = ep
                try:
                    c.seek(int((req / sr + t0) * 1e6), backward=True, any_frame=False)
                except Exception as e:  # noqa: BLE001 — не умеет перематываться: с начала и пропуск
                    print("seek:", e)
                    c.seek(0)
                pit = c.demux(st)
                rs = new_rs()
                self._feed_pos = req
                skip_to = req
                need_stamp = True
                eof = False
                errors = 0
                continue
            if eof or self.produced - self.consumed >= self.max_buffer:
                time.sleep(0.01)
                continue
            try:
                packet = next(pit)
            except StopIteration:
                packet = None
            except av.FFmpegError as e:
                errors += 1
                if errors > 30:
                    print("demux:", e)
                    packet = None
                else:
                    continue
            if packet is None:
                try:
                    push(rs.resample(None))
                except (ValueError, av.FFmpegError):
                    pass
                self.eof_frame = self._feed_pos
                self.eof_epoch = self._feed_epoch
                eof = True
                continue
            try:
                decode(packet)
                errors = 0
            except av.FFmpegError:
                errors += 1      # битый пакет — пропускаем


# ======================================================================
# Движок
# ======================================================================
class AudioEngine(QObject):
    """Замена QMediaPlayer + QAudioOutput с кроссфейдом, EQ, нормализацией и спектром."""

    positionChanged = Signal(int)
    durationChanged = Signal(int)
    playbackStateChanged = Signal(object)
    mediaStatusChanged = Signal(object)
    errorOccurred = Signal(object, str)
    aboutToFinish = Signal()
    trackSwitched = Signal(str, int)    # путь нового трека, длительность доигравшего (мс)
    spectrum = Signal(list)
    fatal = Signal(str)                 # устройство вывода умерло насовсем → плееру пора на Qt

    PlaybackState = PS
    MediaStatus = MS

    def __init__(self, parent=None, *, stream_factory=None, samplerate: int | None = None,
                 start_timer: bool = True):
        super().__init__(parent)
        if not AVAILABLE:
            raise AudioUnavailable(f"нет зависимостей: {IMPORT_ERROR}")
        self._factory = stream_factory or STREAM_FACTORY
        if self._factory is None and sd is None:
            raise AudioUnavailable(f"sounddevice/PortAudio: {SD_ERROR}")
        self._lock = threading.RLock()
        self._sr_req = samplerate
        self._out = None
        self.sr = 48000
        self.latency = 0.0
        self._open_output()                 # бросает AudioUnavailable

        self._cur: _Stream | None = None
        self._next: _Stream | None = None
        self._fading: list[list] = []        # [stream, pos, len, gain0] — уходящие (кроссфейд)
        self._dying: list[list] = []         # то же для стопа/смены трека (короткий declick)
        self._playing = False
        self._run_gain = 0.0
        self._vol = 0.7
        self._vol_target = 0.7
        self._cf = 4.0
        self._normalize = True
        self._eq_gains = [0.0] * 10
        self._eq_on = False
        self._eq_sos = None
        self._eq_pre = 1.0
        self._eq_zi = np.zeros((10, 2, 2))
        self._eq_live = None                  # sos, с которым считан zi
        self._switches: deque = deque()       # (stream, prev_duration_ms) — для GUI
        self._ended: _Stream | None = None
        self._cb_error = ""
        self._tap = np.zeros(SPEC_N * 2, dtype=np.float32)
        self._tap_w = 0
        self._tap_frames = 0

        self._state = PS.StoppedState
        self._status = MS.NoMedia
        self._src: str | None = None
        self._last_pos = -1
        self._idle_since: float | None = None
        self._out_running = False
        self._reopen_at = 0.0
        self._reopen_fails = 0
        self._tick = 0
        self._spec = SpectrumAnalyzer(self.sr)

        self._timer = QTimer(self)
        self._timer.setInterval(POLL_MS)
        self._timer.timeout.connect(self._poll)
        if start_timer:
            self._timer.start()
        app = QCoreApplication.instance()
        if app is not None:
            app.aboutToQuit.connect(self.close)

    # ------------------------------------------------------------------
    # устройство
    # ------------------------------------------------------------------
    def _open_output(self) -> None:
        errors = []
        for kw in self._output_candidates():
            try:
                kw = dict(kw, channels=2, dtype="float32", callback=self._callback)
                out = (self._factory or sd.OutputStream)(**kw)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{type(e).__name__}: {e}")
                continue
            self._out = out
            self.sr = int(kw["samplerate"])
            try:
                lat = out.latency
                self.latency = float(lat[1] if isinstance(lat, (tuple, list)) else lat)
            except Exception:  # noqa: BLE001
                self.latency = 0.0
            return
        raise AudioUnavailable("не открылось устройство вывода: " + "; ".join(errors[-2:]))

    def _output_candidates(self):
        if self._factory is not None:
            yield {"samplerate": self._sr_req or 48000}
            return
        # 1) WASAPI shared (меньше задержка, без лишнего ресемплинга MME), 2) устройство по умолчанию
        try:
            for api in sd.query_hostapis():
                if "WASAPI" in api.get("name", "") and api.get("default_output_device", -1) >= 0:
                    dev = api["default_output_device"]
                    rate = self._pick_rate(sd.query_devices(dev)["default_samplerate"])
                    extra = {}
                    try:
                        extra["extra_settings"] = sd.WasapiSettings(exclusive=False)
                    except Exception:  # noqa: BLE001
                        pass
                    yield dict(device=dev, samplerate=rate, latency=0.1, **extra)
        except Exception as e:  # noqa: BLE001
            print("audio: wasapi probe:", e)
        try:
            info = sd.query_devices(kind="output")
            rate = self._pick_rate(info["default_samplerate"])
        except Exception:  # noqa: BLE001
            rate = 48000
        yield dict(samplerate=rate, latency="high")
        if rate != 48000:
            yield dict(samplerate=48000, latency="high")
        yield dict(samplerate=44100, latency="high")

    def _pick_rate(self, r) -> int:
        if self._sr_req:
            return int(self._sr_req)
        try:
            r = int(round(float(r)))
        except (TypeError, ValueError):
            return 48000
        return r if 22050 <= r <= 192000 else 48000

    def _ensure_output(self) -> bool:
        if self._out is None:
            return False
        if self._out_running and getattr(self._out, "active", True):
            return True
        try:
            self._out.start()
            self._out_running = True
            return True
        except Exception as e:  # noqa: BLE001
            print("audio: start failed:", e)
            return self._reopen(str(e))

    def _reopen(self, why: str) -> bool:
        self._close_output()
        old_sr = self.sr
        try:
            self._open_output()
            if self.sr != old_sr:   # другое устройство с другой частотой — перезапускаем потоки
                self._rebuild_for_rate()
            self._out.start()
            self._out_running = True
            self._reopen_fails = 0
            return True
        except Exception as e:  # noqa: BLE001
            self._reopen_fails += 1
            print("audio: reopen failed:", e)
            if self._reopen_fails >= 3:
                self.fatal.emit(f"Звуковое устройство недоступно: {why or e}")
            return False

    def _rebuild_for_rate(self) -> None:
        with self._lock:
            pos = self.position()
            src = self._src
            for s in [self._cur, self._next] + [f[0] for f in self._fading + self._dying]:
                if s:
                    s.close()
            self._cur = self._next = None
            self._fading.clear()
            self._dying.clear()
            self._spec = SpectrumAnalyzer(self.sr)
            self._eq_live = None
            self._eq_sos, self._eq_pre = design_eq(self._eq_gains, self.sr) if self._eq_on else (None, 1.0)
            if src:
                self._cur = self._make_stream(src)
                self._cur.seek(int(pos * self.sr / 1000))

    def _close_output(self) -> None:
        out, self._out = self._out, None
        self._out_running = False
        if out is not None:
            try:
                out.abort()
            except Exception:  # noqa: BLE001
                pass
            try:
                out.close()
            except Exception:  # noqa: BLE001
                pass

    def close(self) -> None:
        """Освободить устройство и остановить декодеры (при выходе из приложения)."""
        try:
            self._timer.stop()
        except RuntimeError:
            pass
        with self._lock:
            for s in [self._cur, self._next] + [f[0] for f in self._fading + self._dying]:
                if s:
                    s.close()
            self._cur = self._next = None
            self._fading.clear()
            self._dying.clear()
            self._playing = False
        self._close_output()

    # ------------------------------------------------------------------
    # аудиоколбэк (поток PortAudio)
    # ------------------------------------------------------------------
    def _callback(self, outdata, frames, _time=None, _status=None) -> None:
        try:
            with self._lock:
                outdata[:] = self._render(frames)
        except Exception as e:  # noqa: BLE001 — исключения не должны вылетать из колбэка
            try:
                outdata.fill(0)
            except Exception:  # noqa: BLE001
                pass
            self._cb_error = f"{type(e).__name__}: {e}"

    def _render(self, n: int):
        out = np.zeros((n, 2))
        target = 1.0 if self._playing else 0.0
        g0 = self._run_gain
        if g0 > 0.0 or target > 0.0:
            self._mix_main(out, n)
            if g0 != target:
                out *= np.linspace(g0, target, n, endpoint=False)[:, None]
            self._run_gain = target
        if self._dying:
            self._mix_out(self._dying, out, n)
        if self._eq_sos is not None:
            if self._eq_live is None:
                self._eq_zi = np.zeros((10, 2, 2))
            self._eq_live = self._eq_sos
            out, self._eq_zi = sosfilt(self._eq_sos, out * self._eq_pre, axis=0, zi=self._eq_zi)
        elif self._eq_live is not None:
            self._eq_live = None
        # отвод для спектра (до общей громкости — визуализация не зависит от ползунка)
        mono = (out[:, 0] + out[:, 1]) * 0.5
        self._tap_write(mono)
        v0, v1 = self._vol, self._vol_target
        if v0 != v1:
            out *= np.linspace(v0, v1, n)[:, None]
            self._vol = v1
        else:
            out *= v0
        peak = np.abs(out).max() if n else 0.0
        if peak > LIMIT_TH:
            a = np.abs(out)
            over = a > LIMIT_TH
            lim = LIMIT_TH + (1 - LIMIT_TH) * np.tanh((a - LIMIT_TH) / (1 - LIMIT_TH))
            out = np.where(over, np.sign(out) * lim, out)
        return out.astype(np.float32)

    def _tap_write(self, mono) -> None:
        tap = self._tap
        size = len(tap)
        m = mono[-size:]
        k = len(m)
        w = self._tap_w
        first = min(k, size - w)
        tap[w:w + first] = m[:first]
        if k > first:
            tap[:k - first] = m[first:]
        self._tap_w = (w + k) % size
        self._tap_frames += k

    def _stream_gain(self, s: _Stream, n: int):
        g0, g1 = s.gain, s.gain_target
        if abs(g1 - g0) < 1e-4:
            s.gain = g1
            return g1
        g1 = g0 + (g1 - g0) * min(1.0, n / (0.25 * self.sr))  # τ≈0.25 с: подстройка ~1 с без скачка
        s.gain = g1
        return np.linspace(g0, g1, n, endpoint=False)[:, None]

    def _mix_main(self, out, n: int) -> None:
        filled = 0
        buf = np.zeros((n, 2), dtype=np.float32)
        guard = 0
        while filled < n and guard < 4:
            guard += 1
            cur = self._cur
            if cur is None:
                break
            nxt = self._next
            if nxt is not None and self._cf > 0:
                rem = cur.remaining_exact()
                cf = int(self._cf * self.sr)
                if cur.duration_frames:
                    cf = min(cf, max(int(0.5 * self.sr), cur.duration_frames // 3))
                if rem is not None and rem <= cf:
                    length = max(int(0.05 * self.sr), rem)
                    self._fading.append([cur, 0, length, 1.0])
                    self._switch(nxt, fade=length)
                    continue
            want = n - filled
            k = cur.read_into(buf[:want])
            if k:
                seg = buf[:k].astype(np.float64)
                g = self._stream_gain(cur, k)
                seg *= g
                if cur.fade_in is not None:
                    p, ln = cur.fade_in
                    t = (p + np.arange(k)) / ln
                    np.clip(t, 0.0, 1.0, out=t)
                    seg *= np.sin(t * (math.pi / 2))[:, None]
                    p += k
                    cur.fade_in = None if p >= ln else [p, ln]
                out[filled:filled + k] += seg
                filled += k
            if filled < n:
                if cur.finished():
                    if nxt is not None:      # gapless: следующий начинается с этого же сэмпла
                        self._switch(nxt, fade=0)
                        continue
                    self._ended = cur
                    self._playing = False
                break       # недобор данных (декодер не успел) — тишина
        if self._fading:
            self._mix_out(self._fading, out, n)

    def _mix_out(self, lst: list, out, n: int) -> None:
        buf = np.zeros((n, 2), dtype=np.float32)
        for item in list(lst):
            s, p, ln, g0 = item
            k = s.read_into(buf)
            if k:
                t = (p + np.arange(k)) / ln
                np.clip(t, 0.0, 1.0, out=t)
                env = np.cos(t * (math.pi / 2)) * g0
                out[:k] += buf[:k] * (env * s.gain)[:, None]
            item[1] = p + n
            if item[1] >= ln or s.finished() or (s.stop_flag and not k):
                lst.remove(item)
                s.close()

    def _switch(self, nxt: _Stream, fade: int) -> None:
        prev = self._cur
        prev_ms = 0
        if prev is not None:
            end = prev.end_frame()
            prev_ms = int((end if end else prev.pos) * 1000 / self.sr)
        nxt.fade_in = [0, fade] if fade > 0 else None
        self._cur = nxt
        self._next = None
        self._src = nxt.path
        self._switches.append((nxt, prev_ms))
        if fade <= 0 and prev is not None:
            prev.close()

    # ------------------------------------------------------------------
    # интерфейс QMediaPlayer
    # ------------------------------------------------------------------
    def _make_stream(self, path: str, duration_hint_ms: int | None = None) -> _Stream:
        buffer_s = max(self._cf, 3.0) + 2.0
        s = _Stream(path, self.sr, buffer_s, duration_hint_ms)
        self._apply_norm(s)
        if not s.lufs_known and self._normalize:
            def got(lufs, s=s):
                s.lufs, s.lufs_known = lufs, True
                self._apply_norm(s)
            loudness.request(path, got)
        return s

    def _apply_norm(self, s: _Stream, instant: bool = False) -> None:
        if not s.lufs_known:
            ok, lufs = loudness.cached(s.path)
            if ok:
                s.lufs, s.lufs_known = lufs, True
                instant = True
        g = db_to_lin(gain_db_for(s.lufs)) if (self._normalize and s.lufs_known) else 1.0
        s.gain_target = g
        if instant:
            s.gain = g

    def _retire(self, s: _Stream | None, gain: float = 1.0) -> None:
        """Убрать поток: если звучал — короткое затухание (без щелчка), иначе сразу закрыть."""
        if s is None:
            return
        if self._run_gain > 0 and self._playing:
            self._dying.append([s, 0, int(0.04 * self.sr), gain])
        else:
            s.close()

    def setSource(self, url, duration_hint_ms: int | None = None) -> None:
        path = url.toLocalFile() if isinstance(url, QUrl) else str(url)
        new = self._make_stream(path, duration_hint_ms) if path else None
        with self._lock:
            self._drop_all()
            self._playing = False
            self._ended = None
            self._src = path or None
            self._cur = new
        self._last_pos = -1
        self._set_state(PS.StoppedState)
        self._set_status(MS.LoadingMedia if path else MS.NoMedia)

    def _drop_all(self) -> None:
        if self._cur is not None:
            g = 1.0
            if self._cur.fade_in is not None:
                p, ln = self._cur.fade_in
                g = math.sin(min(1.0, p / ln) * math.pi / 2)
            self._retire(self._cur, g)
        for f in self._fading:
            p, ln = f[1], f[2]
            self._retire(f[0], math.cos(min(1.0, p / ln) * math.pi / 2) * f[3])
        self._fading.clear()
        if self._next is not None:
            self._next.close()
        self._cur = self._next = None
        self._switches.clear()

    def source(self) -> QUrl:
        return QUrl.fromLocalFile(self._src) if self._src else QUrl()

    def play(self) -> None:
        if self._cur is None and self._src:
            new = self._make_stream(self._src)
            with self._lock:
                if self._cur is None:
                    self._cur = new
                else:
                    new.close()
        with self._lock:
            if self._cur is None:
                return
            if self._ended is self._cur or self._cur.finished():
                self._cur.seek(0)
                self._ended = None
            self._playing = True
        self._idle_since = None
        if not self._ensure_output():
            with self._lock:
                self._playing = False
            self.errorOccurred.emit(QMediaPlayer.Error.ResourceError, "Не удалось открыть звуковое устройство")
            return
        self._set_state(PS.PlayingState)

    def pause(self) -> None:
        with self._lock:
            if self._cur is None:
                return
            self._playing = False
        self._set_state(PS.PausedState)

    def stop(self) -> None:
        with self._lock:
            self._drop_all()
            self._playing = False
            self._ended = None
        self._last_pos = -1
        self._set_state(PS.StoppedState)
        if self._status not in (MS.NoMedia, MS.InvalidMedia):
            self._set_status(MS.LoadedMedia)

    def playbackState(self):
        return self._state

    def mediaStatus(self):
        return self._status

    def isPlaying(self) -> bool:
        return self._state == PS.PlayingState

    def position(self) -> int:
        s = self._cur
        if s is None:
            return 0
        pos = s.pos / self.sr - (self.latency if self._playing else 0.0)
        return max(0, int(pos * 1000))

    def duration(self) -> int:
        s = self._cur
        if s is None:
            return 0
        end = s.end_frame()
        return int(end * 1000 / self.sr) if end else 0

    def setPosition(self, ms: int) -> None:
        with self._lock:
            s = self._cur
            if s is None:
                return
            # уходящий при кроссфейде трек обрываем — пользователь перематывает новый
            for f in self._fading:
                self._retire(f[0], 0.5)
            self._fading.clear()
            if s.fade_in is not None:
                s.fade_in = None
            dur = self.duration()
            if dur:
                ms = min(int(ms), max(0, dur - 200))
            s.seek(int(max(0, ms) * self.sr / 1000))
            if self._ended is s:
                self._ended = None
            if self._next is None:
                s.atf_sent = False
        self._last_pos = -1
        self.positionChanged.emit(self.position())

    def setVolume(self, v: float) -> None:
        v = max(0.0, min(1.0, float(v)))
        self._vol_target = v
        if not self._out_running:
            self._vol = v

    def volume(self) -> float:
        return self._vol_target

    # --- расширения -----------------------------------------------------
    def queue_next(self, path, duration_hint_ms: int | None = None) -> bool:
        """Подготовить следующий трек: кроссфейд/gapless переход без участия плеера."""
        cur = self._cur
        if cur is None or self._ended is cur or not path:
            return False
        new = self._make_stream(str(path), duration_hint_ms)
        with self._lock:
            if self._cur is not cur or self._ended is cur:
                new.close()
                return False
            if self._next is not None:
                self._next.close()
            self._next = new
            return True

    def clear_next(self) -> bool:
        """Отменить подготовленный трек. False — если переход уже начался (или ничего не было)."""
        with self._lock:
            if self._next is None:
                if self._cur is not None and not self._switches:
                    self._cur.atf_sent = False   # подготовка отменена — спросим ещё раз
                return False
            self._next.close()
            self._next = None
            if self._cur is not None:
                self._cur.atf_sent = False
            return True

    def has_next(self) -> bool:
        return self._next is not None

    def set_crossfade(self, seconds: float) -> None:
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            seconds = 4.0
        self._cf = max(0.0, min(12.0, seconds))
        buf = int((max(self._cf, 3.0) + 2.0) * self.sr)
        for s in (self._cur, self._next):
            if s is not None:
                s.max_buffer = buf

    def set_normalize(self, on: bool) -> None:
        self._normalize = bool(on)
        with self._lock:
            streams = [self._cur, self._next] + [f[0] for f in self._fading]
        for s in streams:
            if s is None:
                continue
            if self._normalize and not s.lufs_known:
                def got(lufs, s=s):
                    s.lufs, s.lufs_known = lufs, True
                    self._apply_norm(s)
                loudness.request(s.path, got)
            self._apply_norm(s)

    def set_eq(self, gains, on: bool = True) -> None:
        try:
            g = [float(x) for x in gains][:10]
        except (TypeError, ValueError):
            g = []
        g = [max(-12.0, min(12.0, x)) if math.isfinite(x) else 0.0 for x in g] + [0.0] * (10 - len(g))
        self._eq_gains = g
        self._eq_on = bool(on)
        sos, pre = design_eq(g, self.sr) if on else (None, 1.0)
        with self._lock:    # zi сохраняется — коэффициенты меняются без сброса состояния
            self._eq_sos, self._eq_pre = sos, pre

    def analyze(self, path) -> None:
        """Заранее посчитать громкость (например, для предзагруженного трека)."""
        if self._normalize and path:
            loudness.request(str(path))

    def spectrum_now(self) -> list:
        return [float(x) for x in self._spec.vals]

    # ------------------------------------------------------------------
    # GUI-опрос: все сигналы отсюда
    # ------------------------------------------------------------------
    def _set_state(self, st) -> None:
        if st != self._state:
            self._state = st
            self.playbackStateChanged.emit(st)

    def _set_status(self, st) -> None:
        if st != self._status:
            self._status = st
            self.mediaStatusChanged.emit(st)

    def _poll(self) -> None:
        try:
            self._poll_inner()
        except Exception as e:  # noqa: BLE001 — опрос не должен ронять GUI
            print("audio poll:", e)

    def _poll_inner(self) -> None:
        self._tick += 1
        if self._cb_error:
            print("audio callback:", self._cb_error)
            self._cb_error = ""
        with self._lock:
            switches = list(self._switches)
            self._switches.clear()
            cur, nxt = self._cur, self._next
            ended = self._ended is not None and self._ended is cur
            if ended:
                self._ended = None
            if nxt is not None and nxt.error:
                print("audio: next track failed:", nxt.error)
                nxt.close()
                self._next = None
                nxt = None
            busy = self._playing or self._dying or self._run_gain > 0

        # 1) переходы
        for s, prev_ms in switches:
            if s is self._cur:
                self._last_pos = -1
                self.trackSwitched.emit(s.path, prev_ms)
                if s is self._cur:
                    d = self.duration()
                    if d:
                        self.durationChanged.emit(d)
        cur = self._cur
        # 2) ошибка открытия текущего
        if cur is not None and cur.error:
            msg = cur.error
            with self._lock:
                if self._cur is cur:
                    self._cur = None
                    self._playing = False
            self._set_state(PS.StoppedState)
            self._set_status(MS.InvalidMedia)
            self.errorOccurred.emit(QMediaPlayer.Error.FormatError, msg)
            return
        # 3) статус загрузки
        if cur is not None and self._status in (MS.LoadingMedia, MS.LoadedMedia, MS.StalledMedia):
            if cur.has_data():
                self._set_status(MS.BufferedMedia)
                d = self.duration()
                if d:
                    self.durationChanged.emit(d)
        # 4) конец трека без следующего
        if ended:
            self._set_state(PS.StoppedState)
            self._set_status(MS.EndOfMedia)
            return
        cur = self._cur
        # 5) скоро конец → плеер готовит следующий
        if cur is not None and self._playing and not cur.atf_sent and self._next is None:
            rem = cur.remaining_exact()
            if rem is None:
                rem = cur.remaining_estimate()
            if rem is not None and rem <= max(self._cf, 3.0) * self.sr and cur.pos > 0:
                cur.atf_sent = True
                self.aboutToFinish.emit()
        # 6) позиция (~10 раз в секунду)
        if self._playing and self._tick % 3 == 0:
            p = self.position()
            if p != self._last_pos:
                self._last_pos = p
                self.positionChanged.emit(p)
        # 7) спектр
        if busy and self._tap_frames:
            w = self._tap_w
            tap = self._tap
            seg = np.concatenate([tap[w:], tap[:w]])[-SPEC_N:].astype(np.float64)
            self.spectrum.emit(self._spec.compute(seg))
        else:
            vals = self._spec.decay()
            if vals is not None:
                self.spectrum.emit(vals)
        # 8) устройство: умерло → переоткрыть; простаивает → отпустить (Windows не уснёт с открытым звуком)
        now = time.monotonic()
        if self._out_running and self._out is not None:
            if self._playing and not getattr(self._out, "active", True) and now >= self._reopen_at:
                self._reopen_at = now + 2.0
                self._reopen("поток остановился")
            if busy:
                self._idle_since = None
            elif self._idle_since is None:
                self._idle_since = now
            elif now - self._idle_since > 5.0:
                try:
                    self._out.stop()
                except Exception:  # noqa: BLE001
                    pass
                self._out_running = False
                self._idle_since = None
