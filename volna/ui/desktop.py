"""Volna как часть Windows: окно управления музыкой и медиаклавиши, трей, мини-плеер, статус в Discord.

Всё здесь необязательное: если чего-то нет (не Windows, нет пакета, Discord не запущен),
приложение просто работает без этой функции.
"""
from __future__ import annotations

import ctypes
import sys
import threading
import time

from PySide6.QtCore import QAbstractNativeEventFilter, QObject, QPoint, QRectF, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QAction, QColor, QFont, QIcon, QPainter, QPainterPath, QPixmap
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkRequest
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget

from ..config import settings

IS_WIN = sys.platform.startswith("win")


# ===========================================================================
# Окно управления музыкой Windows (SMTC) + медиаклавиши
# ===========================================================================
class MediaControls(QObject):
    """System Media Transport Controls: плашка с обложкой при нажатии медиаклавиш, кнопки на экране блокировки.

    Через WinRT (пакеты winrt-*). Если их нет — медиаклавиши ловим глобальными горячими клавишами.
    """
    command = Signal(str)  # play / pause / toggle / next / prev

    def __init__(self, parent=None):
        super().__init__(parent)
        self.ok = False
        self._mp = None
        self._smtc = None
        self._art_url = ""
        if not IS_WIN:
            return
        try:
            from winrt.windows.media.playback import MediaPlayer
            self._mp = MediaPlayer()
            self._mp.command_manager.is_enabled = False  # кнопками управляем сами
            smtc = self._mp.system_media_transport_controls
            smtc.is_enabled = True
            smtc.is_play_enabled = True
            smtc.is_pause_enabled = True
            smtc.is_next_enabled = True
            smtc.is_previous_enabled = True
            self._token = smtc.add_button_pressed(self._on_button)
            self._smtc = smtc
            self.ok = True
        except Exception as e:  # noqa: BLE001
            print("SMTC недоступен:", e)

    def _on_button(self, _sender, args) -> None:
        # вызывается из потока WinRT — передаём в Qt сигналом (он сам доставит в GUI-поток)
        try:
            from winrt.windows.media import SystemMediaTransportControlsButton as B
            m = {B.PLAY: "play", B.PAUSE: "pause", B.NEXT: "next", B.PREVIOUS: "prev", B.STOP: "pause"}
            cmd = m.get(args.button)
            if cmd:
                self.command.emit(cmd)
        except Exception as e:  # noqa: BLE001
            print("SMTC button:", e)

    def set_track(self, t: dict | None) -> None:
        if not self.ok:
            return
        try:
            from winrt.windows.foundation import Uri
            from winrt.windows.media import MediaPlaybackType
            from winrt.windows.storage.streams import RandomAccessStreamReference
            du = self._smtc.display_updater
            if not t:
                du.clear_all()
                du.update()
                return
            du.type = MediaPlaybackType.MUSIC
            du.music_properties.title = t.get("title") or ""
            du.music_properties.artist = t.get("artist") or ""
            art = (t.get("artwork_url") or "").replace("-t300x300.", "-t500x500.")
            if art.startswith("https://"):
                du.thumbnail = RandomAccessStreamReference.create_from_uri(Uri(art))
            du.update()
        except Exception as e:  # noqa: BLE001
            print("SMTC track:", e)

    def set_playing(self, playing: bool) -> None:
        if not self.ok:
            return
        try:
            from winrt.windows.media import MediaPlaybackStatus
            self._smtc.playback_status = MediaPlaybackStatus.PLAYING if playing else MediaPlaybackStatus.PAUSED
        except Exception as e:  # noqa: BLE001
            print("SMTC state:", e)


class MediaHotkeys(QAbstractNativeEventFilter):
    """Запасной вариант: глобальные медиаклавиши через RegisterHotKey."""
    WM_HOTKEY = 0x0312
    KEYS = {1: (0xB3, "toggle"), 2: (0xB0, "next"), 3: (0xB1, "prev"), 4: (0xB2, "pause")}

    def __init__(self, emit):
        super().__init__()
        self.emit = emit
        self.ok = False
        if not IS_WIN:
            return
        try:
            user32 = ctypes.windll.user32
            got = [user32.RegisterHotKey(None, hid, 0, vk) for hid, (vk, _c) in self.KEYS.items()]
            self.ok = any(got)
        except Exception as e:  # noqa: BLE001
            print("Медиаклавиши недоступны:", e)

    def nativeEventFilter(self, event_type, message):
        if not self.ok or event_type not in (b"windows_generic_MSG", "windows_generic_MSG"):
            return False, 0
        try:
            from ctypes import wintypes
            msg = wintypes.MSG.from_address(int(message))
            if msg.message == self.WM_HOTKEY and msg.wParam in self.KEYS:
                self.emit(self.KEYS[msg.wParam][1])
                return True, 0
        except Exception:  # noqa: BLE001
            pass
        return False, 0


