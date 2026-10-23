"use strict";
/* Volna Mobile — те же методы API, что у Python-моста на ПК (ui/bridge*.py), поверх JS-движка.
   Интерфейс (core.js, pages.js, …) не знает, что работает на телефоне: он вызывает call("метод"). */
(() => {
  const { U, FS, DIR, P, Clip, artistKey, norm } = window.VP;
  const { Accounts, Settings, DB } = window.VS;
  const S = window.VSrc, B = window.VB;

  let emitRaw = () => {};
  const emit = (name, data) => { try { emitRaw(name, JSON.stringify(data ?? null)); } catch (e) { console.error(e); } };
  let readyResolve; const ready = new Promise((r) => { readyResolve = r; });
  const App = { emit, ready, me: null };

  const MOODS_HOME = [["Ночной лоуфай", "lofi night"], ["Фонк", "phonk"], ["Пост-панк", "russian post punk"], ["Инди", "indie"], ["Хип-хоп", "hip hop"], ["Электроника", "electronic"], ["Аниме OST", "anime ost"], ["Джаз", "jazz"]];
  const SETTING_DEFAULTS = { lastfm_scrobble: true, lastfm_love: true, update_repo: "XwastX/volna", update_auto: true, ui: {}, crossfade: 0, normalize: false, eq: new Array(10).fill(0), eq_on: false,
    close_to_tray: false, discord_on: false, discord_id: "", wave_mood: "", offline_liked: false, party_skip: true };
  const artHi = (u) => (u ? u.replace("-t300x300.", "-t500x500.") : u);
  function slim(t) {
    if (!t) return null;
    const src = t.sources || (t.sc_id ? "sc" : "");
    return { id: t.id, title: t.title || "", artist: t.artist || "", art: t.artwork_url || "", dur: t.duration_ms || 0, liked: !!t.liked,
      sc: src.split(",").includes("sc") || !!t.sc_id, sp: src.includes("spotify"), ym: !!t.ym_id, off: !!t.offline,
      missing: !t.ym_id && (t.match_status === "failed" || t.playable === 0), pending: !t.ym_id && !t.sc_id && t.match_status !== "failed",
      url: t.permalink_url || "", ak: t.artist_key || artistKey(t.artist || "") };
  }
  const progress = (task) => (frac, text = "") => emit("progress", { task, frac, text });

  /* ---------------- запуск после входа в аккаунт ---------------- */
  App.start = async (acc) => {
    const dir = `users/${acc.id}`;
    App.me = acc;
    App.settings = await new Settings(dir).load();
    App.db = await new DB(dir).load();
    App.sc = await new S.SoundCloud().init();
    App.ym = new S.Yandex(App.settings);
    App.feed = new B.Feed(App.db, App.sc);
    App.context = "";
    App.offline = new B.Offline(App.db, dir, (t, prog) => App.player.fetch(t, prog, true).then((f) => f.name || f.path.split("/").pop()), (s) => {
      emit("offline", s);
      if (!s.active && s.total && App._dlDone !== s.done) { App._dlDone = s.done; const ok = s.total - s.failed; emit("toast", { text: `Скачано треков: ${ok}${s.failed ? `, не получилось: ${s.failed}` : ""}`, kind: s.failed && !ok ? "error" : "ok" }); }
    });
    App.player = new window.VPlayer({ db: App.db, settings: App.settings, sc: App.sc, ym: App.ym, offline: App.offline, emit, slim,
      onTrack: (t) => { const s = slim(t); if (s) s.artHi = artHi(s.art); emit("track", s); onQueue(); tint(t); },
      onQueue: () => onQueue() });
    App.sleep = { timer: null, end: 0, track: false, fade: null };
    readyResolve();
    if (App.settings.get("update_auto", true) !== false) setTimeout(() => checkUpdate().then((i) => { if (i.available) emit("update", i); }).catch(() => {}), 6000);
  };
  function onQueue() {
    const p = App.player; if (!p) return;
    const q = p.queueState();
    emit("queue", { wave: !!p.wave, mode: p.wave ? p.wave.mode : null, items: p.upcoming(8).map(slim), user: q.user.map(slim), next: q.next.map(slim), ctx: p.wave ? "Моя волна" : App.context });
  }
  let tintReq = 0;
  function tint(t) {
    const req = ++tintReq, url = t && t.artwork_url;
    if (!url) { emit("tint", null); return; }
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = () => {
      if (req !== tintReq) return;
      try {
        const c = document.createElement("canvas"); c.width = c.height = 24; const g = c.getContext("2d"); g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data; let best = null, bw = -1;
        for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]), s = mx ? (mx - mn) / mx : 0, v = mx / 255, w = s * s * (0.3 + v); if (v > 0.25 && w > bw) { bw = w; best = [d[i], d[i + 1], d[i + 2]]; } }
        emit("tint", best ? `#${best.map((x) => x.toString(16).padStart(2, "0")).join("")}` : null);
      } catch (_) { emit("tint", null); }
    };
    img.onerror = () => emit("tint", null); img.src = url;
  }
  const ymWaveOn = () => App.settings.get("wave_source") === "yandex" && App.ym.logged;
  const NOT_HERE = (what) => { throw new Error(`${what} — только в версии для компьютера`); };

  /* ---------------- методы ---------------- */
  const api = {
    /* общее */
    init: () => ({ version: window.VOLNA_MOBILE_VERSION || "0.7.0", stats: App.db.stats(), volume: App.settings.get("volume", 80), mode: App.settings.get("wave_mode", "mix"),
      modes: Object.entries(B.MODES).map(([key, v]) => ({ key, label: v.label })), moods: MOODS_HOME.map(([label, query]) => ({ label, query })),
      scProfile: App.settings.get("sc_profile_url", ""), track: slim(App.player.current), waveMoods: Object.entries(B.MOODS).map(([key, v]) => ({ key, label: v.label })),
      waveMood: App.settings.get("wave_mood", ""), engine: "volna", offline: App.player.offlineOnly, mobile: true }),
    stats: () => App.db.stats(),
    open_url: ({ url }) => { if (String(url).startsWith("https://")) window.open(url, "_system"); return true; },
    ping: () => U.now(),

    /* медиатека */
    library: ({ source = "all", search = "", liked = false }) => App.db.library(source, search, liked).map(slim),
    playlists: () => App.db.playlists().sort((a, b) => (a.source !== "local") - (b.source !== "local") || b.created_at - a.created_at)
      .map((p) => ({ id: p.id, name: p.name, source: p.source, n: p.n, arts: App.db.playlistArts(p.id) })),
    playlist: ({ pid }) => App.db.playlistTracks(pid).map(slim),
    playlist_info: ({ pid }) => { const p = App.db.playlist(pid); if (!p) throw new Error("Плейлист не найден"); return { id: p.id, name: p.name, source: p.source, n: p.n, arts: App.db.playlistArts(pid) }; },
    async search({ q }) {
      const db = App.db;
      if (q.includes("soundcloud.com/")) return { added: await api.import_sc_link({ url: q }), rows: [] };
      const rows = [];
      if (App.ym.logged && App.settings.get("ym_prefer", true) !== false) { try { for (const p of await App.ym.search(q, 20)) rows.push(slim(db.track(db.upsertYm(p)))); } catch (_) { /* SoundCloud ниже */ } }
      for (const t of await App.sc.searchTracks(q, 40)) if (t.playable) rows.push(slim(db.trackBySc(t.sc_id) || db.track(db.upsertSc(t))));
      return { rows };
    },
    like: ({ id, liked }) => {
      App.db.setLike(id, liked); afterLike(App.db.track(id), liked);
      const cur = App.player.current;
      if (cur && App.db.resolve(cur.id) === App.db.resolve(id)) { cur.liked = +liked; emit("track", { ...slim(cur), artHi: artHi(cur.artwork_url) }); if (liked && App.player.wave) App.player.wave.onLike(cur).then(onQueue).catch(() => {}); }
      return liked;
    },

    /* воспроизведение */
    async play({ ids, index = 0, context = "" }) {
      App.context = context;
      let rows = ids.map((i) => App.db.track(i)).filter(Boolean); if (!rows.length) return true;
      index = Math.min(index, rows.length - 1);
      if (App.player.offlineOnly) {
        const picked = rows[index], keep = [];
        for (const r of rows) if (await App.offline.fileFor(r)) keep.push(r);
        if (!keep.length) throw new Error("В этом списке нет скачанных треков — в офлайн-режиме играет только скачанное");
        const after = rows.slice(index).find((r) => keep.includes(r));
        index = keep.indexOf(keep.includes(picked) ? picked : after); if (index < 0) index = 0; rows = keep;
      }
      App.player.playList(rows, index); return true;
    },
    toggle: () => { App.player.toggle(); return true; },
    next: () => { App.player.next(); return true; },
    prev: () => { App.player.prev(); return true; },
    seek: ({ ms }) => { App.player.seek(+ms); return true; },
    volume: ({ v }) => { App.player.setVolume(+v); return true; },
    like_current: () => { const r = App.player.likeCurrent(); afterLike(App.player.current, r); return r; },
    dislike_current: () => { App.player.dislikeCurrent(); return true; },
    async wave({ mode = null, query = null, from_id = null }) {
      if (mode) App.settings.set("wave_mode", mode);
      if (App.player.offlineOnly) {
        const rows = []; for (const r of App.db.offlineTracks()) if (!r.disliked && (await App.offline.fileFor(r))) rows.push(r);
        if (!rows.length) throw new Error("Нет скачанных треков — скачай плейлист или «Любимые», чтобы слушать без интернета");
        const key = new Map(rows.map((r) => [r.id, Math.random() * (r.liked ? 0.45 : 1)]));   // любимые чаще в начале
        rows.sort((a, b) => key.get(a.id) - key.get(b.id));
        App.context = "Волна из скачанного"; App.player.playList(rows, 0); return { cold: false, offline: true };
      }
      const m = App.settings.get("wave_mode", "mix"), mood = App.settings.get("wave_mood", "") || null;
      const w = ymWaveOn() ? new B.YandexWave(App.db, App.ym, m, mood) : new B.Wave(App.db, App.sc, m, mood);
      try { await w.start({ fromTrack: from_id ? App.db.track(from_id) : null, query }); } catch (e) { if (e instanceof B.ColdStart) return { cold: true }; throw e; }
      App.player.playWave(w); return { cold: false };
    },
    set_mode: ({ mode }) => App.settings.set("wave_mode", mode),

    /* импорт */
    async import_sc_profile({ url }) {
      const db = App.db, sc = App.sc, prog = progress("sc");
      url = String(url).trim(); if (!url.startsWith("http")) url = "https://soundcloud.com/" + url.replace(/^[@/]+/, "");
      App.settings.set("sc_profile_url", url);
      prog(0.02, "Ищу профиль");
      const user = await sc.resolve(url); if (user.kind !== "user") throw new Error("Ссылка не на профиль. Нужна вида soundcloud.com/имя");
      prog(0.1, "Загружаю лайки");
      const likes = await sc.userLikes(user.id); for (const t of likes) db.upsertSc(t, { inLibrary: true, liked: true });
      prog(0.4, "Загружаю плейлисты");
      const pls = await sc.userPlaylists(user.id); let nPl = 0, nPt = 0;
      for (let i = 0; i < pls.length; i++) {
        prog(0.4 + 0.6 * i / Math.max(1, pls.length), `Плейлист: ${pls[i].title || ""}`);
        let title, tracks; try { [title, tracks] = await sc.playlistFull(pls[i]); } catch (_) { continue; }
        const ids = tracks.map((t) => db.upsertSc(t, { inLibrary: true }));
        if (ids.length) { db.upsertPlaylist(title, "sc", `sc:${pls[i].id}`, ids); nPl++; nPt += ids.length; }
      }
      prog(1, "Готово"); await db.flush();
      return { user: user.username || "", likes: likes.length, playlists: nPl, playlist_tracks: nPt };
    },
    async import_sc_link({ url }) {
      const db = App.db, obj = await App.sc.resolve(url);
      if (obj.kind === "track") { const t = S.parseTrack(obj); db.upsertSc(t, { inLibrary: true }); return { kind: "track", name: `${t.artist} — ${t.title}`, tracks: 1 }; }
      if (obj.kind === "playlist") { const [title, tracks] = await App.sc.playlistFull(obj); const ids = tracks.map((t) => db.upsertSc(t, { inLibrary: true })); db.upsertPlaylist(title, "sc", `sc:${obj.id}`, ids); return { kind: "playlist", name: title, tracks: ids.length }; }
      if (obj.kind === "user") { const r = await api.import_sc_profile({ url }); return { kind: "user", name: r.user, tracks: r.likes + r.playlist_tracks }; }
      throw new Error("Не понял, что это за ссылка");
    },
    import_spotify_zip: () => NOT_HERE("Импорт выгрузки Spotify (ZIP)"),
    import_spotify_link: ({ url }) => S.importSpotifyLink(App.db, url),
    async match({ stop = false }) {
      if (stop) { App.stopMatch = true; return true; }
      if (!App.db.stats().pending) return { found: 0, failed: 0, total: 0 };
      App.stopMatch = false;
      return S.matchPending(App.db, App.sc, progress("match"), () => App.stopMatch);
    },

    /* главная, миксы, артист, статистика */
    home() {
      const db = App.db, h = new Date().getHours();
      const greet = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : h < 23 ? "Добрый вечер" : "Доброй ночи";
      let artists = db.topArtists(U.now() - 30 * 86400, 12); if (artists.length < 4) artists = db.topArtists(0, 12);
      return { greet, empty: db.stats().lib === 0, liked: db.stats().liked, playlists: api.playlists().slice(0, 7), recent: db.recentPlayed(16).map(slim),
        artists: artists.map((a) => ({ key: a.key, name: a.name, art: a.art, ms: a.ms })), forgotten: db.forgotten(16).map(slim), added: db.recentlyAdded(16).map(slim),
        moods: MOODS_HOME.map(([label, query]) => ({ label, query })) };
    },
    async mixes({ force = false }) { return (await App.feed.mixes(force)).map((m) => ({ key: m.key, title: m.title, sub: m.sub, arts: m.arts, n: m.ids.length })); },
    async mix({ key }) {
      const m = (await App.feed.mixes()).find((x) => x.key === key); if (!m) throw new Error("Микс устарел — обнови главную");
      return { title: m.title, sub: m.sub, arts: m.arts, rows: m.ids.map((i) => App.db.track(i)).filter(Boolean).map(slim) };
    },
    artist({ key }) {
      const rows = App.db.artistTracks(key), st = App.db.artistListen(key);
      return { key, name: rows.length ? rows[0].artist : key, art: App.db.artistArt(key), avatar: (App.avatars || {})[key] || "", listened_ms: st.ms, plays: st.plays, liked: st.liked,
        mine: rows.filter((t) => t.in_library).map(slim), known: rows.length };
    },
    async artist_online({ key, name }) {
      const db = App.db; App.avatars = App.avatars || {};
      const found = (await App.sc.searchTracks(name, 50)).filter((t) => t.playable && artistKey(t.artist) === key).sort((a, b) => (b.playback_count || 0) - (a.playback_count || 0));
      const top = found.slice(0, 10).map((t) => slim(db.trackBySc(t.sc_id) || db.track(db.upsertSc(t))));
      let avatar = App.avatars[key] || "";
      if (!avatar) { try { for (const u of await App.sc.searchUsers(name, 5)) if (norm(u.username || "") === norm(name) || norm(u.full_name || "") === norm(name)) { avatar = (u.avatar_url || "").replace("-large.", "-t500x500."); break; } } catch (_) { /* */ } App.avatars[key] = avatar; }
      const similar = new Map();
      for (const t of found.slice(0, 3)) for (const c of await App.feed.related(t.sc_id)) { const a = artistKey(c.artist); if (a && a !== key && !similar.has(a)) similar.set(a, { key: a, name: c.artist, art: c.artwork_url }); }
      return { top, avatar, similar: [...similar.values()].slice(0, 10) };
    },
    stats_page({ period = "month" }) {
      const since = { week: U.now() - 7 * 86400, month: U.now() - 30 * 86400 }[period] || 0, db = App.db;
      return { totals: db.listenTotals(since), artists: db.topArtists(since, 10), tracks: db.topTracks(since, 10).map((t) => ({ ...slim(t), ms: t.listened_ms, plays: t.plays })), hours: db.byHour(since), genres: db.topGenres(since, 10) };
    },
    recap({ period = "month" }) {
      const r = App.db.recap(U.now() - (period === "year" ? 365 : 30) * 86400);
      r.artists = r.artists.map((a) => ({ key: a.key, name: a.name, art: artHi(a.art), ms: a.ms, plays: a.plays }));
      r.tracks = r.tracks.map((t) => ({ ...slim(t), ms: t.listened_ms, plays: t.plays, artHi: artHi(t.artwork_url) }));
      r.period = period; return r;
    },

    /* свои плейлисты */
    playlist_create: ({ name, add = null }) => { const pid = App.db.createPlaylist(name); if (add) App.db.addToPlaylist(pid, add); return pid; },
    playlist_rename: ({ pid, name }) => { App.db.renamePlaylist(pid, name); return true; },
    playlist_delete: ({ pid }) => { App.db.deletePlaylist(pid); return true; },
    playlist_add: ({ pid, id }) => App.db.addToPlaylist(pid, id),
    playlist_remove: ({ pid, id }) => { App.db.removeFromPlaylist(pid, id); return true; },
    playlist_reorder: ({ pid, ids }) => { App.db.reorderPlaylist(pid, ids); return true; },

    /* очередь */
    play_next: ({ id }) => { const t = App.db.track(id); if (t) App.player.playNext(t); return true; },
    enqueue: ({ id }) => { const t = App.db.track(id); if (t) App.player.enqueue(t); return true; },
    queue_remove: ({ kind, i }) => { App.player.queueRemove(kind, +i); return true; },
    queue_move: ({ kind, src, dst }) => { App.player.queueMove(kind, +src, +dst); return true; },
    queue_jump: ({ kind, i }) => { App.player.queueJump(kind, +i); return true; },
    queue: () => { onQueue(); return true; },

    /* тексты */
    async lyrics({ id }) {
      const t = App.db.track(id); if (!t) return { found: false, synced: [], plain: "" };
      const c = App.db.getLyrics(t.id); if (c) return c;
      const d = await S.fetchLyrics(t.title, t.artist, t.duration_ms || 0); App.db.putLyrics(t.id, d); return d;
    },

    /* таймер сна */
    sleep({ minutes = null, track = false, cancel = false }) {
      sleepReset();
      if (!cancel) {
        if (track && App.player.current) { App.sleep.track = true; App.player.stopAfter = true; }
        else if (minutes) { App.sleep.end = U.now() + minutes * 60; App.sleep.timer = setTimeout(sleepFire, minutes * 60000); }
      }
      const st = sleepState(); emit("sleep", st); return st;
    },

    /* настройки */
    settings_get: () => { const o = {}; for (const k of Object.keys(SETTING_DEFAULTS)) o[k] = App.settings.get(k, SETTING_DEFAULTS[k]); return { ...o, engine: "volna", discord_status: "", mini_on: false, media: "android", sleep: sleepState(), mobile: true }; },
    settings_set: ({ key, value }) => {
      if (!(key in SETTING_DEFAULTS)) throw new Error("Неизвестная настройка");
      if (key === "eq") value = (value || []).slice(0, 10).map((x) => U.clamp(+x, -12, 12));
      else if (key === "crossfade") value = U.clamp(+value, 0, 12);
      App.settings.set(key, value);
      if (key === "eq" || key === "eq_on") App.player.applyAudio();
      return value;
    },
    mini: () => false,
    cache_info: () => S.Cache.info(),
    cache_clear: () => { const c = App.player.current || {}; return S.Cache.clear([`${c.sc_id}.mp3`, `${c.sc_id}.m4a`, `${c.sc_id}.ogg`, `ym_${c.ym_id}.mp3`, `ym_${c.ym_id}.aac`, `ym_${c.ym_id}.m4a`]); },
    clipboard: () => Clip.get(),
    clipboard_set: async ({ text }) => { await Clip.set(String(text).slice(0, 10000)); return true; },

    /* Яндекс */
    async ym_status() {
      const flags = { available: true, prefer: App.settings.get("ym_prefer", true) !== false, waveSource: App.settings.get("wave_source") === "yandex" ? "yandex" : "volna" };
      if (!App.ym.logged) return { ...flags, logged: false };
      try { return { ...flags, ...(await App.ym.account()) }; }
      catch (e) { return e.message === S.AUTH_MSG ? { ...flags, logged: false, error: e.message } : { ...flags, logged: true, name: "Яндекс", offline: true, error: e.message }; }
    },
    async ym_login() {
      const Br = P.Browser;
      if (!Br) throw new Error("Вход через окно Яндекса работает только в приложении на телефоне. Вставь токен вручную.");
      const token = await new Promise((resolve) => {
        let done = false; const hs = [];
        const finish = (tok) => { if (done) return; done = true; hs.forEach((h) => h && h.remove && h.remove()); resolve(tok); };
        Br.addListener("urlChangeEvent", (ev) => { const tok = S.tokenFromUrl(ev.url); if (tok) { Br.close().catch(() => {}); finish(tok); } else if (/error=access_denied/.test(ev.url)) { Br.close().catch(() => {}); finish(null); } }).then((h) => hs.push(h));
        Br.addListener("closeEvent", () => finish(null)).then((h) => hs.push(h));
        Br.openWebView({ url: S.OAUTH_URL, title: "Вход в Яндекс Музыку", toolbarType: "navigation" }).catch(() => finish(null));
      });
      if (!token) return null;
      const info = await App.ym.login(token); emit("ym", info); return info;
    },
    ym_token: async ({ token }) => { const t = S.tokenFromUrl(token) || String(token).trim(); if (!/^[A-Za-z0-9_\-.]{20,}$/.test(t)) throw new Error("Это не похоже на токен Яндекса"); const info = await App.ym.login(t); emit("ym", info); return info; },
    ym_logout: () => { App.ym.logout(); if (App.player.wave && App.player.wave.source === "yandex") App.player.stopWave(); emit("ym", { logged: false }); return { available: true, logged: false }; },
    async ym_import() { if (!App.ym.logged) throw new Error("Сначала войди в Яндекс Музыку"); const r = await App.ym.importAll(App.db, progress("ym")); await App.db.flush(); return r; },
    async ym_search({ q, limit = 30 }) { return { rows: (await App.ym.search(q, limit)).map((p) => slim(App.db.track(App.db.upsertYm(p)))) }; },
    ym_set: ({ key, value }) => {
      if (key === "ym_prefer") { value = !!value; App.player.prefetched.clear(); }
      else if (key === "wave_source") { value = value === "yandex" ? "yandex" : "volna"; if (value === "yandex" && !App.ym.logged) throw new Error("Чтобы включить волну Яндекса, сначала войди в Яндекс Музыку"); }
      else throw new Error("Неизвестная настройка");
      return App.settings.set(key, value);
    },

    /* умные плейлисты */
    smart_schema: () => B.Smart.schema(),
    smart_list: () => B.Smart.list(App.db),
    smart_get: ({ sid }) => { const sp = B.Smart.get(App.db, +sid); if (!sp) throw new Error("Умный плейлист не найден"); const rows = B.Smart.query(App.db, sp.rules); return { ...sp, rows: rows.map(slim), arts: rows.filter((t) => t.artwork_url).map((t) => t.artwork_url).slice(0, 4) }; },
    smart_preview: ({ rules }) => { const rows = B.Smart.query(App.db, rules); return { n: rows.length, arts: rows.filter((t) => t.artwork_url).map((t) => t.artwork_url).slice(0, 4), sample: rows.slice(0, 5).map((t) => `${t.artist} — ${t.title}`) }; },
    smart_save: ({ name, rules, sid = null }) => B.Smart.save(App.db, (String(name || "").trim() || "Умный плейлист").slice(0, 100), rules, sid ? +sid : null),
    smart_delete: ({ sid }) => { B.Smart.remove(App.db, +sid); return true; },

    /* обмен с друзьями */
    async share_code({ kind = "playlist", key = null }) {
      const [name, rows] = shareTracks(kind, key); if (!rows.length) throw new Error("Делиться нечем — плейлист пустой");
      const code = await B.Share.pack(name, rows); await Clip.set(code); return { code, tracks: rows.length, name, chars: code.length };
    },
    share_file: () => NOT_HERE("Сохранение файлом .volna"),
    async share_import({ code = null }) { if (!code) throw new Error("Вставь код плейлиста — открыть файл на телефоне пока нельзя"); return B.Share.importCode(App.db, code); },

    /* офлайн */
    async offline_add({ ids = null, kind = null, key = null }) { const rows = rowsFor(kind, key, ids); if (!rows.length) throw new Error("Нечего скачивать — список пустой"); const added = await App.offline.add(rows.map((r) => r.id)); return { added, already: rows.length - added }; },
    async offline_remove({ ids = null, kind = null, key = null }) { const n = await App.offline.remove(rowsFor(kind, key, ids).map((r) => r.id)); emit("offline", App.offline.status()); return { removed: n }; },
    offline_cancel: () => { App.offline.cancel(); return true; },
    offline_status: () => ({ ...App.offline.status(), mode: App.player.offlineOnly, auto: !!App.settings.get("offline_liked", false) }),
    async offline_list() { const rows = []; for (const r of App.db.offlineTracks()) if (await App.offline.fileFor(r)) rows.push(r); return { rows: rows.map(slim), bytes: await App.offline.bytes(), arts: rows.filter((r) => r.artwork_url).map((r) => r.artwork_url).slice(0, 4) }; },
    offline_mode: ({ on }) => { App.settings.set("offline_mode", !!on); App.player.offlineOnly = !!on; emit("offline_mode", !!on); return !!on; },
    offline_auto: ({ on }) => App.settings.set("offline_liked", !!on),

    /* ДНК */
    async dna() { try { await window.VDna.backfill(App.db, App.sc); } catch (_) { /* без сети — по тому, что есть */ } App.dnaCache = window.VDna.compute(App.db, App.db.byHour(0)); return window.VDna.pub(App.dnaCache); },
    async dna_code({ name = "" }) { const d = App.dnaCache || window.VDna.compute(App.db, App.db.byHour(0)); const code = await window.VDna.pack(d, name); await Clip.set(code); return { code }; },
    async dna_compare({ code }) { if (!code) code = await Clip.get(); return window.VDna.compare(App.dnaCache || window.VDna.compute(App.db, App.db.byHour(0)), code); },

    /* аккаунт */
    account_info: () => ({ me: Accounts.pub(Accounts.get(App.me.id)), all: Accounts.list() }),
    account_rename: async ({ name }) => { const a = await Accounts.rename(App.me.id, name); App.me = a; return a; },
    account_password: async ({ old = "", new: nw = "" }) => { await Accounts.setPassword(App.me.id, old, nw); return Accounts.pub(Accounts.get(App.me.id)); },
    account_switch: async () => { App.player.toggle(false); await App.db.flush(); try { sessionStorage.setItem("volna.choose", "1"); } catch (_) { /* */ } location.reload(); return true; },
    account_delete: async ({ password = "" }) => { App.player.toggle(false); await App.db.flush(); await Accounts.remove(App.me.id, password); location.reload(); return true; },

    /* только на ПК */
    party_state: () => ({ on: false, mobile: true }), party_start: () => NOT_HERE("Режим вечеринки"),
    lfm_status: () => ({ configured: false, logged: false, mobile: true }),
    update_check: () => checkUpdate(),
    update_install: async () => {
      if (!App.updateUrl) throw new Error("Сначала проверь обновления");
      location.href = App.updateUrl;   // Android откроет загрузку в браузере, потом — установщик APK
      return true;
    },
  };
  const ver = (s) => { const n = String(s || "").match(/\d+/g) || []; return [0, 1, 2].map((i) => +(n[i] || 0)); };
  const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  async function checkUpdate() {
    const cur = window.VOLNA_MOBILE_VERSION, repo = String(App.settings.get("update_repo", "") || "XwastX/volna").trim().replace(/^\/+|\/+$/g, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { configured: false, current: cur };
    const r = await window.VP.http(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, type: "json", timeout: 12000 });
    if (r.status === 404) return { configured: true, current: cur, available: false, note: "В репозитории пока нет релизов" };
    if (r.status >= 400) throw new Error(`GitHub ответил ${r.status}`);
    const rel = r.data || {}, tag = String(rel.tag_name || "");
    const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name || ""));
    const url = asset ? asset.browser_download_url || "" : "";
    const ok = !!asset && newer(tag, cur) && /^https:\/\/github\.com\//.test(url);
    App.updateUrl = ok ? url : "";
    return { configured: true, current: cur, latest: tag.replace(/^v/, ""), available: ok, installed: true, notes: String(rel.body || "").slice(0, 2000), url: ok ? url : "", page: rel.html_url || "" };
  }
  function shareTracks(kind, key) {
    if (kind === "liked") return ["Любимые треки", App.db.library("all", "", true)];
    if (kind === "smart") { const sp = B.Smart.get(App.db, +key); return sp ? [sp.name, B.Smart.query(App.db, sp.rules)] : ["", []]; }
    if (kind === "offline") return ["Скачанное", App.db.offlineTracks()];
    const p = App.db.playlist(+key); return p ? [p.name, App.db.playlistTracks(+key)] : ["", []];
  }
  function rowsFor(kind, key, ids) { if (ids) return ids.map((i) => App.db.track(+i)).filter(Boolean); return kind ? shareTracks(kind, key)[1] : []; }
  function afterLike(t, liked) {
    if (!t) return;
    if (t.ym_id && App.ym.logged) App.ym.like(t.ym_id, liked).catch((e) => { if (e.message === S.AUTH_MSG) emit("ym", { logged: false }); });
    if (liked && App.settings.get("offline_liked", false)) App.offline.add([t.id]).catch(() => {});
  }
  function sleepState() { if (!App.sleep) return { on: false }; if (App.sleep.track) return { on: true, track: true }; if (App.sleep.end) return { on: true, end: App.sleep.end * 1000 }; return { on: false }; }
  function sleepReset() {
    const s = App.sleep; clearTimeout(s.timer); s.end = 0;
    if (s.track) App.player.stopAfter = false; s.track = false;
    if (s.fade) { clearInterval(s.fade); s.fade = null; App.player.volumeRaw(App.settings.get("volume", 80)); }
  }
  function sleepFire() {
    const s = App.sleep; let i = 0;
    s.fade = setInterval(() => {
      i++; const vol = App.settings.get("volume", 80);
      if (i >= 30) { clearInterval(s.fade); s.fade = null; App.player.toggle(false); App.player.volumeRaw(vol); s.end = 0; emit("sleep", { on: false, done: true }); return; }
      App.player.volumeRaw(vol * (1 - i / 30));
    }, 500);
  }

  /* ---------------- подключение к интерфейсу (вместо QWebChannel) ---------------- */
  window.__MOCK_API__ = (onReply, onEvent) => {
    emitRaw = onEvent;
    return {
      call(id, method, args) {
        (async () => {
          await ready;
          const fn = api[method];
          if (!fn) throw new Error(`Эта функция пока есть только на компьютере (${method})`);
          return fn(JSON.parse(args || "{}"));
        })().then((data) => onReply(id, JSON.stringify({ ok: true, data: data === undefined ? null : data })),
          (e) => { console.warn(method, e); onReply(id, JSON.stringify({ ok: false, data: null, error: e.message || String(e) })); });
      },
    };
  };
  /* при сворачивании — сохранить базу сразу */
  document.addEventListener("visibilitychange", () => { if (document.hidden && App.db) App.db.flush(); });
  if (P.App) P.App.addListener("pause", () => { if (App.db) App.db.flush(); });

  window.VApp = App; window.VApi = api; App.slim = slim; App.Accounts = Accounts;
})();
