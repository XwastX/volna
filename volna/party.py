"""Режим вечеринки: гости с телефонов в той же Wi-Fi сети ищут треки, кидают их в очередь и голосуют.

Встроенный HTTP-сервер (только стандартная библиотека). Доступ — по ссылке с секретным ключом из QR-кода.
Сервер работает в своих потоках; всё, что меняет плеер, уходит в GUI через колбэк on_change/on_skip.
"""
from __future__ import annotations

import json
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .db import Database

WEB = Path(__file__).resolve().parent / "web"
MAX_BODY = 4096
MAX_PER_GUEST = 3          # сколько ещё не сыгранных треков может держать в очереди один гость
SEARCH_GAP = 0.6           # не чаще одного поиска в 0,6 с от гостя
ACTIVE_SEC = 600           # гость «на вечеринке», если заходил за последние 10 минут


def lan_ip() -> str:
    """IP компьютера в локальной сети (пакеты при этом никуда не отправляются)."""
    for target in ("192.168.0.1", "10.255.255.255", "8.8.8.8"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((target, 80))
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith("127."):
                return ip
        except OSError:
            continue
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return "127.0.0.1"


def qr_svg(text: str) -> str:
    try:
        import qrcode  # noqa: PLC0415
        import qrcode.image.svg  # noqa: PLC0415
    except ImportError:
        return ""
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=12, border=2)
    svg = img.to_string(encoding="unicode")
    return svg if isinstance(svg, str) else svg.decode()


