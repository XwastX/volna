"""Офлайн-режим: скачанные треки лежат в %APPDATA%\\Volna\\offline.

Кэш (cache/) чистится сам по лимиту, а папка offline — нет: файл удаляется только когда
пользователь сам убирает трек из скачанного. В базе у трека хранится имя файла (колонка offline).
"""
from __future__ import annotations

import shutil
import threading
from collections import deque
from pathlib import Path

from .config import data_dir
from .db import Database

MIN_SIZE = 50_000


def offline_dir() -> Path:
    p = data_dir() / "offline"
    p.mkdir(parents=True, exist_ok=True)
    return p


def file_for(t: dict | None) -> Path | None:
    """Скачанный файл трека, если он на месте."""
    name = (t or {}).get("offline") or ""
    if not name or "/" in name or "\\" in name:
        return None
    p = offline_dir() / name
    try:
        if p.is_file() and p.stat().st_size > MIN_SIZE:
            return p
    except OSError:
        pass
    return None


def total_bytes() -> int:
    n = 0
    for p in offline_dir().iterdir():
        try:
            if p.is_file():
                n += p.stat().st_size
        except OSError:
            pass
    return n


def remove(db: Database, ids: list[int]) -> int:
    n = 0
    for tid in ids:
        t = db.track(db.resolve(int(tid)))
        if not t:
            continue
        p = file_for(t)
        if p:
            try:
                p.unlink()
            except OSError:
                pass
        if t.get("offline"):
            db.set_offline(t["id"], "")
            n += 1
    return n


def cleanup(db: Database) -> None:
    """Убирает отметки у треков, чьи файлы пропали, и файлы, на которые никто не ссылается."""
    names = set()
    for t in db.offline_tracks():
        if file_for(t):
            names.add(t["offline"])
        else:
            db.set_offline(t["id"], "")
    for p in offline_dir().iterdir():
        if p.is_file() and p.name not in names:
            try:
                p.unlink()
            except OSError:
                pass


class Downloader:
    """Очередь скачивания в одном фоновом потоке.

    fetch(track, progress) -> путь к файлу в кэше (Player._fetch: Яндекс или SoundCloud).
    on_change(status) вызывается из фонового потока — мост переправляет его в GUI сигналом.
    """

    def __init__(self, db: Database, fetch, on_change=None) -> None:
        self.db, self.fetch, self.on_change = db, fetch, on_change
        self._q: deque[int] = deque()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._cancel = False
        self.done = self.total = self.failed = 0
        self.current = ""
        self.frac = 0.0
        self.last_error = ""

    def status(self) -> dict:
        with self._lock:
            return {"active": bool(self._thread and self._thread.is_alive()), "done": self.done,
                    "total": self.total, "failed": self.failed, "current": self.current,
                    "frac": round(self.frac, 3), "queued": len(self._q), "error": self.last_error}

    def _notify(self) -> None:
        if self.on_change:
            try:
                self.on_change(self.status())
            except Exception:  # noqa: BLE001
                pass

    def add(self, ids: list[int]) -> int:
        added = 0
        with self._lock:
            if not (self._thread and self._thread.is_alive()):
                self.done = self.total = self.failed = 0
                self.last_error = ""
            queued = set(self._q)
            for tid in ids:
                tid = self.db.resolve(int(tid))
                if tid in queued:
                    continue
                t = self.db.track(tid)
                if not t or file_for(t):
                    continue
                self._q.append(tid)
                queued.add(tid)
                added += 1
            self.total += added
            self._cancel = False
            if added and not (self._thread and self._thread.is_alive()):
                self._thread = threading.Thread(target=self._run, daemon=True, name="offline-dl")
                self._thread.start()
        self._notify()
        return added

    def cancel(self) -> None:
        with self._lock:
            self._cancel = True
            self.total -= len(self._q)
            self._q.clear()
        self._notify()

    def _run(self) -> None:
        while True:
            with self._lock:
                if self._cancel or not self._q:
                    self.current = ""
                    self._thread = None
                    break
                tid = self._q.popleft()
            t = self.db.track(tid)
            if not t:
                continue
            with self._lock:
                self.current = f"{t['artist']} — {t['title']}"
                self.frac = 0.0
            self._notify()
            try:
                self.save(t)
            except Exception as e:  # noqa: BLE001
                with self._lock:
                    self.failed += 1
                    self.last_error = f"{t['title']}: {e}"
            with self._lock:
                self.done += 1
            self._notify()
        self._notify()

    def save(self, t: dict) -> Path:
        """Скачать один трек (если он уже в кэше — просто скопировать)."""
        tr = dict(t)

        def prog(f, *_):
            self.frac = f or 0.0

        src = Path(self.fetch(tr, prog))
        tid = self.db.resolve(tr["id"])
        dst = offline_dir() / f"t{tid}{src.suffix.lower() or '.mp3'}"
        tmp = dst.with_suffix(dst.suffix + ".part")
        shutil.copyfile(src, tmp)
        tmp.replace(dst)
        self.db.set_offline(tid, dst.name)
        return dst
