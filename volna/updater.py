"""Проверка обновлений через GitHub Releases.

В настройках указывается репозиторий вида «egor/volna». Релиз с тегом v0.6.0 и файлом
Volna-Setup-*.exe считается новой версией: приложение скачивает установщик и запускает его.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile

import requests

from . import __version__
from .config import settings

UA = f"Volna/{__version__}"


def _ver(s: str) -> tuple:
    nums = re.findall(r"\d+", s or "")
    return tuple(int(x) for x in nums[:3]) + (0,) * (3 - len(nums[:3]))


DEFAULT_REPO = "XwastX/volna"   # отсюда приходят обновления, если в настройках не указан свой
_last_url = ""          # ссылка из последней проверки — ставим только её, а не то, что пришло из интерфейса
ALLOWED_HOSTS = ("https://github.com/", "https://objects.githubusercontent.com/",
                 "https://release-assets.githubusercontent.com/")


def is_installed() -> bool:
    """Обновляться установщиком имеет смысл только у собранной программы, а не при запуске из исходников."""
    return bool(getattr(sys, "frozen", False))


def check() -> dict:
    global _last_url
    repo = (settings().get("update_repo") or DEFAULT_REPO).strip().strip("/")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        return {"configured": False, "current": __version__}
    try:
        r = requests.get(f"https://api.github.com/repos/{repo}/releases/latest",
                         headers={"User-Agent": UA, "Accept": "application/vnd.github+json"}, timeout=12)
    except requests.RequestException as e:
        raise RuntimeError(f"Нет связи с GitHub: {e}") from e
    if r.status_code == 404:
        return {"configured": True, "current": __version__, "available": False, "note": "В репозитории пока нет релизов"}
    if not r.ok:
        raise RuntimeError(f"GitHub ответил {r.status_code}")
    rel = r.json()
    tag = rel.get("tag_name") or ""
    asset = next((a for a in rel.get("assets") or []
                  if a.get("name", "").lower().endswith(".exe") and "setup" in a.get("name", "").lower()), None)
    newer = _ver(tag) > _ver(__version__)
    _last_url = asset.get("browser_download_url", "") if (asset and newer) else ""
    return {"configured": True, "current": __version__, "latest": tag.lstrip("v"),
            "available": bool(newer and asset), "installed": is_installed(),
            "notes": (rel.get("body") or "")[:2000], "url": asset.get("browser_download_url") if asset else "",
            "size": asset.get("size") if asset else 0, "page": rel.get("html_url", "")}


def download_and_run(progress=None) -> None:
    url = _last_url
    if not url or not url.startswith(ALLOWED_HOSTS):
        raise RuntimeError("Сначала проверь обновления — установщик берётся только из релизов GitHub")
    path = os.path.join(tempfile.gettempdir(), "Volna-Setup-update.exe")
    with requests.get(url, stream=True, timeout=60, headers={"User-Agent": UA}) as r:
        r.raise_for_status()
        if not r.url.startswith(ALLOWED_HOSTS):   # после редиректов тоже только GitHub
            raise RuntimeError("Установщик пришёл не с GitHub — обновление отменено")
        total = int(r.headers.get("content-length") or 0)
        done = 0
        with open(path, "wb") as f:
            for chunk in r.iter_content(256 * 1024):
                f.write(chunk)
                done += len(chunk)
                if progress and total:
                    progress(done / total, "Скачиваю обновление")
    if not sys.platform.startswith("win"):
        raise RuntimeError("Обновление ставится только на Windows")
    # тихая установка поверх, потом установщик сам запустит Volna
    subprocess.Popen([path, "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], close_fds=True)
