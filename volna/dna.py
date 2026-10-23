"""«Музыкальная ДНК»: портрет вкуса по медиатеке и прослушиваниям + сравнение с другом по коду."""
from __future__ import annotations

import base64
import json
import math
import re
import time
import zlib
from collections import defaultdict

from .db import Database, artist_key
from .recommender import MOODS

PREFIX = "VOLNADNA1:"
_TAG_RE = re.compile(r'"([^"]+)"|(\S+)')

# синонимы жанров: на SoundCloud один и тот же жанр пишут по-разному
_GENRE_ALIASES = {
    "hip-hop": "hip hop", "hiphop": "hip hop", "hip hop & rap": "hip hop", "rap": "hip hop", "русский рэп": "hip hop",
    "rusrap": "hip hop", "foreignrap": "hip hop", "r&b & soul": "r&b", "rnb": "r&b", "electronic music": "electronic",
    "electronica": "electronic", "lo-fi": "lofi", "lo fi": "lofi", "drum & bass": "drum and bass", "dnb": "drum and bass",
    "d&b": "drum and bass", "alternative rock": "alternative", "indie rock": "indie", "indie pop": "indie",
    "rusrock": "rock", "ruspop": "pop", "dance & edm": "edm", "dance": "edm", "electro": "electronic",
    "soundtrack": "ost", "films": "ost", "anime": "ost", "phonk music": "phonk", "drift phonk": "phonk",
    "post punk": "post-punk", "postpunk": "post-punk", "techno music": "techno",
    "classical music": "classical", "classicalmusic": "classical", "metal music": "metal", "trap music": "trap",
}
GENRE_LABELS = {
    "hip hop": "Хип-хоп", "electronic": "Электроника", "pop": "Поп", "rock": "Рок", "indie": "Инди",
    "lofi": "Лоуфай", "phonk": "Фонк", "r&b": "R&B", "edm": "EDM", "house": "Хаус", "techno": "Техно",
    "drum and bass": "Драм-н-бэйс", "metal": "Метал", "jazz": "Джаз", "classical": "Классика", "ost": "Саундтреки",
    "post-punk": "Пост-панк", "trap": "Трэп", "alternative": "Альтернатива", "ambient": "Эмбиент",
    "soul": "Соул", "punk": "Панк", "dubstep": "Дабстеп", "folk": "Фолк", "country": "Кантри",
    "reggae": "Регги", "k-pop": "K-pop", "j-pop": "J-pop", "hyperpop": "Гиперпоп", "drill": "Дрилл",
    "dance": "Танцевальная", "disco": "Диско", "funk": "Фанк", "blues": "Блюз", "chanson": "Шансон",
}
# порядок важен: первый подходящий архетип с наибольшей силой признака
ARCHETYPES = {
    "digger": ("Искатель андеграунда", "Находишь треки раньше, чем они попадут в чарты"),
    "omnivore": ("Всеядный исследователь", "Слушаешь всё подряд и не держишься за один жанр"),
    "loyal": ("Верный фанат", "У тебя есть свои артисты, и ты им не изменяешь"),
    "keeper": ("Хранитель классики", "Музыка прошлых десятилетий звучит у тебя чаще новинок"),
    "fresh": ("Охотник за новинками", "Почти всё, что ты слушаешь, вышло недавно"),
    "night": ("Ночной слушатель", "Главная музыка у тебя звучит после полуночи"),
    "energy": ("Заряженный", "Быстрое, громкое, с басом — твоё"),
    "calm": ("Созерцатель", "Спокойная музыка под мысли и дождь"),
    "mainstream": ("Голос большинства", "Слушаешь то, что знают все — и это нормально"),
}


def _genre(t: dict) -> str:
    g = (t.get("genre") or "").strip().lower()
    if not g:
        for a, b in _TAG_RE.findall(t.get("tags") or ""):
            g = (a or b).strip().lower()
            if g:
                break
    g = re.sub(r"\s+", " ", g)
    return _GENRE_ALIASES.get(g, g)


def genre_label(g: str) -> str:
    return GENRE_LABELS.get(g) or g[:1].upper() + g[1:]


def _weights(db: Database) -> tuple[dict[int, float], dict[int, dict]]:
    """Вес каждого трека во вкусе: лайк, медиатека, прослушивания (минуты), минус скипы и дизлайки."""
    tracks = {t["id"]: t for t in db.query(
        "SELECT * FROM tracks WHERE in_library=1 OR liked=1 OR id IN (SELECT track_id FROM events)")}
    w: dict[int, float] = defaultdict(float)
    for t in tracks.values():
        w[t["id"]] += (3.0 if t["liked"] else 0.0) + (1.0 if t["in_library"] else 0.0) - (6.0 if t["disliked"] else 0.0)
    for r in db.query("SELECT track_id, kind, sum(ms) AS ms, count(*) AS n FROM events"
                      " WHERE kind IN ('complete','skip','history') GROUP BY track_id, kind"):
        if r["track_id"] not in tracks:
            continue
        if r["kind"] == "skip":
            w[r["track_id"]] -= 0.3 * r["n"]
        else:
            w[r["track_id"]] += min(6.0, (r["ms"] or 0) / 180_000)   # ~1 очко за 3 минуты, не больше 6
    return {k: v for k, v in w.items() if v > 0}, tracks


