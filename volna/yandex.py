"""Яндекс Музыка: вход по токену, импорт лайков и плейлистов, скачивание треков, «Моя волна».

Работает через неофициальную библиотеку yandex-music (MarshalX). Нужна подписка Плюс:
без неё Яндекс отдаёт только 30-секундные превью — такие варианты мы не берём.

Токен хранится в настройках ("ym_token"). Если Яндекс отвечает «не авторизован»,
токен стирается и пользователь видит понятную ошибку — нужно войти заново.
Все сетевые методы рассчитаны на вызов из фоновых потоков.
"""
from __future__ import annotations

import os
import threading
import uuid
from collections import deque
from pathlib import Path

import requests

from .config import cache_dir, settings
from .db import Database, artist_key

OAUTH_CLIENT_ID = "23cabbbdc6cd418abb4b39c32c41195d"   # приложение «Яндекс Музыка»
OAUTH_URL = f"https://oauth.yandex.ru/authorize?response_type=token&client_id={OAUTH_CLIENT_ID}"
MY_WAVE = "user:onyourwave"
RADIO_FROM = "desktop_win-radio-volna-default"
CACHE_EXTS = (".mp3", ".m4a", ".aac", ".flac")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

AUTH_MSG = "Вход в Яндекс Музыку устарел — войди заново в «Импорт» или «Настройках»"
NOT_LOGGED_MSG = "Сначала войди в Яндекс Музыку"


class YandexError(Exception):
    """Понятная пользователю ошибка Яндекс Музыки."""


class YandexAuthError(YandexError):
    """Токена нет, он истёк или отозван."""


def _lib():
    """Модуль yandex_music — импортируем лениво, чтобы приложение жило и без него."""
    try:
        import yandex_music  # noqa: PLC0415
        return yandex_music
    except ImportError as e:  # pragma: no cover — зависит от окружения
        raise YandexError("Не установлена библиотека yandex-music (pip install yandex-music)") from e


def _exc_classes():
    try:
        from yandex_music import exceptions as ex  # noqa: PLC0415
        return ex.UnauthorizedError, ex.NetworkError, ex.YandexMusicError
    except ImportError:  # pragma: no cover
        return (), (), ()


def _g(o, name, default=None):
    """getattr, который понимает и объекты библиотеки, и словари (в тестах)."""
    if o is None:
        return default
    if isinstance(o, dict):
        return o.get(name, default)
    return getattr(o, name, default)


def parse_track(t) -> dict | None:
    """yandex_music.Track → словарь для базы. None — если это не трек (подкаст без названия и т.п.)."""
    tid = _g(t, "id")
    title = _g(t, "title")
    if tid in (None, "") or not title:
        return None
    version = _g(t, "version")
    if version and version.lower() not in title.lower():
        title = f"{title} ({version})"
    artists = [_g(a, "name") for a in (_g(t, "artists") or [])]
    artists = [a for a in artists if a]
    artist = ", ".join(artists) or _g(t, "ugc_artist_name") or ""
    albums = _g(t, "albums") or []
    alb = albums[0] if albums else None
    cover = _g(t, "cover_uri") or _g(alb, "cover_uri") or ""
    art = f"https://{cover.replace('%%', '400x400')}" if cover else ""
    alb_id = _g(alb, "id")
    return {
        "ym_id": str(tid),
        "ym_tid": f"{tid}:{alb_id}" if alb_id else str(tid),   # id:альбом — для фидбека и лайков
        "title": title,
        "artist": artist,
        "album": _g(alb, "title") or "",
        "duration_ms": int(_g(t, "duration_ms") or 0),
        "genre": _g(alb, "genre") or "",
        "year": int(_g(alb, "year") or 0),
        "artwork_url": art,
        "available": _g(t, "available") is not False,
        "url": f"https://music.yandex.ru/album/{alb_id}/track/{tid}" if alb_id else f"https://music.yandex.ru/track/{tid}",
    }


