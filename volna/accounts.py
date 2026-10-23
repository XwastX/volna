"""Аккаунты: у каждого пользователя на этом компьютере своя медиатека, настройки, вход в Яндекс и т.д.

Список аккаунтов — accounts.json в корневой папке Volna. Данные аккаунта лежат в users/<id>/,
а у первого аккаунта, созданного из старых данных (до версии 0.7), — прямо в корне (dir = "").
Кэш треков общий для всех: это просто скачанный звук, по нему ничего не узнать о человеке.

Пароль хранится как PBKDF2-SHA256 (200 000 итераций, своя соль). Он закрывает вход в аккаунт в приложении,
но файлы на диске не шифрует — это защита от случайного входа, а не от того, у кого есть доступ к диску.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import shutil
import threading
import time
from pathlib import Path

from . import config

ITER = 200_000
COLORS = ["#8fa8ff", "#c38bff", "#ff8fb1", "#ffb86b", "#5fe3a1", "#5fd3ff", "#ffd23f", "#ff7a7a"]
_lock = threading.Lock()


def _path() -> Path:
    return config.root_dir() / "accounts.json"


def _load() -> dict:
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("accounts"), list):
            return d
    except (OSError, ValueError):
        pass
    return {"accounts": [], "last": ""}


def _save(d: dict) -> None:
    with _lock:
        tmp = _path().with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path())


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), ITER).hex()


def public(a: dict) -> dict:
    return {"id": a["id"], "name": a["name"], "color": a.get("color") or COLORS[0],
            "locked": bool(a.get("hash")), "last": a.get("last_login", 0)}


def list_accounts() -> list[dict]:
    return [public(a) for a in _load()["accounts"]]


def legacy_data() -> bool:
    """В корне лежат данные старой версии без аккаунтов — их заберёт первый аккаунт."""
    return (config.root_dir() / "library.db").exists() and not _load()["accounts"]


def last_id() -> str:
    return _load().get("last") or ""


def get(aid: str) -> dict | None:
    return next((a for a in _load()["accounts"] if a["id"] == aid), None)


def account_dir(a: dict) -> Path:
    root = config.root_dir()
    return root if not a.get("dir") else root / a["dir"]


def _check_name(name: str, d: dict, skip: str = "") -> str:
    name = " ".join((name or "").split())[:32]
    if not name:
        raise ValueError("Введи имя")
    if any(a["name"].lower() == name.lower() and a["id"] != skip for a in d["accounts"]):
        raise ValueError("Аккаунт с таким именем уже есть")
    return name


def create(name: str, password: str = "") -> dict:
    d = _load()
    name = _check_name(name, d)
    if password and len(password) < 4:
        raise ValueError("Пароль — минимум 4 символа (или оставь пустым)")
    aid = secrets.token_hex(6)
    first_legacy = not d["accounts"] and (config.root_dir() / "library.db").exists()
    a = {"id": aid, "name": name, "dir": "" if first_legacy else f"users/{aid}",
         "color": COLORS[len(d["accounts"]) % len(COLORS)], "created": time.time()}
    if password:
        a["salt"] = secrets.token_hex(16)
        a["hash"] = _hash(password, a["salt"])
    d["accounts"].append(a)
    _save(d)
    account_dir(a).mkdir(parents=True, exist_ok=True)
    return public(a)


def check_password(aid: str, password: str) -> bool:
    a = get(aid)
    if not a:
        return False
    if not a.get("hash"):
        return True
    return hmac.compare_digest(_hash(password or "", a["salt"]), a["hash"])


def login(aid: str, password: str = "") -> dict:
    """Проверяет пароль и делает аккаунт активным: все пути данных (база, настройки) переключаются на него."""
    a = get(aid)
    if not a:
        raise ValueError("Аккаунт не найден")
    if not check_password(aid, password):
        time.sleep(0.6)    # чуть притормаживаем перебор пароля
        raise ValueError("Неверный пароль")
    d = _load()
    for x in d["accounts"]:
        if x["id"] == aid:
            x["last_login"] = time.time()
    d["last"] = aid
    _save(d)
    activate(a)
    return public(a)


def activate(a: dict) -> None:
    config.set_profile(account_dir(a), a["id"])


def current() -> dict | None:
    aid = config.profile_id()
    a = get(aid) if aid else None
    return public(a) if a else None


def rename(aid: str, name: str) -> dict:
    d = _load()
    name = _check_name(name, d, skip=aid)
    for a in d["accounts"]:
        if a["id"] == aid:
            a["name"] = name
            _save(d)
            return public(a)
    raise ValueError("Аккаунт не найден")


def set_password(aid: str, old: str, new: str) -> None:
    if not check_password(aid, old):
        raise ValueError("Старый пароль не подходит")
    if new and len(new) < 4:
        raise ValueError("Пароль — минимум 4 символа (или оставь пустым, чтобы убрать)")
    d = _load()
    for a in d["accounts"]:
        if a["id"] == aid:
            if new:
                a["salt"] = secrets.token_hex(16)
                a["hash"] = _hash(new, a["salt"])
            else:
                a.pop("salt", None)
                a.pop("hash", None)
            _save(d)
            return
    raise ValueError("Аккаунт не найден")


def delete(aid: str, password: str = "") -> None:
    """Удаляет аккаунт. Файлы удаляются при следующем запуске (сейчас база ещё открыта)."""
    if not check_password(aid, password):
        raise ValueError("Неверный пароль")
    d = _load()
    a = next((x for x in d["accounts"] if x["id"] == aid), None)
    if not a:
        return
    d["accounts"].remove(a)
    if d.get("last") == aid:
        d["last"] = ""
    d.setdefault("trash", []).append(a.get("dir") or "")
    _save(d)


_ROOT_FILES = ("library.db", "library.db-wal", "library.db-shm", "settings.json", "lastfm_queue.json")


def purge_trash() -> None:
    """Стирает папки удалённых аккаунтов. Вызывается при запуске, пока базы ещё никто не открыл."""
    d = _load()
    trash = d.get("trash") or []
    if not trash:
        return
    root = config.root_dir()
    left = []
    for rel in trash:
        if rel:
            target = (root / rel).resolve()
            if root.resolve() not in target.parents:     # только внутри папки Volna
                continue
            shutil.rmtree(target, ignore_errors=True)
            if target.exists():
                left.append(rel)
        else:   # аккаунт из старых данных жил в корне — убираем только его файлы
            if any(not a.get("dir") for a in d["accounts"]):
                continue     # корень уже занял новый аккаунт — не трогаем
            for name in _ROOT_FILES:
                try:
                    (root / name).unlink()
                except FileNotFoundError:
                    pass
                except OSError:
                    left.append("")
            for sub in ("offline", "ym_profile"):
                shutil.rmtree(root / sub, ignore_errors=True)
    d["trash"] = sorted(set(left))
    _save(d)