# ===========================================================================
# Discord: «Слушает Volna»
# ===========================================================================
class DiscordPresence:
    """Статус в Discord. Нужен ID приложения из discord.com/developers (вводится в настройках)."""

    def __init__(self):
        self._rpc = None
        self._client_id = ""
        self._lock = threading.Lock()
        self._last: tuple | None = None
        self.status = "выключено"

    def _connect(self) -> bool:
        cid = (settings().get("discord_id") or "").strip()
        if not self._rpc and time.time() - getattr(self, "_last_try", 0) < 30 and cid == getattr(self, "_tried_id", ""):
            return False   # Discord не запущен — не долбим его на каждом треке
        self._last_try, self._tried_id = time.time(), cid
        if not settings().get("discord_on") or not cid.isdigit():
            self.close()
            self.status = "выключено" if not settings().get("discord_on") else "нужен ID приложения"
            return False
        if self._rpc and cid == self._client_id:
            return True
        self.close()
        try:
            from pypresence import Presence
            rpc = Presence(cid)
            rpc.connect()
            self._rpc, self._client_id = rpc, cid
            self.status = "подключено"
            return True
        except Exception as e:  # noqa: BLE001 — Discord не запущен и т.п.
            self.status = f"Discord не найден ({e.__class__.__name__})"
            self._rpc = None
            return False

    def update(self, t: dict | None, playing: bool, pos_ms: int) -> None:
        threading.Thread(target=self._update, args=(t, playing, pos_ms), daemon=True).start()

    def _update(self, t, playing, pos_ms) -> None:
        with self._lock:
            if not self._connect():
                return
            try:
                if not t or not playing:
                    if self._last is not None:
                        self._rpc.clear()
                        self._last = None
                    return
                key = (t.get("id"), int(time.time() - pos_ms / 1000) // 5)
                if key == self._last:
                    return
                self._last = key
                from pypresence.types import ActivityType
                start = int(time.time() - pos_ms / 1000)
                dur = (t.get("duration_ms") or 0) // 1000
                art = (t.get("artwork_url") or "").replace("-t300x300.", "-t500x500.")
                kw = dict(activity_type=ActivityType.LISTENING, details=(t.get("title") or "")[:120],
                          state=(t.get("artist") or "")[:120], start=start,
                          large_image=art if art.startswith("https://") else None,
                          large_text="Volna")
                if dur:
                    kw["end"] = start + dur
                if t.get("permalink_url"):
                    kw["buttons"] = [{"label": "Слушать на SoundCloud", "url": t["permalink_url"]}]
                self._rpc.update(**kw)
            except Exception as e:  # noqa: BLE001
                self.status = f"ошибка: {e.__class__.__name__}"
                self.close()

    def close(self) -> None:
        rpc, self._rpc, self._last = self._rpc, None, None
        if rpc is None:
            return

        def bye():
            try:
                rpc.clear()
                rpc.close()
            except Exception:  # noqa: BLE001
                pass
        # Discord может не отвечать — не держим из-за него выход из приложения
        threading.Thread(target=bye, daemon=True).start()


# ===========================================================================
# Мини-плеер поверх всех окон
# ===========================================================================
class MiniPlayer(QWidget):
    action = Signal(str)       # toggle / next / prev / like / open
    W, H = 380, 108

    def __init__(self, icon: QIcon):
        super().__init__(None, Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Tool)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowTitle("Volna — мини-плеер")
        self.setWindowIcon(icon)
        self.setFixedSize(self.W, self.H)
        self.setMouseTracking(True)
        self.t: dict | None = None
        self.playing = False
        self.pos = 0
        self.dur = 0
        self.pos_at = time.monotonic()
        self.tint = QColor("#a8bcff")
        self.cover: QPixmap | None = None
        self.bands: list[float] = []
        self._drag: QPoint | None = None
        self._hover = None
        self._nam = QNetworkAccessManager(self)
        self._timer = QTimer(self, interval=33, timeout=self.update)
        p = settings().get("mini_pos")
        if p and any(sc.availableGeometry().contains(QPoint(int(p[0]) + 40, int(p[1]) + 40)) for sc in QApplication.screens()):
            self.move(int(p[0]), int(p[1]))
        else:   # первый запуск или монитор отключили — ставим в угол основного экрана
            scr = QApplication.primaryScreen().availableGeometry()
            self.move(scr.right() - self.W - 24, scr.bottom() - self.H - 24)

    # --- данные ------------------------------------------------------------
    def set_track(self, t: dict | None) -> None:
        old = (self.t or {}).get("artwork_url")
        self.t = t
        if t and t.get("artwork_url") != old:
            self.cover = None
            url = t.get("artwork_url") or ""
            if url.startswith("http"):
                rep = self._nam.get(QNetworkRequest(QUrl(url)))
                rep.finished.connect(lambda r=rep, u=url: self._got(r, u))
        self.update()

    def _got(self, rep, url) -> None:
        pm = QPixmap()
        pm.loadFromData(rep.readAll())
        rep.deleteLater()
        if self.t and self.t.get("artwork_url") == url and not pm.isNull():
            self.cover = pm
            self.update()

    def set_playing(self, on: bool) -> None:
        self.playing = on
        self.pos_at = time.monotonic()

    def set_pos(self, pos: int, dur: int) -> None:
        self.pos, self.dur, self.pos_at = pos, dur, time.monotonic()

    def set_tint(self, c: str | None) -> None:
        self.tint = QColor(c or "#a8bcff")

    def set_bands(self, b: list) -> None:
        self.bands = b

    def showEvent(self, e):
        self._timer.start()
        super().showEvent(e)

    def hideEvent(self, e):
        self._timer.stop()
        super().hideEvent(e)

    # --- рисование ----------------------------------------------------------
    def _btn_rects(self):
        y, s = 58, 34
        x0 = 124
        return {"prev": QRectF(x0, y, s, s), "toggle": QRectF(x0 + 42, y - 2, 38, 38),
                "next": QRectF(x0 + 88, y, s, s), "like": QRectF(x0 + 134, y, s, s),
                "close": QRectF(self.W - 30, 8, 22, 22)}

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        r = QRectF(0.5, 0.5, self.W - 1, self.H - 1)
        bg = QPainterPath()
        bg.addRoundedRect(r, 16, 16)
        p.fillPath(bg, QColor(13, 20, 40, 245))
        glow = QColor(self.tint)
        glow.setAlpha(40)
        p.fillPath(bg, glow)
        p.setPen(QColor(168, 188, 255, 40))
        p.drawPath(bg)
        # обложка
        cr = QRectF(12, 12, 84, 84)
        cp = QPainterPath()
        cp.addRoundedRect(cr, 10, 10)
        p.save()
        p.setClipPath(cp)
        if self.cover:
            p.drawPixmap(cr.toRect(), self.cover)
        else:
            p.fillRect(cr, QColor("#1c2748"))
        p.restore()
        # текст
        t = self.t
        f = QFont("Segoe UI", 10)
        f.setBold(True)
        p.setFont(f)
        p.setPen(QColor("#eef1fb"))
        fm = p.fontMetrics()
        p.drawText(QRectF(110, 14, self.W - 150, 20), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   fm.elidedText(t["title"] if t else "Ничего не играет", Qt.TextElideMode.ElideRight, self.W - 150))
        f.setBold(False)
        f.setPointSizeF(9)
        p.setFont(f)
        p.setPen(QColor("#9099b8"))
        fm = p.fontMetrics()
        p.drawText(QRectF(110, 33, self.W - 150, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   fm.elidedText(t["artist"] if t else "Volna", Qt.TextElideMode.ElideRight, self.W - 150))
        # спектр справа
        if self.bands and self.playing:
            n = min(16, len(self.bands))
            step = len(self.bands) / n
            for i in range(n):
                v = max(0.04, float(self.bands[int(i * step)]))
                c = QColor(self.tint)
                c.setAlpha(150)
                h = 30 * v
                p.fillRect(QRectF(self.W - 112 + i * 6, 92 - h, 4, h), c)
        # кнопки
        rects = self._btn_rects()
        for name, rr in rects.items():
            hov = self._hover == name
            if name == "toggle":
                p.setBrush(QColor("#ffffff") if hov else QColor("#eef1fb"))
                p.setPen(Qt.PenStyle.NoPen)
                p.drawEllipse(rr)
                p.setBrush(QColor("#060a16"))
                c = rr.center()
                if self.playing:
                    p.drawRoundedRect(QRectF(c.x() - 6, c.y() - 7, 4, 14), 1, 1)
                    p.drawRoundedRect(QRectF(c.x() + 2, c.y() - 7, 4, 14), 1, 1)
                else:
                    tri = QPainterPath()
                    tri.moveTo(c.x() - 4, c.y() - 7)
                    tri.lineTo(c.x() + 7, c.y())
                    tri.lineTo(c.x() - 4, c.y() + 7)
                    tri.closeSubpath()
                    p.drawPath(tri)
                continue
            col = QColor("#eef1fb") if hov else QColor("#9099b8")
            if name == "like" and t and t.get("liked"):
                col = QColor("#ffb089")
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(col)
            c = rr.center()
            if name in ("prev", "next"):
                d = -1 if name == "prev" else 1
                tri = QPainterPath()
                tri.moveTo(c.x() - 5 * d, c.y() - 6)
                tri.lineTo(c.x() + 4 * d, c.y())
                tri.lineTo(c.x() - 5 * d, c.y() + 6)
                tri.closeSubpath()
                p.drawPath(tri)
                p.drawRect(QRectF(c.x() + 4 * d - (1 if d > 0 else 1), c.y() - 6, 2, 12))
            elif name == "like":
                hp = QPainterPath()
                x, y = c.x(), c.y() + 1
                hp.moveTo(x, y + 6)
                hp.cubicTo(x - 9, y, x - 6, y - 8, x, y - 3)
                hp.cubicTo(x + 6, y - 8, x + 9, y, x, y + 6)
                if t and t.get("liked"):
                    p.drawPath(hp)
                else:
                    p.setBrush(Qt.BrushStyle.NoBrush)
                    pen = p.pen()
                    pen.setColor(col)
                    pen.setWidthF(1.6)
                    pen.setStyle(Qt.PenStyle.SolidLine)
                    p.setPen(pen)
                    p.drawPath(hp)
            elif name == "close":
                pen = p.pen()
                pen.setColor(col)
                pen.setWidthF(1.6)
                pen.setStyle(Qt.PenStyle.SolidLine)
                p.setPen(pen)
                p.drawLine(c + QPoint(-5, -5), c + QPoint(5, 5))
                p.drawLine(c + QPoint(-5, 5), c + QPoint(5, -5))
        # прогресс
        pos = self.pos + ((time.monotonic() - self.pos_at) * 1000 if self.playing else 0)
        frac = min(1.0, pos / self.dur) if self.dur else 0
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(168, 188, 255, 45))
        p.drawRoundedRect(QRectF(110, self.H - 10, self.W - 126, 3), 1.5, 1.5)
        p.setBrush(self.tint)
        p.drawRoundedRect(QRectF(110, self.H - 10, (self.W - 126) * frac, 3), 1.5, 1.5)

    # --- мышь ---------------------------------------------------------------
    def _hit(self, pos):
        for name, rr in self._btn_rects().items():
            if rr.adjusted(-4, -4, 4, 4).contains(pos):
                return name
        return None

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            name = self._hit(e.position())
            if name == "close":
                self.hide()
                settings().set("mini_on", False)
            elif name:
                self.action.emit(name)
            else:
                self._drag = e.globalPosition().toPoint() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, e):
        if self._drag is not None:
            self.move(e.globalPosition().toPoint() - self._drag)
        else:
            h = self._hit(e.position())
            if h != self._hover:
                self._hover = h
                self.setCursor(Qt.CursorShape.PointingHandCursor if h else Qt.CursorShape.ArrowCursor)
                self.update()

    def mouseReleaseEvent(self, _e):
        if self._drag is not None:
            self._drag = None
            settings().set("mini_pos", [self.x(), self.y()])

    def mouseDoubleClickEvent(self, e):
        if not self._hit(e.position()):
            self.action.emit("open")

    def leaveEvent(self, _e):
        self._hover = None
        self.update()


