"use strict";
/* Volna Mobile — «умная» часть: своя волна, волна Яндекса, миксы, умные плейлисты, ДНК, обмен, офлайн.
   Логика — та же, что в Python-версии на ПК (recommender.py, feed.py, smart.py, dna.py, share.py, offline.py). */
(() => {
  const { U, FS, DIR, artistKey, b64 } = window.VP;
  const { SourceError, Cache, ymParse } = window.VSrc;

  /* ================= своя волна ================= */
  const MODES = {
    favorite: { lib: 0.65, nw: -0.2, known: 0.5, label: "Любимое" },
    mix: { lib: 0.3, nw: 0.15, known: 0.15, label: "Микс" },
    discover: { lib: 0.05, nw: 0.55, known: -0.4, label: "Незнакомое" },
  };
  const MOODS = {
    energetic: { label: "Бодрое", plus: ["phonk", "drum", "dnb", "edm", "hardstyle", "trap", "rock", "metal", "punk", "house", "techno", "dance", "gym", "workout", "drift", "hype", "rave", "bass", "dubstep", "jersey"],
      minus: ["ambient", "lofi", "lo-fi", "sleep", "chill", "piano", "acoustic", "calm", "study"] },
    calm: { label: "Спокойное", plus: ["lofi", "lo-fi", "chill", "ambient", "acoustic", "piano", "jazz", "soul", "sleep", "dream", "downtempo", "indie folk", "r&b", "calm", "relax", "bossa"],
      minus: ["phonk", "metal", "hardstyle", "dubstep", "hardcore", "drill", "rave", "gym"] },
    focus: { label: "Для учёбы", plus: ["lofi", "lo-fi", "ambient", "instrumental", "study", "piano", "classical", "post-rock", "downtempo", "chillhop", "beats", "minimal", "soundtrack", "ost"],
      minus: ["rap", "hip-hop", "hip hop", "metal", "phonk", "pop", "vocal", "drill"] },
  };
  const QUEUE_TARGET = 8, REFILL_AT = 3, EARLY_SKIP = 30000;
  class ColdStart extends Error {}
  function tagsOf(t) {
    const out = new Set(); if (t.genre) out.add(t.genre.trim().toLowerCase());
    for (const m of String(t.tags || "").matchAll(/"([^"]+)"|(\S+)/g)) { const x = (m[1] || m[2]).trim().toLowerCase(); if (x.length > 2 && x.length < 30) out.add(x); }
    return out;
  }
  const squash = (x, s = 4) => Math.tanh(x / s);

  class Wave {
    constructor(db, sc, mode = "mix", mood = null) {
      Object.assign(this, { db, sc, mode: MODES[mode] ? mode : "mix", mood: MOODS[mood] ? mood : null, source: "volna" });
      this.queue = []; this.history = []; this.session = new Set(); this.seedW = new Map(); this.sessionArtist = new Map();
      this.artistAff = new Map(); this.tagAff = new Map(); this.focus = null; this.refilling = null;
    }
    buildProfile() {
      const db = this.db, rawA = new Map(), rawT = new Map(), score = new Map();
      const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
      const evIds = new Set(db.events().map((e) => e[0]));
      for (const t of db.all()) if (t.in_library || t.liked || t.disliked || evIds.has(t.id)) add(score, t.id, (t.liked ? 3 : 0) + (t.in_library ? 1 : 0) - (t.disliked ? 5 : 0));
      const now = U.now();
      for (const [tid, k, ts, ms, ctx] of db.events()) {
        const age = ts ? Math.max(0, (now - ts) / 86400) : 365; let decay = 0.5 ** (age / 120), d;
        if (k === "complete") d = 0.6; else if (k === "play") d = 0.15; else if (k === "skip") d = ms < EARLY_SKIP ? -0.7 : -0.2;
        else if (k === "history") { const m = /plays=(\d+)/.exec(ctx || ""); d = 0.8 * Math.log1p(ms / 60000) + 0.3 * Math.log1p(m ? +m[1] : 0); decay = Math.max(decay, 0.35); }
        else continue;
        add(score, tid, d * decay);
      }
      for (const [tid, s] of score) { const t = db.row(tid); if (!t) continue; add(rawA, t.artist_key, s); for (const g of tagsOf(t)) add(rawT, g, s * 0.5); }
      this.artistAff = new Map([...rawA].filter(([a]) => a).map(([a, v]) => [a, squash(v)]));
      this.tagAff = new Map([...rawT].map(([g, v]) => [g, squash(v, 6)]));
      const seeds = [];
      for (const [tid, s] of score) { const t = db.row(tid); if (t && t.sc_id && s > 0.5 && t.playable !== 0 && !t.disliked) seeds.push([t.sc_id, s]); }
      seeds.sort((a, b) => b[1] - a[1]);
      this.seedW = new Map(seeds.slice(0, 300));
    }
    async start({ fromTrack = null, query = null } = {}) {
      this.queue = []; this.focus = null; this.buildProfile();
      if (fromTrack && fromTrack.sc_id) { this.focus = fromTrack.sc_id; this.seedW.set(fromTrack.sc_id, Math.max(1, ...this.seedW.values()) * 3 + 5); this.session.add(fromTrack.sc_id); }
      if (query) for (const t of await this.sc.searchTracks(query, 20)) if (t.playable) this.seedW.set(t.sc_id, (this.seedW.get(t.sc_id) || 0) + 2);
      if (!this.seedW.size) throw new ColdStart();
    }
    async next() {
      if (this.queue.length < REFILL_AT) await this.refill();
      const t = this.queue.shift(); if (!t) return null;
      this.history.push(t); this.session.add(t.sc_id); return t;
    }
    peek(n = 5) { return this.queue.slice(0, n); }
    removeAt(i) { if (i >= 0 && i < this.queue.length) { this.session.add(this.queue[i].sc_id); this.queue.splice(i, 1); } }
    onFinished(t, ms, completed) {
      const a = t.artist_key || artistKey(t.artist);
      if (completed) { this.db.log(t.id, "complete", ms, "wave"); this.sessionArtist.set(a, (this.sessionArtist.get(a) || 0) + 0.2); if (t.sc_id) this.seedW.set(t.sc_id, (this.seedW.get(t.sc_id) || 0) + 1); }
      else {
        this.db.log(t.id, "skip", ms, "wave");
        if (ms < EARLY_SKIP) {
          this.sessionArtist.set(a, (this.sessionArtist.get(a) || 0) - 0.5);
          const src = t._seed; if (this.seedW.has(src)) this.seedW.set(src, this.seedW.get(src) * 0.5);
          this.queue = this.queue.filter((q) => !(q._seed === src && (q._score || 0) < 0.9));
        }
      }
    }
    async onLike(t) {
      const a = t.artist_key || artistKey(t.artist); this.sessionArtist.set(a, (this.sessionArtist.get(a) || 0) + 0.6);
      if (!t.sc_id) return;
      this.seedW.set(t.sc_id, Math.max(1, ...this.seedW.values()) * 2 + 3);
      this.queue = this.queue.slice(0, 2);
      try { await this.refill(t.sc_id); } catch (_) { /* сеть */ }
    }
    async onDislike(t) {
      const a = t.artist_key || artistKey(t.artist); this.sessionArtist.set(a, (this.sessionArtist.get(a) || 0) - 1.5);
      this.seedW.delete(t.sc_id); const src = t._seed; if (this.seedW.has(src)) this.seedW.set(src, this.seedW.get(src) * 0.3);
      this.queue = this.queue.filter((q) => (q.artist_key || "") !== a && q._seed !== src);
    }
    pickSeeds(n) {
      const out = this.focus && Math.random() < 0.6 ? [this.focus] : [];
      const items = [...this.seedW].filter(([s, w]) => w > 0 && !out.includes(s));
      while (items.length && out.length < n) { const pick = U.weighted(items.map((_, i) => i), items.map((x) => x[1])); out.push(items.splice(pick, 1)[0][0]); }
      return out;
    }
    async related(sc) {
      const c = this.db.getRelated(sc); if (c) return c;
      try { const r = await this.sc.related(sc, 30); this.db.putRelated(sc, r); return r; } catch (_) { return []; }
    }
    score(c, base, inLib) {
      const cfg = MODES[this.mode], a = artistKey(c.artist), aff = this.artistAff.get(a) || 0, known = inLib || aff > 0.15, tags = [...tagsOf(c)];
      const tagS = tags.length ? tags.reduce((s, g) => s + (this.tagAff.get(g) || 0), 0) / Math.sqrt(tags.length) : 0;
      let s = base + 0.8 * aff + 0.35 * U.clamp(tagS, -1, 1) + (this.sessionArtist.get(a) || 0) + (known ? cfg.known : cfg.nw);
      if (this.mood) {
        const text = ` ${(tags.join(" ") + " " + (c.title || "").toLowerCase()).replace(/[^\p{L}\p{N}_&-]+/gu, " ")} `, m = MOODS[this.mood];
        if (m.plus.some((w) => text.includes(` ${w} `))) s += 0.6; else if (m.minus.some((w) => text.includes(` ${w} `))) s -= 0.7;
      }
      s += 0.08 * Math.log10((c.playback_count || 0) + 1) / 7 + U.gauss() * 0.12;
      return s;
    }
    refill(force = null) {
      if (this.refilling) return this.refilling;
      this.refilling = (async () => {
        const seeds = force ? [force] : []; seeds.push(...this.pickSeeds(4 - seeds.length));
        const rel = await Promise.all(seeds.map(async (s) => [s, await this.related(s)]));
        this.refillFrom(rel);
      })().finally(() => { this.refilling = null; });
      return this.refilling;
    }
    refillFrom(related) {
      const db = this.db, cfg = MODES[this.mode];
      const recent = db.recentTrackIds(3600 * (this.mode === "favorite" ? 1 : 6));
      const all = db.all(), disliked = new Set(all.filter((t) => t.disliked && t.sc_id).map((t) => t.sc_id)), lib = new Set(all.filter((t) => t.in_library && t.sc_id).map((t) => t.sc_id));
      const queued = new Set(this.queue.map((q) => q.sc_id)), cands = new Map();
      const consider = (c, base, seed) => {
        const sid = c.sc_id;
        if (this.session.has(sid) || queued.has(sid) || disliked.has(sid) || !c.playable) return;
        const dur = c.duration_ms || 0; if (dur && (dur < 60000 || dur > 720000) && !lib.has(sid)) return;
        if ((this.artistAff.get(artistKey(c.artist)) || 0) < -0.6) return;
        const s = this.score(c, base, lib.has(sid));
        if (!cands.has(sid) || cands.get(sid)._score < s) cands.set(sid, { ...c, _score: s, _seed: seed });
      };
      for (const [seed, rel] of related) rel.forEach((c, r) => consider(c, 1 - r / 40, seed));
      const nLib = Math.max(0, Math.round(QUEUE_TARGET * cfg.lib));
      for (const row of U.shuffle(all.filter((t) => t.in_library && t.sc_id && !t.disliked && t.playable !== 0)).slice(0, nLib * 4)) consider({ ...row, playable: true }, 0.55, null);
      const recentA = [...this.history.slice(-5), ...this.queue].map((t) => artistKey(t.artist));
      let pool = [...cands.values()].sort((a, b) => b._score - a._score).slice(0, 60), libTaken = 0;
      while (pool.length && this.queue.length < QUEUE_TARGET) {
        const top = pool.slice(0, 15);
        const sc = top.map((c) => { const a = artistKey(c.artist); let s = c._score - 0.6 * recentA.filter((x) => x === a).length; if (lib.has(c.sc_id) && libTaken >= nLib) s -= 0.5; return s / 0.25; });
        const mx = Math.max(...sc), c = U.weighted(top, sc.map((x) => Math.exp(x - mx)));
        pool = pool.filter((x) => x !== c);
        const row = db.trackBySc(c.sc_id);
        if (row && (recent.has(row.id) || row.disliked)) continue;
        if (lib.has(c.sc_id)) libTaken++;
        const full = db.track(row ? row.id : db.upsertSc(c));
        full._seed = c._seed; full._score = c._score;
        this.queue.push(full); recentA.push(artistKey(c.artist));
      }
    }
  }

  /* ================= «Моя волна» Яндекса ================= */
  const DIVERSITY = { favorite: "favorite", mix: "default", discover: "discover" };
  const ENERGY = { energetic: "active", calm: "calm", focus: "calm" };
  class YandexWave {
    constructor(db, ym, mode = "mix", mood = null) {
      Object.assign(this, { db, ym, mode: DIVERSITY[mode] ? mode : "mix", mood, source: "yandex", station: "user:onyourwave" });
      this.queue = []; this.history = []; this.session = new Set(); this.batch = null; this.last = null; this.refilling = null;
    }
    async start({ fromTrack = null, query = null } = {}) {
      this.queue = []; this.history = []; this.session.clear(); this.last = null; this.station = "user:onyourwave";
      if (fromTrack && fromTrack.ym_id) { this.station = `track:${fromTrack.ym_id}`; this.session.add(String(fromTrack.ym_id)); }
      else if (query) { const f = await this.ym.search(query, 1); if (f.length) this.station = `track:${f[0].ym_id}`; }
      if (this.station === "user:onyourwave") { try { await this.ym.rotorSettings(this.station, ENERGY[this.mood] || "all", DIVERSITY[this.mode]); } catch (e) { console.warn("ym settings", e); } }
      await this.refill();
      if (!this.queue.length) throw new SourceError("Яндекс не прислал треков для волны — попробуй ещё раз");
      this.feedback("radioStarted", null, { from: "mobile-radio-volna-default" });
    }
    async next() {
      if (this.queue.length < 2) { try { await this.refill(); } catch (e) { console.warn("ym refill", e); } }
      const t = this.queue.shift(); if (!t) return null;
      this.history.push(t); this.feedback("trackStarted", t); return t;
    }
    peek(n = 5) { return this.queue.slice(0, n); }
    removeAt(i) { if (i >= 0 && i < this.queue.length) this.queue.splice(i, 1); }
    onFinished(t, ms, completed) { this.db.log(t.id, completed ? "complete" : "skip", ms, "wave"); this.feedback(completed ? "trackFinished" : "skip", t, { secs: Math.round(Math.max(0, ms) / 100) / 10 }); }
    async onLike(t) { this.queue = this.queue.slice(0, 1); if (t.ym_id) this.last = t.ym_tid || String(t.ym_id); try { await this.refill(); } catch (_) { /* */ } }
    async onDislike(t) {
      if (t.ym_id) this.ym.dislike(t.ym_id).catch(() => {});
      this.feedback("skip", t, { secs: 0.1 });
      const a = t.artist_key || artistKey(t.artist); this.queue = this.queue.filter((q) => (q.artist_key || "") !== a);
    }
    feedback(type, t, { from, secs } = {}) {
      const tid = t ? t.ym_tid || t.ym_id : null; if (t && !tid) return;
      this.ym.rotorFeedback(this.station, type, { batch: (t && t._batch) || this.batch, trackId: tid, from, secs }).catch(() => {});
    }
    refill() {
      if (this.refilling) return this.refilling;
      this.refilling = (async () => {
        const res = await this.ym.rotorTracks(this.station, this.last);
        const seq = (res && res.sequence) || [], batch = res && res.batchId;
        if (batch) this.batch = batch;
        for (const s of seq) {
          const p = ymParse(s.track); if (!p || !p.available || this.session.has(p.ym_id)) continue;
          const row = this.db.trackByYm(p.ym_id); if (row && row.disliked) continue;
          const id = this.db.upsertYm(p, { inLibrary: !!s.liked, liked: !!s.liked });
          const full = this.db.track(id); if (!full || full.disliked || this.queue.length >= 10) continue;
          full.ym_tid = p.ym_tid; full._batch = batch; this.session.add(p.ym_id); this.queue.push(full);
        }
        if (seq.length) { const lp = ymParse(seq[seq.length - 1].track); if (lp) this.last = lp.ym_tid; }
      })().finally(() => { this.refilling = null; });
      return this.refilling;
    }
  }

  /* ================= миксы для главной ================= */
  class Feed {
    constructor(db, sc) { this.db = db; this.sc = sc; this.cache = null; }
    async related(sc) { const c = this.db.getRelated(sc); if (c) return c; try { const r = await this.sc.related(sc, 30); this.db.putRelated(sc, r); return r; } catch (_) { return []; } }
    async mixes(force = false) {
      const day = U.day();
      if (this.cache && this.cache[0] === day && !force) return this.cache[1];
      const out = await this.build(U.seeded(force ? Math.random() : day));
      this.cache = [day, out]; return out;
    }
    async build(rnd) {
      const db = this.db, w = new Wave(db, this.sc); w.buildProfile();
      if (!w.seedW.size) return [];
      const disliked = new Set(db.all().filter((t) => t.disliked && t.sc_id).map((t) => t.sc_id));
      const byA = new Map();
      for (const [sc, wt] of w.seedW) { const r = db.trackBySc(sc); if (r) { const l = byA.get(r.artist_key) || []; l.push([sc, wt]); byA.set(r.artist_key, l); } }
      const top = [...byA].sort((a, b) => b[1].reduce((s, x) => s + x[1], 0) - a[1].reduce((s, x) => s + x[1], 0)).slice(0, 5);
      const mixes = [];
      for (const [ak, seeds] of top) {
        const pool = new Map();
        for (const [sc] of seeds.sort((a, b) => b[1] - a[1]).slice(0, 3)) for (const c of await this.related(sc)) if (c.playable && !disliked.has(c.sc_id)) pool.set(c.sc_id, c);
        const own = db.artistTracks(ak).filter((r) => r.sc_id && r.playable !== 0).slice(0, 6);
        const ids = own.slice(0, 4).map((r) => r.id), seenA = new Map();
        for (const c of U.shuffle([...pool.values()], rnd)) {
          const a = artistKey(c.artist); if ((seenA.get(a) || 0) >= 2) continue; seenA.set(a, (seenA.get(a) || 0) + 1);
          const row = db.trackBySc(c.sc_id); ids.push(row ? row.id : db.upsertSc(c)); if (ids.length >= 30) break;
        }
        U.shuffle(ids, rnd); if (ids.length < 8) continue;
        const name = own.length ? own[0].artist : ak;
        const others = this.names(ids).filter((n) => artistKey(n) !== ak).slice(0, 2);
        mixes.push(this.pack(`Микс: ${name}`, [name, ...others].join(", ") + " и похожие", ids));
      }
      const disc = [], used = new Set();
      for (const sc of w.pickSeeds(6)) for (const c of await this.related(sc)) {
        const a = artistKey(c.artist);
        if (!c.playable || disliked.has(c.sc_id) || (w.artistAff.get(a) || 0) > 0.05 || used.has(c.sc_id)) continue;
        used.add(c.sc_id); const row = db.trackBySc(c.sc_id); if (row && row.in_library) continue;
        disc.push(row ? row.id : db.upsertSc(c));
      }
      U.shuffle(disc, rnd);
      if (disc.length >= 8) mixes.unshift(this.pack("Открытия дня", "Новые для тебя артисты в духе твоих любимых", disc.slice(0, 30), "discover"));
      return mixes;
    }
    names(ids) { const seen = new Set(), out = []; for (const i of ids) { const t = this.db.row(i); if (t && !seen.has(t.artist)) { seen.add(t.artist); out.push(t.artist); } } return out; }
    pack(title, sub, ids, key = null) { const arts = []; for (const i of ids) { const t = this.db.row(i); if (t && t.artwork_url && !arts.includes(t.artwork_url)) arts.push(t.artwork_url); if (arts.length === 4) break; } return { key: key || title, title, sub, ids, arts }; }
  }

  /* ================= умные плейлисты ================= */
  const S_FIELDS = { liked: ["В «Любимых»", "bool"], source: ["Источник", "enum"], artist: ["Исполнитель", "text"], title: ["Название", "text"], genre: ["Жанр или тег", "text"],
    added: ["Добавлен за последние (дней)", "days"], played: ["Играл за последние (дней)", "days"], notplayed: ["Не играл последние (дней)", "days_not"],
    plays: ["Прослушиваний", "num"], duration: ["Длительность (мин)", "minutes"] };
  const S_OPS = { bool: { is: "да", isnot: "нет" }, enum: { has: "это", hasnot: "не это" }, text: { contains: "содержит", notcontains: "не содержит", is: "равно" },
    days: { within: "за" }, days_not: { within: "не играл" }, num: { gte: "не меньше", lte: "не больше" }, minutes: { gte: "не меньше", lte: "не больше" } };
  const S_SOURCES = { sc: "SoundCloud", spotify: "Spotify", yandex: "Яндекс Музыка" };
  const S_SORTS = { added: "Сначала новые", plays: "Самые заслушанные", last: "Давно не игравшие", title: "По названию", random: "Случайно" };
  const S_PRESETS = [
    { name: "Любимое за месяц", rules: { match: "all", rules: [{ field: "liked", op: "is", value: true }, { field: "added", op: "within", value: 30 }], sort: "added", limit: 100 } },
    { name: "Давно не слушал", rules: { match: "all", rules: [{ field: "liked", op: "is", value: true }, { field: "notplayed", op: "within", value: 60 }], sort: "random", limit: 50 } },
    { name: "На повторе", rules: { match: "all", rules: [{ field: "plays", op: "gte", value: 5 }], sort: "plays", limit: 50 } },
    { name: "Из Spotify", rules: { match: "all", rules: [{ field: "source", op: "has", value: "spotify" }], sort: "added", limit: 500 } },
    { name: "Короткие треки", rules: { match: "all", rules: [{ field: "duration", op: "lte", value: 2.5 }], sort: "random", limit: 60 } },
  ];
  const truthy = (v) => (typeof v === "string" ? !["", "0", "false", "нет", "no"].includes(v.trim().toLowerCase()) : !!v);
  const Smart = {
    schema() { return { fields: Object.entries(S_FIELDS).map(([key, [label, type]]) => ({ key, label, type })), ops: S_OPS,
      sources: Object.entries(S_SOURCES).map(([key, label]) => ({ key, label })), sorts: Object.entries(S_SORTS).map(([key, label]) => ({ key, label })), presets: S_PRESETS }; },
    query(db, rules) {
      if (!rules || typeof rules !== "object") rules = {};
      const plays = new Map(), last = new Map();
      for (const e of db.events()) { if (e[1] === "complete" || e[1] === "play") plays.set(e[0], (plays.get(e[0]) || 0) + 1); if (["complete", "play", "skip"].includes(e[1])) last.set(e[0], Math.max(last.get(e[0]) || 0, e[2])); }
      const preds = [];
      for (const r of Array.isArray(rules.rules) ? rules.rules : []) {
        if (!r || typeof r !== "object" || !S_FIELDS[r.field]) continue;
        const typ = S_FIELDS[r.field][1], op = r.op, v = r.value;
        const val = (t) => ({ liked: t.liked, source: t.sources, artist: t.artist, title: t.title, genre: `${t.genre} ${t.tags}`, added: t.added_at, played: last.get(t.id) || 0, notplayed: last.get(t.id) || 0, plays: plays.get(t.id) || 0, duration: t.duration_ms }[r.field]);
        if (typ === "bool") { const want = (op === "is") === truthy(v); preds.push((t) => !!val(t) === want); }
        else if (typ === "enum") { if (!S_SOURCES[v]) continue; preds.push((t) => String(val(t)).includes(v) === (op === "has")); }
        else if (typ === "text") { if (!["string", "number"].includes(typeof v)) continue; const s = String(v).trim().slice(0, 200).toLowerCase(); if (!s) continue;
          preds.push(op === "is" ? (t) => String(val(t)).toLowerCase() === s : (t) => String(val(t)).toLowerCase().includes(s) === (op !== "notcontains")); }
        else if (typ === "days" || typ === "days_not") { const n = parseFloat(v); if (!isFinite(n)) continue; const since = U.now() - n * 86400; preds.push(typ === "days_not" ? (t) => val(t) < since : (t) => val(t) >= since); }
        else { const n = parseFloat(v) * (typ === "minutes" ? 60000 : 1); if (!isFinite(n)) continue; preds.push(op === "gte" ? (t) => val(t) >= n : (t) => val(t) <= n); }
      }
      const any = rules.match === "any";
      let rows = db.all().filter((t) => (t.in_library || t.liked) && !t.disliked && (!preds.length || (any ? preds.some((p) => p(t)) : preds.every((p) => p(t)))));
      const sort = typeof rules.sort === "string" && S_SORTS[rules.sort] ? rules.sort : "added";
      if (sort === "random") U.shuffle(rows);
      else rows.sort({ added: (a, b) => b.added_at - a.added_at, plays: (a, b) => (plays.get(b.id) || 0) - (plays.get(a.id) || 0), last: (a, b) => (last.get(a.id) || 0) - (last.get(b.id) || 0),
        title: (a, b) => a.title.localeCompare(b.title, "ru", { sensitivity: "base" }) }[sort]);
      let limit = parseInt(rules.limit, 10); if (!isFinite(limit)) limit = 200; limit = U.clamp(limit, 1, 2000);
      return rows.slice(0, limit).map((t) => ({ ...t }));
    },
    list(db) { return Object.values(db.d.smart).sort((a, b) => a.created_at - b.created_at).map((s) => { const rows = this.query(db, s.rules); return { id: s.id, name: s.name, rules: s.rules, n: rows.length, arts: rows.filter((t) => t.artwork_url).map((t) => t.artwork_url).slice(0, 4) }; }); },
    save(db, name, rules, sid) { if (sid && db.d.smart[sid]) { Object.assign(db.d.smart[sid], { name, rules }); } else { sid = ++db.d.seq.p; db.d.smart[sid] = { id: sid, name, rules, created_at: U.now() }; } db.touch(); return sid; },
    remove(db, sid) { delete db.d.smart[sid]; db.touch(); },
    get(db, sid) { const s = db.d.smart[sid]; return s ? { id: s.id, name: s.name, rules: s.rules } : null; },
  };

  /* ================= обмен плейлистами (тот же формат, что на ПК) ================= */
  const Share = {
    async pack(name, tracks) {
      const items = tracks.map((t) => { const it = { t: t.title || "", a: t.artist || "" }; if (t.duration_ms) it.d = Math.floor(t.duration_ms / 1000);
        if (t.sc_id) it.sc = t.sc_id; if (t.spotify_uri) it.sp = t.spotify_uri; if (t.ym_id) it.ym = t.ym_id; if (t.artwork_url) it.i = t.artwork_url; if (t.permalink_url) it.u = t.permalink_url; return it; });
      const raw = new TextEncoder().encode(JSON.stringify({ v: 1, n: name, tr: items }));
      const cs = new CompressionStream("deflate"); const out = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer());
      return "VOLNA1:" + b64.url(out);
    },
    async unpack(code) {
      code = String(code || "").replace(/\s+/g, ""); if (code.startsWith("VOLNA1:")) code = code.slice(7);
      let data;
      try { const ds = new DecompressionStream("deflate"); data = JSON.parse(await new Response(new Blob([b64.fromUrl(code)]).stream().pipeThrough(ds)).text()); }
      catch (_) { throw new Error("Код плейлиста повреждён — скопируй его целиком"); }
      if (!data || !Array.isArray(data.tr)) throw new Error("Это не код плейлиста Volna");
      return data;
    },
    async importCode(db, code) {
      const data = await this.unpack(code), ids = [];
      for (const it of data.tr.slice(0, 5000)) {
        if (!it || typeof it !== "object") continue;
        const title = String(it.t || "").slice(0, 300), artist = String(it.a || "").slice(0, 300); if (!title) continue;
        const dur = (parseInt(it.d, 10) || 0) * 1000, sc = it.sc ? parseInt(it.sc, 10) : 0;
        let tid;
        if (it.ym) { tid = db.upsertYm({ ym_id: String(it.ym), title, artist, duration_ms: dur, artwork_url: it.i || "" }, { inLibrary: true }); if (sc) db.attachMatch(tid, { sc_id: sc, artwork_url: it.i || "", permalink_url: it.u || "", playable: true, duration_ms: dur }); }
        else if (sc) tid = db.upsertSc({ sc_id: sc, title, artist, duration_ms: dur, artwork_url: it.i || "", permalink_url: it.u || "", playable: true }, { inLibrary: true });
        else tid = db.upsertSpotify(it.sp || null, title, artist, "", dur, { inLibrary: true });
        ids.push(tid);
      }
      if (!ids.length) throw new Error("В коде нет треков");
      const name = String(data.n || "Плейлист друга").slice(0, 100) + " (от друга)";
      const pid = db.createPlaylist(name); for (const i of ids) db.addToPlaylist(pid, i);
      return { pid, name, tracks: ids.length };
    },
  };

  /* ================= офлайн ================= */
  class Offline {
    constructor(db, dir, fetch, onChange) { Object.assign(this, { db, dir, fetch, onChange }); this.q = []; this.running = false; this.cancelled = false; this.done = 0; this.total = 0; this.failed = 0; this.current = ""; this.frac = 0; this.error = ""; }
    path(name) { return `${this.dir}/offline/${name}`; }
    async fileFor(t) { const n = t && t.offline; if (!n || n.includes("/")) return null; return (await FS.size(this.path(n), DIR.DATA)) > 50000 ? this.path(n) : null; }
    status() { return { active: this.running, done: this.done, total: this.total, failed: this.failed, current: this.current, frac: Math.round(this.frac * 1000) / 1000, queued: this.q.length, error: this.error }; }
    notify() { try { this.onChange && this.onChange(this.status()); } catch (_) { /* */ } }
    async add(ids) {
      if (!this.running) { this.done = this.total = this.failed = 0; this.error = ""; }
      let added = 0;
      for (let id of ids) { id = this.db.resolve(id); const t = this.db.track(id); if (!t || this.q.includes(id) || (await this.fileFor(t))) continue; this.q.push(id); added++; }
      this.total += added; this.cancelled = false; this.notify();
      if (added && !this.running) this.run();
      return added;
    }
    cancel() { this.cancelled = true; this.total -= this.q.length; this.q = []; this.notify(); }
    async run() {
      this.running = true;
      while (this.q.length && !this.cancelled) {
        const id = this.q.shift(), t = this.db.track(id); if (!t) continue;
        this.current = `${t.artist} — ${t.title}`; this.frac = 0; this.notify();
        try {
          const name = await this.fetch(t, (f) => { this.frac = f || 0; });
          const ext = name.split(".").pop(), dst = `t${this.db.resolve(id)}.${ext}`;
          await FS.copy(`audio/${name}`, DIR.CACHE, this.path(dst), DIR.DATA);
          this.db.setOffline(id, dst);
        } catch (e) { this.failed++; this.error = `${t.title}: ${e.message}`; }
        this.done++; this.notify();
      }
      this.running = false; this.current = ""; this.notify();
    }
    async remove(ids) { let n = 0; for (const id of ids) { const t = this.db.track(id); if (!t || !t.offline) continue; await FS.remove(this.path(t.offline), DIR.DATA); this.db.setOffline(t.id, ""); n++; } return n; }
    async bytes() { const l = await FS.list(`${this.dir}/offline`, DIR.DATA); return l.reduce((s, f) => s + (f.size || 0), 0); }
  }

  window.VB = { MODES, MOODS, ColdStart, Wave, YandexWave, Feed, Smart, Share, Offline, tagsOf };
})();
