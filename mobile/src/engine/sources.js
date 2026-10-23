"use strict";
/* Volna Mobile — источники музыки: SoundCloud, Яндекс Музыка, ссылки Spotify, поиск пар, тексты, кэш звука. */
(() => {
  const { U, http, NetError, FS, DIR, norm, artistKey, seqRatio, md5, hmacSha256B64 } = window.VP;
  const { JsonFile } = window.VS;

  class SourceError extends Error {}
  class NotStreamable extends SourceError {}

  /* ================= кэш звука (общий для аккаунтов, лимит 300 МБ) ================= */
  const Cache = {
    file: new JsonFile("cache-index.json"), idx: null, limit: 300 * 1024 * 1024,
    async load() { if (!this.idx) this.idx = await this.file.load({}); return this.idx; },
    async find(prefix) {
      await this.load();
      for (const ext of ["mp3", "m4a", "ogg", "aac", "flac", "ts"]) {
        const name = `${prefix}.${ext}`;
        if (this.idx[name] && this.idx[name].size > 50000) {
          if (await FS.size(`audio/${name}`, DIR.CACHE) > 50000) { this.idx[name].t = U.now(); this.file.save(this.idx); return name; }
          delete this.idx[name];
        }
      }
      return null;
    },
    async add(name) {
      await this.load();
      this.idx[name] = { size: await FS.size(`audio/${name}`, DIR.CACHE), t: U.now() };
      this.file.save(this.idx);
      this.prune();
    },
    async prune(protect = []) {
      const items = Object.entries(this.idx).sort((a, b) => b[1].t - a[1].t);
      let total = 0;
      for (const [name, v] of items) {
        total += v.size;
        if (total > this.limit && !protect.includes(name)) { await FS.remove(`audio/${name}`, DIR.CACHE); delete this.idx[name]; }
      }
      this.file.save(this.idx);
    },
    async info() { await this.load(); const v = Object.values(this.idx); return { mb: Math.round(v.reduce((s, x) => s + x.size, 0) / 104857.6) / 10, files: v.length }; },
    async clear(protect = []) {
      await this.load(); let n = 0;
      for (const name of Object.keys(this.idx)) if (!protect.includes(name)) { await FS.remove(`audio/${name}`, DIR.CACHE); delete this.idx[name]; n++; }
      this.file.save(this.idx, true); return n;
    },
  };

  /* ================= SoundCloud ================= */
  const API = "https://api-v2.soundcloud.com", SITE = "https://soundcloud.com";
  const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
  const yearOf = (s) => { const m = /^(\d{4})/.exec(String(s || "")); return m ? +m[1] : 0; };
  function parseTrack(t) {
    if (!t || (t.kind || "track") !== "track" || t.id == null || !t.title) return null;
    const user = t.user || {};
    let title = String(t.title).trim(), artist = String((t.publisher_metadata || {}).artist || "").trim();
    if (!artist) {
      const m = /^(.{1,80}?)\s+[-–—]\s+(.+)$/.exec(title);
      if (m) { artist = m[1].trim(); title = m[2].trim(); } else artist = String(user.username || "").trim();
    }
    const tr = ((t.media || {}).transcodings || []).filter((x) => !x.snipped && !String((x.format || {}).protocol || "").includes("encrypted"));
    const policy = String(t.policy || "").toUpperCase();
    const playable = tr.length > 0 && policy !== "SNIP" && policy !== "BLOCK" && t.streamable !== false;
    let art = t.artwork_url || user.avatar_url || "";
    if (art) art = art.replace("-large.", "-t300x300.");
    return { sc_id: +t.id, title, artist, duration_ms: +(t.full_duration || t.duration || 0), genre: String(t.genre || "").trim(), tags: String(t.tag_list || "").trim(),
      artwork_url: art, permalink_url: t.permalink_url || "", sc_user_id: user.id ?? null, playable, playback_count: t.playback_count || 0,
      year: yearOf(t.release_date || t.display_date || t.created_at), likes_count: t.likes_count || t.favoritings_count || 0 };
  }

  class SoundCloud {
    constructor() { this.cfg = new JsonFile("soundcloud.json"); this.cid = ""; this.cidAt = 0; this.cidP = null; this.dl = new Map(); }
    async init() { const c = await this.cfg.load({}); this.cid = c.client_id || ""; return this; }
    async clientId(refresh = false) {
      if (this.cid && !refresh) return this.cid;
      if (!this.cidP) this.cidP = this.scrape().then((id) => { this.cid = id; this.cidAt = U.now(); this.cfg.save({ client_id: id }, true); return id; }).finally(() => { this.cidP = null; });
      return this.cidP;
    }
    async scrape() {
      let html;
      try { html = (await http(SITE + "/", { headers: { "User-Agent": UA, Accept: "text/html" } })).data; } catch (e) { throw new SourceError(`Нет связи с soundcloud.com: ${e.message}`); }
      let m = /[?&]client_id=([0-9a-zA-Z]{32})/.exec(html); if (m) return m[1];
      const srcs = [...String(html).matchAll(/<script[^>]+src="(https:\/\/[^"]+\.js)"/g)].map((x) => x[1]).reverse();
      for (const src of srcs) {
        let js; try { js = (await http(src, { headers: { "User-Agent": UA } })).data; } catch (_) { continue; }
        m = /client_id\s*[:=]\s*"([0-9a-zA-Z]{32})"/.exec(js) || /[?&]client_id=([0-9a-zA-Z]{32})/.exec(js);
        if (m) return m[1];
      }
      throw new SourceError("Не удалось получить ключ SoundCloud (сайт поменял разметку?)");
    }
    async get(path, params = {}, retry = true) {
      let url = path.startsWith("http") ? path : API + path;
      const p = { ...params };
      if (!url.includes("client_id=")) p.client_id = await this.clientId();
      const used = p.client_id || (/[?&]client_id=([0-9a-zA-Z]{32})/.exec(url) || [])[1] || "";
      for (let attempt = 0; attempt < 3; attempt++) {
        let r;
        try { r = await http(url, { params: p, type: "json", headers: { "User-Agent": UA, Accept: "application/json", Origin: SITE, Referer: SITE + "/" } }); }
        catch (e) { if (attempt === 2) throw new SourceError(`Сеть: ${e.message}`); await U.sleep(1000 * (1 + attempt)); continue; }
        if ((r.status === 401 || r.status === 403) && retry) {
          if (this.cid && this.cid !== used) { /* другой запрос уже обновил ключ */ }
          else if (r.status === 403 && U.now() - this.cidAt < 60) throw new SourceError("Доступ запрещён (403) — трек закрыт в твоём регионе или удалён");
          else await this.clientId(true);
          url = url.replace(/client_id=[0-9a-zA-Z]+/, `client_id=${this.cid}`);
          if (p.client_id) p.client_id = this.cid;
          return this.get(url, p, false);
        }
        if (r.status === 429 || r.status >= 500) { await U.sleep(2000 + attempt * 2000); continue; }
        if (r.status === 401 || r.status === 403) throw new SourceError(`Доступ запрещён (${r.status})`);
        if (r.status === 404) throw new SourceError("Не найдено (404)");
        if (r.status >= 400) throw new SourceError(`SoundCloud ответил ${r.status}`);
        return r.data;
      }
      throw new SourceError("SoundCloud не отвечает, попробуй позже");
    }
    async paged(path, params, limit) {
      const out = []; let d = await this.get(path, params);
      for (;;) { out.push(...(d.collection || [])); if (!d.next_href || out.length >= limit) break; d = await this.get(d.next_href); }
      return out.slice(0, limit);
    }
    async searchTracks(q, limit = 30) { const d = await this.get("/search/tracks", { q, limit, linked_partitioning: 1 }); return (d.collection || []).map(parseTrack).filter(Boolean); }
    async searchUsers(q, limit = 5) { return (await this.get("/search/users", { q, limit })).collection || []; }
    resolve(url) { return this.get("/resolve", { url: url.trim() }); }
    async tracksByIds(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const d = await this.get("/tracks", { ids: ids.slice(i, i + 50).join(",") });
        out.push(...(Array.isArray(d) ? d : d.collection || []).map(parseTrack).filter(Boolean));
      }
      return out;
    }
    async related(sc, limit = 30) { const d = await this.get(`/tracks/${sc}/related`, { limit, linked_partitioning: 1 }); return (d.collection || []).map(parseTrack).filter(Boolean); }
    async userLikes(uid, limit = 2000) { return (await this.paged(`/users/${uid}/likes`, { limit: 200, linked_partitioning: 1 }, limit)).map((i) => parseTrack(i.track)).filter(Boolean); }
    async userPlaylists(uid) {
      const own = await this.paged(`/users/${uid}/playlists`, { limit: 50, linked_partitioning: 1 }, 500);
      const liked = (await this.paged(`/users/${uid}/likes`, { limit: 200, linked_partitioning: 1 }, 2000)).map((i) => i.playlist).filter(Boolean);
      const seen = new Set(), out = [];
      for (const p of [...own, ...liked]) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
      return out;
    }
    async playlistFull(pl) {
      if (!pl.tracks || !pl.tracks.length) pl = await this.get(`/playlists/${pl.id}`);
      const raw = pl.tracks || [], full = new Map();
      for (const t of raw) if (t.title) full.set(t.id, parseTrack(t));
      const stubs = raw.filter((t) => !t.title).map((t) => t.id);
      if (stubs.length) for (const p of await this.tracksByIds(stubs)) full.set(p.sc_id, p);
      return [pl.title || "Плейлист", raw.map((t) => full.get(t.id)).filter(Boolean)];
    }

    /* --- звук: скачиваем целиком в кэш (как на ПК) --- */
    stream(sc, progress) {
      const key = `sc${sc}`;
      if (!this.dl.has(key)) this.dl.set(key, this._stream(sc, progress).finally(() => this.dl.delete(key)));
      return this.dl.get(key);
    }
    async _stream(sc, progress) {
      const hit = await Cache.find(String(sc)); if (hit) return hit;
      const data = await this.get(`/tracks/${sc}`);
      const usable = ((data.media || {}).transcodings || []).filter((t) => !t.snipped && !String((t.format || {}).protocol || "").includes("encrypted"));
      if (!usable.length) throw new NotStreamable("Трек недоступен для прослушивания (Go+ или закрыт правообладателем)");
      const rank = (t) => { const f = t.format || {}, mime = f.mime_type || ""; return [f.protocol === "progressive" ? 0 : 1, mime.includes("mpeg") ? 0 : mime.includes("mp4") || mime.includes("aac") ? 1 : 2]; };
      usable.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; });
      let last = null;
      for (const tc of usable) {
        try {
          const params = data.track_authorization ? { track_authorization: data.track_authorization } : {};
          const info = await this.get(tc.url, params);
          if (!info.url) continue;
          const fmt = tc.format || {};
          if (fmt.protocol === "progressive") {
            const name = `${sc}.mp3`;
            await FS.download(info.url, `audio/${name}`, DIR.CACHE, { "User-Agent": UA }, progress);
            await Cache.add(name); return name;
          }
          return await this.hls(sc, info.url, fmt.mime_type || "", progress);
        } catch (e) { last = e; }
      }
      throw new NotStreamable(`Не удалось получить поток: ${last ? last.message : "нет вариантов"}`);
    }
    async hls(sc, url, mime, progress) {
      const abs = (base, rel) => new URL(rel, base).href;
      let text = (await http(url, { headers: { "User-Agent": UA } })).data;
      if (text.includes("#EXT-X-STREAM-INF")) { const v = text.split("\n").find((l) => l.trim() && !l.startsWith("#")); url = abs(url, v.trim()); text = (await http(url)).data; }
      let init = null; const segs = [];
      for (let ln of text.split("\n")) {
        ln = ln.trim();
        if (ln.startsWith("#EXT-X-KEY") && !ln.includes("METHOD=NONE")) throw new NotStreamable("Поток зашифрован");
        if (ln.startsWith("#EXT-X-MAP")) { const m = /URI="([^"]+)"/.exec(ln); if (m) init = abs(url, m[1]); }
        else if (ln && !ln.startsWith("#")) segs.push(abs(url, ln));
      }
      if (!segs.length) throw new NotStreamable("Пустой HLS-плейлист");
      let ext;
      if (mime.includes("ogg") || mime.includes("opus")) ext = "ogg";
      else if (mime.includes("mpeg") && !init) ext = "mp3";
      else if (init || mime.includes("mp4") || mime.includes("aac")) ext = "m4a";
      else ext = "ts";
      if (!init && ext === "m4a" && !mime.includes("mp4")) ext = "ts";
      const parts = new Array(segs.length); let done = 0, next = 0;
      const getBin = async (u) => {
        for (let a = 0; a < 3; a++) {
          try { const r = await http(u, { type: "binary", timeout: 30000 }); if (r.status < 400) return r.data; } catch (_) { /* повтор */ }
          await U.sleep(500);
        }
        throw new SourceError("Не удалось скачать часть трека");
      };
      const worker = async () => { while (next < segs.length) { const i = next++; parts[i] = await getBin(segs[i]); done++; if (progress) progress(done / segs.length); } };
      await Promise.all(Array.from({ length: Math.min(5, segs.length) }, worker));
      const name = `${sc}.${ext}`, tmp = `audio/${sc}.part`;
      if (init) await FS.writeB64(tmp, await getBin(init), DIR.CACHE);
      else await FS.writeB64(tmp, parts.shift(), DIR.CACHE);
      for (const p of parts) await FS.appendB64(tmp, p, DIR.CACHE);
      await FS.copy(tmp, DIR.CACHE, `audio/${name}`, DIR.CACHE);
      await FS.remove(tmp, DIR.CACHE);
      await Cache.add(name);
      return name;
    }
  }

  /* ================= Яндекс Музыка ================= */
  const YM = "https://api.music.yandex.net";
  const YM_CLIENT = "YandexMusicAndroid/24023621";
  const YM_DESKTOP = "YandexMusicDesktopAppWindows/5.95.0";
  const YM_FILE_KEY = "kzqU4XhfCaY6B6JTHODeq5";
  const YM_SALT = "XGRlBW9FXlekgbPrRHuSiA";
  const OAUTH_URL = "https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d";
  const AUTH_MSG = "Вход в Яндекс Музыку устарел — войди заново в настройках";
  const ymExt = (codec) => { codec = String(codec || "").toLowerCase(); if (codec === "mp3") return "mp3"; if (codec.startsWith("flac") && !codec.endsWith("mp4")) return "flac"; if (codec.endsWith("-mp4")) return "m4a"; return "aac"; };
  function ymParse(t) {
    if (!t || t.id == null || !t.title) return null;
    let title = t.title; if (t.version && !title.toLowerCase().includes(String(t.version).toLowerCase())) title = `${title} (${t.version})`;
    const artists = (t.artists || []).map((a) => a.name).filter(Boolean);
    const alb = (t.albums || [])[0] || null;
    const cover = t.coverUri || (alb && alb.coverUri) || "";
    return { ym_id: String(t.id), ym_tid: alb && alb.id ? `${t.id}:${alb.id}` : String(t.id), title, artist: artists.join(", ") || t.ugcArtistName || "",
      album: (alb && alb.title) || "", duration_ms: +(t.durationMs || 0), genre: (alb && alb.genre) || "", year: +((alb && alb.year) || 0),
      artwork_url: cover ? `https://${cover.replace("%%", "400x400")}` : "", available: t.available !== false,
      url: alb && alb.id ? `https://music.yandex.ru/album/${alb.id}/track/${t.id}` : `https://music.yandex.ru/track/${t.id}` };
  }
  function tokenFromUrl(url) { const m = /access_token=([^&#]+)/.exec(url || ""); return m ? decodeURIComponent(m[1]) : null; }

  class Yandex {
    constructor(settings) { this.s = settings; this.acc = null; this.dl = new Map(); }
    get token() { return this.s.get("ym_token", "") || ""; }
    get logged() { return !!this.token; }
    async req(path, { method = "GET", params = null, form = null, json = null, headers = {} } = {}) {
      if (!this.token) throw new SourceError("Сначала войди в Яндекс Музыку");
      const h = { Authorization: `OAuth ${this.token}`, "X-Yandex-Music-Client": YM_CLIENT, ...headers };
      let data = null;
      if (form) { h["Content-Type"] = "application/x-www-form-urlencoded"; data = new URLSearchParams(form).toString(); }
      if (json) { h["Content-Type"] = "application/json"; data = JSON.stringify(json); }
      const r = await http(YM + path, { method, params, data, headers: h, type: "json" });
      if (r.status === 401 || r.status === 403) { this.s.set("ym_token", ""); this.acc = null; throw new SourceError(AUTH_MSG); }
      if (r.status >= 400) throw new SourceError(`Яндекс ответил ${r.status}`);
      return r.data && r.data.result !== undefined ? r.data.result : r.data;
    }
    async login(token) { this.s.set("ym_token", token); this.acc = null; try { return await this.account(); } catch (e) { this.s.set("ym_token", ""); throw e; } }
    logout() { this.s.set("ym_token", ""); this.acc = null; }
    async account() {
      if (!this.logged) return { logged: false };
      if (this.acc) return this.acc;
      const st = await this.req("/account/status"); const a = st.account || {};
      let avatar = "";
      try { const r = await http("https://login.yandex.ru/info", { params: { format: "json" }, headers: { Authorization: `OAuth ${this.token}` }, type: "json", timeout: 6000 });
        if (r.data && r.data.default_avatar_id && !r.data.is_avatar_empty) avatar = `https://avatars.yandex.net/get-yapic/${r.data.default_avatar_id}/islands-200`; } catch (_) { /* не важно */ }
      this.acc = { logged: true, uid: a.uid, login: a.login || "", name: a.displayName || a.fullName || a.login || "Яндекс", plus: !!(st.plus && st.plus.hasPlus), avatar };
      return this.acc;
    }
    async fullTracks(ids) { const out = []; for (let i = 0; i < ids.length; i += 200) out.push(...((await this.req("/tracks", { method: "POST", form: { "track-ids": ids.slice(i, i + 200).join(","), "with-positions": "false" } })) || [])); return out; }
    async shortsToTracks(shorts) {
      const have = new Map(), need = [], order = [];
      for (const s of shorts || []) { const id = String(s.id); order.push(id); if (s.track) have.set(id, s.track); else need.push(s.albumId ? `${id}:${s.albumId}` : id); }
      if (need.length) for (const t of await this.fullTracks(need)) have.set(String(t.id), t);
      return order.filter((x) => have.has(x)).map((x) => have.get(x));
    }
    async importAll(db, prog = () => {}) {
      const acc = await this.account(); const uid = acc.uid;
      prog(0.02, "Загружаю «Мне нравится»…");
      const likes = await this.req(`/users/${uid}/likes/tracks`, { params: { "if-modified-since-revision": 0 } });
      const tracks = await this.shortsToTracks(((likes.library || {}).tracks) || []);
      const liked = [];
      tracks.forEach((tr, i) => { const p = ymParse(tr); if (p) liked.push(db.upsertYm(p, { inLibrary: true, liked: true })); if (i % 25 === 0) prog(0.05 + 0.45 * i / Math.max(1, tracks.length), `Лайки: ${i}/${tracks.length}`); });
      if (liked.length) db.upsertPlaylist("Мне нравится · Яндекс", "yandex", `ym:${uid}:3`, liked);
      prog(0.5, "Загружаю плейлисты…");
      const pls = (await this.req(`/users/${uid}/playlists/list`)) || [];
      let nPl = 0, nTr = liked.length;
      for (let k = 0; k < pls.length; k++) {
        const pl = pls[k]; const kind = pl.kind; const owner = (pl.owner || {}).uid || pl.uid || uid; const name = pl.title || "Плейлист";
        if (kind == null || kind === 3) continue;
        let items;
        try { items = await this.shortsToTracks(((await this.req(`/users/${owner}/playlists/${kind}`)) || {}).tracks || []); }
        catch (e) { if (e.message === AUTH_MSG) throw e; continue; }
        const ids = items.map(ymParse).filter(Boolean).map((p) => db.upsertYm(p, { inLibrary: true }));
        db.upsertPlaylist(name, "yandex", `ym:${owner}:${kind}`, ids);
        nPl++; nTr += ids.length; prog(0.5 + 0.5 * (k + 1) / Math.max(1, pls.length), `Плейлист «${name}»: ${ids.length}`);
      }
      prog(1, "Готово");
      return { user: acc.name, liked: liked.length, playlists: nPl, tracks: nTr };
    }
    async search(q, limit = 30) { const r = await this.req("/search", { params: { text: q, type: "track", page: 0, nocorrect: "False" } }); return (((r || {}).tracks || {}).results || []).map(ymParse).filter((p) => p && p.available).slice(0, limit); }
    async like(ymId, liked) { const acc = await this.account(); await this.req(`/users/${acc.uid}/likes/tracks/${liked ? "add-multiple" : "remove"}`, { method: "POST", form: { "track-ids": String(ymId) } }); return true; }
    async dislike(ymId) { const acc = await this.account(); await this.req(`/users/${acc.uid}/dislikes/tracks/add-multiple`, { method: "POST", form: { "track-ids": String(ymId) } }); return true; }
    async bestLink(ymId) {
      /* 1) get-file-info с подписью десктопного клиента (как в библиотеке yandex-music) */
      try {
        const ts = Math.floor(Date.now() / 1000), quality = "hq", codecs = ["mp3", "aac", "he-aac", "aac-mp4", "he-aac-mp4"], transport = "raw";
        const sign = (await hmacSha256B64(YM_FILE_KEY, `${ts}${ymId}${quality}${codecs.join("")}${transport}`)).slice(0, -1);
        const r = await this.req("/get-file-info", { params: { ts, trackId: ymId, quality, codecs: codecs.join(","), transports: transport, sign }, headers: { "X-Yandex-Music-Client": YM_DESKTOP } });
        const di = (r || {}).downloadInfo; const url = di && (di.url || (di.urls || [])[0]);
        if (url) return [url, di.codec || "mp3"];
      } catch (e) { if (e.message === AUTH_MSG) throw e; }
      /* 2) старый download-info + XML с подписью md5 */
      const infos = (await this.req(`/tracks/${ymId}/download-info`)) || [];
      const full = infos.filter((i) => !i.preview).sort((a, b) => ((a.codec === "mp3" && a.bitrateInKbps >= 320 ? 0 : 1) - (b.codec === "mp3" && b.bitrateInKbps >= 320 ? 0 : 1)) || b.bitrateInKbps - a.bitrateInKbps);
      for (const i of full) {
        try {
          const xml = (await http(i.downloadInfoUrl, { headers: { Authorization: `OAuth ${this.token}` } })).data;
          const tag = (n) => ((new RegExp(`<${n}>([^<]*)</${n}>`)).exec(xml) || [])[1];
          const host = tag("host"), path = tag("path"), ts = tag("ts"), s = tag("s");
          if (host && path && s) return [`https://${host}/get-mp3/${md5(YM_SALT + path.slice(1) + s)}/${ts}${path}`, i.codec || "mp3"];
        } catch (_) { /* следующий вариант */ }
      }
      if (infos.length) throw new SourceError("Яндекс отдаёт только превью — нужна подписка Плюс или трек недоступен в регионе");
      throw new SourceError("Трек недоступен в Яндекс Музыке");
    }
    stream(ymId, progress) {
      const key = `ym${ymId}`;
      if (!this.dl.has(key)) this.dl.set(key, this._stream(String(ymId), progress).finally(() => this.dl.delete(key)));
      return this.dl.get(key);
    }
    async _stream(ymId, progress) {
      const hit = await Cache.find(`ym_${ymId}`); if (hit) return hit;
      const [url, codec] = await this.bestLink(ymId);
      const name = `ym_${ymId}.${ymExt(codec)}`;
      await FS.download(url, `audio/${name}`, DIR.CACHE, {}, progress);
      await Cache.add(name);
      return name;
    }
    /* «Моя волна» (rotor) */
    async rotorTracks(station, queue) { return this.req(`/rotor/station/${station}/tracks`, { params: queue ? { settings2: "True", queue } : { settings2: "True" } }); }
    async rotorSettings(station, moodEnergy, diversity) { return this.req(`/rotor/station/${station}/settings3`, { method: "POST", json: { moodEnergy, diversity, type: "rotor", language: "any" } }); }
    async rotorFeedback(station, type, { batch, trackId, from, secs } = {}) {
      const body = { type, timestamp: new Date().toISOString() };
      if (trackId) body.trackId = trackId; if (from) body.from = from; if (secs) body.totalPlayedSeconds = secs;
      return this.req(`/rotor/station/${station}/feedback`, { method: "POST", params: batch ? { "batch-id": batch } : null, json: body });
    }
  }

  /* ================= Spotify: публичная ссылка ================= */
  async function importSpotifyLink(db, url) {
    const m = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|track)\/([A-Za-z0-9]+)/.exec(url || "");
    if (!m) throw new Error("Это не похоже на ссылку open.spotify.com на плейлист, альбом или трек");
    const [, kind, sid] = m;
    let html;
    try { html = (await http(`https://open.spotify.com/embed/${kind}/${sid}`, { headers: { "User-Agent": UA } })).data; } catch (e) { throw new Error(`Нет связи с Spotify: ${e.message}`); }
    const mm = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/.exec(html);
    if (!mm) throw new Error("Spotify не отдал данные плейлиста (возможно, он приватный)");
    const ent = ((((JSON.parse(mm[1]).props || {}).pageProps || {}).state || {}).data || {}).entity || {};
    const name = ent.name || ent.title || "Spotify";
    let items = ent.trackList || [];
    if (kind === "track" && !items.length) items = [{ uri: ent.uri, title: ent.name || ent.title, subtitle: (ent.artists || []).map((a) => a.name).join(", "), duration: ent.duration }];
    const ids = [];
    for (const it of items) { const artist = String(it.subtitle || "").replace(/ /g, " "); if (it.title && artist) ids.push(db.upsertSpotify(it.uri, it.title, artist, "", +(it.duration || 0), { inLibrary: true })); }
    if (!ids.length) throw new Error("В плейлисте не нашлось треков");
    if (kind !== "track") db.upsertPlaylist(name, "spotify", `spotify:${kind}:${sid}`, ids);
    return { name, tracks: ids.length };
  }

  /* ================= поиск пары на SoundCloud ================= */
  const VARIANT = ["remix", "cover", "sped up", "speed up", "slowed", "nightcore", "live", "instrumental", "karaoke", "8d", "reverb", "bass boosted", "acoustic", "кавер", "ремикс", "минус", "edit", "mashup", "flip", "bootleg", "tiktok"];
  const sim = (a, b) => { if (!a || !b) return 0; if (a === b) return 1; const ta = new Set(a.split(" ")), tb = new Set(b.split(" ")); let n = 0; for (const x of ta) if (tb.has(x)) n++; return Math.max(seqRatio(a, b), 0.9 * n / Math.max(1, ta.size)); };
  function matchScore(title, artist, dur, c) {
    const nt = norm(title), na = artistKey(artist), ct = norm(c.title), ca = artistKey(c.artist);
    const sT = sim(nt, ct), sA = Math.max(sim(na, ca), na && ct.includes(na) ? 1 : 0, na && norm(c.artist).includes(na) ? 0.85 : 0);
    let sD = 0.6; if (dur && c.duration_ms) { const d = Math.abs(dur - c.duration_ms) / 1000; sD = d <= 3 ? 1 : d <= 8 ? 0.8 : d <= 20 ? 0.4 : 0; }
    let s = 0.45 * sT + 0.35 * sA + 0.2 * sD;
    const lo = `${title} ${artist}`.toLowerCase(), lc = `${c.title} ${c.artist}`.toLowerCase();
    if (VARIANT.some((w) => lc.includes(w) && !lo.includes(w))) s -= 0.15;
    if (!c.playable) s -= 0.5;
    return s;
  }
  async function findOnSoundCloud(sc, title, artist, dur = 0) {
    let best = null, bs = 0; const qs = [`${artist} ${title}`]; if (norm(title).length > 4) qs.push(title);
    for (const q of qs) { for (const c of await sc.searchTracks(q, 15)) { const s = matchScore(title, artist, dur, c); if (s > bs) { best = c; bs = s; } } if (bs >= 0.85) break; }
    return bs >= 0.62 ? best : null;
  }
  async function matchPending(db, sc, progress, shouldStop) {
    const pend = db.unmatchedSpotify(); let found = 0, failed = 0, errors = 0;
    for (let i = 0; i < pend.length; i++) {
      if (shouldStop()) break;
      const t = pend[i]; progress(i / Math.max(1, pend.length), `${t.artist} — ${t.title}`);
      let c;
      try { c = await findOnSoundCloud(sc, t.title, t.artist, t.duration_ms); }
      catch (e) { if (++errors >= 5) throw new Error(`Поиск остановлен: SoundCloud не отвечает. Найдено: ${found}`); await U.sleep(2000); continue; }
      errors = 0;
      if (c) { db.attachMatch(t.id, c); found++; } else { db.markMatchFailed(t.id); failed++; }
      await U.sleep(300);
    }
    progress(1, "Готово");
    return { found, failed, total: pend.length };
  }

  /* ================= тексты (LRCLIB) ================= */
  const JUNK = /\s*[([][^)\]]*(official|video|audio|lyric|visuali[sz]er|remaster|prod|feat|ft\.|hd|hq|clip|клип)[^)\]]*[)\]]/gi;
  const cleanTitle = (t) => (String(t || "").replace(JUNK, "").replace(/\s+(feat\.?|ft\.?)\s.*$/i, "").replace(/^[\s\-–—]+|[\s\-–—]+$/g, "") || t);
  function parseLrc(lrc) {
    const out = [];
    for (const raw of String(lrc || "").split("\n")) {
      const st = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)]; if (!st.length) continue;
      const text = raw.replace(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g, "").trim();
      for (const m of st) out.push({ t: Math.round((+m[1] * 60 + parseFloat(m[2].replace(":", "."))) * 1000), text });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  function pickLyrics(results, title, artist, dur) {
    let best = null, bs = -1; const nt = norm(title), na = norm(artist);
    for (const r of results || []) {
      let s = 0; const rt = norm(r.trackName || ""), ra = norm(r.artistName || "");
      if (rt === nt) s += 2; else if (nt && rt.includes(nt)) s += 1;
      if (na && (ra.includes(na) || na.includes(ra))) s += 2;
      if (dur && r.duration) { const d = Math.abs(+r.duration - dur); s += d <= 3 ? 1.5 : d <= 10 ? 0.5 : -1; }
      if (r.syncedLyrics) s += 0.7;
      if (s > bs) { best = r; bs = s; }
    }
    return bs >= 3 ? best : null;
  }
  async function fetchLyrics(title, artist, durMs) {
    const API_L = "https://lrclib.net/api", t = cleanTitle(title), dur = durMs ? Math.round(durMs / 1000) : 0, H = { "User-Agent": "Volna/0.7 (Android music player)" };
    let data = null;
    try {
      const r = await http(`${API_L}/get`, { params: { track_name: t, artist_name: artist, ...(dur ? { duration: dur } : {}) }, headers: H, type: "json" });
      if (r.status === 200) data = r.data; else if (r.status === 429 || r.status >= 500) throw new Error("База текстов сейчас перегружена — попробуй позже");
    } catch (e) { if (!(e instanceof NetError)) throw e; }
    if (!data) {
      try {
        let r = await http(`${API_L}/search`, { params: { track_name: t, artist_name: artist }, headers: H, type: "json" });
        if (r.status === 429 || r.status >= 500) throw new Error("База текстов сейчас перегружена — попробуй позже");
        if (r.status === 200) data = pickLyrics(r.data, t, artist, dur);
        if (!data) { r = await http(`${API_L}/search`, { params: { q: `${artist} ${t}` }, headers: H, type: "json" }); if (r.status === 200) data = pickLyrics(r.data, t, artist, dur); }
      } catch (e) { if (e instanceof NetError) throw new Error(`Нет связи с базой текстов: ${e.message}`); throw e; }
    }
    if (!data || typeof data !== "object") return { synced: [], plain: "", instrumental: false, found: false };
    return { synced: parseLrc(data.syncedLyrics), plain: String(data.plainLyrics || "").trim(), instrumental: !!data.instrumental, found: true };
  }

  window.VSrc = { SourceError, NotStreamable, Cache, SoundCloud, parseTrack, Yandex, ymParse, tokenFromUrl, OAUTH_URL, AUTH_MSG, importSpotifyLink, findOnSoundCloud, matchPending, fetchLyrics };
})();