# ===========================================================================
# Трей
# ===========================================================================
class Tray(QSystemTrayIcon):
    action = Signal(str)  # show / mini / toggle / next / prev / quit

    def __init__(self, icon: QIcon, parent=None):
        super().__init__(icon, parent)
        self.setToolTip("Volna")
        m = QMenu()
        self._title = QAction("Ничего не играет", m, enabled=False)
        m.addAction(self._title)
        m.addSeparator()
        self._play = m.addAction("Играть", lambda: self.action.emit("toggle"))
        m.addAction("Следующий трек", lambda: self.action.emit("next"))
        m.addAction("Предыдущий трек", lambda: self.action.emit("prev"))
        m.addSeparator()
        m.addAction("Открыть Volna", lambda: self.action.emit("show"))
        m.addAction("Мини-плеер", lambda: self.action.emit("mini"))
        m.addSeparator()
        m.addAction("Выйти", lambda: self.action.emit("quit"))
        self._menu = m
        self.setContextMenu(m)
        self.activated.connect(self._on_activated)

    def _on_activated(self, reason):
        if reason in (QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick):
            self.action.emit("show")
        elif reason == QSystemTrayIcon.ActivationReason.MiddleClick:
            self.action.emit("toggle")

    def set_track(self, t: dict | None) -> None:
        text = f"{t['artist']} — {t['title']}" if t else "Ничего не играет"
        self._title.setText(text[:60])
        self.setToolTip(f"Volna\n{text}"[:120])

    def set_playing(self, on: bool) -> None:
        self._play.setText("Пауза" if on else "Играть")
