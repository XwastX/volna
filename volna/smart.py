"""Умные плейлисты: правила вместо ручного списка, содержимое пересчитывается само.

Правило: {"field": ..., "op": ..., "value": ...}. Плейлист: {"match": "all"|"any", "rules": [...],
"sort": ..., "limit": N}. SQL собирается только из белого списка — никаких строк от пользователя в запросе.
"""
from __future__ import annotations

import json
import time

from .db import Database

SCHEMA = """
CREATE TABLE IF NOT EXISTS smart_playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    rules      TEXT NOT NULL,
    created_at REAL NOT NULL
);
"""

# поле → (подпись, тип, SQL-выражение)
PLAYS = "(SELECT count(*) FROM events e WHERE e.track_id=t.id AND e.kind IN ('complete','play'))"
LAST = "(SELECT max(e.ts) FROM events e WHERE e.track_id=t.id AND e.kind IN ('complete','play','skip'))"
FIELDS = {
    "liked":    ("В «Любимых»", "bool", "t.liked"),
    "source":   ("Источник", "enum", "t.sources"),
    "artist":   ("Исполнитель", "text", "t.artist"),
    "title":    ("Название", "text", "t.title"),
    "genre":    ("Жанр или тег", "text", "(t.genre || ' ' || t.tags)"),
    "added":    ("Добавлен за последние (дней)", "days", "t.added_at"),
    "played":   ("Играл за последние (дней)", "days", LAST),
    "notplayed": ("Не играл последние (дней)", "days_not", LAST),
    "plays":    ("Прослушиваний", "num", PLAYS),
    "duration": ("Длительность (мин)", "minutes", "t.duration_ms"),
}
OPS = {
    "bool": {"is": "да", "isnot": "нет"},
    "enum": {"has": "это", "hasnot": "не это"},
    "text": {"contains": "содержит", "notcontains": "не содержит", "is": "равно"},
    "days": {"within": "за"},
    "days_not": {"within": "не играл"},
    "num": {"gte": "не меньше", "lte": "не больше"},
    "minutes": {"gte": "не меньше", "lte": "не больше"},
}
SOURCES = {"sc": "SoundCloud", "spotify": "Spotify", "yandex": "Яндекс Музыка"}
SORTS = {
    "added": ("Сначала новые", "t.added_at DESC"),
    "plays": ("Самые заслушанные", f"{PLAYS} DESC"),
    "last": ("Давно не игравшие", f"coalesce({LAST}, 0) ASC"),
    "title": ("По названию", "t.title COLLATE NOCASE"),
    "random": ("Случайно", "random()"),
}

PRESETS = [
    {"name": "Любимое за месяц", "rules": {"match": "all", "rules": [
        {"field": "liked", "op": "is", "value": True}, {"field": "added", "op": "within", "value": 30}],
        "sort": "added", "limit": 100}},
    {"name": "Давно не слушал", "rules": {"match": "all", "rules": [
        {"field": "liked", "op": "is", "value": True}, {"field": "notplayed", "op": "within", "value": 60}],
        "sort": "random", "limit": 50}},
    {"name": "На повторе", "rules": {"match": "all", "rules": [
        {"field": "plays", "op": "gte", "value": 5}], "sort": "plays", "limit": 50}},
    {"name": "Из Spotify", "rules": {"match": "all", "rules": [
        {"field": "source", "op": "has", "value": "spotify"}], "sort": "added", "limit": 500}},
    {"name": "Короткие треки", "rules": {"match": "all", "rules": [
        {"field": "duration", "op": "lte", "value": 2.5}], "sort": "random", "limit": 60}},
]


def ensure(db: Database) -> None:
    db.conn().executescript(SCHEMA)