def _ext_for(codec: str) -> str:
    codec = (codec or "").lower()
    if codec == "mp3":
        return ".mp3"
    if codec.startswith("flac") and not codec.endswith("mp4"):
        return ".flac"
    if codec.endswith("-mp4"):
        return ".m4a"
    return ".aac"   # aac / he-aac из download-info — «сырой» ADTS-поток


def cached_file(ym_id) -> Path | None:
    for ext in CACHE_EXTS:
        p = cache_dir() / f"ym_{ym_id}{ext}"
        if p.exists() and p.stat().st_size > 50_000:
            return p
    return None


class YandexMusic:
    """Обёртка над yandex_music.Client: состояние входа, импорт, поток, поиск."""

    def __init__(self, client_factory=None, http=None) -> None:
        # client_factory(token) -> клиент с уже вызванным init(); подменяется в тестах
        self._factory = client_factory or self._make_client
        self.http = http or requests.Session()
        self.http.headers["User-Agent"] = UA
        self._lock = threading.RLock()
        self._client = None
        self._account: dict | None = None
        self._expired = False          # токен стёрт из-за «не авторизован» — подсказка «войди заново»
        self._dl_guard = threading.Lock()
        self._dl_locks: dict[str, threading.Lock] = {}

    # --- вход ---------------------------------------------------------------
    @staticmethod
    def _make_client(token: str):
        lib = _lib()
        return lib.Client(token, report_unknown_fields=False).init()

    @property
    def token(self) -> str:
        return settings().get("ym_token") or ""

    @property
    def logged_in(self) -> bool:
        return bool(self.token)

    def client(self):
        with self._lock:
            if self._client is not None:
                return self._client
            token = self.token
            if not token:
                raise YandexAuthError(AUTH_MSG if self._expired else NOT_LOGGED_MSG)
            cl = self._guard(lambda: self._factory(token))
            if _g(_g(_g(cl, "me"), "account"), "uid") is None:
                self._drop()
                self._expired = True
                raise YandexAuthError(AUTH_MSG)
            self._client = cl
            return cl

    def login(self, token: str) -> dict:
        """Проверяет токен, сохраняет его и возвращает данные аккаунта."""
        token = (token or "").strip()
        if token.startswith("http") or "access_token=" in token:
            token = token_from_url(token) or ""
        if len(token) < 20:
            raise YandexError("Это не похоже на токен Яндекса")
        try:
            cl = self._guard(lambda: self._factory(token), drop=False)
        except YandexAuthError:
            raise YandexAuthError("Яндекс не принял этот токен") from None
        if _g(_g(_g(cl, "me"), "account"), "uid") is None:
            raise YandexAuthError("Яндекс не принял этот токен")
        with self._lock:
            settings().set("ym_token", token)
            self._client = cl
            self._account = None
            self._expired = False
        return self.account()

    def logout(self) -> None:
        with self._lock:
            self._drop()
            self._expired = False

    def _drop(self) -> None:
        self._client = None
        self._account = None
        if settings().get("ym_token"):
            settings().set("ym_token", "")

    def _guard(self, fn, drop: bool = True):
        """Выполнить вызов библиотеки, переведя её ошибки в понятные."""
        unauth, net, base = _exc_classes()
        try:
            return fn()
        except YandexError:
            raise
        except Exception as e:  # noqa: BLE001
            if unauth and isinstance(e, unauth):
                if drop:
                    with self._lock:
                        self._drop()
                        self._expired = True
                raise YandexAuthError(AUTH_MSG) from e
            if net and isinstance(e, net):
                raise YandexError(f"Нет связи с Яндекс Музыкой: {e}") from e
            if base and isinstance(e, base):
                raise YandexError(f"Яндекс Музыка: {e}") from e
            if isinstance(e, requests.RequestException):
                raise YandexError(f"Нет связи с Яндекс Музыкой: {e}") from e
            raise

    def call(self, fn):
        """fn(client) с обработкой истёкшего токена."""
        cl = self.client()
        return self._guard(lambda: fn(cl))

    def account(self) -> dict:
        if not self.logged_in:
            return {"logged": False}
        if self._account is not None:
            return self._account
        cl = self.client()
        me = _g(cl, "me")
        acc = _g(me, "account")
        plus = bool(_g(_g(me, "plus"), "has_plus"))
        info = {
            "logged": True,
            "uid": _g(acc, "uid"),
            "login": _g(acc, "login") or "",
            "name": _g(acc, "display_name") or _g(acc, "full_name") or _g(acc, "login") or "Яндекс",
            "plus": plus,
            "avatar": self._avatar(),
        }
        self._account = info
        return info

    def _avatar(self) -> str:
        try:
            r = self.http.get("https://login.yandex.ru/info", params={"format": "json"},
                              headers={"Authorization": f"OAuth {self.token}"}, timeout=6)
            d = r.json() if r.ok else {}
            if d.get("default_avatar_id") and not d.get("is_avatar_empty"):
                return f"https://avatars.yandex.net/get-yapic/{d['default_avatar_id']}/islands-200"
        except Exception:  # noqa: BLE001 — аватар не важен
            pass
        return ""

    # --- треки -------------------------------------------------------------
    def full_tracks(self, ids: list[str], chunk: int = 200) -> list:
        out = []
        for i in range(0, len(ids), chunk):
            part = ids[i:i + chunk]
            out += self.call(lambda cl, p=part: cl.tracks(p)) or []
        return out

    def _shorts_to_tracks(self, shorts) -> list:
        """TrackShort[] → Track[]: что пришло вместе с плейлистом — берём, остальное догружаем."""
        have, need, order = {}, [], []
        for s in shorts or []:
            tr = _g(s, "track")
            sid = str(_g(s, "id"))
            order.append(sid)
            if tr is not None:
                have[sid] = tr
            else:
                alb = _g(s, "album_id")
                need.append(f"{sid}:{alb}" if alb else sid)
        if need:
            for tr in self.full_tracks(need):
                have[str(_g(tr, "id"))] = tr
        return [have[s] for s in order if s in have]

    def import_all(self, db: Database, progress=None) -> dict:
        """«Мне нравится» → лайки медиатеки, плейлисты пользователя → плейлисты 'yandex'."""
        prog = progress or (lambda *_: None)
        acc = self.account()
        uid = acc["uid"]
        prog(0.02, "Загружаю «Мне нравится»…")
        likes = self.call(lambda cl: cl.users_likes_tracks())
        shorts = list(_g(likes, "tracks") or [])
        tracks = self._shorts_to_tracks(shorts)
        liked_ids = []
        for i, tr in enumerate(tracks):
            p = parse_track(tr)
            if p:
                liked_ids.append(db.upsert_ym_track(p, in_library=True, liked=True))
            if i % 25 == 0:
                prog(0.05 + 0.45 * i / max(1, len(tracks)), f"Лайки: {i}/{len(tracks)}")
        # «Мне нравится» как плейлист тоже, в порядке Яндекса
        if liked_ids:
            db.upsert_playlist("Мне нравится · Яндекс", "yandex", f"ym:{uid}:3", liked_ids)
        prog(0.5, "Загружаю плейлисты…")
        pls = self.call(lambda cl: cl.users_playlists_list()) or []
        n_pl, n_tr = 0, len(liked_ids)
        for k, pl in enumerate(pls):
            kind = _g(pl, "kind")
            owner = _g(_g(pl, "owner"), "uid") or _g(pl, "uid") or uid
            name = _g(pl, "title") or "Плейлист"
            if kind is None or kind == 3:
                continue
            try:
                full = self.call(lambda cl, kd=kind, o=owner: cl.users_playlists(kd, o))
                items = self._shorts_to_tracks(_g(full, "tracks") or [])
            except YandexAuthError:
                raise
            except YandexError as e:
                print("ym playlist skipped:", name, e)
                continue
            ids = []
            for tr in items:
                p = parse_track(tr)
                if p:
                    ids.append(db.upsert_ym_track(p, in_library=True))
            db.upsert_playlist(name, "yandex", f"ym:{owner}:{kind}", ids)
            n_pl += 1
            n_tr += len(ids)
            prog(0.5 + 0.5 * (k + 1) / max(1, len(pls)), f"Плейлист «{name}»: {len(ids)}")
        prog(1.0, "Готово")
        return {"user": acc["name"], "liked": len(liked_ids), "playlists": n_pl, "tracks": n_tr}

    def search(self, q: str, limit: int = 30) -> list[dict]:
        res = self.call(lambda cl: cl.search(q, type_="track"))
        items = _g(_g(res, "tracks"), "results") or []
        out = [p for p in (parse_track(t) for t in items) if p and p["available"]]
        return out[:limit]

    def similar(self, ym_id) -> list[dict]:
        res = self.call(lambda cl: cl.tracks_similar(ym_id))
        return [p for p in (parse_track(t) for t in (_g(res, "similar_tracks") or [])) if p and p["available"]]

    def like(self, ym_id, liked: bool) -> bool:
        if liked:
            return bool(self.call(lambda cl: cl.users_likes_tracks_add(ym_id)))
        return bool(self.call(lambda cl: cl.users_likes_tracks_remove(ym_id)))

    def dislike(self, ym_id) -> bool:
        return bool(self.call(lambda cl: cl.users_dislikes_tracks_add(ym_id)))

    # --- звук -----------------------------------------------------------------
    def best_link(self, ym_id) -> tuple[str, str]:
        """Прямая ссылка на лучший вариант: mp3 320, иначе самый высокий битрейт (aac при равенстве)."""
        infos = self.call(lambda cl: cl.tracks_download_info(ym_id, get_direct_links=True)) or []
        full = [i for i in infos if not _g(i, "preview")]

        def rank(i):
            codec, br = (_g(i, "codec") or "").lower(), int(_g(i, "bitrate_in_kbps") or 0)
            return (0 if codec == "mp3" and br >= 320 else 1, -br, 0 if "aac" in codec else 1)

        for i in sorted(full, key=rank):
            link = _g(i, "direct_link")
            if not link:
                try:
                    link = self._guard(lambda i=i: i.get_direct_link())
                except YandexAuthError:
                    raise
                except Exception as e:  # noqa: BLE001
                    print("ym direct link:", e)
                    continue
            if link:
                return link, _g(i, "codec") or "mp3"
        # новые треки иногда есть только в get-file-info
        cl = self.client()
        if hasattr(cl, "tracks_file_info"):
            try:
                fi = self._guard(lambda: cl.tracks_file_info(
                    ym_id, quality="hq", codecs=["mp3", "aac", "he-aac", "aac-mp4", "he-aac-mp4"], transport="raw"))
                di = _g(fi, "download_info")
                if di is not None and _g(di, "url"):
                    return _g(di, "url"), _g(di, "codec") or "mp3"
            except YandexAuthError:
                raise
            except Exception as e:  # noqa: BLE001
                print("ym file-info:", e)
        if infos:
            raise YandexError("Яндекс отдаёт только превью — нужна подписка Плюс или трек недоступен в регионе")
        raise YandexError("Трек недоступен в Яндекс Музыке")

    def stream_file(self, ym_id, progress=None) -> Path:
        ym_id = str(ym_id)
        with self._dl_guard:
            lock = self._dl_locks.setdefault(ym_id, threading.Lock())
        with lock:
            hit = cached_file(ym_id)
            if hit:
                os.utime(hit)
                return hit
            url, codec = self.best_link(ym_id)
            return self._download(ym_id, url, _ext_for(codec), progress)

    def _download(self, ym_id: str, url: str, ext: str, progress) -> Path:
        from .soundcloud import prune_cache  # noqa: PLC0415 — общий кэш и лимит
        dst = cache_dir() / f"ym_{ym_id}{ext}"
        tmp = dst.with_name(f"ym_{ym_id}.{uuid.uuid4().hex}.part")
        try:
            with self.http.get(url, stream=True, timeout=30) as r:
                r.raise_for_status()
                total = int(r.headers.get("content-length") or 0)
                done = 0
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(64 * 1024):
                        f.write(chunk)
                        done += len(chunk)
                        if progress and total:
                            progress(done / total)
            os.replace(tmp, dst)
        except requests.RequestException as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise YandexError(f"Не удалось скачать трек с Яндекса: {e}") from e
        prune_cache()
        return dst


