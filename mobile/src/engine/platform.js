"use strict";
(() => {
/* Volna Mobile — платформа: сеть, файлы, системные плагины Capacitor и мелкие утилиты.
   На телефоне всё идёт через нативные плагины (без CORS и с файлами на диске),
   в обычном браузере (для тестов) — через fetch и IndexedDB. */

const Cap = window.Capacitor || null;
const NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plugin = (name) => (NATIVE && Cap.registerPlugin ? Cap.registerPlugin(name) : null);
const P = {
  Http: NATIVE ? (window.capacitorExports && window.capacitorExports.CapacitorHttp) || plugin("CapacitorHttp") : null,
  FS: plugin("Filesystem"),
  App: plugin("App"),
  StatusBar: plugin("StatusBar"),
  Splash: plugin("SplashScreen"),
  Media: plugin("MediaSession"),
  Browser: plugin("InAppBrowser"),
  Clipboard: plugin("Clipboard"),
};

/* ---------------- утилиты ---------------- */
const U = {
  now: () => Date.now() / 1000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  clamp: (x, a, b) => Math.max(a, Math.min(b, x)),
  shuffle(a, rnd = Math.random) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
  gauss(rnd = Math.random) { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
  seeded(seed) {   // mulberry32 от строки
    let h = 1779033703 ^ String(seed).length;
    for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  },
  weighted(items, weights, rnd = Math.random) {
    const total = weights.reduce((s, w) => s + w, 0); let r = rnd() * total;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  },
  uid: () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join(""),
  day: (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
};

const FEAT_RE = /(?:\s+|\s*[([]\s*)(?:feat\.?|ft\.?|featuring|prod\.?(?: by)?)\s.*$/i;
function norm(text) {
  let t = String(text || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ё/g, "е");
  t = t.replace(FEAT_RE, "");
  t = t.replace(/[^\p{L}\p{N}_\s]/gu, " ");
  return t.replace(/\s+/g, " ").trim();
}
function artistKey(artist) {
  const first = String(artist || "").split(/,|&| x | и | and |;|\//i)[0];
  return norm(first);
}
/* похожесть строк как difflib.SequenceMatcher.ratio (Ратклифф—Обершелп) */
function seqRatio(a, b) {
  if (!a.length && !b.length) return 1;
  const matches = (s1, s2) => {
    if (!s1 || !s2) return 0;
    let best = 0, bi = 0, bj = 0;
    const prev = new Array(s2.length + 1).fill(0);
    for (let i = 1; i <= s1.length; i++) {
      let diag = 0;
      for (let j = 1; j <= s2.length; j++) {
        const tmp = prev[j];
        prev[j] = s1[i - 1] === s2[j - 1] ? diag + 1 : 0;
        if (prev[j] > best) { best = prev[j]; bi = i - best; bj = j - best; }
        diag = tmp;
      }
    }
    if (!best) return 0;
    return best + matches(s1.slice(0, bi), s2.slice(0, bj)) + matches(s1.slice(bi + best), s2.slice(bj + best));
  };
  return (2 * matches(a, b)) / (a.length + b.length);
}

/* ---------------- криптография ---------------- */
function md5(str) {
  const bytes = new TextEncoder().encode(str);
  const k = [], s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const len = bytes.length, nblk = ((len + 8) >> 6) + 1, w = new Uint32Array(nblk * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
  w[len >> 2] |= 0x80 << ((len % 4) * 8);
  w[nblk * 16 - 2] = (len * 8) >>> 0; w[nblk * 16 - 1] = Math.floor(len / 0x20000000);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let blk = 0; blk < nblk; blk++) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g; const r = Math.floor(i / 16);
      if (r === 0) { f = (b & c) | (~b & d); g = i; }
      else if (r === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (r === 2) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d; d = c; c = b;
      const x = (a + f + k[i] + w[blk * 16 + g]) >>> 0, sh = s[r * 4 + (i % 4)];
      b = (b + ((x << sh) | (x >>> (32 - sh)))) >>> 0; a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((v) => Array.from({ length: 4 }, (_, i) => ((v >>> (i * 8)) & 255).toString(16).padStart(2, "0")).join("")).join("");
}
const b64 = {
  fromBytes(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  toBytes(str) { const bin = atob(str); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; },
  url(u8) { return b64.fromBytes(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  fromUrl(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); return b64.toBytes(s + "=".repeat((4 - (s.length % 4)) % 4)); },
};
async function hmacSha256B64(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64.fromBytes(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg))));
}
async function pbkdf2Hex(password, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, k, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

/* ---------------- сеть ---------------- */
class NetError extends Error {}
/* type: text | json | binary (вернёт base64) */
async function http(url, { method = "GET", headers = {}, params = null, data = null, type = "text", timeout = 20000 } = {}) {
  if (params) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
    if (q) url += (url.includes("?") ? "&" : "?") + q;
  }
  if (P.Http) {
    let r;
    try {
      r = await P.Http.request({ url, method, headers, data: data ?? undefined, responseType: type === "binary" ? "arraybuffer" : type === "json" ? "json" : "text",
        connectTimeout: timeout, readTimeout: timeout });
    } catch (e) { throw new NetError(`Нет связи: ${e.message || e}`); }
    let body = r.data;
    if (type === "json" && typeof body === "string") { try { body = JSON.parse(body); } catch (_) { /* не JSON */ } }
    return { status: r.status, data: body, headers: r.headers || {}, url: r.url || url };
  }
  /* браузер (тесты): обычный fetch */
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
  let res;
  try { res = await fetch(url, { method, headers, body: data ?? undefined, signal: ctl.signal }); }
  catch (e) { throw new NetError(`Нет связи: ${e.message || e}`); }
  finally { clearTimeout(tm); }
  let body;
  if (type === "binary") body = b64.fromBytes(new Uint8Array(await res.arrayBuffer()));
  else if (type === "json") { const t = await res.text(); try { body = JSON.parse(t); } catch (_) { body = t; } }
  else body = await res.text();
  const hs = {}; res.headers.forEach((v, k) => { hs[k] = v; });
  return { status: res.status, data: body, headers: hs, url: res.url || url };
}

/* ---------------- файлы ----------------
   Пути относительные: «a/b.json». DATA — данные аккаунтов (не чистится системой),
   CACHE — звук (Android может почистить сам, это нормально). */
const DIR = { DATA: "DATA", CACHE: "CACHE" };
const webStore = (() => {   // IndexedDB-шим для браузера
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((ok, bad) => {
    const r = indexedDB.open("volna-fs", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("f");
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((ok, bad) => { const t = db.transaction("f", mode); const st = t.objectStore("f"); const req = fn(st); t.oncomplete = () => ok(req && req.result); t.onerror = () => bad(t.error); }); };
  return {
    get: (k) => tx("readonly", (s) => s.get(k)),
    put: (k, v) => tx("readwrite", (s) => s.put(v, k)),
    del: (k) => tx("readwrite", (s) => s.delete(k)),
    keys: () => tx("readonly", (s) => s.getAllKeys()),
  };
})();
const fsDir = (d) => (d === DIR.CACHE ? "CACHE" : "DATA");
const FS = {
  async readText(path, dir = DIR.DATA) {
    if (P.FS) { try { return (await P.FS.readFile({ path, directory: fsDir(dir), encoding: "utf8" })).data; } catch (_) { return null; } }
    const v = await webStore.get(`${dir}/${path}`); return v == null ? null : v.text ?? null;
  },
  async writeText(path, text, dir = DIR.DATA) {
    if (P.FS) { await P.FS.writeFile({ path, data: text, directory: fsDir(dir), encoding: "utf8", recursive: true }); return; }
    await webStore.put(`${dir}/${path}`, { text });
  },
  async writeB64(path, data, dir = DIR.CACHE) {
    if (P.FS) { await P.FS.writeFile({ path, data, directory: fsDir(dir), recursive: true }); return; }
    await webStore.put(`${dir}/${path}`, { b64: [data] });
  },
  async appendB64(path, data, dir = DIR.CACHE) {
    if (P.FS) { await P.FS.appendFile({ path, data, directory: fsDir(dir) }); return; }
    const v = (await webStore.get(`${dir}/${path}`)) || { b64: [] }; v.b64.push(data); await webStore.put(`${dir}/${path}`, v);
  },
  async download(url, path, dir = DIR.CACHE, headers = {}, onProgress = null) {
    if (P.FS) {
      let h = null;
      if (onProgress && P.FS.addListener) h = await P.FS.addListener("progress", (p) => { if (p.url === url && p.contentLength) onProgress(p.bytes / p.contentLength); });
      try { await P.FS.downloadFile({ url, path, directory: fsDir(dir), headers, recursive: true, progress: !!onProgress }); }
      catch (e) { throw new NetError(`Не удалось скачать: ${e.message || e}`); }
      finally { if (h) h.remove(); }
      return;
    }
    const r = await http(url, { headers, type: "binary", timeout: 60000 });
    if (r.status >= 400) throw new NetError(`Сервер ответил ${r.status}`);
    await FS.writeB64(path, r.data, dir);
  },
  async size(path, dir = DIR.CACHE) {
    if (P.FS) { try { return (await P.FS.stat({ path, directory: fsDir(dir) })).size || 0; } catch (_) { return 0; } }
    const v = await webStore.get(`${dir}/${path}`); if (!v) return 0;
    return v.text != null ? v.text.length : v.b64.reduce((s, x) => s + Math.floor(x.length * 3 / 4), 0);
  },
  async exists(path, dir = DIR.DATA) { return (await FS.size(path, dir)) > 0; },
  async remove(path, dir = DIR.CACHE) {
    if (P.FS) { try { await P.FS.deleteFile({ path, directory: fsDir(dir) }); } catch (_) { /* нет файла */ } return; }
    await webStore.del(`${dir}/${path}`);
  },
  async rmdir(path, dir = DIR.DATA) {
    if (P.FS) { try { await P.FS.rmdir({ path, directory: fsDir(dir), recursive: true }); } catch (_) { /* */ } return; }
    for (const k of await webStore.keys()) if (k.startsWith(`${dir}/${path}/`)) await webStore.del(k);
  },
  async copy(from, fromDir, to, toDir) {
    if (P.FS) { await P.FS.copy({ from, directory: fsDir(fromDir), to, toDirectory: fsDir(toDir) }); return; }
    const v = await webStore.get(`${fromDir}/${from}`); if (v) await webStore.put(`${toDir}/${to}`, v);
  },
  async list(path, dir = DIR.CACHE) {
    if (P.FS) { try { return (await P.FS.readdir({ path, directory: fsDir(dir) })).files.map((f) => ({ name: f.name, size: f.size || 0, mtime: f.mtime || 0 })); } catch (_) { return []; } }
    const out = [];
    for (const k of await webStore.keys()) if (k.startsWith(`${dir}/${path}/`)) out.push({ name: k.slice(`${dir}/${path}/`.length), size: await FS.size(k.slice(dir.length + 1), dir), mtime: 0 });
    return out;
  },
  /* адрес файла для <audio> */
  async src(path, dir = DIR.CACHE) {
    if (P.FS) { const { uri } = await P.FS.getUri({ path, directory: fsDir(dir) }); return Cap.convertFileSrc(uri); }
    const v = await webStore.get(`${dir}/${path}`); if (!v) return "";
    const parts = v.b64.map((x) => b64.toBytes(x));
    const ext = path.split(".").pop();
    const type = { mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", aac: "audio/aac", ts: "video/mp2t", flac: "audio/flac" }[ext] || "audio/mpeg";
    return URL.createObjectURL(new Blob(parts, { type }));
  },
};

/* ---------------- буфер обмена ---------------- */
const Clip = {
  async get() { try { if (P.Clipboard) return (await P.Clipboard.read()).value || ""; return await navigator.clipboard.readText(); } catch (_) { return ""; } },
  async set(text) { try { if (P.Clipboard) await P.Clipboard.write({ string: text }); else await navigator.clipboard.writeText(text); return true; } catch (_) { return false; } },
};

window.VP = { Cap, NATIVE, P, U, norm, artistKey, seqRatio, md5, b64, hmacSha256B64, pbkdf2Hex, timingSafeEq, http, NetError, FS, DIR, Clip };
})();
