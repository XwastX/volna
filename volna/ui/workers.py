"""Фоновые задачи: сеть и база не должны подвешивать окно."""
from __future__ import annotations

import traceback

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, Slot


class _Signals(QObject):
    done = Signal(object)
    error = Signal(str)
    progress = Signal(float, str)
    finished = Signal()


class _Task(QRunnable):
    def __init__(self, fn, with_progress: bool):
        super().__init__()
        self.fn = fn
        self.with_progress = with_progress
        self.signals = _Signals()
        self.cancelled = False

    @Slot()
    def run(self):
        try:
            if self.with_progress:
                res = self.fn(lambda frac, text="": self.signals.progress.emit(float(frac), str(text)))
            else:
                res = self.fn()
        except Exception as e:  # noqa: BLE001 — показываем пользователю любую ошибку
            traceback.print_exc()
            if not self.cancelled:
                self._safe(self.signals.error, str(e) or e.__class__.__name__)
        else:
            if not self.cancelled:
                self._safe(self.signals.done, res)
        finally:
            self._safe(self.signals.finished)

    @staticmethod
    def _safe(sig, *args) -> None:
        """Приложение могло уже закрыться, пока задача работала, — тогда сигнал некому отправлять."""
        try:
            sig.emit(*args)
        except RuntimeError:
            pass


SHUTDOWN = False   # True при закрытии окна — длинные задачи должны остановиться

_alive: set[_Task] = set()
_pool = QThreadPool()
_pool.setMaxThreadCount(6)


def run_bg(fn, on_done=None, on_error=None, on_progress=None) -> _Task:
    """Запускает fn в фоне. Если задан on_progress, fn получает функцию progress(доля, текст)."""
    task = _Task(fn, on_progress is not None)
    task.setAutoDelete(False)
    _alive.add(task)

    def finish(*_):
        _alive.discard(task)

    if on_done:
        task.signals.done.connect(on_done)
    if on_error:
        task.signals.error.connect(on_error)
    if on_progress:
        task.signals.progress.connect(on_progress)
    task.signals.finished.connect(finish)
    _pool.start(task)
    return task


def shutdown(timeout_ms: int = 1500) -> None:
    """Закрытие приложения: отменяем очередь задач и коротко ждём текущие."""
    global SHUTDOWN
    SHUTDOWN = True
    for t in list(_alive):
        t.cancelled = True
    _pool.clear()
    _pool.waitForDone(timeout_ms)
