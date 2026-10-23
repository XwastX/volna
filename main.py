"""Точка входа: python main.py"""
import os
import sys

# флаги движка задаём до создания приложения
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-features=CalculateNativeWinOcclusion")

from PySide6.QtGui import QIcon  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from volna import APP_NAME, accounts  # noqa: E402
from volna.ui import workers  # noqa: E402
from volna.ui.login_window import LoginWindow, auto_login  # noqa: E402
from volna.ui.main_window import ICON_PATH, MainWindow  # noqa: E402


def main() -> int:
    if sys.platform.startswith("win"):
        try:  # своя иконка на панели задач, а не иконка Python
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Volna.Player")
        except Exception:  # noqa: BLE001
            pass
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setQuitOnLastWindowClosed(False)  # закрытие окна может сворачивать в трей
    if ICON_PATH.exists():
        app.setWindowIcon(QIcon(str(ICON_PATH)))
    windows = {}

    def open_main():
        win = windows["main"] = MainWindow()
        win.show()
        login = windows.pop("login", None)
        if login:
            login.close()
            login.deleteLater()

    try:
        accounts.purge_trash()    # файлы удалённых аккаунтов
    except Exception as e:  # noqa: BLE001
        print("purge:", e)
    if auto_login("--choose" in sys.argv):
        open_main()
    else:  # «Кто слушает?» — главное окно откроется после входа
        login = windows["login"] = LoginWindow()
        login.done.connect(open_main)
        login.show()
        app.setQuitOnLastWindowClosed(True)    # закрыли окно входа — выходим

        def keep_tray():
            if "main" in windows:
                app.setQuitOnLastWindowClosed(False)
        login.done.connect(keep_tray)

    def on_quit():
        win = windows.get("main")
        mp = win.player.mp if win else None
        try:
            if mp is not None:
                (mp.close if hasattr(mp, "close") else mp.stop)()   # освобождаем звуковое устройство
        except Exception:  # noqa: BLE001
            pass
        workers.shutdown()
    app.aboutToQuit.connect(on_quit)
    return app.exec()


if __name__ == "__main__":
    code = main()
    if sys.stdout:          # у pythonw и exe без консоли stdout = None
        sys.stdout.flush()
    # фоновые сетевые запросы могут висеть до таймаута — не ждём их, база уже сохранена
    os._exit(code)
