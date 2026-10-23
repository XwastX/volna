"use strict";
/* Volna Mobile — «Музыкальная ДНК» (порт volna/dna.py; коды совместимы с ПК). */
(() => {
  const { U, artistKey, b64 } = window.VP;
  const { MOODS } = window.VB;
  const PREFIX = "VOLNADNA1:";
  const ALIASES = { "hip-hop": "hip hop", hiphop: "hip hop", "hip hop & rap": "hip hop", rap: "hip hop", "русский рэп": "hip hop", rusrap: "hip hop", foreignrap: "hip hop",
    "r&b & soul": "r&b", rnb: "r&b", "electronic music": "electronic", electronica: "electronic", "lo-fi": "lofi", "lo fi": "lofi", "drum & bass": "drum and bass",
    dnb: "drum and bass", "d&b": "drum and bass", "alternative rock": "alternative", "indie rock": "indie", "indie pop": "indie", rusrock: "rock", ruspop: "pop",
    "dance & edm": "edm", dance: "edm", electro: "electronic", soundtrack: "ost", films: "ost", anime: "ost", "phonk music": "phonk", "drift phonk": "phonk",
    "post punk": "post-punk", postpunk: "post-punk", "techno music": "techno", "classical music": "classical", classicalmusic: "classical", "metal music": "metal", "trap music": "trap" };
  const LABELS = { "hip hop": "Хип-хоп", electronic: "Электроника", pop: "Поп", rock: "Рок", indie: "Инди", lofi: "Лоуфай", phonk: "Фонк", "r&b": "R&B", edm: "EDM", house: "Хаус",
    techno: "Техно", "drum and bass": "Драм-н-бэйс", metal: "Метал", jazz: "Джаз", classical: "Классика", ost: "Саундтреки", "post-punk": "Пост-панк", trap: "Трэп",
    alternative: "Альтернатива", ambient: "Эмбиент", soul: "Соул", punk: "Панк", dubstep: "Дабстеп", folk: "Фолк", country: "Кантри", reggae: "Регги", "k-pop": "K-pop",
    "j-pop": "J-pop", hyperpop: "Гиперпоп", drill: "Дрилл", disco: "Диско", funk: "Фанк", blues: "Блюз", chanson: "Шансон" };
  const ARCH = { digger: ["Искатель андеграунда", "Находишь треки раньше, чем они попадут в чарты"], omnivore: ["Всеядный исследователь", "Слушаешь всё подряд и не держишься за один жанр"],
    loyal: ["Верный фанат", "У тебя есть свои артисты, и ты им не изменяешь"], keeper: ["Хранитель классики", "Музыка прошлых десятилетий звучит у тебя чаще новинок"],
    fresh: ["Охотник за новинками", "Почти всё, что ты слушаешь, вышло недавно"], night: ["Ночной слушатель", "Главная музыка у тебя звучит после полуночи"],
    energy: ["Заряженный", "Быстрое, громкое, с басом — твоё"], calm: ["Созерцатель", "Спокойная музыка под мысли и дождь"], mainstream: ["Голос большинства", "Слушаешь то, что знают все — и это нормально"] };
  const clamp = (x) => Math.round(U.clamp(x, 0, 100));
  const genreOf = (t) => {
    let g = String(t.genre || "").trim().toLowerCase();
    if (!g) for (const m of String(t.tags || "").matchAll(/"([^"]+)"|(\S+)/g)) { g = (m[1] || m[2]).trim().toLowerCase(); if (g) break; }
    g = g.replace(/\s+/g, " "); return ALIASES[g] || g;
  };
  const label = (g) => LABELS[g] || g.charAt(0).toUpperCase() + g.slice(1);
  const normMap = (m, top) => { const total = [...m.values()].reduce((s, x) => s + x, 0) || 1; let e = [...m].sort((a, b) => b[1] - a[1]); if (top) e = e.slice(0, top); return Object.fromEntries(e.map(([k, v]) => [k, Math.round(v / total * 1e4) / 1e4])); };
  const entropy = (m) => { const v = [...m.values()].filter((x) => x > 0); if (v.length < 2) return 0; const s = v.reduce((a, b) => a + b, 0); return -v.reduce((a, x) => a + x / s * Math.log(x / s), 0) / Math.log(v.length); };
  const addTo = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

  function weights(db) {
    const evIds = new Set(db.events().map((e) => e[0])), tracks = new Map(), w = new Map();
    for (const t of db.all()) if (t.in_library || t.liked || evIds.has(t.id)) { tracks.set(t.id, t); addTo(w, t.id, (t.liked ? 3 : 0) + (t.in_library ? 1 : 0) - (t.disliked ? 6 : 0)); }
    const agg = new Map();
    for (const [tid, kind, , ms] of db.events()) { if (!tracks.has(tid) || !["complete", "skip", "history"].includes(kind)) continue; const k = `${tid}|${kind}`; const a = agg.get(k) || [0, 0]; a[0] += ms; a[1]++; agg.set(k, a); }
    for (const [k, [ms, n]] of agg) { const [tid, kind] = k.split("|"); addTo(w, +tid, kind === "skip" ? -0.3 * n : Math.min(6, ms / 180000)); }
    for (const [k, v] of [...w]) if (v <= 0) w.delete(k);
    return [w, tracks];
  }

  function compute(db, hours = null) {
    const [w, tracks] = weights(db);
    if (w.size < 5) return { empty: true, n: w.size };
    const total = [...w.values()].reduce((s, x) => s + x, 0);
    const genres = new Map(), artists = new Map(), names = {}, arts = {}, decades = new Map(), src = new Map();
    let yearsW = 0, yearSum = 0;
    const thisYear = new Date().getFullYear();
    for (const [tid, x] of w) {
      const t = tracks.get(tid), g = genreOf(t); if (g) addTo(genres, g, x);
      const k = t.artist_key || artistKey(t.artist);
      if (k) { addTo(artists, k, x); if (!names[k]) names[k] = (String(t.artist).split(/,|&| x | feat/)[0] || t.artist).trim(); if (t.artwork_url && !arts[k]) arts[k] = t.artwork_url; }
      const y = t.year || 0; if (y > 1900 && y < 2100) { addTo(decades, String(Math.floor(y / 10) * 10), x); yearSum += y * x; yearsW += x; }
      addTo(src, t.ym_id || (t.sources || "").includes("yandex") ? "Яндекс" : (t.sources || "").includes("spotify") ? "Spotify" : "SoundCloud", x);
    }
    const aSorted = [...artists].sort((a, b) => b[1] - a[1]), aTotal = [...artists.values()].reduce((s, x) => s + x, 0) || 1;
    const top5 = aSorted.slice(0, 5).reduce((s, x) => s + x[1], 0) / aTotal;
    const avgYear = yearsW ? Math.round(yearSum / yearsW) : 0, known = total ? yearsW / total : 0;
    const fresh = yearsW ? [...w].filter(([tid]) => (tracks.get(tid).year || 0) >= thisYear - 2).reduce((s, [, x]) => s + x, 0) / yearsW : 0;
    const pl = [...w].filter(([tid]) => (tracks.get(tid).plays || 0) > 0).map(([tid, x]) => [tracks.get(tid).plays, x]).sort((a, b) => a[0] - b[0]);
    let median = 0; if (pl.length) { const half = pl.reduce((s, [, x]) => s + x, 0) / 2; let acc = 0; for (const [p, x] of pl) { acc += x; if (acc >= half) { median = p; break; } } }
    const rarity = median ? clamp((7.2 - Math.log10(median + 1)) / 4.2 * 100) : null;
    const gems = [...w].filter(([tid]) => { const p = tracks.get(tid).plays || 0; return p > 0 && p < 50000; }).sort((a, b) => b[1] - a[1] || tracks.get(a[0]).plays - tracks.get(b[0]).plays).slice(0, 4);
    const moodShare = (key) => { const plus = MOODS[key].plus; let s = 0;
      for (const [tid, x] of w) { const t = tracks.get(tid); const text = ` ${genreOf(t)} ${String(t.tags || "").toLowerCase()} ${String(t.genre || "").toLowerCase()} `;
        if (plus.some((p) => new RegExp(`(?<![a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`).test(text))) s += x; }
      return s / total; };
    const energy = clamp(50 + (moodShare("energetic") - moodShare("calm")) * 120);
    const diversity = clamp(entropy(artists) * 70 + entropy(genres) * 30);
    const fair = artists.size ? Math.min(1, 5 / artists.size) : 1;
    const loyalty = fair < 1 ? clamp((top5 - fair) / (1 - fair) * 160) : 50;
    const hrs = hours || new Array(24).fill(0), hsum = hrs.reduce((s, x) => s + x, 0) || 1;
    const night = [0, 1, 2, 3, 4, 23].reduce((s, h) => s + hrs[h], 0) / hsum, morning = [5, 6, 7, 8, 9, 10].reduce((s, h) => s + hrs[h], 0) / hsum;
    const chrono = hrs.some((x) => x) ? (night > 0.28 ? "Сова" : morning > 0.35 ? "Жаворонок" : "Дневной") : "";
    const traits = { digger: rarity != null && rarity > 60 ? rarity / 100 * 1.1 : 0, omnivore: diversity > 70 ? diversity / 100 : 0, loyal: loyalty > 55 ? loyalty / 100 : 0,
      keeper: avgYear && thisYear - avgYear > 12 && known > 0.2 ? Math.min(1, (thisYear - avgYear) / 25) : 0, fresh: fresh > 0.55 && known > 0.2 ? fresh : 0,
      night: night > 0.3 ? night * 1.6 : 0, energy: energy > 68 ? energy / 100 : 0, calm: energy < 32 ? (100 - energy) / 100 : 0, mainstream: rarity != null && rarity < 30 ? (100 - rarity) / 100 * 0.9 : 0 };
    let ranked = Object.entries(traits).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    if (!ranked.length) ranked = ["omnivore"];
    const [main, second] = ranked;
    return {
      empty: false, n: w.size,
      archetype: { key: main, title: ARCH[main][0], text: ARCH[main][1], second: second ? ARCH[second][0] : "" },
      genres: Object.entries(normMap(genres, 8)).map(([k, v]) => ({ key: k, label: label(k), share: v })),
      artists: aSorted.slice(0, 8).map(([k, v]) => ({ key: k, name: names[k] || k, art: arts[k] || "", share: Math.round(v / aTotal * 1e4) / 1e4 })),
      decades: Object.entries(normMap(decades)).sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ label: `${d}-е`, share: v })),
      avgYear, knownYears: Math.round(known * 100) / 100, rarity, medianPlays: median,
      gems: gems.map(([tid]) => { const t = tracks.get(tid); return { id: tid, title: t.title, artist: t.artist, art: t.artwork_url, plays: t.plays }; }),
      diversity, loyalty, energy, chrono, sources: Object.entries(normMap(src)).map(([k, v]) => ({ label: k, share: v })), artistsTotal: artists.size,
      _artists: Object.fromEntries(aSorted.slice(0, 80).map(([k, v]) => [k, Math.round(v / total * 1e5) / 1e5])), _names: Object.fromEntries(aSorted.slice(0, 80).map(([k]) => [k, names[k] || k])),
      _genres: normMap(genres, 25), _decades: normMap(decades),
    };
  }
  const rarityLabel = (r) => (r == null ? "Пока неизвестно" : r >= 80 ? "Глубокий андеграунд" : r >= 60 ? "Андеграунд" : r >= 40 ? "Между нишей и мейнстримом" : r >= 20 ? "Популярное" : "Мейнстрим");
  function pub(d) { const o = {}; for (const [k, v] of Object.entries(d)) if (!k.startsWith("_")) o[k] = v; if (!d.empty) o.rarityLabel = rarityLabel(d.rarity); return o; }

  async function pack(d, name = "") {
    if (d.empty) throw new Error("Пока мало данных — послушай и полайкай треки, потом делись ДНК");
    const payload = { v: 1, n: String(name || "").slice(0, 40), t: d.archetype.key, a: Object.entries(d._artists).map(([k, v]) => [k, String(d._names[k] || k).slice(0, 60), v]),
      g: d._genres, e: d._decades, r: d.rarity, dv: d.diversity, en: d.energy };
    const raw = new TextEncoder().encode(JSON.stringify(payload));
    const out = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    return PREFIX + b64.url(out);
  }
  async function unpack(code) {
    code = String(code || "").replace(/\s+/g, "");
    if (!code.startsWith(PREFIX)) throw new Error("Это не код ДНК Volna — он начинается с VOLNADNA1:");
    let data;
    try { data = JSON.parse(await new Response(new Blob([b64.fromUrl(code.slice(PREFIX.length))]).stream().pipeThrough(new DecompressionStream("deflate"))).text()); }
    catch (_) { throw new Error("Код ДНК повреждён — скопируй его целиком"); }
    if (!data || !Array.isArray(data.a)) throw new Error("Код ДНК повреждён");
    const artists = {}, names = {};
    for (const it of data.a.slice(0, 120)) if (Array.isArray(it) && it.length === 3 && typeof it[0] === "string" && isFinite(+it[2])) { artists[it[0].slice(0, 80)] = +it[2]; names[it[0].slice(0, 80)] = String(it[1]).slice(0, 60); }
    const fd = (x) => { const o = {}; if (x && typeof x === "object") for (const [k, v] of Object.entries(x).slice(0, 60)) if (isFinite(+v)) o[String(k).slice(0, 40)] = +v; return o; };
    return { name: String(data.n || "").slice(0, 40), type: String(data.t || ""), artists, names, genres: fd(data.g), decades: fd(data.e) };
  }
  const cos = (a, b) => { const keys = new Set([...Object.keys(a), ...Object.keys(b)]); if (!keys.size) return 0; let dot = 0; for (const k of keys) dot += (a[k] || 0) * (b[k] || 0);
    const na = Math.sqrt(Object.values(a).reduce((s, v) => s + v * v, 0)), nb = Math.sqrt(Object.values(b).reduce((s, v) => s + v * v, 0)); return na && nb ? dot / (na * nb) : 0; };
  async function compare(mine, code) {
    if (mine.empty) throw new Error("Сначала нужно немного послушать музыку здесь — пока твоя ДНК пустая");
    const o = await unpack(code);
    const aS = cos(mine._artists, o.artists), gS = cos(mine._genres, o.genres);
    const eS = Object.keys(mine._decades).length && Object.keys(o.decades).length ? cos(mine._decades, o.decades) : gS;
    const score = clamp((Math.sqrt(aS) * 0.45 + gS * 0.4 + eS * 0.15) * 100);
    const common = Object.keys(mine._artists).filter((k) => k in o.artists).sort((a, b) => (mine._artists[b] + o.artists[b]) - (mine._artists[a] + o.artists[a]));
    const theirs = Object.keys(o.artists).sort((a, b) => o.artists[b] - o.artists[a]).filter((k) => !(k in mine._artists));
    const cg = Object.keys(mine._genres).filter((k) => k in o.genres).sort((a, b) => (mine._genres[b] + o.genres[b]) - (mine._genres[a] + o.genres[a]));
    const verdict = score >= 80 ? "Музыкальные близнецы" : score >= 60 ? "Очень похожий вкус" : score >= 40 ? "Есть общее" : score >= 20 ? "Разные миры, но пересечения есть" : "Полные противоположности";
    return { name: o.name || "Друг", score, verdict, type: (ARCH[o.type] || [""])[0], common: common.slice(0, 10).map((k) => mine._names[k] || o.names[k] || k),
      commonGenres: cg.slice(0, 6).map(label), discover: theirs.slice(0, 8).map((k) => ({ key: k, name: o.names[k] || k })),
      parts: { artists: clamp(Math.sqrt(aS) * 100), genres: clamp(gS * 100), eras: clamp(eS * 100) } };
  }
  async function backfill(db, sc, limit = 400) {
    const ev = new Set(db.events().map((e) => e[0]));
    const rows = db.all().filter((t) => t.sc_id && (t.plays == null || t.year == null) && (t.liked || t.in_library || ev.has(t.id)) && t.playable !== 0).slice(0, limit);
    if (!rows.length) return 0;
    const got = await sc.tracksByIds(rows.map((t) => t.sc_id)), seen = new Set();
    for (const s of got) { seen.add(s.sc_id); const t = db.row(db.bySc.get(s.sc_id)); if (t) { t.year = s.year || 0; t.plays = s.playback_count || 0; } }
    for (const t of rows) if (!seen.has(t.sc_id)) { const r = db.row(t.id); if (r) { if (r.year == null) r.year = 0; if (r.plays == null) r.plays = 0; } }
    db.touch(); return got.length;
  }
  window.VDna = { compute, pub, pack, compare, backfill };
})();
