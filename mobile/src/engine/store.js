"use strict";
/* Volna Mobile — хранилище: аккаунты, настройки, медиатека (та же модель, что SQLite на ПК, но в JSON). */
(() => {
  const { U, FS, DIR, norm, artistKey, pbkdf2Hex, timingSafeEq } = window.VP;
  const ITER = 120000;
  const COLORS = ["#8fa8ff", "#c38bff", "#ff8fb1", "#ffb86b", "#5fe3a1", "#5fd3ff", "#ffd23f", "#ff7a7a"];

  /* --- отложенная запись JSON (не чаще раза в ~1,2 с) --- */
  class JsonFile {
    constructor(path) { this.path = path; this.timer = null; this.pending = null; this.writing = Promise.resolve(); }
    async load(def) { const t = await FS.readText(this.path); if (!t) return def; try { return JSON.parse(t); } catch (_) { return def; } }
    save(obj, now = false) {
      this.pending = obj;
      clearTimeout(this.timer);
      const go = () => { const o = this.pending; this.pending = null; this.writing = this.writing.then(() => FS.writeText(this.path, JSON.stringify(o))).catch((e) => console.error("save", this.path, e)); return this.writing; };
      if (now) return go();
      this.timer = setTimeout(go, 1200);
      return this.writing;
    }
    flush() { if (this.pending) { clearTimeout(this.timer); return this.save(this.pending, true); } return this.writing; }
  }

  /* ================= аккаунты ================= */
  const Accounts = {
    file: new JsonFile("accounts.json"),
    d: null,
    async load() { this.d = await this.file.load({ accounts: [], last: "", trash: [] }); this.d.trash = this.d.trash || []; return this.d; },
    pub(a) { return { id: a.id, name: a.name, color: a.color, locked: !!a.hash, last: a.last_login || 0 }; },
    list() { return this.d.accounts.map((a) => this.pub(a)); },
    get(id) { return this.d.accounts.find((a) => a.id === id) || null; },
    checkName(name, skip = "") {
      name = String(name || "").split(/\s+/).filter(Boolean).join(" ").slice(0, 32);
      if (!name) throw new Error("Введи имя");
      if (this.d.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase() && a.id !== skip)) throw new Error("Аккаунт с таким именем уже есть");
      return name;
    },
    async create(name, password = "") {
      name = this.checkName(name);
      if (password && password.length < 4) throw new Error("Пароль — минимум 4 символа (или оставь пустым)");
      const a = { id: U.uid(), name, color: COLORS[this.d.accounts.length % COLORS.length], created: U.now() };
      if (password) { a.salt = U.uid() + U.uid(); a.hash = await pbkdf2Hex(password, a.salt, ITER); }
      this.d.accounts.push(a);
      await this.file.save(this.d, true);
      return this.pub(a);
    },
    async check(id, password) {
      const a = this.get(id); if (!a) return false;
      if (!a.hash) return true;
      return timingSafeEq(await pbkdf2Hex(password || "", a.salt, ITER), a.hash);
    },
    async login(id, password = "") {
      const a = this.get(id); if (!a) throw new Error("Аккаунт не найден");
      if (!(await this.check(id, password))) { await U.sleep(600); throw new Error("Неверный пароль"); }
      a.last_login = U.now(); this.d.last = id;
      await this.file.save(this.d, true);
      return this.pub(a);
    },
    async rename(id, name) { const a = this.get(id); a.name = this.checkName(name, id); await this.file.save(this.d, true); return this.pub(a); },
    async setPassword(id, old, nw) {
      if (!(await this.check(id, old))) throw new Error("Старый пароль не подходит");
      if (nw && nw.length < 4) throw new Error("Пароль — минимум 4 символа (или оставь пустым, чтобы убрать)");
      const a = this.get(id);
      if (nw) { a.salt = U.uid() + U.uid(); a.hash = await pbkdf2Hex(nw, a.salt, ITER); } else { delete a.salt; delete a.hash; }
      await this.file.save(this.d, true);
    },
    async remove(id, password) {
      if (!(await this.check(id, password))) throw new Error("Неверный пароль");
      this.d.accounts = this.d.accounts.filter((a) => a.id !== id);
      if (this.d.last === id) this.d.last = "";
      await this.file.save(this.d, true);
      await FS.rmdir(`users/${id}`, DIR.DATA);
    },
  };

  /* ================= настройки аккаунта ================= */
  class Settings {
    constructor(dir) { this.file = new JsonFile(`${dir}/settings.json`); this.d = {}; }
    async load() { this.d = await this.file.load({}); return this; }
    get(k, def = undefined) { return k in this.d ? this.d[k] : def; }
    set(k, v) { this.d[k] = v; this.file.save(this.d); return v; }
  }

  /* ================= медиатека ================= */
  const EMPTY = () => ({ v: 1, seq: { t: 0, p: 0 }, tracks: {}, playlists: {}, pl: {}, events: [], merged: {}, lyrics: {}, smart: {} });
  const T_DEFAULT = { sc_id: null, spotify_uri: null, ym_id: null, title: "", artist: "", artist_key: "", album: "", duration_ms: 0, genre: "", tags: "",
    artwork_url: "", permalink_url: "", sc_user_id: null, playable: null, match_status: "none", in_library: 0, liked: 0, disliked: 0, sources: "",
    added_at: 0, year: null, plays: null, offline: "" };

  class DB {
    constructor(dir) { this.dir = dir; this.file = new JsonFile(`${dir}/library.json`); this.relFile = new JsonFile(`${dir}/related.json`); }
    async load() {
      this.d = Object.assign(EMPTY(), await this.file.load(EMPTY()));
      this.rel = await this.relFile.load({});
      this.reindex();
      return this;
    }
    reindex() {
      this.bySc = new Map(); this.byYm = new Map(); this.bySp = new Map();
      for (const t of Object.values(this.d.tracks)) this.index(t);
    }
    index(t) { if (t.sc_id != null) this.bySc.set(+t.sc_id, t.id); if (t.ym_id) this.byYm.set(String(t.ym_id), t.id); if (t.spotify_uri) this.bySp.set(t.spotify_uri, t.id); }
    touch() { this.file.save(this.d); }
    flush() { return Promise.all([this.file.flush(), this.relFile.flush()]); }
    row(id) { return this.d.tracks[id] || null; }
    copy(t) { return t ? { ...t } : null; }

    /* --- треки --- */
    resolve(id) { let x = +id; for (let i = 0; i < 8 && this.d.merged[x]; i++) x = this.d.merged[x]; return x; }
    track(id) { return this.copy(this.row(this.resolve(id))); }
    trackBySc(sc) { const id = this.bySc.get(+sc); return id ? this.track(id) : null; }
    trackByYm(ym) { const id = this.byYm.get(String(ym)); return id ? this.track(id) : null; }
    newTrack(fields) {
      const id = ++this.d.seq.t;
      const t = { ...T_DEFAULT, ...fields, id, added_at: fields.added_at || U.now() };
      t.artist_key = artistKey(t.artist);
      this.d.tracks[id] = t; this.index(t); return t;
    }
    addSource(t, src) { const parts = (t.sources || "").split(",").filter(Boolean); if (!parts.includes(src)) { parts.push(src); t.sources = parts.sort().join(","); } }
    setMeta(t, src) {
      const y = +(src.year || 0), p = +(src.playback_count || 0);
      if (y > 1900 && y < 2100) t.year = y;
      if (p > 0) t.plays = p;
    }
    upsertSc(s, { inLibrary = false, liked = false } = {}) {
      const id = this.bySc.get(+s.sc_id);
      const f = { title: s.title, artist: s.artist, artist_key: artistKey(s.artist), duration_ms: s.duration_ms || 0, genre: s.genre || "", tags: s.tags || "",
        artwork_url: s.artwork_url || "", permalink_url: s.permalink_url || "", sc_user_id: s.sc_user_id ?? null, playable: s.playable ? 1 : 0 };
      let t;
      if (id) { t = this.row(id); Object.assign(t, f); t.in_library = Math.max(t.in_library, +inLibrary); t.liked = Math.max(t.liked, +liked); this.addSource(t, "sc"); }
      else t = this.newTrack({ ...f, sc_id: +s.sc_id, in_library: +inLibrary, liked: +liked, sources: "sc" });
      this.setMeta(t, s); this.touch(); return t.id;
    }
    upsertSpotify(uri, title, artist, album = "", dur = 0, { inLibrary = true, liked = false } = {}) {
      let t = uri && this.bySp.get(uri) ? this.row(this.bySp.get(uri)) : null;
      if (!t) { const k = artistKey(artist), lt = String(title).toLowerCase(); t = Object.values(this.d.tracks).find((x) => x.artist_key === k && x.title.toLowerCase() === lt && x.sources.includes("spotify")) || null; }
      if (t) {
        t.in_library = Math.max(t.in_library, +inLibrary); t.liked = Math.max(t.liked, +liked);
        if (!t.spotify_uri && uri) { t.spotify_uri = uri; this.index(t); }
        if (!t.album) t.album = album; if (!t.duration_ms) t.duration_ms = dur;
        this.addSource(t, "spotify");
      } else t = this.newTrack({ spotify_uri: uri || null, title, artist, album, duration_ms: dur, in_library: +inLibrary, liked: +liked, sources: "spotify" });
      this.touch(); return t.id;
    }
    findSame(title, artist, dur) {
      const k = artistKey(artist), nt = norm(title); if (!k || !nt) return null;
      const rows = Object.values(this.d.tracks).filter((x) => x.artist_key === k && !x.ym_id).sort((a, b) => (a.sc_id == null) - (b.sc_id == null) || a.id - b.id);
      for (const r of rows) { if (norm(r.title) !== nt) continue; const d = r.duration_ms || 0; if (dur && d && Math.abs(d - dur) > 5000) continue; return r; }
      return null;
    }
    upsertYm(s, { inLibrary = false, liked = false } = {}) {
      const ym = String(s.ym_id), dur = +(s.duration_ms || 0);
      let t = this.byYm.has(ym) ? this.row(this.byYm.get(ym)) : this.findSame(s.title || "", s.artist || "", dur);
      if (t) {
        t.ym_id = ym; this.index(t);
        t.in_library = Math.max(t.in_library, +inLibrary); t.liked = Math.max(t.liked, +liked);
        for (const [k, v] of [["album", s.album], ["genre", s.genre], ["artwork_url", s.artwork_url]]) if (!t[k] && v) t[k] = v;
        if (!t.duration_ms) t.duration_ms = dur;
        this.addSource(t, "yandex");
      } else t = this.newTrack({ ym_id: ym, title: s.title || "", artist: s.artist || "", album: s.album || "", duration_ms: dur, genre: s.genre || "",
        artwork_url: s.artwork_url || "", permalink_url: s.url || "", in_library: +inLibrary, liked: +liked, sources: "yandex" });
      this.setMeta(t, s); this.touch(); return t.id;
    }
    attachMatch(spId, sc) {
      const t = this.row(this.resolve(spId)); if (!t) return spId;
      const otherId = this.bySc.get(+sc.sc_id);
      if (otherId && otherId !== t.id) {
        const o = this.row(otherId);
        for (const e of this.d.events) if (e[0] === otherId) e[0] = t.id;
        for (const pid of Object.keys(this.d.pl)) {
          const l = this.d.pl[pid]; const i = l.indexOf(otherId);
          if (i >= 0) { if (l.includes(t.id)) l.splice(i, 1); else l[i] = t.id; }
        }
        t.in_library = Math.max(t.in_library, o.in_library); t.liked = Math.max(t.liked, o.liked); t.disliked = Math.max(t.disliked, o.disliked);
        if (!t.offline && o.offline) t.offline = o.offline;
        delete this.d.tracks[otherId];
        this.d.merged[otherId] = t.id;
        for (const k of Object.keys(this.d.merged)) if (this.d.merged[k] === otherId) this.d.merged[k] = t.id;
      }
      Object.assign(t, { sc_id: +sc.sc_id, artwork_url: sc.artwork_url || "", permalink_url: sc.permalink_url || "", sc_user_id: sc.sc_user_id ?? null,
        genre: sc.genre || "", tags: sc.tags || "", playable: sc.playable ? 1 : 0, match_status: "matched" });
      if (!t.duration_ms) t.duration_ms = sc.duration_ms || 0;
      this.addSource(t, "sc"); this.setMeta(t, sc); this.index(t); this.touch();
      return t.id;
    }
    markMatchFailed(id) { const t = this.row(this.resolve(id)); if (t) { t.match_status = "failed"; this.touch(); } }
    all() { return Object.values(this.d.tracks); }
    library(source = "all", search = "", likedOnly = false) {
      let rows = this.all().filter((t) => t.in_library);
      if (["sc", "spotify", "yandex"].includes(source)) rows = rows.filter((t) => t.sources.includes(source));
      if (likedOnly) rows = rows.filter((t) => t.liked);
      if (search) { const q = search.toLowerCase().replace(/ё/g, "е"); rows = rows.filter((t) => t.title.toLowerCase().replace(/ё/g, "е").includes(q) || t.artist.toLowerCase().replace(/ё/g, "е").includes(q)); }
      return rows.sort((a, b) => b.added_at - a.added_at || b.id - a.id).map((t) => this.copy(t));
    }
    unmatchedSpotify(limit = 10000) {
      return this.all().filter((t) => t.sc_id == null && t.sources.includes("spotify") && t.match_status === "none")
        .sort((a, b) => b.in_library - a.in_library || a.id - b.id).slice(0, limit).map((t) => this.copy(t));
    }
    setLike(id, liked) {
      const t = this.row(this.resolve(id)); if (!t) return;
      if (liked) Object.assign(t, { liked: 1, disliked: 0, in_library: 1 }); else t.liked = 0;
      this.log(t.id, liked ? "like" : "unlike");
    }
    setDislike(id, dis = true) {
      const t = this.row(this.resolve(id)); if (!t) return;
      t.disliked = +dis; if (dis) { t.liked = 0; this.log(t.id, "dislike"); } else this.touch();
    }
    addToLibrary(id) { const t = this.row(this.resolve(id)); if (t) { t.in_library = 1; this.touch(); } }
    setOffline(id, name) { const t = this.row(this.resolve(id)); if (t) { t.offline = name || ""; this.touch(); } }
    offlineTracks() { return this.all().filter((t) => t.offline).sort((a, b) => b.liked - a.liked || b.added_at - a.added_at).map((t) => this.copy(t)); }

    /* --- плейлисты --- */
    upsertPlaylist(name, source, extId, ids) {
      let p = extId ? Object.values(this.d.playlists).find((x) => x.ext_id === extId) : null;
      if (p) p.name = name; else { const id = ++this.d.seq.p; p = this.d.playlists[id] = { id, name, source, ext_id: extId || null, created_at: U.now() }; }
      const seen = new Set(), list = [];
      for (let tid of ids) { tid = this.resolve(tid); if (!seen.has(tid) && this.d.tracks[tid]) { seen.add(tid); list.push(tid); } }
      this.d.pl[p.id] = list; this.touch(); return p.id;
    }
    playlists() {
      return Object.values(this.d.playlists).map((p) => ({ ...p, n: (this.d.pl[p.id] || []).length }))
        .sort((a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" }));
    }
    playlist(pid) { const p = this.d.playlists[pid]; return p ? { ...p, n: (this.d.pl[pid] || []).length } : null; }
    playlistTracks(pid) { return (this.d.pl[pid] || []).map((id) => this.track(id)).filter(Boolean); }
    deletePlaylist(pid) { delete this.d.playlists[pid]; delete this.d.pl[pid]; this.touch(); }
    createPlaylist(name) { const id = ++this.d.seq.p; this.d.playlists[id] = { id, name: (name || "").trim() || "Новый плейлист", source: "local", ext_id: null, created_at: U.now() }; this.d.pl[id] = []; this.touch(); return id; }
    renamePlaylist(pid, name) { const p = this.d.playlists[pid]; if (p) { p.name = (name || "").trim() || "Без названия"; this.touch(); } }
    addToPlaylist(pid, tid) {
      tid = this.resolve(tid); const l = this.d.pl[pid] = this.d.pl[pid] || [];
      const t = this.row(tid); if (t) t.in_library = 1;
      if (l.includes(tid)) { this.touch(); return false; }
      l.push(tid); this.touch(); return true;
    }
    removeFromPlaylist(pid, tid) { tid = this.resolve(tid); const l = this.d.pl[pid] || []; const i = l.indexOf(tid); if (i >= 0) { l.splice(i, 1); this.touch(); } }
    reorderPlaylist(pid, ids) { const cur = new Set(this.d.pl[pid] || []); const l = ids.map((x) => +x).filter((x) => cur.has(x)); for (const x of this.d.pl[pid] || []) if (!l.includes(x)) l.push(x); this.d.pl[pid] = l; this.touch(); }
    playlistArts(pid) { const out = []; for (const id of this.d.pl[pid] || []) { const t = this.row(id); if (t && t.artwork_url) out.push(t.artwork_url); if (out.length === 4) break; } return out; }

    /* --- события: [track_id, kind, ts, ms, context] --- */
    log(tid, kind, ms = 0, ctx = "", ts = null) {
      tid = this.resolve(tid); if (!this.d.tracks[tid]) return;
      this.d.events.push([tid, kind, ts ?? U.now(), Math.round(ms || 0), ctx]);
      if (this.d.events.length > 120000) this.d.events.splice(0, 20000);
      this.touch();
    }
    events() { return this.d.events; }
    recentTrackIds(seconds) { const since = U.now() - seconds; const s = new Set(); for (const e of this.d.events) if (e[2] >= since && (e[1] === "play" || e[1] === "complete" || e[1] === "skip")) s.add(e[0]); return s; }

    /* --- кэш похожих (SoundCloud /related) --- */
    getRelated(sc, maxAge = 3 * 86400) { const r = this.rel[sc]; return r && U.now() - r[0] < maxAge ? r[1] : null; }
    putRelated(sc, list) {
      this.rel[sc] = [U.now(), list];
      const keys = Object.keys(this.rel);
      if (keys.length > 500) { keys.sort((a, b) => this.rel[a][0] - this.rel[b][0]).slice(0, 100).forEach((k) => delete this.rel[k]); }
      this.relFile.save(this.rel);
    }

    /* --- подборки и статистика --- */
    listenRows(since = 0) {
      const out = [];
      for (const e of this.d.events) {
        if ((e[1] === "complete" || e[1] === "skip") && e[2] >= since) out.push([e[0], e[3], 1]);
        else if (since <= 0 && e[1] === "history") { const m = /plays=(\d+)/.exec(e[4] || ""); out.push([e[0], e[3], m ? +m[1] : 1]); }
      }
      return out;
    }
    recentPlayed(limit = 20) {
      const last = new Map();
      for (const e of this.d.events) if ((e[1] === "play" || e[1] === "complete") && (!last.has(e[0]) || last.get(e[0]) < e[2])) last.set(e[0], e[2]);
      return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => this.row(id)).filter((t) => t && !t.disliked).slice(0, limit).map((t) => this.copy(t));
    }
    recentlyAdded(limit = 20) { return this.all().filter((t) => t.in_library).sort((a, b) => b.added_at - a.added_at || b.id - a.id).slice(0, limit).map((t) => this.copy(t)); }
    forgotten(limit = 20, days = 30) {
      const since = U.now() - days * 86400, recent = new Set();
      for (const e of this.d.events) if (e[2] >= since && ["play", "complete", "skip"].includes(e[1])) recent.add(e[0]);
      return U.shuffle(this.all().filter((t) => t.liked && t.playable !== 0 && t.match_status !== "failed" && !recent.has(t.id))).slice(0, limit).map((t) => this.copy(t));
    }
    topArtists(since = 0, limit = 12) {
      const acc = new Map();
      for (const [tid, ms, plays] of this.listenRows(since)) {
        const t = this.row(tid); if (!t || !t.artist_key) continue;
        const a = acc.get(t.artist_key) || { key: t.artist_key, name: t.artist, ms: 0, plays: 0, ids: new Set() };
        a.ms += ms; a.plays += plays; a.ids.add(tid); if (t.artist > a.name) a.name = t.artist; acc.set(t.artist_key, a);
      }
      return [...acc.values()].sort((a, b) => b.ms - a.ms).slice(0, limit).map((a) => ({ key: a.key, name: a.name, ms: a.ms, plays: a.plays, tracks: a.ids.size, art: this.artistArt(a.key) }));
    }
    topTracks(since = 0, limit = 20) {
      const acc = new Map();
      for (const [tid, ms, plays] of this.listenRows(since)) { const a = acc.get(tid) || [0, 0]; a[0] += ms; a[1] += plays; acc.set(tid, a); }
      return [...acc.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, limit).map(([id, [ms, plays]]) => { const t = this.track(id); return t && { ...t, listened_ms: ms, plays }; }).filter(Boolean);
    }
    listenTotals(since = 0) {
      let ms = 0, plays = 0; const tr = new Set(), ar = new Set();
      for (const [tid, m, p] of this.listenRows(since)) { const t = this.row(tid); if (!t) continue; ms += m; plays += p; tr.add(tid); ar.add(t.artist_key); }
      return { ms, plays, tracks: tr.size, artists: ar.size };
    }
    byHour(since = 0) { const h = new Array(24).fill(0); for (const e of this.d.events) if ((e[1] === "complete" || e[1] === "skip") && e[2] >= since) h[new Date(e[2] * 1000).getHours()] += Math.floor(e[3] / 60000); return h; }
    topGenres(since = 0, limit = 10) {
      const acc = new Map();
      for (const [tid, ms] of this.listenRows(since)) { const t = this.row(tid); if (!t || !t.genre) continue; const g = t.genre.trim().toLowerCase(); acc.set(g, (acc.get(g) || 0) + ms); }
      return [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, ms]) => ({ name, ms }));
    }
    artistArt(key) { const rows = this.all().filter((t) => t.artist_key === key && t.artwork_url).sort((a, b) => b.liked - a.liked || b.in_library - a.in_library); return rows[0] ? rows[0].artwork_url : ""; }
    artistTracks(key) {
      const plays = new Map(); for (const e of this.d.events) if (e[1] === "complete" || e[1] === "play") plays.set(e[0], (plays.get(e[0]) || 0) + 1);
      return this.all().filter((t) => t.artist_key === key && !t.disliked).map((t) => ({ ...t, plays: plays.get(t.id) || 0 }))
        .sort((a, b) => b.in_library - a.in_library || b.plays - a.plays || b.liked - a.liked);
    }
    artistListen(key) {
      let ms = 0, plays = 0;
      for (const [tid, m, p] of this.listenRows(0)) { const t = this.row(tid); if (t && t.artist_key === key) { ms += m; plays += p; } }
      return { ms, plays, liked: this.all().filter((t) => t.artist_key === key && t.liked).length };
    }
    getLyrics(tid, maxAge = 30 * 86400) {
      const r = this.d.lyrics[this.resolve(tid)]; if (!r) return null;
      if (!r[1].found && U.now() - r[0] > 7 * 86400) return null;
      if (U.now() - r[0] > maxAge) return null;
      return r[1];
    }
    putLyrics(tid, data) { this.d.lyrics[this.resolve(tid)] = [U.now(), data]; this.touch(); }
    recap(since) {
      const totals = this.listenTotals(since);
      const days = new Set(), first = new Map(); let likes = 0; const dayMs = new Map();
      for (const e of this.d.events) {
        const t = this.row(e[0]);
        if (["complete", "skip", "play"].includes(e[1])) {
          if (e[2] >= since) days.add(U.day(new Date(e[2] * 1000)));
          if (t && (!first.has(t.artist_key) || first.get(t.artist_key) > e[2])) first.set(t.artist_key, e[2]);
        }
        if (e[1] === "like" && e[2] >= since) likes++;
        if ((e[1] === "complete" || e[1] === "skip") && e[2] >= since) { const d = U.day(new Date(e[2] * 1000)); dayMs.set(d, (dayMs.get(d) || 0) + e[3]); }
      }
      const hours = this.byHour(since);
      const any = hours.some((x) => x);
      const peak = any ? hours.indexOf(Math.max(...hours)) : null;
      const busiest = [...dayMs.entries()].sort((a, b) => b[1] - a[1])[0];
      return { totals, days: days.size, new_artists: [...first.values()].filter((v) => v >= since).length, peak_hour: peak,
        night_min: [0, 1, 2, 3, 4, 5, 23].reduce((s, h) => s + hours[h], 0), total_min: hours.reduce((s, x) => s + x, 0), likes,
        busiest: busiest ? { day: busiest[0], ms: busiest[1] } : null,
        artists: this.topArtists(since, 5), tracks: this.topTracks(since, 5), genres: this.topGenres(since, 3) };
    }
    stats() {
      const all = this.all();
      return { total: all.length, lib: all.filter((t) => t.in_library).length, liked: all.filter((t) => t.liked).length,
        pending: all.filter((t) => t.sources.includes("spotify") && t.sc_id == null && t.match_status === "none").length,
        failed: all.filter((t) => t.match_status === "failed").length, offline: all.filter((t) => t.offline).length };
    }
  }

  window.VS = { JsonFile, Accounts, Settings, DB, COLORS };
})();