def _norm(d: dict, top: int | None = None) -> dict:
    total = sum(d.values()) or 1.0
    items = sorted(d.items(), key=lambda kv: -kv[1])
    if top:
        items = items[:top]
    return {k: round(v / total, 4) for k, v in items}


def _entropy(d: dict) -> float:
    vals = [v for v in d.values() if v > 0]
    if len(vals) < 2:
        return 0.0
    s = sum(vals)
    h = -sum(v / s * math.log(v / s) for v in vals)
    return h / math.log(len(vals))


def _clamp(x: float, lo: float = 0, hi: float = 100) -> int:
    return int(round(max(lo, min(hi, x))))


def compute(db: Database, by_hour: list[int] | None = None) -> dict:
    w, tracks = _weights(db)
    if len(w) < 5:
        return {"empty": True, "n": len(w)}
    total = sum(w.values())

    # жанры
    genres: dict[str, float] = defaultdict(float)
    for tid, x in w.items():
        g = _genre(tracks[tid])
        if g:
            genres[g] += x
    g_top = _norm(genres, 8)

    # артисты
    artists: dict[str, float] = defaultdict(float)
    names: dict[str, str] = {}
    arts: dict[str, str] = {}
    for tid, x in w.items():
        t = tracks[tid]
        k = t["artist_key"] or artist_key(t["artist"])
        if not k:
            continue
        artists[k] += x
        names.setdefault(k, (re.split(r",|&| x | feat", t["artist"], maxsplit=1)[0] or t["artist"]).strip())
        if t.get("artwork_url") and k not in arts:
            arts[k] = t["artwork_url"]
    a_sorted = sorted(artists.items(), key=lambda kv: -kv[1])
    top5_share = sum(v for _, v in a_sorted[:5]) / (sum(artists.values()) or 1)

    # эпохи
    decades: dict[str, float] = defaultdict(float)
    years_w = 0.0
    year_sum = 0.0
    for tid, x in w.items():
        y = tracks[tid].get("year") or 0
        if 1900 < y < 2100:
            decades[f"{y // 10 * 10}"] += x
            year_sum += y * x
            years_w += x
    avg_year = int(round(year_sum / years_w)) if years_w else 0
    known_years = years_w / total if total else 0
    this_year = time.localtime().tm_year
    fresh_share = (sum(x for tid, x in w.items() if (tracks[tid].get("year") or 0) >= this_year - 2) / years_w
                   if years_w else 0)

    # редкость (по числу прослушиваний на SoundCloud)
    pl = sorted((tracks[tid]["plays"], x) for tid, x in w.items() if (tracks[tid].get("plays") or 0) > 0)
    median_plays = 0
    if pl:
        half, acc = sum(x for _, x in pl) / 2, 0.0
        for p, x in pl:
            acc += x
            if acc >= half:
                median_plays = p
                break
    rarity = _clamp((7.2 - math.log10(median_plays + 1)) / 4.2 * 100) if median_plays else None
    gems = sorted(((tid, x) for tid, x in w.items() if 0 < (tracks[tid].get("plays") or 0) < 50_000),
                  key=lambda kv: (-kv[1], tracks[kv[0]]["plays"]))[:4]

    # энергия: доля «бодрых» и «спокойных» тегов
    def mood_share(key: str) -> float:
        plus = MOODS[key]["plus"]
        s = 0.0
        for tid, x in w.items():
            t = tracks[tid]
            text = f" {_genre(t)} {(t.get('tags') or '').lower()} {(t.get('genre') or '').lower()} "
            if any(re.search(rf"(?<![a-z]){re.escape(p)}(?![a-z])", text) for p in plus):
                s += x
        return s / total
    energetic, calm = mood_share("energetic"), mood_share("calm")
    energy = _clamp(50 + (energetic - calm) * 120)

    diversity = _clamp(_entropy(artists) * 70 + _entropy(genres) * 30)
    # верность: насколько топ-5 артистов перетягивают на себя больше «честной» доли
    n_art = len(artists)
    fair = min(1.0, 5 / n_art) if n_art else 1.0
    loyalty = _clamp((top5_share - fair) / (1 - fair) * 160) if fair < 1 else 50

    # ночь/день
    hours = by_hour or [0] * 24
    hsum = sum(hours) or 1
    night = sum(hours[h] for h in (0, 1, 2, 3, 4, 23)) / hsum
    morning = sum(hours[h] for h in range(5, 11)) / hsum
    chrono = ("Сова" if night > 0.28 else "Жаворонок" if morning > 0.35 else "Дневной") if sum(hours) else ""

    # источники
    src: dict[str, float] = defaultdict(float)
    for tid, x in w.items():
        s = tracks[tid].get("sources") or ""
        if tracks[tid].get("ym_id") or "yandex" in s:
            src["Яндекс"] += x
        elif "spotify" in s:
            src["Spotify"] += x
        else:
            src["SoundCloud"] += x

    # архетип: самая выраженная черта
    traits = {
        "digger": (rarity or 0) / 100 * 1.1 if rarity is not None and rarity > 60 else 0,
        "omnivore": diversity / 100 if diversity > 70 else 0,
        "loyal": loyalty / 100 if loyalty > 55 else 0,
        "keeper": (min(1.0, (this_year - avg_year) / 25) if avg_year and this_year - avg_year > 12
                   and known_years > 0.2 else 0),
        "fresh": fresh_share if fresh_share > 0.55 and known_years > 0.2 else 0,
        "night": night * 1.6 if night > 0.3 else 0,
        "energy": energy / 100 if energy > 68 else 0,
        "calm": (100 - energy) / 100 if energy < 32 else 0,
        "mainstream": (100 - rarity) / 100 * 0.9 if rarity is not None and rarity < 30 else 0,
    }
    ranked = [k for k, v in sorted(traits.items(), key=lambda kv: -kv[1]) if v > 0]
    if not ranked:
        ranked = ["omnivore"]
    main, second = ranked[0], (ranked[1] if len(ranked) > 1 else None)

    return {
        "empty": False,
        "n": len(w),
        "archetype": {"key": main, "title": ARCHETYPES[main][0], "text": ARCHETYPES[main][1],
                      "second": ARCHETYPES[second][0] if second else ""},
        "genres": [{"key": k, "label": genre_label(k), "share": v} for k, v in g_top.items()],
        "artists": [{"key": k, "name": names.get(k, k), "art": arts.get(k, ""),
                     "share": round(v / (sum(artists.values()) or 1), 4)} for k, v in a_sorted[:8]],
        "decades": [{"label": f"{d}-е", "share": v} for d, v in sorted(_norm(decades).items())],
        "avgYear": avg_year, "knownYears": round(known_years, 2),
        "rarity": rarity, "medianPlays": median_plays,
        "gems": [{"id": tid, "title": tracks[tid]["title"], "artist": tracks[tid]["artist"],
                  "art": tracks[tid]["artwork_url"], "plays": tracks[tid]["plays"]} for tid, _ in gems],
        "diversity": diversity, "loyalty": loyalty, "energy": energy,
        "chrono": chrono, "sources": [{"label": k, "share": v} for k, v in _norm(src).items()],
        "artistsTotal": len(artists),
        "_artists_full": {k: round(v / total, 5) for k, v in a_sorted[:80]},
        "_names": {k: names.get(k, k) for k, _ in a_sorted[:80]},
        "_genres_full": _norm(genres, 25),
        "_decades_full": _norm(decades),
    }


