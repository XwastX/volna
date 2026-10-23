"""Окно «Кто слушает?»: выбор аккаунта, пароль, создание нового. Показывается до главного окна."""
from __future__ import annotations

import json
import traceback

from PySide6.QtCore import QObject, QUrl, Signal, Slot
from PySide6.QtGui import QColor, QIcon
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEngineScript
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QMainWindow

from .. import APP_NAME, accounts
from .main_window import BG, ICON_PATH, WEB_DIR, _dark_titlebar, _Page, _webchannel_js


class _Auth(QObject):
    reply = Signal(int, str)
    logged_in = Signal()

    @Slot(int, str, str)
    def call(self, rid: int, method: str, args: str) -> None:
        try:
            a = json.loads(args or "{}")
            if method == "state":
                res = {"accounts": accounts.list_accounts(), "legacy": accounts.legacy_data(), "last": accounts.last_id()}
            elif method == "create":
                res = accounts.create(str(a.get("name") or ""), str(a.get("password") or ""))
            elif method == "login":
                res = accounts.login(str(a.get("id") or ""), str(a.get("password") or ""))
            else:
                raise ValueError(f"нет метода {method}")
        except Exception as e:  # noqa: BLE001
            if not isinstance(e, ValueError):
                traceback.print_exc()
            self.reply.emit(rid, json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
            return
        self.reply.emit(rid, json.dumps({"ok": True, "data": res}, ensure_ascii=False))
        if method == "login":
            self.logged_in.emit()


class LoginWindow(QMainWindow):
    done = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(f"{APP_NAME} — вход")
        if ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(ICON_PATH)))
        self.resize(980, 660)
        self.setStyleSheet(f"QMainWindow {{ background: {BG}; }}")
        self.view = QWebEngineView(self)
        page = _Page(self.view)
        page.setBackgroundColor(QColor(BG))
        self.view.setPage(page)
        self.auth = _Auth(self)
        self.auth.logged_in.connect(self.done.emit)
        self.channel = QWebChannel(page)
        self.channel.registerObject("auth", self.auth)
        page.setWebChannel(self.channel)
        script = QWebEngineScript()
        script.setName("qwebchannel")
        script.setSourceCode(_webchannel_js())
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        page.scripts().insert(script)
        self.view.load(QUrl.fromLocalFile(str(WEB_DIR / "login.html")))
        self.setCentralWidget(self.view)
        _dark_titlebar(self)


def auto_login(force_choose: bool = False) -> bool:
    """Без окна входа: единственный аккаунт без пароля (и не просили сменить аккаунт)."""
    if force_choose:
        return False
    accs = accounts.list_accounts()
    if len(accs) == 1 and not accs[0]["locked"]:
        accounts.login(accs[0]["id"], "")
        return True
    return False
