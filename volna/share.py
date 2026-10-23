"""Обмен плейлистами с друзьями: короткий код (текстом в мессенджер) или файл .volna."""
from __future__ import annotations

import base64
import json
import zlib

from .db import Database

PREFIX = "VOLNA1:"


def pack(db: Database, name: str, tracks: list[dict]) -> str:
    items = []
    for t in tracks:
        it = {"t": t.get("title") or "", "a": t.get("artist") or ""}
        if t.get("duration_ms"):
            it["d"] = int(t["duration_ms"] / 1000)
        for src, key in (("sc_id", "sc"), ("spotify_uri", "sp"), ("ym_id", "ym")):
            if t.get(src):
                it[key] = t[src]
        if t.get("artwork_url"):
            it["i"] = t["artwork_url"]
        if t.get("permalink_url"):
            it["u"] = t["permalink_url"]
        items.append(it)
    raw = json.dumps({"v": 1, "n": name, "tr": items}, ensure_ascii=False, separators=(",", ":")).encode()
    return PREFIX + base64.urlsafe_b64encode(zlib.compress(raw, 9)).decode().rstrip("=")


def unpack(code: str) -> dict:
    code = "".join((code or "").split())
    if code.startswith(PREFIX):
        code = code[len(PREFIX):]
    try:
        raw = zlib.decompress(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)))
        data = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        raise ValueError("Код плейлиста повреждён — скопируй его целиком") from e
    if not isinstance(data, dict) or not isinstance(data.get("tr"), list):
        raise ValueError("Это не код плейлиста Volna")
    return data


def import_code(db: Database, code: str) -> dict:
    data = unpack(code)
    ids = []
    for it in data["tr"][:5000]:
        if not isinstance(it, dict):
            continue
        title, artist = str(it.get("t") or "")[:300], str(it.get("a") or "")[:300]
        if not title:
            continue
        try:
            dur_ms = int(it.get("d") or 0) * 1000
            if it.get("sc"):
                it["sc"] = int(it["sc"])
        except (TypeError, ValueError):
            continue   # испорченная запись — пропускаем, остальное импортируем
        if it.get("ym"):
            tid = db.upsert_ym_track({"ym_id": str(it["ym"]), "title": title, "artist": artist, "duration_ms": dur_ms,
                                      "artwork_url": it.get("i") or ""}, in_library=True)
            if it.get("sc"):   # трек есть и на SoundCloud — запомним, чтобы был запасной источник
                db.attach_match(tid, {"sc_id": int(it["sc"]), "artwork_url": it.get("i") or "",
                                      "permalink_url": it.get("u") or "", "playable": True, "duration_ms": dur_ms})
        elif it.get("sc"):
            tid = db.upsert_sc_track({
                "sc_id": int(it["sc"]), "title": title, "artist": artist,
                "duration_ms": dur_ms, "artwork_url": it.get("i") or "",
                "permalink_url": it.get("u") or "", "playable": True,
            }, in_library=True)
        else:
            tid = db.upsert_spotify_track(it.get("sp"), title, artist, "", dur_ms, in_library=True)
        ids.append(tid)
    if not ids:
        raise ValueError("В коде нет треков")
    name = (str(data.get("n") or "Плейлист друга")[:100]) + " (от друга)"
    pid = db.create_playlist(name)
    for tid in ids:
        db.add_to_playlist(pid, tid)
    return {"pid": pid, "name": name, "tracks": len(ids)}