def rarity_label(r: int | None) -> str:
    if r is None:
        return "Пока неизвестно"
    return ("Глубокий андеграунд" if r >= 80 else "Андеграунд" if r >= 60 else
            "Между нишей и мейнстримом" if r >= 40 else "Популярное" if r >= 20 else "Мейнстрим")


def public(d: dict) -> dict:
    """Без служебных полей — для интерфейса."""
    out = {k: v for k, v in d.items() if not k.startswith("_")}
    if not d.get("empty"):
        out["rarityLabel"] = rarity_label(d.get("rarity"))
    return out


# --- код для друга -----------------------------------------------------------
def pack(d: dict, name: str = "") -> str:
    if d.get("empty"):
        raise ValueError("Пока мало данных — послушай и полайкай треки, потом делись ДНК")
    payload = {
        "v": 1, "n": (name or "")[:40], "t": d["archetype"]["key"],
        "a": [[k, d["_names"].get(k, k)[:60], v] for k, v in d["_artists_full"].items()],
        "g": d["_genres_full"], "e": d["_decades_full"],
        "r": d.get("rarity"), "dv": d.get("diversity"), "en": d.get("energy"),
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    return PREFIX + base64.urlsafe_b64encode(zlib.compress(raw, 9)).decode().rstrip("=")


def unpack(code: str) -> dict:
    code = "".join((code or "").split())
    if not code.startswith(PREFIX):
        raise ValueError("Это не код ДНК Volna — он начинается с VOLNADNA1:")
    body = code[len(PREFIX):]
    try:
        data = json.loads(zlib.decompress(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)), bufsize=1 << 16))
    except Exception as e:  # noqa: BLE001
        raise ValueError("Код ДНК повреждён — скопируй его целиком") from e
    if not isinstance(data, dict) or not isinstance(data.get("a"), list):
        raise ValueError("Код ДНК повреждён")
    arts = {}
    names = {}
    for it in data["a"][:120]:
        if isinstance(it, list) and len(it) == 3 and isinstance(it[0], str):
            try:
                arts[it[0][:80]] = float(it[2])
            except (TypeError, ValueError):
                continue
            names[it[0][:80]] = str(it[1])[:60]

    def fdict(x):
        out = {}
        if isinstance(x, dict):
            for k, v in list(x.items())[:60]:
                try:
                    out[str(k)[:40]] = float(v)
                except (TypeError, ValueError):
                    pass
        return out
    return {"name": str(data.get("n") or "")[:40], "type": str(data.get("t") or ""), "artists": arts, "names": names,
            "genres": fdict(data.get("g")), "decades": fdict(data.get("e")),
            "rarity": data.get("r") if isinstance(data.get("r"), (int, float)) else None,
            "diversity": data.get("dv") if isinstance(data.get("dv"), (int, float)) else None,
            "energy": data.get("en") if isinstance(data.get("en"), (int, float)) else None}