class Party:
    def __init__(self, db: Database, search_fn, on_change=None, on_skip=None) -> None:
        self.db = db
        self.search_fn = search_fn          # search_fn(q) -> list[dict] (треки SoundCloud, parse_track)
        self.on_change = on_change          # очередь поменялась (из фонового потока)
        self.on_skip = on_skip              # гости проголосовали за пропуск
        self.key = f"{secrets.randbelow(10 ** 6):06d}"
        self.lock = threading.RLock()
        self.items: list[dict] = []         # {qid, tid, title, artist, art, dur, guest, by, votes:set, ts}
        self.guests: dict[str, dict] = {}   # id -> {name, seen, last_search}
        self.results: dict[str, dict] = {}  # токен результата поиска -> трек
        self.skip_votes: set[str] = set()
        self.allow_skip = True
        self.now: dict = {}                 # заполняет мост: title, artist, art, pos, dur, playing, tid
        self._seq = 0
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.port = 0
        self.bad: dict[str, list] = {}      # IP -> [число неверных ключей, время первой ошибки]

    # --- сервер ------------------------------------------------------------
    def start(self, port: int = 8765) -> None:
        handler = type("H", (_Handler,), {"party": self})
        last = None
        for p in (port, port + 1, port + 2, 0):
            try:
                self.server = ThreadingHTTPServer(("0.0.0.0", p), handler)
                break
            except OSError as e:
                last = e
        if self.server is None:
            raise RuntimeError(f"Не получилось открыть сервер вечеринки: {last}")
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True, name="party-http")
        self.thread.start()

    def stop(self) -> None:
        srv, self.server = self.server, None
        if srv:
            threading.Thread(target=lambda: (srv.shutdown(), srv.server_close()), daemon=True).start()

    @property
    def running(self) -> bool:
        return self.server is not None

    def url(self) -> str:
        return f"http://{lan_ip()}:{self.port}/?k={self.key}"

    # --- состояние -----------------------------------------------------------
    def _changed(self) -> None:
        if self.on_change:
            try:
                self.on_change()
            except Exception:  # noqa: BLE001
                pass

    def ordered(self) -> list[dict]:
        with self.lock:
            return sorted(self.items, key=lambda it: (-len(it["votes"]), it["ts"]))

    def active_guests(self) -> int:
        now = time.time()
        with self.lock:
            return sum(1 for g in self.guests.values() if now - g["seen"] < ACTIVE_SEC)

    def skip_need(self) -> int:
        return max(2, (self.active_guests() + 1) // 2)

    def guest(self, gid: str, name: str | None = None) -> dict:
        with self.lock:
            g = self.guests.get(gid)
            if g is None:
                if len(self.guests) > 300:
                    raise PermissionError("На вечеринке слишком много гостей")
                g = self.guests[gid] = {"name": "", "seen": 0.0, "last_search": 0.0}
            if name is not None:
                g["name"] = name.strip()[:24]
            g["seen"] = time.time()
            return g

    def state(self, gid: str) -> dict:
        g = self.guest(gid)
        with self.lock:
            q = [{"qid": it["qid"], "title": it["title"], "artist": it["artist"], "art": it["art"],
                  "votes": len(it["votes"]), "mine": gid in it["votes"], "by": it["by"],
                  "own": it["guest"] == gid} for it in self.ordered()]
            return {"now": {k: self.now.get(k) for k in ("title", "artist", "art", "pos", "dur", "playing")},
                    "queue": q, "guests": self.active_guests(), "me": g["name"],
                    "skip": {"on": self.allow_skip, "votes": len(self.skip_votes), "need": self.skip_need(),
                             "mine": gid in self.skip_votes}}

    def search(self, gid: str, q: str) -> list[dict]:
        g = self.guest(gid)
        q = (q or "").strip()[:80]
        if len(q) < 2:
            return []
        now = time.time()
        with self.lock:
            if now - g["last_search"] < SEARCH_GAP:
                raise PermissionError("Не так быстро")
            g["last_search"] = now
        out = []
        for t in self.db.library(search=q)[:8]:          # сначала — то, что есть в медиатеке хозяина
            out.append(self._token({"tid": t["id"]}, t["title"], t["artist"], t.get("artwork_url") or "",
                                   t.get("duration_ms") or 0, lib=True))
        seen = {(o["title"].lower(), o["artist"].lower()) for o in out}
        try:
            found = self.search_fn(q)
        except Exception:  # noqa: BLE001
            found = []
        for t in found:
            if len(out) >= 20:
                break
            if not t.get("playable") or (t["title"].lower(), t["artist"].lower()) in seen:
                continue
            out.append(self._token({"sc": t}, t["title"], t["artist"], t.get("artwork_url") or "",
                                   t.get("duration_ms") or 0))
        return out

    def _token(self, ref: dict, title, artist, art, dur, lib=False) -> dict:
        tok = secrets.token_urlsafe(9)
        with self.lock:
            self.results[tok] = ref | {"ts": time.time()}
            if len(self.results) > 2000:            # старые результаты больше не нужны
                for k in sorted(self.results, key=lambda k: self.results[k]["ts"])[:1000]:
                    self.results.pop(k, None)
        return {"token": tok, "title": title, "artist": artist, "art": art, "dur": dur, "lib": lib}

    def add(self, gid: str, token: str) -> dict:
        g = self.guest(gid)
        with self.lock:
            ref = self.results.get(token)
        if not ref:
            raise ValueError("Результат поиска устарел — найди трек ещё раз")
        tid = ref["tid"] if "tid" in ref else self.db.upsert_sc_track(ref["sc"])
        tid = self.db.resolve(tid)
        t = self.db.track(tid)
        if not t:
            raise ValueError("Трек не найден")
        with self.lock:
            same = next((it for it in self.items if it["tid"] == tid), None)
            if same:                                   # уже в очереди — просто голос за него
                same["votes"].add(gid)
                res = {"dup": True, "qid": same["qid"]}
            elif self.now.get("tid") == tid:
                raise ValueError("Этот трек играет прямо сейчас")
            else:
                mine = sum(1 for it in self.items if it["guest"] == gid)
                if mine >= MAX_PER_GUEST:
                    raise PermissionError(f"У тебя уже {mine} трека в очереди — дождись, пока они заиграют")
                self._seq += 1
                self.items.append({"qid": self._seq, "tid": tid, "title": t["title"], "artist": t["artist"],
                                   "art": t.get("artwork_url") or "", "dur": t.get("duration_ms") or 0,
                                   "guest": gid, "by": g["name"] or "Гость", "votes": {gid}, "ts": time.time()})
                res = {"dup": False, "qid": self._seq}
        self._changed()
        return res

    def host_add(self, tid: int) -> None:
        t = self.db.track(self.db.resolve(int(tid)))
        if not t:
            return
        with self.lock:
            if any(it["tid"] == t["id"] for it in self.items):
                return
            self._seq += 1
            self.items.append({"qid": self._seq, "tid": t["id"], "title": t["title"], "artist": t["artist"],
                               "art": t.get("artwork_url") or "", "dur": t.get("duration_ms") or 0,
                               "guest": "host", "by": "Хозяин", "votes": {"host"}, "ts": time.time()})
        self._changed()

    def vote(self, gid: str, qid: int) -> None:
        self.guest(gid)
        with self.lock:
            it = next((x for x in self.items if x["qid"] == qid), None)
            if not it:
                raise ValueError("Этого трека уже нет в очереди")
            if gid in it["votes"]:
                it["votes"].discard(gid)
            else:
                it["votes"].add(gid)
        self._changed()

    def remove(self, qid: int, gid: str | None = None) -> None:
        """gid=None — убирает хозяин; гость может убрать только свой трек."""
        with self.lock:
            it = next((x for x in self.items if x["qid"] == qid), None)
            if not it:
                return
            if gid is not None and it["guest"] != gid:
                raise PermissionError("Убрать можно только свой трек")
            self.items.remove(it)
        self._changed()

    def clear(self) -> None:
        with self.lock:
            self.items.clear()
            self.skip_votes.clear()
        self._changed()

    def vote_skip(self, gid: str) -> dict:
        self.guest(gid)
        fire = False
        with self.lock:
            if not self.allow_skip:
                raise PermissionError("Хозяин выключил голосование за пропуск")
            if gid in self.skip_votes:
                self.skip_votes.discard(gid)
            else:
                self.skip_votes.add(gid)
            if len(self.skip_votes) >= self.skip_need():
                self.skip_votes.clear()
                fire = True
        if fire and self.on_skip:
            self.on_skip()
        return {"skipped": fire}

    def started(self, tid: int | None) -> None:
        """Заиграл трек: убираем его из очереди вечеринки, голоса за пропуск обнуляются."""
        with self.lock:
            self.skip_votes.clear()
            if tid is None:
                return
            tid = self.db.resolve(tid)
            before = len(self.items)
            self.items = [it for it in self.items if it["tid"] != tid]
            changed = len(self.items) != before
        if changed:
            self._changed()

    def host_state(self) -> dict:
        with self.lock:
            return {"on": self.running, "url": self.url() if self.running else "", "key": self.key,
                    "guests": self.active_guests(), "allowSkip": self.allow_skip,
                    "skip": {"votes": len(self.skip_votes), "need": self.skip_need()},
                    "names": sorted({g["name"] for g in self.guests.values()
                                     if g["name"] and time.time() - g["seen"] < ACTIVE_SEC})[:30],
                    "queue": [{"qid": it["qid"], "id": it["tid"], "title": it["title"], "artist": it["artist"],
                               "art": it["art"], "votes": len(it["votes"]), "by": it["by"]} for it in self.ordered()]}


class _Handler(BaseHTTPRequestHandler):
    party: Party
    server_version = "VolnaParty/1"
    sys_version = ""

    def log_message(self, *_a) -> None:   # не засоряем консоль
        pass

    # --- ответы ---
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, code: int = 200, extra: dict | None = None) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8", extra)

    def _err(self, code: int, msg: str) -> None:
        self._json({"error": msg}, code)

    # --- проверки ---
    def _auth(self, qs: dict) -> bool:
        """Ключ из ссылки. После 20 неверных ключей с одного адреса — блок на 10 минут (подбор ключа)."""
        ip = self.client_address[0]
        p = self.party
        with p.lock:
            rec = p.bad.get(ip)
            if rec and time.time() - rec[1] > 600:
                p.bad.pop(ip, None)
                rec = None
            if rec and rec[0] >= 20:
                return False
        key = (qs.get("k") or [""])[0] or self.headers.get("X-Party-Key", "")
        ok = secrets.compare_digest(key.encode(), p.key.encode())
        if not ok:
            with p.lock:
                r = p.bad.setdefault(ip, [0, time.time()])
                r[0] += 1
        return ok

    def _gid(self) -> tuple[str, dict]:
        """Гость определяется cookie; если её нет — выдаём новую."""
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "vg" and 10 <= len(v) <= 40 and v.replace("-", "").replace("_", "").isalnum():
                return v, {}
        gid = secrets.token_urlsafe(12)
        return gid, {"Set-Cookie": f"vg={gid}; Path=/; Max-Age=86400; SameSite=Strict; HttpOnly"}

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("Слишком большой запрос")
        data = json.loads(self.rfile.read(n) or b"{}") if n else {}
        if not isinstance(data, dict):
            raise ValueError("Плохой запрос")
        return data

    # --- маршруты ---
    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            if not self._auth(qs):
                self._send(403, "Нужна ссылка из QR-кода на экране Volna".encode(), "text/plain; charset=utf-8")
                return
            gid, extra = self._gid()
            html = (WEB / "party.html").read_bytes()
            extra["Content-Security-Policy"] = ("default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline'; "
                                                "script-src 'self' 'unsafe-inline'; connect-src 'self'")
            self._send(200, html, "text/html; charset=utf-8", extra)
            return
        if u.path == "/favicon.ico":
            p = WEB.parent / "assets" / "icon.png"
            self._send(200, p.read_bytes() if p.exists() else b"", "image/png")
            return
        if not u.path.startswith("/api/"):
            self._err(404, "Нет такой страницы")
            return
        if not self._auth(qs):
            self._err(403, "Неверный ключ вечеринки")
            return
        gid, extra = self._gid()
        try:
            if u.path == "/api/state":
                self._json(self.party.state(gid), extra=extra)
            elif u.path == "/api/search":
                self._json({"rows": self.party.search(gid, (qs.get("q") or [""])[0])}, extra=extra)
            else:
                self._err(404, "Нет такого метода")
        except PermissionError as e:
            self._json({"error": str(e)}, 429, extra)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 400, extra)

    def do_POST(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if not self._auth(qs):
            self._err(403, "Неверный ключ вечеринки")
            return
        gid, extra = self._gid()
        p = self.party
        try:
            body = self._body()
            if u.path == "/api/join":
                p.guest(gid, str(body.get("name") or ""))
                out = {"ok": True}
            elif u.path == "/api/add":
                out = p.add(gid, str(body.get("token") or ""))
            elif u.path == "/api/vote":
                p.vote(gid, int(body.get("qid") or 0))
                out = {"ok": True}
            elif u.path == "/api/remove":
                p.remove(int(body.get("qid") or 0), gid)
                out = {"ok": True}
            elif u.path == "/api/skip":
                out = p.vote_skip(gid)
            else:
                self._err(404, "Нет такого метода")
                return
            self._json(out, extra=extra)
        except PermissionError as e:
            self._json({"error": str(e)}, 429, extra)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 400, extra)
