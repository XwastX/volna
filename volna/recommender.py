"""«Волна» — бесконечный поток рекомендаций, который подстраивается на лету.

Как это работает:
1. Профиль вкуса: веса исполнителей и тегов/жанров из лайков, библиотеки,
   истории Spotify, дослушиваний, скипов и дизлайков.
2. «Семена»: любимые/дослушанные треки. Для них берём похожие треки SoundCloud
   (/related) — это главный источник новых треков.
3. Каждый кандидат получает оценку: близость к семени + любовь к артисту
   + совпадение тегов + бонус/штраф за новизну (зависит от режима) + немного случайности.
4. В очередь берём с разнообразием (не два одинаковых артиста подряд).
5. Реакции сразу меняют поток: лайк делает трек сильным семенем и подмешивает
   похожие, ранний скип/дизлайк режут артиста и ветку, из которой пришёл трек.
"""
from __future__ import annotations

import math
import random
import re
import threading
import time
from collections import defaultdict, deque

from .db import Database, artist_key
from .soundcloud import SoundCloud, SoundCloudError

MODES = {
    # доля треков из библиотеки, бонус за новое, бонус за знакомое
    "favorite": {"lib_share": 0.65, "new_bonus": -0.2, "known_bonus": 0.5, "label": "Любимое"},
    "mix":      {"lib_share": 0.30, "new_bonus": 0.15, "known_bonus": 0.15, "label": "Микс"},
    "discover": {"lib_share": 0.05, "new_bonus": 0.55, "known_bonus": -0.4, "label": "Незнакомое"},
}

# настроение волны: слова в жанрах/тегах, которые его усиливают или гасят
MOODS = {
    "energetic": {"label": "Бодрое",
                  "plus": ("phonk", "drum", "dnb", "edm", "hardstyle", "trap", "rock", "metal", "punk", "house", "techno",
                           "dance", "gym", "workout", "drift", "hype", "rave", "bass", "dubstep", "jersey"),
                  "minus": ("ambient", "lofi", "lo-fi", "sleep", "chill", "piano", "acoustic", "calm", "study")},
    "calm": {"label": "Спокойное",
             "plus": ("lofi", "lo-fi", "chill", "ambient", "acoustic", "piano", "jazz", "soul", "sleep", "dream",
                      "downtempo", "indie folk", "r&b", "calm", "relax", "bossa"),
             "minus": ("phonk", "metal", "hardstyle", "dubstep", "hardcore", "drill", "rave", "gym")},
    "focus": {"label": "Для учёбы",
              "plus": ("lofi", "lo-fi", "ambient", "instrumental", "study", "piano", "classical", "post-rock",
                       "downtempo", "chillhop", "beats", "minimal", "soundtrack", "ost"),
              "minus": ("rap", "hip-hop", "hip hop", "metal", "phonk", "pop", "vocal", "drill")},
}

QUEUE_TARGET = 8
REFILL_AT = 3
EARLY_SKIP_MS = 30_000
_TAG_RE = re.compile(r'"([^"]+)"|(\S+)')


def _tags(track: dict) -> set[str]:
    out = set()
    if track.get("genre"):
        out.add(track["genre"].strip().lower())
    for a, b in _TAG_RE.findall(track.get("tags") or ""):
        t = (a or b).strip().lower()
        if 2 < len(t) < 30:
            out.add(t)
    return out


def _squash(x: float, scale: float = 4.0) -> float:
    return math.tanh(x / scale)