def token_from_url(url: str) -> str | None:
    """access_token из адреса редиректа OAuth (он во фрагменте после #)."""
    from urllib.parse import parse_qs, urlsplit  # noqa: PLC0415
    parts = urlsplit(url)
    for chunk in (parts.fragment, parts.query):
        tok = parse_qs(chunk).get("access_token")
        if tok and tok[0]:
            return tok[0]
    return None


_ym: YandexMusic | None = None
_ym_lock = threading.Lock()


def ym() -> YandexMusic:
    global _ym
    with _ym_lock:
        if _ym is None:
            _ym = YandexMusic()
        return _ym


def set_ym(inst: YandexMusic | None) -> None:
    """Подмена синглтона (тесты)."""
    global _ym
    with _ym_lock:
        _ym = inst


# ======================================================================
# «Моя волна» Яндекса
# ======================================================================
# режимы и настроения Volna → настройки станции (settings2)
DIVERSITY = {"favorite": "favorite", "mix": "default", "discover": "discover"}
MOOD_ENERGY = {"energetic": "active", "calm": "calm", "focus": "calm", None: "all", "": "all"}
QUEUE_TARGET = 6
REFILL_AT = 2


class YandexWave:
    """Тот же интерфейс, что у recommender.Wave, но треки подбирает Яндекс (rotor API)."""

    source = "yandex"

    def __init__(self, db: Database, client: YandexMusic | None = None, mode: str = "mix", mood: str | None = None):
        self.db = db
        self.ym = client or ym()
        self.mode = mode if mode in DIVERSITY else "mix"
        self.mood = mood if mood in MOOD_ENERGY else None
        self.station = MY_WAVE
        self.lock = threading.RLock()
        self.refill_lock = threading.Lock()
        self.queue: deque[dict] = deque()
        self._snap: tuple = ()
        self.history: list[dict] = []
        self.batch_id: str | None = None
        self.session_ids: set[str] = set()
        self._last_ym: str | None = None   # последний трек цепочки (для queue=)
        self._started = False

    # --- публичное API (как у Wave) ------------------------------------------
    def start(self, mode: str | None = None, *, from_track: dict | None = None, query: str | None = None) -> None:
        if mode:
            self.mode = mode if mode in DIVERSITY else "mix"
        with self.lock:
            self.queue.clear()
            self._sync()
            self.history.clear()
            self.session_ids.clear()
            self._last_ym = None
        self.station = MY_WAVE
        if from_track and from_track.get("ym_id"):
            self.station = f"track:{from_track['ym_id']}"
            self.session_ids.add(str(from_track["ym_id"]))
        elif query:
            found = self.ym.search(query, limit=1)
            if found:
                self.station = f"track:{found[0]['ym_id']}"
        if self.station == MY_WAVE:
            try:
                self.ym.call(lambda cl: cl.rotor_station_settings2(
                    self.station, MOOD_ENERGY.get(self.mood, "all"), DIVERSITY[self.mode], language="any"))
            except YandexAuthError:
                raise
            except YandexError as e:
                print("ym wave settings:", e)
        self.refill()
        with self.lock:
            if not self.queue:
                raise YandexError("Яндекс не прислал треков для волны — попробуй ещё раз")
        self._feedback("radioStarted", from_=RADIO_FROM)
        self._started = True

    def next_track(self) -> dict | None:
        with self.lock:
            need = len(self.queue) < REFILL_AT
        if need:
            try:
                self.refill()
            except YandexAuthError:
                raise
            except YandexError as e:
                print("ym wave refill:", e)
        with self.lock:
            if not self.queue:
                return None
            t = self.queue.popleft()
            self.history.append(t)
            self._sync()
        self._feedback("trackStarted", track=t)
        return t

    def peek(self, n: int = 5) -> list[dict]:
        return list(self._snap[:n])

    def remove_at(self, i: int) -> None:
        with self.lock:
            if 0 <= i < len(self.queue):
                del self.queue[i]
                self._sync()

    def on_finished(self, track: dict, listened_ms: int, completed: bool) -> None:
        self.db.log(track["id"], "complete" if completed else "skip", listened_ms, "wave")
        secs = round(max(0, listened_ms) / 1000, 1)
        self._feedback("trackFinished" if completed else "skip", track=track, total_played_seconds=secs)

    def on_like(self, track: dict) -> None:
        # сам лайк в Яндекс отправляет bridge_yandex.ym_like; волна просто «поворачивает»
        with self.lock:
            self.queue = deque(list(self.queue)[:1])
            self._sync()
            if track.get("ym_id"):
                self._last_ym = track.get("ym_tid") or str(track["ym_id"])
        try:
            self.refill()
        except YandexError as e:
            print("ym wave like refill:", e)

    def on_dislike(self, track: dict) -> None:
        if track.get("ym_id"):
            try:
                self.ym.dislike(track["ym_id"])
            except YandexError as e:
                print("ym dislike:", e)
        self._feedback("skip", track=track, total_played_seconds=0.1)
        a = track.get("artist_key") or artist_key(track.get("artist", ""))
        with self.lock:
            self.queue = deque(q for q in self.queue if (q.get("artist_key") or "") != a)
            self._sync()

    # --- внутреннее -------------------------------------------------------------
    def _sync(self) -> None:
        self._snap = tuple(self.queue)

    def _feedback(self, kind: str, track: dict | None = None, **kw) -> None:
        """Обратная связь станции — лучшее усилие: сеть упала, волна всё равно играет."""
        tid = (track or {}).get("ym_tid") or (track or {}).get("ym_id")
        if track is not None and not tid:
            return
        station, batch = self.station, (track or {}).get("_batch") or self.batch_id

        def send(cl):
            return cl.rotor_station_feedback(station, kind, batch_id=batch, track_id=tid, **kw)
        try:
            self.ym.call(send)
        except YandexError as e:
            print(f"ym feedback {kind}:", e)

    def refill(self) -> None:
        with self.refill_lock:
            with self.lock:
                last = self._last_ym
            res = self.ym.call(lambda cl: cl.rotor_station_tracks(self.station, settings2=True, queue=last))
            batch = _g(res, "batch_id")
            seq = list(_g(res, "sequence") or [])
            disliked = {r["ym_id"] for r in self.db.query(
                "SELECT ym_id FROM tracks WHERE disliked=1 AND ym_id IS NOT NULL")}
            fresh = []
            for s in seq:
                p = parse_track(_g(s, "track"))
                if not p or not p["available"]:
                    continue
                if p["ym_id"] in self.session_ids or p["ym_id"] in disliked:
                    continue
                liked = bool(_g(s, "liked"))
                tid = self.db.upsert_ym_track(p, in_library=liked, liked=liked)
                full = self.db.track(tid)
                if not full or full["disliked"]:
                    continue
                full["ym_tid"], full["_batch"] = p["ym_tid"], batch
                fresh.append(full)
            with self.lock:
                if batch:
                    self.batch_id = batch
                for f in fresh:
                    if f["ym_id"] in self.session_ids or len(self.queue) >= QUEUE_TARGET + 4:
                        continue
                    self.session_ids.add(f["ym_id"])
                    self.queue.append(f)
                if seq:
                    lp = parse_track(_g(seq[-1], "track"))
                    if lp:
                        self._last_ym = lp["ym_tid"]
                self._sync()


def wave_source() -> str:
    return "yandex" if settings().get("wave_source") == "yandex" else "volna"


def prefer_yandex() -> bool:
    v = settings().get("ym_prefer")
    return True if v is None else bool(v)