def _cos(a: dict, b: dict) -> float:
    keys = set(a) | set(b)
    if not keys:
        return 0.0
    dot = sum(a.get(k, 0) * b.get(k, 0) for k in keys)
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def compare(mine: dict, code: str) -> dict:
    if mine.get("empty"):
        raise ValueError("Сначала нужно немного послушать музыку здесь — пока твоя ДНК пустая")
    other = unpack(code)
    a_sim = _cos(mine["_artists_full"], other["artists"])
    g_sim = _cos(mine["_genres_full"], other["genres"])
    e_sim = _cos(mine["_decades_full"], other["decades"]) if mine["_decades_full"] and other["decades"] else g_sim
    # артисты совпадают редко, поэтому их сходство «растягиваем» корнем
    score = _clamp((math.sqrt(a_sim) * 0.45 + g_sim * 0.4 + e_sim * 0.15) * 100)
    common = sorted(set(mine["_artists_full"]) & set(other["artists"]),
                    key=lambda k: -(mine["_artists_full"][k] + other["artists"][k]))
    theirs = [k for k in sorted(other["artists"], key=lambda k: -other["artists"][k]) if k not in mine["_artists_full"]]
    common_g = sorted(set(mine["_genres_full"]) & set(other["genres"]),
                      key=lambda k: -(mine["_genres_full"][k] + other["genres"][k]))
    verdict = ("Музыкальные близнецы" if score >= 80 else "Очень похожий вкус" if score >= 60 else
               "Есть общее" if score >= 40 else "Разные миры, но пересечения есть" if score >= 20 else "Полные противоположности")
    return {
        "name": other["name"] or "Друг", "score": score, "verdict": verdict,
        "type": ARCHETYPES.get(other["type"], ("", ""))[0],
        "common": [mine["_names"].get(k) or other["names"].get(k, k) for k in common[:10]],
        "commonGenres": [genre_label(g) for g in common_g[:6]],
        "discover": [{"key": k, "name": other["names"].get(k, k)} for k in theirs[:8]],
        "parts": {"artists": _clamp(math.sqrt(a_sim) * 100), "genres": _clamp(g_sim * 100), "eras": _clamp(e_sim * 100)},
    }


def backfill(db: Database, sc, limit: int = 400) -> int:
    """Дозаполняет год и популярность у треков SoundCloud, сохранённых до версии 0.6."""
    rows = db.query("SELECT sc_id FROM tracks WHERE sc_id IS NOT NULL AND (plays IS NULL OR year IS NULL)"
                    " AND (liked=1 OR in_library=1 OR id IN (SELECT track_id FROM events))"
                    " AND coalesce(playable,1)=1 LIMIT ?", (limit,))
    ids = [r["sc_id"] for r in rows]
    if not ids:
        return 0
    got = sc.tracks_by_ids(ids)
    seen = set()
    for t in got:
        seen.add(t["sc_id"])
        db.execute("UPDATE tracks SET year=?, plays=? WHERE sc_id=?",
                   (t.get("year") or 0, t.get("playback_count") or 0, t["sc_id"]))
    # трек удалён с SC — ставим нули, чтобы не спрашивать снова
    for i in ids:
        if i not in seen:
            db.execute("UPDATE tracks SET year=coalesce(year,0), plays=coalesce(plays,0) WHERE sc_id=?", (i,))
    return len(got)
