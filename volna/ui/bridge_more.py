"""Расширение моста (0.6): офлайн-режим, «Музыкальная ДНК», режим вечеринки."""
from __future__ import annotations

import random

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtGui import QGuiApplication
from PySide6.QtMultimedia import QMediaPlayer

from .. import accounts, dna, offline
from ..config import settings
from ..party import Party, qr_svg
from .workers import run_bg


class _Sig(QObject):
    """Сигналы из фоновых потоков (скачивание, сервер вечеринки) в GUI-поток."""
    dl = Signal(object)
    party = Signal()
    skip = Signal()


class MoreAPI:
    def _init_more(self) -> None:
        self._msig = _Sig(self)
        self._msig.dl.connect(self._dl_status)
        # отложенно: изменение очереди может прийти прямо из обработчика смены трека
        self._msig.party.connect(self._party_apply, Qt.ConnectionType.QueuedConnection)
        self._msig.skip.connect(self._party_skip, Qt.ConnectionType.QueuedConnection)
        self._dl_last_done = -1
        player = self.player
        # скачивание идёт в сеть даже в офлайн-режиме (иначе нельзя докачать то, чего нет)
        self.downloader = offline.Downloader(self.db, lambda tr, prog: player._fetch(tr, prog, force_net=True),
                                             self._msig.dl.emit)
        run_bg(lambda: offline.cleanup(self.db), lambda _r: None, lambda _e: None)
        self.party: Party | None = None
        self._party_qr = ""
        self._party_first = None
        p = self.player
        p.track_changed.connect(self._party_track)
        p.position_changed.connect(self._party_pos)
        p.playing_changed.connect(self._party_playing)
        self._dna_cache = None

    # ======================================================================
    # офлайн
    # ======================================================================
    def _dl_status(self, s: dict) -> None:
        self.emit("offline", s)
        if s.get("done") != self._dl_last_done:
            self._dl_last_done = s.get("done")
            if not s.get("active") and s.get("total"):
                ok = s["total"] - s["failed"]
                text = f"Скачано треков: {ok}" + (f", не получилось: {s['failed']}" if s["failed"] else "")
                self.emit("toast", {"text": text, "kind": "error" if s["failed"] and not ok else "ok"})

    def _rows_for(self, kind: str | None, key, ids) -> list[dict]:
        if ids:
            return [r for r in (self.db.track(int(i)) for i in ids) if r]
        if kind == "offline":
            return self.db.offline_tracks()
        if kind and hasattr(self, "_share_tracks"):
            return self._share_tracks(kind, key)[1]
        return []

    def api_offline_add(self, rid, ids: list | None = None, kind: str | None = None, key=None):
        rows = self._rows_for(kind, key, ids)
        if not rows:
            raise ValueError("Нечего скачивать — список пустой")
        added = self.downloader.add([r["id"] for r in rows])
        return {"added": added, "already": len(rows) - added}

    def api_offline_remove(self, rid, ids: list | None = None, kind: str | None = None, key=None):
        rows = self._rows_for(kind, key, ids)
        n = offline.remove(self.db, [r["id"] for r in rows])
        self.emit("offline", self.downloader.status())
        return {"removed": n}

    def api_offline_cancel(self, rid):
        self.downloader.cancel()
        return True

    def api_offline_status(self, rid):
        return self.downloader.status() | {"mode": self.player.offline_only,
                                           "auto": bool(settings().get("offline_liked", False))}

    def api_offline_list(self, rid):
        from .bridge import slim  # noqa: PLC0415
        db = self.db

        def work():
            rows = [r for r in db.offline_tracks() if offline.file_for(r)]
            return {"rows": [slim(r) for r in rows], "bytes": offline.total_bytes(),
                    "arts": [r["artwork_url"] for r in rows if r.get("artwork_url")][:4]}
        return self._bg(rid, work)

    def api_offline_mode(self, rid, on: bool):
        settings().set("offline_mode", bool(on))
        self.player.offline_only = bool(on)
        self.emit("offline_mode", bool(on))
        return bool(on)

    def api_offline_auto(self, rid, on: bool):
        settings().set("offline_liked", bool(on))
        return bool(on)

    def offline_like_hook(self, t: dict, liked: bool) -> None:
        if liked and settings().get("offline_liked", False) and t:
            self.downloader.add([t["id"]])

    def offline_filter(self, rows: list[dict], index: int) -> tuple[list[dict], int]:
        """В офлайн-режиме из списка играют только скачанные треки."""
        if not self.player.offline_only:
            return rows, index
        picked = rows[index] if 0 <= index < len(rows) else None
        keep = [r for r in rows if offline.file_for(r)]
        if not keep:
            raise ValueError("В этом списке нет скачанных треков — в офлайн-режиме играет только скачанное")
        if picked in keep:
            return keep, keep.index(picked)
        after = [r for r in rows[index:] if r in keep]   # кликнули по нескачанному — ближайший скачанный после него
        return keep, keep.index(after[0]) if after else 0

    def offline_wave(self) -> bool:
        """«Моя волна» без интернета: перемешанные скачанные треки, любимые чаще."""
        if not self.player.offline_only:
            return False
        rows = [r for r in self.db.offline_tracks() if offline.file_for(r) and not r["disliked"]]
        if not rows:
            raise ValueError("Нет скачанных треков — скачай плейлист или «Любимые», чтобы слушать без интернета")
        rows.sort(key=lambda r: random.random() * (0.45 if r["liked"] else 1.0))
        self.context = "Волна из скачанного"
        self.player.play_list(rows, 0)
        return True

    # ======================================================================
    # Музыкальная ДНК
    # ======================================================================
    def _dna_compute(self) -> dict:
        try:
            dna.backfill(self.db, self.sc)   # год и популярность для старых треков
        except Exception as e:  # noqa: BLE001 — без интернета считаем по тому, что есть
            print("dna backfill:", e)
        d = dna.compute(self.db, self.db.by_hour(0))
        self._dna_cache = d
        return d

    def api_dna(self, rid):
        return self._bg(rid, lambda: dna.public(self._dna_compute()))

    def api_dna_code(self, rid, name: str = ""):
        d = self._dna_cache or dna.compute(self.db, self.db.by_hour(0))
        code = dna.pack(d, name)
        QGuiApplication.clipboard().setText(code)
        return {"code": code}

    def api_dna_compare(self, rid, code: str):
        if not code:
            code = QGuiApplication.clipboard().text()[:100_000]
        d = self._dna_cache or dna.compute(self.db, self.db.by_hour(0))
        return dna.compare(d, code)

    # ======================================================================
    # вечеринка
    # ======================================================================
    @property
    def party_on(self) -> bool:
        return bool(self.party and self.party.running)

    def api_party_start(self, rid):
        if not self.party_on:
            sc = self.sc
            self.party = Party(self.db, lambda q: sc.search_tracks(q, limit=20),
                               on_change=self._msig.party.emit, on_skip=self._msig.skip.emit)
            self.party.allow_skip = bool(settings().get("party_skip", True))
            self.party.start(int(settings().get("party_port", 8765) or 8765))
            self._party_qr = qr_svg(self.party.url())
            self._party_track(self.player.current)
            self._party_playing(self.player.mp.playbackState() == QMediaPlayer.PlaybackState.PlayingState)
            for t in list(self.player.user_queue):   # то, что уже стояло в очереди, — от хозяина
                self.party.host_add(t["id"])
        return self._party_info()

    def _party_info(self) -> dict:
        if not self.party_on:
            return {"on": False}
        return self.party.host_state() | {"qr": self._party_qr}

    def api_party_state(self, rid):
        return self._party_info()

    def api_party_stop(self, rid):
        if self.party:
            self.party.stop()
            self.party = None
        self.emit("party", {"on": False})
        self._on_queue()
        return True

    def api_party_remove(self, rid, qid: int):
        if self.party_on:
            self.party.remove(int(qid))
        return True

    def api_party_clear(self, rid):
        if self.party_on:
            self.party.clear()
        return True

    def api_party_allow_skip(self, rid, on: bool):
        settings().set("party_skip", bool(on))
        if self.party_on:
            self.party.allow_skip = bool(on)
        return bool(on)

    def party_intercept(self, action: str, tid: int | None = None, i: int | None = None) -> bool:
        """Действия хозяина с очередью во время вечеринки. True — обработано здесь."""
        if not self.party_on:
            return False
        if action in ("enqueue", "next") and tid:
            self.party.host_add(tid)
            return True
        if action == "remove":
            items = self.party.ordered()
            if i is not None and 0 <= i < len(items):
                self.party.remove(items[i]["qid"])
            return True
        if action == "move":
            raise ValueError("Во время вечеринки порядок очереди решают голоса гостей")
        return False

    def _party_apply(self) -> None:
        """Очередь вечеринки (по голосам) становится очередью плеера «Далее»."""
        if not self.party_on:
            return
        p = self.player
        rows = [r for r in (self.db.track(it["tid"]) for it in self.party.ordered()) if r]
        first = rows[0]["id"] if rows else None
        if first != self._party_first:
            p._unprepare()     # следующий трек сменился — переподготовим переход
            self._party_first = first
        p.user_queue = rows
        p.queue_changed.emit()
        if rows and p.current is None:      # ничего не играло (или список закончился) — запускаем
            p._advance()
        self.emit("party", self._party_info())

    def _party_skip(self) -> None:
        if self.party_on and self.player.current:
            self.emit("toast", {"text": "Гости проголосовали — пропускаем трек", "kind": "ok"})
            self.player.next()

    def _party_track(self, t) -> None:
        if not self.party_on:
            return
        self.party.now.update({"title": (t or {}).get("title") or "", "artist": (t or {}).get("artist") or "",
                               "art": (t or {}).get("artwork_url") or "", "tid": (t or {}).get("id"),
                               "pos": 0, "dur": (t or {}).get("duration_ms") or 0})
        self.party.started((t or {}).get("id"))

    def _party_pos(self, pos: int, dur: int) -> None:
        if self.party_on:
            self.party.now["pos"] = pos
            if dur:
                self.party.now["dur"] = dur

    def _party_playing(self, on: bool) -> None:
        if self.party_on:
            self.party.now["playing"] = bool(on)

    # ======================================================================
    # аккаунт
    # ======================================================================
    def api_account_info(self, rid):
        cur = accounts.current()
        return {"me": cur, "all": accounts.list_accounts()}

    def api_account_rename(self, rid, name: str):
        cur = accounts.current()
        if not cur:
            raise ValueError("Нет активного аккаунта")
        return accounts.rename(cur["id"], name)

    def api_account_password(self, rid, old: str = "", new: str = ""):
        cur = accounts.current()
        if not cur:
            raise ValueError("Нет активного аккаунта")
        accounts.set_password(cur["id"], old, new)
        return accounts.current()

    def _restart_to_login(self) -> None:
        import sys  # noqa: PLC0415
        from PySide6.QtCore import QProcess, QTimer  # noqa: PLC0415
        if getattr(sys, "frozen", False):
            QProcess.startDetached(sys.executable, [a for a in sys.argv[1:] if a != "--choose"] + ["--choose"])
        else:
            QProcess.startDetached(sys.executable, [a for a in sys.argv if a != "--choose"] + ["--choose"])
        QTimer.singleShot(300, lambda: (self.win.quit_app() if hasattr(self.win, "quit_app") else None))

    def api_account_switch(self, rid):
        self._restart_to_login()
        return True

    def api_account_delete(self, rid, password: str = ""):
        cur = accounts.current()
        if not cur:
            raise ValueError("Нет активного аккаунта")
        if not accounts.check_password(cur["id"], password):
            raise ValueError("Неверный пароль")
        if self.party:
            self.party.stop()
        accounts.delete(cur["id"], password)   # файлы сотрутся при следующем запуске
        self._restart_to_login()
        return True

    def api_clipboard_set(self, rid, text: str):
        QGuiApplication.clipboard().setText(str(text)[:10_000])
        return True

    def party_shutdown(self) -> None:
        if self.party:
            self.party.stop()
