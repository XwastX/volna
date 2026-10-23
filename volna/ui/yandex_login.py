"""Окно входа в Яндекс Музыку: страница OAuth во встроенном браузере.

Яндекс после входа перенаправляет на адрес вида ...#access_token=XXX&expires_in=...
Мы ловим этот адрес (до загрузки страницы), забираем токен и закрываем окно.
Куки Яндекса живут в отдельном профиле (data_dir()/ym_profile) и не смешиваются со страницей приложения.
Если встроенный браузер не справился (капча, двухфакторка), можно вставить токен или адрес вручную.
"""
from __future__ import annotations

from PySide6.QtCore import QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QApplication, QDialog, QHBoxLayout, QLabel, QLineEdit, QPushButton,
                               QVBoxLayout)

from ..config import data_dir
from ..yandex import OAUTH_URL, token_from_url

try:
    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
    from PySide6.QtWebEngineWidgets import QWebEngineView
except ImportError:  # pragma: no cover — без WebEngine остаётся только ручной ввод
    QWebEnginePage = QWebEngineProfile = QWebEngineView = None

_profile = None


def ym_profile():
    """Постоянный профиль браузера только для Яндекса (живёт до конца приложения)."""
    global _profile
    if _profile is None and QWebEngineProfile is not None:
        path = data_dir() / "ym_profile"
        path.mkdir(parents=True, exist_ok=True)
        _profile = QWebEngineProfile("volna-yandex", QApplication.instance())
        _profile.setPersistentStoragePath(str(path))
        _profile.setCachePath(str(path / "cache"))
        _profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies)
    return _profile


if QWebEnginePage is not None:
    class _OAuthPage(QWebEnginePage):
        token_found = Signal(str)
        denied = Signal()

        def acceptNavigationRequest(self, url, nav_type, is_main_frame):  # noqa: N802 — имя из Qt
            s = url.toString()
            if "access_token=" in s:
                tok = token_from_url(s)
                if tok:
                    self.token_found.emit(tok)
                    return False   # страницу Яндекс Музыки грузить незачем
            if "error=access_denied" in s:
                self.denied.emit()
                return False
            return super().acceptNavigationRequest(url, nav_type, is_main_frame)
else:  # pragma: no cover
    _OAuthPage = None


class YandexLoginDialog(QDialog):
    """После закрытия: self.token — строка или None (отмена)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Вход в Яндекс Музыку")
        self.resize(520, 720)
        self.token: str | None = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 8)
        self.view = None
        if QWebEngineView is not None and ym_profile() is not None:
            self.view = QWebEngineView(self)
            self.page = _OAuthPage(ym_profile(), self.view)
            self.page.token_found.connect(self._got)
            self.page.denied.connect(self.reject)
            self.view.setPage(self.page)
            self.view.urlChanged.connect(self._on_url)
            lay.addWidget(self.view, 1)
            self.view.load(QUrl(OAUTH_URL))
        else:
            info = QLabel("Встроенный браузер недоступен. Открой вход в обычном браузере и вставь сюда "
                          "адрес страницы, на которую он тебя перенаправит (с access_token=…).")
            info.setWordWrap(True)
            lay.addWidget(info)
        # ручной запасной путь
        row = QHBoxLayout()
        row.setContentsMargins(8, 0, 8, 0)
        self.manual = QLineEdit(self)
        self.manual.setPlaceholderText("Или вставь токен / адрес с access_token=…")
        self.manual.returnPressed.connect(self._manual)
        ok = QPushButton("Готово", self)
        ok.clicked.connect(self._manual)
        ext = QPushButton("Открыть в браузере", self)
        ext.setToolTip("Если тут капча или вход не проходит — войди в обычном браузере и скопируй адрес")
        ext.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(OAUTH_URL)))
        row.addWidget(self.manual, 1)
        row.addWidget(ok)
        row.addWidget(ext)
        lay.addLayout(row)

    def _on_url(self, url: QUrl) -> None:
        tok = token_from_url(url.toString())
        if tok:
            self._got(tok)

    def _manual(self) -> None:
        text = self.manual.text().strip()
        if not text:
            return
        tok = token_from_url(text) if ("access_token=" in text) else text
        if tok:
            self._got(tok)

    def _got(self, token: str) -> None:
        if self.token:
            return
        self.token = token
        if self.view is not None:
            self.view.stop()
        self.accept()


def ask_token(parent=None) -> str | None:
    """Модальный вариант (для отладки/скриптов): вернуть токен или None."""
    dlg = YandexLoginDialog(parent)
    dlg.exec()
    return dlg.token
