"""Пути к данным приложения и простые настройки в JSON."""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

from . import APP_NAME


_profile_dir: Path | None = None     # папка активного аккаунта (см. accounts.py)
_profile_id = ""


def set_profile(path: Path, pid: str) -> None:
    """Переключает все пути данных на папку аккаунта. Вызывается при входе, до создания базы и настроек."""
    global _profile_dir, _profile_id, _settings
    _profile_dir = Path(path)
    _profile_dir.mkdir(parents=True, exist_ok=True)
    _profile_id = pid
    _settings = None   # настройки перечитаются уже из папки аккаунта


def profile_id() -> str:
    return _profile_id


def data_dir() -> Path:
    """Папка данных активного аккаунта (без аккаунта — корневая папка Volna)."""
    if _profile_dir is not None:
        return _profile_dir
    return root_dir()


def root_dir() -> Path:
    override = os.environ.get("VOLNA_DATA_DIR")
    if override:
        p = Path(override)
    elif sys.platform.startswith("win"):
        p = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
    else:
        p = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / APP_NAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def cache_dir() -> Path:
    p = root_dir() / "cache"     # звук общий для всех аккаунтов
    p.mkdir(parents=True, exist_ok=True)
    return p


DB_PATH = lambda: data_dir() / "library.db"  # noqa: E731
SETTINGS_PATH = lambda: data_dir() / "settings.json"  # noqa: E731

_DEFAULTS = {
    "sc_client_id": "",
    "sc_profile_url": "",
    "volume": 70,
    "wave_mode": "mix",
}

_lock = threading.Lock()


class Settings:
    def __init__(self) -> None:
        self._data = dict(_DEFAULTS)
        try:
            with open(SETTINGS_PATH(), "r", encoding="utf-8") as f:
                self._data.update(json.load(f))
        except (OSError, ValueError):
            pass

    def get(self, key: str, default=None):
        return self._data.get(key, default)

    def set(self, key: str, value) -> None:
        with _lock:
            self._data[key] = value
            tmp = SETTINGS_PATH().with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, SETTINGS_PATH())


_settings: Settings | None = None


def settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
