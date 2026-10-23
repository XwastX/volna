"""Поиск трека из Spotify на SoundCloud: нечёткое сравнение названия, артиста и длительности."""
from __future__ import annotations

import time
from difflib import SequenceMatcher

from .db import Database, artist_key, norm
from .soundcloud import SoundCloud, SoundCloudError

# слова, которые меняют трек: если их нет в оригинале, кандидат подозрителен
_VARIANT_WORDS = ("remix", "cover", "sped up", "speed up", "slowed", "nightcore", "live", "instrumental",
                  "karaoke", "8d", "reverb", "bass boosted", "acoustic", "кавер", "ремикс", "минус", "edit",
                  "mashup", "flip", "bootleg", "tiktok")

THRESHOLD = 0.62


def _sim(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    seq = SequenceMatcher(None, a, b).ratio()
    ta, tb = set(a.split()), set(b.split())
    contain = len(ta & tb) / max(1, len(ta))  # сколько слов оригинала есть у кандидата
    return max(seq, 0.9 * contain)


def score(title: str, artist: str, duration_ms: int, cand: dict) -> float:
    nt, na = norm(title), artist_key(artist)
    ct, ca = norm(cand["title"]), artist_key(cand["artist"])
    s_title = _sim(nt, ct)
    # артист мог оказаться в названии («Artist - Title») или быть каналом-перезаливщиком
    s_artist = max(_sim(na, ca), 1.0 if na and na in ct else 0.0, 0.85 if na and na in norm(cand["artist"]) else 0.0)
    if duration_ms and cand.get("duration_ms"):
        diff = abs(duration_ms - cand["duration_ms"]) / 1000
        s_dur = 1.0 if diff <= 3 else 0.8 if diff <= 8 else 0.4 if diff <= 20 else 0.0
    else:
        s_dur = 0.6
    s = 0.45 * s_title + 0.35 * s_artist + 0.20 * s_dur
    low_orig = (title + " " + artist).lower()
    low_cand = (cand["title"] + " " + cand["artist"]).lower()
    for w in _VARIANT_WORDS:
        if w in low_cand and w not in low_orig:
            s -= 0.15
            break
    if not cand.get("playable"):
        s -= 0.5
    return s


def find_on_soundcloud(client: SoundCloud, title: str, artist: str, duration_ms: int = 0) -> dict | None:
    best, best_s = None, 0.0
    queries = [f"{artist} {title}"]
    if len(norm(title)) > 4:
        queries.append(title)
    for q in queries:
        for cand in client.search_tracks(q, limit=15):
            s = score(title, artist, duration_ms, cand)
            if s > best_s:
                best, best_s = cand, s
        if best_s >= 0.85:
            break
    return best if best_s >= THRESHOLD else None


def match_pending(db: Database, client: SoundCloud, limit: int = 10_000, progress=None,
                  should_stop=lambda: False, delay: float = 0.35) -> dict:
    """Сопоставляет все ещё не найденные треки Spotify. progress(доля, текст)."""
    pending = db.unmatched_spotify(limit)
    found = failed = errors = 0
    for i, t in enumerate(pending):
        if should_stop():
            break
        if progress:
            progress(i / max(1, len(pending)), f"{t['artist']} — {t['title']}")
        try:
            cand = find_on_soundcloud(client, t["title"], t["artist"], t["duration_ms"])
        except SoundCloudError as e:
            errors += 1
            if errors >= 5:
                raise SoundCloudError(f"Поиск остановлен: SoundCloud не отвечает ({e}). "
                                      f"Найдено до остановки: {found}") from e
            time.sleep(2)
            continue
        errors = 0
        if cand:
            db.attach_match(t["id"], cand)
            found += 1
        else:
            db.mark_match_failed(t["id"])
            failed += 1
        time.sleep(delay)
    if progress:
        progress(1.0, "Готово")
    return {"found": found, "failed": failed, "total": len(pending)}