def _truthy(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() not in ("", "0", "false", "нет", "no")
    return bool(v)


def _clause(r: dict, args: list) -> str | None:
    if not isinstance(r, dict) or not isinstance(r.get("field"), str):
        return None
    f = FIELDS.get(r.get("field"))
    if not f:
        return None
    _label, typ, expr = f
    op, v = r.get("op"), r.get("value")
    if typ == "bool":
        return f"{expr}={'1' if (op == 'is') == _truthy(v) else '0'}"
    if typ == "enum":
        if not isinstance(v, str) or v not in SOURCES:
            return None
        args.append(f"%{v}%")
        return f"{expr} {'LIKE' if op == 'has' else 'NOT LIKE'} ?"
    if typ == "text":
        if not isinstance(v, (str, int, float)):
            return None
        s = str(v).strip()[:200]
        if not s:
            return None
        if op == "is":
            args.append(s)
            return f"lower({expr})=lower(?)"
        args.append(f"%{s}%")
        return f"{expr} {'NOT LIKE' if op == 'notcontains' else 'LIKE'} ?"
    if typ in ("days", "days_not"):
        try:
            since = time.time() - float(v) * 86400
        except (TypeError, ValueError):
            return None
        args.append(since)
        return f"coalesce({expr}, 0) < ?" if typ == "days_not" else f"coalesce({expr}, 0) >= ?"
    if typ in ("num", "minutes"):
        try:
            n = float(v) * (60000 if typ == "minutes" else 1)
        except (TypeError, ValueError):
            return None
        args.append(n)
        return f"{expr} {'>=' if op == 'gte' else '<='} ?"
    return None


def query(db: Database, rules: dict) -> list[dict]:
    if not isinstance(rules, dict):
        rules = {}
    raw = rules.get("rules")
    args: list = []
    clauses = [c for c in (_clause(r, args) for r in (raw if isinstance(raw, list) else [])) if c]
    glue = " OR " if rules.get("match") == "any" else " AND "
    where = f"({glue.join(clauses)})" if clauses else "1=1"
    sort = SORTS.get(rules.get("sort") if isinstance(rules.get("sort"), str) else "added", SORTS["added"])[1]
    try:
        limit = max(1, min(2000, int(rules.get("limit") or 200)))
    except (TypeError, ValueError):
        limit = 200
    sql = (f"SELECT t.* FROM tracks t WHERE (t.in_library=1 OR t.liked=1) AND t.disliked=0 AND {where}"
           f" ORDER BY {sort} LIMIT {limit}")
    return db.query(sql, args)


def list_all(db: Database) -> list[dict]:
    ensure(db)
    out = []
    for r in db.query("SELECT * FROM smart_playlists ORDER BY created_at"):
        rules = json.loads(r["rules"])
        rows = query(db, rules)
        out.append({"id": r["id"], "name": r["name"], "rules": rules, "n": len(rows),
                    "arts": [t["artwork_url"] for t in rows if t.get("artwork_url")][:4]})
    return out


def save(db: Database, name: str, rules: dict, sid: int | None = None) -> int:
    ensure(db)
    blob = json.dumps(rules, ensure_ascii=False)
    if sid:
        db.execute("UPDATE smart_playlists SET name=?, rules=? WHERE id=?", (name, blob, sid))
        return sid
    return db.execute("INSERT INTO smart_playlists (name, rules, created_at) VALUES (?,?,?)",
                      (name, blob, time.time())).lastrowid


def delete(db: Database, sid: int) -> None:
    db.execute("DELETE FROM smart_playlists WHERE id=?", (sid,))


def get(db: Database, sid: int) -> dict | None:
    ensure(db)
    r = db.one("SELECT * FROM smart_playlists WHERE id=?", (sid,))
    if not r:
        return None
    return {"id": r["id"], "name": r["name"], "rules": json.loads(r["rules"])}


def schema() -> dict:
    """Описание полей/операций для редактора в интерфейсе."""
    return {
        "fields": [{"key": k, "label": v[0], "type": v[1]} for k, v in FIELDS.items()],
        "ops": OPS,
        "sources": [{"key": k, "label": v} for k, v in SOURCES.items()],
        "sorts": [{"key": k, "label": v[0]} for k, v in SORTS.items()],
        "presets": PRESETS,
    }
