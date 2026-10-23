"""Подборки для главной: миксы по любимым артистам и «Открытия» — из похожих треков SoundCloud."""
from __future__ import annotations

import random
import time
from collections import defaultdict

from .db import Database, artist_key
from .recommender import Wave
from .soundcloud import SoundCloud, SoundCloudError

MIX_SIZE = 30


class Feed:
    def __init__(self, db: Database, sc: SoundCloud):
        self.db, self.sc = db, sc
        self._cache: tuple[str, list[dict]] | None = None

    def _related(self, sc_id: int) -> list[dict]:
        cached = self.db.get_related(sc_id)
        if cached is not None:
            return cached
        try:
            rel = self.sc.related(sc_id, limit=30)
        except SoundCloudError:
            return []
        self.db.put_related(sc_id, rel)
        return rel

    def mixes(self, force: bool = False) -> list[dict]:
        """Миксы обновляются раз в день (и при force)."""
        day = time.strftime("%Y-%m-%d")
        if self._cache and self._cache[0] == day and not force:
            return self._cache[1]
        out = self._build(random.Random(day if not force else time.time()))
        self._cache = (day, out)
        return out

    def _build(self, rng: random.Random) -> list[dict]:
        w = Wave(self.db, self.sc)
        w.build_profile()
        if not w.seed_w:
            return []
        disliked = {r["sc_id"] for r in self.db.query("SELECT sc_id FROM tracks WHERE disliked=1 AND sc_id IS NOT NULL")}
        # семена по артистам
        by_artist: dict[str, list[tuple[int, float]]] = defaultdict(list)
        for sc_id, weight in w.seed_w.items():
            row = self.db.track_by_sc(sc_id)
            if row:
                by_artist[row["artist_key"]].append((sc_id, weight))
        top = sorted(by_artist.items(), key=lambda kv: -sum(x[1] for x in kv[1]))[:5]
        mixes = []
        used_new: set[int] = set()
        for akey, seeds in top:
            seeds = sorted(seeds, key=lambda x: -x[1])[:3]
            pool: dict[int, dict] = {}
            for sc_id, _ in seeds:
                for c in self._related(sc_id):
                    if c["playable"] and c["sc_id"] not in disliked:
                        pool[c["sc_id"]] = c
            own = [r for r in self.db.artist_tracks(akey) if r.get("sc_id") and r.get("playable") != 0][:6]
            cands = list(pool.values())
            rng.shuffle(cands)
            ids = [r["id"] for r in own[:4]]
            seen_artists: dict[str, int] = defaultdict(int)
            for c in cands:
                a = artist_key(c["artist"])
                if seen_artists[a] >= 2:
                    continue
                seen_artists[a] += 1
                row = self.db.track_by_sc(c["sc_id"])
                ids.append(row["id"] if row else self.db.upsert_sc_track(c))
                if len(ids) >= MIX_SIZE:
                    break
            rng.shuffle(ids)
            if len(ids) < 8:
                continue
            name = own[0]["artist"] if own else akey
            others = [n for n in self._names(ids) if artist_key(n) != akey][:2]
            mixes.append(self._pack(f"Микс: {name}", ", ".join([name] + others) + " и похожие", ids))
        # «Открытия»: похожие треки от незнакомых артистов
        disc: list[int] = []
        seeds = w._pick_seeds(6)
        for sc_id in seeds:
            for c in self._related(sc_id):
                a = artist_key(c["artist"])
                if not c["playable"] or c["sc_id"] in disliked or w.artist_aff.get(a, 0) > 0.05 or c["sc_id"] in used_new:
                    continue
                used_new.add(c["sc_id"])
                row = self.db.track_by_sc(c["sc_id"])
                if row and row["in_library"]:
                    continue
                disc.append(row["id"] if row else self.db.upsert_sc_track(c))
        rng.shuffle(disc)
        if len(disc) >= 8:
            mixes.insert(0, self._pack("Открытия дня", "Новые для тебя артисты в духе твоих любимых", disc[:MIX_SIZE],
                                       key="discover"))
        return mixes

    def _names(self, ids: list[int]) -> list[str]:
        seen, out = set(), []
        for i in ids:
            t = self.db.track(i)
            if t and t["artist"] not in seen:
                seen.add(t["artist"])
                out.append(t["artist"])
        return out

    def _pack(self, title: str, sub: str, ids: list[int], key: str | None = None) -> dict:
        arts = []
        for i in ids:
            t = self.db.track(i)
            if t and t["artwork_url"] and t["artwork_url"] not in arts:
                arts.append(t["artwork_url"])
            if len(arts) == 4:
                break
        return {"key": key or title, "title": title, "sub": sub, "ids": ids, "arts": arts}
