"""Last.fm: скробблинг прослушиваний и похожие артисты для волны.

Нужен свой API-ключ (бесплатно: last.fm/api/account/create) — вводится в настройках.
Вход: auth.getToken → пользователь подтверждает в браузере → auth.getSession.
Скробблы, которые не ушли (нет сети), копятся в файле и отправляются позже.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time

import requests

from .config import data_dir, settings

API = "https://ws.audioscrobbler.com/2.0/"
UA = "Volna/0.5"


class LastFMError(Exception):
    pass


class LastFM:
    def __init__(self):
        self._lock = threading.Lock()
        self._pending_token = ""
        self._similar: dict[str, tuple[float, list[str]]] = {}
        self._queue_path = data_dir() / "lastfm_queue.json"

    # --- настройки ---------------------------------------------------------
    @property
    def key(self) -> str:
        return (settings().get("lastfm_key") or "").strip()

    @property
    def secret(self) -> str:
        return (settings().get("lastfm_secret") or "").strip()

    @property
    def session(self) -> str:
        return settings().get("lastfm_session") or ""

    @property
    def user(self) -> str:
        return settings().get("lastfm_user") or ""

    def configured(self) -> bool:
        return bool(self.key and self.secret)

    def logged_in(self) -> bool:
        return bool(self.configured() and self.session)

    def scrobbling(self) -> bool:
        return self.logged_in() and settings().get("lastfm_scrobble", True)

    # --- запросы -----------------------------------------------------------
    def _sign(self, params: dict) -> str:
        raw = "".join(f"{k}{params[k]}" for k in sorted(params) if k not in ("format", "callback"))
        return hashlib.md5((raw + self.secret).encode("utf-8")).hexdigest()

    def _call(self, method: str, params: dict | None = None, *, signed: bool = False, post: bool = False) -> dict:
        if not self.key:
            raise LastFMError("Не указан API-ключ Last.fm")
        p = {"method": method, "api_key": self.key, **(params or {})}
        if signed:
            if self.session and method not in ("auth.getToken", "auth.getSession"):
                p["sk"] = self.session
            p["api_sig"] = self._sign(p)
        p["format"] = "json"
        try:
            if post:
                r = requests.post(API, data=p, headers={"User-Agent": UA}, timeout=12)
            else:
                r = requests.get(API, params=p, headers={"User-Agent": UA}, timeout=12)
        except requests.RequestException as e:
            raise LastFMError(f"Нет связи с Last.fm: {e}") from e
        try:
            data = r.json()
        except ValueError as e:
            raise LastFMError(f"Last.fm ответил {r.status_code}") from e
        if isinstance(data, dict) and data.get("error"):
            code = data.get("error")
            if code in (4, 9, 14, 15):   # неверная/устаревшая сессия или токен
                if code == 9:
                    settings().set("lastfm_session", "")
            raise LastFMError(f"Last.fm: {data.get('message') or code}")
        return data

    # --- вход --------------------------------------------------------------
    def begin_auth(self) -> str:
        """Возвращает ссылку, которую надо открыть в браузере и подтвердить доступ."""
        if not self.configured():
            raise LastFMError("Сначала введи API-ключ и секрет Last.fm")
        tok = self._call("auth.getToken", signed=True)["token"]
        self._pending_token = tok
        return f"https://www.last.fm/api/auth/?api_key={self.key}&token={tok}"

    def finish_auth(self) -> str:
        if not self._pending_token:
            raise LastFMError("Сначала нажми «Войти» и подтверди доступ в браузере")
        data = self._call("auth.getSession", {"token": self._pending_token}, signed=True)
        sess = data.get("session") or {}
        settings().set("lastfm_session", sess.get("key", ""))
        settings().set("lastfm_user", sess.get("name", ""))
        self._pending_token = ""
        if not sess.get("key"):
            raise LastFMError("Last.fm не выдал сессию — подтверди доступ в браузере и попробуй ещё раз")
        return sess.get("name", "")

    def logout(self) -> None:
        settings().set("lastfm_session", "")
        settings().set("lastfm_user", "")

    # --- скробблинг --------------------------------------------------------
    def now_playing(self, t: dict) -> None:
        if not self.scrobbling():
            return
        p = {"artist": t["artist"], "track": t["title"]}
        if t.get("duration_ms"):
            p["duration"] = int(t["duration_ms"] / 1000)
        try:
            self._call("track.updateNowPlaying", p, signed=True, post=True)
        except LastFMError as e:
            print("lastfm now playing:", e)

    def scrobble(self, t: dict, started_at: float) -> None:
        """Ставит скроббл в очередь и пытается отправить всю очередь."""
        if not self.scrobbling():
            return
        item = {"artist": t["artist"], "track": t["title"], "timestamp": int(started_at)}
        if t.get("album"):
            item["album"] = t["album"]
        if t.get("duration_ms"):
            item["duration"] = int(t["duration_ms"] / 1000)
        with self._lock:
            q = self._load_queue()
            q.append(item)
            self._save_queue(q[-2000:])
        self.flush()

    def flush(self) -> int:
        with self._lock:
            q = self._load_queue()
            sent = 0
            while q:
                batch = q[:50]
                p = {}
                for i, it in enumerate(batch):
                    for k, v in it.items():
                        p[f"{k}[{i}]"] = v
                try:
                    self._call("track.scrobble", p, signed=True, post=True)
                except LastFMError as e:
                    print("lastfm scrobble:", e)
                    break
                q = q[50:]
                sent += len(batch)
            self._save_queue(q)
            return sent

    def pending(self) -> int:
        return len(self._load_queue())

    def _load_queue(self) -> list:
        try:
            return json.loads(self._queue_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []

    def _save_queue(self, q: list) -> None:
        try:
            self._queue_path.write_text(json.dumps(q, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def love(self, t: dict, loved: bool) -> None:
        if not self.scrobbling():
            return
        try:
            self._call("track.love" if loved else "track.unlove", {"artist": t["artist"], "track": t["title"]},
                       signed=True, post=True)
        except LastFMError as e:
            print("lastfm love:", e)

    # --- рекомендации ------------------------------------------------------
    def similar_artists(self, artist: str, limit: int = 12) -> list[str]:
        """Похожие артисты (кэш на неделю). Нужен только API-ключ."""
        if not self.key or not artist:
            return []
        k = artist.lower()
        hit = self._similar.get(k)
        if hit and time.time() - hit[0] < 7 * 86400:
            return hit[1]
        try:
            data = self._call("artist.getSimilar", {"artist": artist, "limit": limit, "autocorrect": 1})
            names = [a["name"] for a in (data.get("similarartists") or {}).get("artist", []) if a.get("name")]
        except LastFMError as e:
            print("lastfm similar:", e)
            names = []
        self._similar[k] = (time.time(), names)
        return names

    def user_info(self) -> dict:
        if not self.logged_in():
            return {}
        try:
            u = self._call("user.getInfo", {"user": self.user}).get("user") or {}
            imgs = [i.get("#text") for i in u.get("image", []) if i.get("#text")]
            return {"name": u.get("name", self.user), "playcount": int(u.get("playcount") or 0),
                    "image": imgs[-1] if imgs else "", "url": u.get("url", "")}
        except LastFMError:
            return {"name": self.user}