class Wave:
    def __init__(self, db: Database, client: SoundCloud, mode: str = "mix", rng: random.Random | None = None,
                 mood: str | None = None):
        self.db = db
        self.sc = client
        self.mode = mode if mode in MODES else "mix"
        self.rng = rng or random.Random()
        self.lock = threading.RLock()          # короткие операции с состоянием
        self.refill_lock = threading.Lock()    # подборы идут по одному (в них сеть)
        self.queue: deque[dict] = deque()
        self._snap: tuple = ()                 # копия очереди для интерфейса — без блокировок
        self.history: list[dict] = []        # сыгранные в сессии
        self.session_ids: set[int] = set()   # sc_id, которые уже были в сессии
        self.seed_w: dict[int, float] = {}   # sc_id семени -> вес
        self.session_artist: dict[str, float] = defaultdict(float)
        self.artist_aff: dict[str, float] = {}
        self.tag_aff: dict[str, float] = {}
        self.focus_seed: int | None = None   # «волна по треку»
        # доп. источник кандидатов (например, похожие артисты из Last.fm): fn(seed_sc_ids) -> [(seed, [треки])]
        self.extra_candidates = None
        self.mood = mood if mood in MOODS else None

    # ------------------------------------------------------------------
    # профиль
    # ------------------------------------------------------------------
    def build_profile(self) -> None:
        raw_artist: dict[str, float] = defaultdict(float)
        raw_tag: dict[str, float] = defaultdict(float)
        track_score: dict[int, float] = defaultdict(float)
        tracks = {t["id"]: t for t in self.db.query(
            "SELECT * FROM tracks WHERE in_library=1 OR liked=1 OR disliked=1"
            " OR id IN (SELECT track_id FROM events)")}
        for t in tracks.values():
            w = 0.0
            w += 3.0 if t["liked"] else 0.0
            w += 1.0 if t["in_library"] else 0.0
            w -= 5.0 if t["disliked"] else 0.0
            track_score[t["id"]] += w
        now = time.time()
        for e in self.db.query("SELECT track_id, kind, ts, ms, context FROM events"):
            age_days = max(0.0, (now - e["ts"]) / 86400) if e["ts"] else 365
            decay = 0.5 ** (age_days / 120)  # полураспад ~4 месяца
            k = e["kind"]
            if k == "complete":
                d = 0.6
            elif k == "play":
                d = 0.15
            elif k == "skip":
                d = -0.7 if e["ms"] < EARLY_SKIP_MS else -0.2
            elif k == "history":
                plays = 0
                m = re.search(r"plays=(\d+)", e["context"] or "")
                if m:
                    plays = int(m.group(1))
                d = 0.8 * math.log1p(e["ms"] / 60_000) + 0.3 * math.log1p(plays)
                decay = max(decay, 0.35)  # старая история всё ещё говорит о вкусе
            else:
                continue
            track_score[e["track_id"]] += d * decay
        for tid, s in track_score.items():
            t = tracks.get(tid) or self.db.track(tid)
            if not t:
                continue
            tracks[tid] = t
            raw_artist[t["artist_key"]] += s
            for tag in _tags(t):
                raw_tag[tag] += s * 0.5
        self.artist_aff = {a: _squash(v) for a, v in raw_artist.items() if a}
        self.tag_aff = {g: _squash(v, 6.0) for g, v in raw_tag.items()}
        # семена — треки с sc_id и положительной оценкой
        seeds = {}
        for tid, s in track_score.items():
            t = tracks[tid]
            if t.get("sc_id") and s > 0.5 and t.get("playable") != 0 and not t["disliked"]:
                seeds[t["sc_id"]] = s
        top = sorted(seeds.items(), key=lambda kv: kv[1], reverse=True)[:300]
        self.seed_w = dict(top)

    # ------------------------------------------------------------------
    # публичное API
    # ------------------------------------------------------------------
    def start(self, mode: str | None = None, *, from_track: dict | None = None, query: str | None = None) -> None:
        with self.lock:
            if mode:
                self.mode = mode if mode in MODES else "mix"
            self.queue.clear()
            self._sync()
            self.focus_seed = None
            self.build_profile()
            if from_track and from_track.get("sc_id"):
                self.focus_seed = from_track["sc_id"]
                self.seed_w[from_track["sc_id"]] = max(self.seed_w.values(), default=1) * 3 + 5
                self.session_ids.add(from_track["sc_id"])
            if query:
                for t in self.sc.search_tracks(query, limit=20):
                    if t["playable"]:
                        self.seed_w[t["sc_id"]] = self.seed_w.get(t["sc_id"], 0) + 2.0
            if not self.seed_w:
                raise ColdStart()

    def next_track(self) -> dict | None:
        """Следующий трек волны (уже сохранён в базе: есть поле id). Вызывать из фонового потока."""
        with self.lock:
            need = len(self.queue) < REFILL_AT
        if need:
            self.refill()
        with self.lock:
            if not self.queue:
                return None
            t = self.queue.popleft()
            self.history.append(t)
            self.session_ids.add(t["sc_id"])
            self._sync()
            return t

    def peek(self, n: int = 5) -> list[dict]:
        """Безопасно для GUI-потока: не ждёт сетевых подборов."""
        return list(self._snap[:n])

    def remove_at(self, i: int) -> None:
        with self.lock:
            if 0 <= i < len(self.queue):
                t = self.queue[i]
                del self.queue[i]
                self.session_ids.add(t["sc_id"])
                self._sync()

    def _sync(self) -> None:
        self._snap = tuple(self.queue)

    # --- реакции --------------------------------------------------------
    def on_finished(self, track: dict, listened_ms: int, completed: bool) -> None:
        with self.lock:
            a = track.get("artist_key") or artist_key(track.get("artist", ""))
            if completed:
                self.db.log(track["id"], "complete", listened_ms, "wave")
                self.session_artist[a] += 0.2
                if track.get("sc_id"):
                    self.seed_w[track["sc_id"]] = self.seed_w.get(track["sc_id"], 0) + 1.0
            else:
                self.db.log(track["id"], "skip", listened_ms, "wave")
                if listened_ms < EARLY_SKIP_MS:
                    self.session_artist[a] -= 0.5
                    src = track.get("_seed")
                    if src in self.seed_w:
                        self.seed_w[src] *= 0.5
                    # убираем из очереди слабые треки той же ветки
                    self.queue = deque(q for q in self.queue
                                       if not (q.get("_seed") == src and q.get("_score", 0) < 0.9))
                    self._sync()

    def on_like(self, track: dict) -> None:
        with self.lock:
            a = track.get("artist_key") or artist_key(track.get("artist", ""))
            self.session_artist[a] += 0.6
            if not track.get("sc_id"):
                return
            self.seed_w[track["sc_id"]] = max(self.seed_w.values(), default=1) * 2 + 3
            # волна сразу поворачивает к лайкнутому: обновляем хвост очереди
            self.queue = deque(list(self.queue)[:2])
            self._sync()
        try:
            self.refill(force_seed=track["sc_id"])
        except SoundCloudError:
            pass

    def on_dislike(self, track: dict) -> None:
        with self.lock:
            a = track.get("artist_key") or artist_key(track.get("artist", ""))
            self.session_artist[a] -= 1.5
            self.seed_w.pop(track.get("sc_id"), None)
            src = track.get("_seed")
            if src in self.seed_w:
                self.seed_w[src] *= 0.3
            self.queue = deque(q for q in self.queue
                               if (q.get("artist_key") or "") != a and q.get("_seed") != src)
            self._sync()

    # ------------------------------------------------------------------
    # подбор
    # ------------------------------------------------------------------
    def _pick_seeds(self, n: int) -> list[int]:
        if self.focus_seed and self.rng.random() < 0.6:
            first = [self.focus_seed]
        else:
            first = []
        items = [(s, w) for s, w in self.seed_w.items() if w > 0 and s not in first]
        out = list(first)
        while items and len(out) < n:
            total = sum(w for _, w in items)
            r = self.rng.random() * total
            acc = 0.0
            pick = len(items) - 1  # запасной вариант на случай погрешности float
            for i, (_s, w) in enumerate(items):
                acc += w
                if acc >= r:
                    pick = i
                    break
            out.append(items.pop(pick)[0])
        return out

    def _related(self, sc_id: int) -> list[dict]:
        cached = self.db.get_related(sc_id)
        if cached is not None:
            return cached
        try:
            rel = self.sc.related(sc_id, limit=30)
        except SoundCloudError:
            return []  # не кэшируем сбой сети
        self.db.put_related(sc_id, rel)
        return rel

    def _library_candidates(self, n: int) -> list[dict]:
        rows = self.db.query(
            "SELECT * FROM tracks WHERE in_library=1 AND sc_id IS NOT NULL AND disliked=0"
            " AND coalesce(playable,1)=1 ORDER BY random() LIMIT ?", (n * 4,))
        return rows

    def _score(self, c: dict, base: float, in_lib: bool) -> float:
        cfg = MODES[self.mode]
        a = artist_key(c["artist"])
        aff = self.artist_aff.get(a, 0.0)
        known = in_lib or aff > 0.15
        tags = _tags(c)
        tag_s = (sum(self.tag_aff.get(t, 0.0) for t in tags) / math.sqrt(len(tags))) if tags else 0.0
        s = base
        s += 0.8 * aff + 0.35 * max(-1.0, min(1.0, tag_s))
        s += self.session_artist.get(a, 0.0)
        s += cfg["known_bonus"] if known else cfg["new_bonus"]
        if self.mood:
            text = " " + re.sub(r"[^\w&-]+", " ", " ".join(tags) + " " + (c.get("title") or "").lower()) + " "
            m = MOODS[self.mood]
            if any(f" {w} " in text for w in m["plus"]):     # целые слова: «ost» ≠ «ghost»
                s += 0.6
            elif any(f" {w} " in text for w in m["minus"]):
                s -= 0.7
        pop = c.get("playback_count") or 0
        s += 0.08 * math.log10(pop + 1) / 7
        s += self.rng.gauss(0, 0.12)
        return s

    def refill(self, force_seed: int | None = None) -> None:
        """Дозаполняет очередь. Сеть — без self.lock, чтобы интерфейс и реакции не ждали."""
        with self.refill_lock:
            with self.lock:
                seeds = [force_seed] if force_seed else []
                seeds += self._pick_seeds(4 - len(seeds))
            related = [(seed, self._related(seed)) for seed in seeds]   # сеть
            if self.extra_candidates:
                try:
                    related += self.extra_candidates(seeds)
                except Exception as e:  # noqa: BLE001 — внешний сервис не должен ломать волну
                    print("extra candidates:", e)
            with self.lock:
                self._refill_from(related)
                self._sync()

    def _refill_from(self, related: list[tuple[int, list[dict]]]) -> None:
        cfg = MODES[self.mode]
        recent_local = self.db.recent_track_ids(3600 * (1 if self.mode == "favorite" else 6))
        disliked_sc = {r["sc_id"] for r in self.db.query("SELECT sc_id FROM tracks WHERE disliked=1 AND sc_id IS NOT NULL")}
        lib_sc = {r["sc_id"] for r in self.db.query("SELECT sc_id FROM tracks WHERE in_library=1 AND sc_id IS NOT NULL")}
        queued = {q["sc_id"] for q in self.queue}

        cands: dict[int, dict] = {}

        def consider(c: dict, base: float, seed: int | None):
            sid = c["sc_id"]
            if sid in self.session_ids or sid in queued or sid in disliked_sc or not c.get("playable"):
                return
            dur = c.get("duration_ms") or 0
            if dur and (dur < 60_000 or dur > 12 * 60_000) and sid not in lib_sc:
                return
            if self.artist_aff.get(artist_key(c["artist"]), 0) < -0.6:
                return
            s = self._score(c, base, sid in lib_sc)
            if sid not in cands or cands[sid]["_score"] < s:
                cands[sid] = {**c, "_score": s, "_seed": seed}

        for seed, rel in related:
            for rank, c in enumerate(rel):
                consider(c, 1.0 - rank / 40, seed)
        n_lib = max(0, round(QUEUE_TARGET * cfg["lib_share"]))
        for row in self._library_candidates(n_lib):
            consider({**row, "playable": row.get("playable") in (1, None)}, 0.55, None)

        # выбор с разнообразием: штраф за артиста, уже стоящего в очереди/недавно игравшего
        recent_artists = [artist_key(t["artist"]) for t in self.history[-5:]] + \
                         [artist_key(t["artist"]) for t in self.queue]
        pool = sorted(cands.values(), key=lambda x: x["_score"], reverse=True)[:60]
        lib_taken = 0
        while pool and len(self.queue) < QUEUE_TARGET:
            def adj(c):
                a = artist_key(c["artist"])
                s = c["_score"] - 0.6 * recent_artists.count(a)
                if c["sc_id"] in lib_sc and lib_taken >= n_lib:
                    s -= 0.5
                return s
            scores = [adj(c) / 0.25 for c in pool[:15]]
            top = max(scores)
            weights = [math.exp(x - top) for x in scores]  # без переполнения
            c = self.rng.choices(pool[:15], weights=weights)[0]
            pool.remove(c)
            row = self.db.track_by_sc(c["sc_id"])
            if row and (row["id"] in recent_local or row["disliked"]):
                continue
            if c["sc_id"] in lib_sc:
                lib_taken += 1
            tid = row["id"] if row else self.db.upsert_sc_track(c)
            full = self.db.track(tid)
            full["_seed"], full["_score"] = c["_seed"], c["_score"]
            self.queue.append(full)
            recent_artists.append(artist_key(c["artist"]))


class ColdStart(Exception):
    """Нечего брать за основу: библиотека пуста. Нужно импортировать музыку или задать стиль."""
