"""Тексты песен из открытой базы LRCLIB (lrclib.net): синхронные (LRC) или обычные."""
from __future__ import annotations

import re

import requests

from . import __version__
from .db import norm

API = "https://lrclib.net/api"
HEADERS = {"User-Agent": f"Volna/{__version__} (desktop music player)"}

_JUNK = re.compile(r"\s*[\(\[][^)\]]*(official|video|audio|lyric|visuali[sz]er|remaster|prod|feat|ft\.|hd|hq|clip|клип)[^)\]]*[\)\]]", re.I)
_LRC_LINE = re.compile(r"\[(\d+):(\d+(?:[.:]\d+)?)\]")


def clean_title(title: str) -> str:
    t = _JUNK.sub("", title or "")
    t = re.sub(r"\s+(feat\.?|ft\.?)\s.*$", "", t, flags=re.I)
    return t.strip(" -–—") or title


def parse_lrc(lrc: str) -> list[dict]:
    """'[01:02.34] строка' → [{'t': 62340, 'text': 'строка'}], по времени."""
    out = []
    for raw in (lrc or "").splitlines():
        stamps = _LRC_LINE.findall(raw)
        if not stamps:
            continue
        text = _LRC_LINE.sub("", raw).strip()
        for m, s in stamps:
            sec = float(s.replace(":", "."))
            out.append({"t": int((int(m) * 60 + sec) * 1000), "text": text})
    out.sort(key=lambda x: x["t"])
    return out


def _pick(results: list[dict], title: str, artist: str, duration_s: float) -> dict | None:
    best, best_s = None, -1.0
    nt, na = norm(title), norm(artist)
    for r in results:
        s = 0.0
        if norm(r.get("trackName") or "") == nt:
            s += 2
        elif nt and nt in norm(r.get("trackName") or ""):
            s += 1
        ra = norm(r.get("artistName") or "")
        if na and (na in ra or ra in na):
            s += 2
        if duration_s and r.get("duration"):
            diff = abs(float(r["duration"]) - duration_s)
            s += 1.5 if diff <= 3 else 0.5 if diff <= 10 else -1
        if r.get("syncedLyrics"):
            s += 0.7
        if s > best_s:
            best, best_s = r, s
    return best if best_s >= 3 else None


def fetch(title: str, artist: str, duration_ms: int = 0) -> dict:
    """Возвращает {'synced': [...], 'plain': str, 'instrumental': bool, 'found': bool}."""
    t = clean_title(title)
    dur = round(duration_ms / 1000) if duration_ms else 0
    data = None
    try:
        params = {"track_name": t, "artist_name": artist}
        if dur:
            params["duration"] = dur
        r = requests.get(f"{API}/get", params=params, headers=HEADERS, timeout=12)
        if r.status_code == 200:
            data = r.json()
        elif r.status_code == 429 or r.status_code >= 500:
            raise RuntimeError("База текстов сейчас перегружена — попробуй позже")
    except requests.RequestException:
        pass
    if not data:
        try:
            r = requests.get(f"{API}/search", params={"track_name": t, "artist_name": artist},
                             headers=HEADERS, timeout=12)
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError("База текстов сейчас перегружена — попробуй позже")
            if r.status_code == 200:
                data = _pick(r.json() or [], t, artist, dur)
            if not data:
                r = requests.get(f"{API}/search", params={"q": f"{artist} {t}"}, headers=HEADERS, timeout=12)
                if r.status_code == 200:
                    data = _pick(r.json() or [], t, artist, dur)
        except requests.RequestException as e:
            raise RuntimeError(f"Нет связи с базой текстов: {e}") from e
    if not data:
        return {"synced": [], "plain": "", "instrumental": False, "found": False}
    return {
        "synced": parse_lrc(data.get("syncedLyrics") or ""),
        "plain": (data.get("plainLyrics") or "").strip(),
        "instrumental": bool(data.get("instrumental")),
        "found": True,
    }
