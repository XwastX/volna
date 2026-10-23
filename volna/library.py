"""Импорт из SoundCloud: профиль пользователя (лайки + плейлисты) или отдельная ссылка."""
from __future__ import annotations

from .db import Database
from .soundcloud import SoundCloud, SoundCloudError, parse_track


def import_sc_profile(db: Database, client: SoundCloud, url: str, progress=None) -> dict:
    url = url.strip()
    if not url.startswith("http"):
        url = "https://soundcloud.com/" + url.lstrip("@/")
    if progress:
        progress(0.02, "Ищу профиль")
    user = client.resolve(url)
    if user.get("kind") != "user":
        raise SoundCloudError("Ссылка не на профиль. Нужна вида soundcloud.com/имя")
    uid = user["id"]
    if progress:
        progress(0.1, "Загружаю лайки")
    likes = client.user_likes(uid)
    for t in likes:
        db.upsert_sc_track(t, in_library=True, liked=True)
    if progress:
        progress(0.4, "Загружаю плейлисты")
    playlists = client.user_playlists(uid)
    n_pl = n_pt = 0
    for i, pl in enumerate(playlists):
        if progress:
            progress(0.4 + 0.6 * i / max(1, len(playlists)), f"Плейлист: {pl.get('title', '')}")
        try:
            title, tracks = client.playlist_full(pl)
        except SoundCloudError:
            continue
        ids = [db.upsert_sc_track(t, in_library=True) for t in tracks]
        if ids:
            db.upsert_playlist(title, "sc", f"sc:{pl['id']}", ids)
            n_pl += 1
            n_pt += len(ids)
    if progress:
        progress(1.0, "Готово")
    return {"user": user.get("username") or "", "likes": len(likes), "playlists": n_pl, "playlist_tracks": n_pt}


def import_sc_link(db: Database, client: SoundCloud, url: str) -> dict:
    """Ссылка на трек, плейлист/альбом или профиль SoundCloud."""
    obj = client.resolve(url)
    kind = obj.get("kind")
    if kind == "track":
        t = parse_track(obj)
        db.upsert_sc_track(t, in_library=True)
        return {"kind": "track", "name": f"{t['artist']} — {t['title']}", "tracks": 1}
    if kind == "playlist":
        title, tracks = client.playlist_full(obj)
        ids = [db.upsert_sc_track(t, in_library=True) for t in tracks]
        db.upsert_playlist(title, "sc", f"sc:{obj['id']}", ids)
        return {"kind": "playlist", "name": title, "tracks": len(ids)}
    if kind == "user":
        r = import_sc_profile(db, client, url)
        return {"kind": "user", "name": r["user"], "tracks": r["likes"] + r["playlist_tracks"]}
    raise SoundCloudError("Не понял, что это за ссылка")
