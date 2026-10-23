"""Окно приложения: веб-интерфейс (Qt WebEngine) поверх Python-ядра."""
from __future__ import annotations

import ctypes
import sys
from pathlib import Path

from PySide6.QtCore import QFile, QIODevice, Qt, QUrl
from PySide6.QtGui import QColor, QIcon
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineScript, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QMainWindow

from .. import APP_NAME
from ..config import settings
from ..db import Database
from ..soundcloud import SoundCloud
from .bridge import Bridge
from .desktop import DiscordPresence, MediaControls, MediaHotkeys, MiniPlayer, Tray
from .player import Player

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "icon.ico"
BG = "#060a16"


class _Page(QWebEnginePage):
    """Ссылки наружу открываем в браузере, а не внутри приложения."""

    def acceptNavigationRequest(self, url, nav_type, is_main_frame):
        if url.scheme() in ("http", "https"):
            from PySide6.QtGui import QDesktopServices
            QDesktopServices.openUrl(url)
            return False
        return super().acceptNavigationRequest(url, nav_type, is_main_frame)

    def javaScriptConsoleMessage(self, level, message, line, source):
        print(f"[js] {message} ({Path(source).name}:{line})")


def _webchannel_js() -> str:
    f = QFile(":/qtwebchannel/qwebchannel.js")
    if f.open(QIODevice.OpenModeFlag.ReadOnly):
        return bytes(f.readAll()).decode("utf-8")
    return ""


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        if ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(ICON_PATH)))
        self.resize(1320, 840)
        self.setMinimumSize(1000, 660)
        self.setStyleSheet(f"QMainWindow {{ background: {BG}; }}")

        self.db = Database()
        self.sc = SoundCloud()
        self.player = Player(self.db, self.sc, self)

        self.view = QWebEngineView(self)
        page = _Page(self.view)
        page.setBackgroundColor(QColor(BG))
        self.view.setPage(page)
        s = page.settings()
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        s.setAttribute(QWebEngineSettings.WebAttribute.ScrollAnimatorEnabled, True)
        self.view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)

        self.bridge = Bridge(self.db, self.sc, self.player, self)
        self.channel = QWebChannel(page)
        self.channel.registerObject("api", self.bridge)
        page.setWebChannel(self.channel)

        script = QWebEngineScript()
        script.setName("qwebchannel")
        script.setSourceCode(_webchannel_js())
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        page.scripts().insert(script)

        page.profile().downloadRequested.connect(self._download)   # экспорт темы и пр. из интерфейса
        self.view.load(QUrl.fromLocalFile(str(WEB_DIR / "index.html")))
        self.setCentralWidget(self.view)
        self.player.track_changed.connect(self._title)
        _dark_titlebar(self)
        self._quitting = False
        self._setup_desktop()

    def _download(self, item) -> None:
        """Скачивание из веб-интерфейса (например, экспорт темы) — спрашиваем, куда сохранить."""
        from PySide6.QtWidgets import QFileDialog
        name = item.downloadFileName() or "volna-file"
        path, _ = QFileDialog.getSaveFileName(self, "Сохранить файл", name)
        if not path:
            item.cancel()
            return
        p = Path(path)
        item.setDownloadDirectory(str(p.parent))
        item.setDownloadFileName(p.name)
        item.accept()

    def _title(self, t) -> None:
        self.setWindowTitle(f"{t['artist']} — {t['title']}" if t else APP_NAME)

    # --- Windows: медиаклавиши, трей, мини-плеер, Discord ----------------------
    def _setup_desktop(self) -> None:
        icon = self.windowIcon()
        p = self.player
        self.media = MediaControls(self)
        self.media.command.connect(self.remote)
        self.hotkeys = None
        if not self.media.ok:
            self.hotkeys = MediaHotkeys(self.remote)
            if self.hotkeys.ok:
                QApplication.instance().installNativeEventFilter(self.hotkeys)
        self.tray = Tray(icon, self)
        self.tray.action.connect(self.remote)
        if QSystemTrayIcon_available():
            self.tray.show()
        self.mini = MiniPlayer(icon)
        self.mini.action.connect(self.remote)
        self.discord = DiscordPresence()
        self._playing = False

        def on_track(t):
            self.media.set_track(t)
            self.tray.set_track(t)
            self.mini.set_track(t)
            self.discord.update(t, self._playing, 0)

        def on_playing(on):
            self._playing = on
            self.media.set_playing(on)
            self.tray.set_playing(on)
            self.mini.set_playing(on)
            self.discord.update(p.current, on, p.mp.position())

        p.track_changed.connect(on_track)
        p.playing_changed.connect(on_playing)
        p.position_changed.connect(self.mini.set_pos)
        self.bridge.tint.connect(self.mini.set_tint)
        if hasattr(p, "spectrum"):
            p.spectrum.connect(self.mini.set_bands)
        if settings().get("mini_on"):
            self.mini.show()

    def remote(self, cmd: str) -> None:
        """Команды из трея, мини-плеера, медиаклавиш."""
        p = self.player
        playing = self._playing
        if cmd == "toggle":
            if p.current:
                p.toggle()
            else:
                self.bridge.emit("remote", "wave")
        elif cmd == "play" and not playing:
            p.toggle() if p.current else self.bridge.emit("remote", "wave")
        elif cmd == "pause" and playing:
            p.toggle()
        elif cmd == "next":
            p.next()
        elif cmd == "prev":
            p.prev()
        elif cmd == "like":
            liked = p.like_current()
            self.bridge.after_like(p.current, liked)
            self.mini.update()
            self.bridge.emit("track-like", liked)
        elif cmd in ("show", "open"):
            self.show()
            self.setWindowState(self.windowState() & ~Qt.WindowState.WindowMinimized)
            self.raise_()
            self.activateWindow()
        elif cmd == "mini":
            self.toggle_mini()
        elif cmd == "quit":
            self.quit_app()

    def toggle_mini(self) -> bool:
        on = not self.mini.isVisible()
        self.mini.setVisible(on)
        settings().set("mini_on", on)
        return on

    def quit_app(self) -> None:
        self._quitting = True
        if hasattr(self.bridge, "scrobble_on_quit"):
            self.bridge.scrobble_on_quit()
        if hasattr(self.bridge, "party_shutdown"):
            self.bridge.party_shutdown()
        self.discord.close()
        self.mini.close()
        self.tray.hide()
        QApplication.instance().quit()

    def closeEvent(self, e):
        if not self._quitting and settings().get("close_to_tray", True) and self.tray.isVisible():
            e.ignore()
            self.hide()
            if not settings().get("tray_hint_shown"):
                self.tray.showMessage("Volna продолжает играть", "Приложение свёрнуто в трей. Выйти — правый клик по значку.",
                                      self.windowIcon(), 4000)
                settings().set("tray_hint_shown", True)
            return
        self.quit_app()
        e.accept()


def QSystemTrayIcon_available() -> bool:
    from PySide6.QtWidgets import QSystemTrayIcon
    return QSystemTrayIcon.isSystemTrayAvailable()


def _dark_titlebar(win: QMainWindow) -> None:
    """Тёмная рамка окна на Windows 10/11 в цвет приложения."""
    if not sys.platform.startswith("win"):
        return
    try:
        hwnd = int(win.winId())
        dwm = ctypes.windll.dwmapi
        on = ctypes.c_int(1)
        dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(on), ctypes.sizeof(on))   # тёмный режим
        r, g, b = 0x06, 0x0a, 0x16
        color = ctypes.c_int(b << 16 | g << 8 | r)                                 # COLORREF = 0x00BBGGRR
        dwm.DwmSetWindowAttribute(hwnd, 35, ctypes.byref(color), ctypes.sizeof(color))  # цвет заголовка (Win11)
    except Exception:  # noqa: BLE001 — старая Windows, просто без тёмной рамки
        pass
