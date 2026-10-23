"use strict";
/* Volna — общее: связь с Python, состояние, компоненты (обложки, карточки, списки, меню, диалоги). */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const svg = (name) => `<svg class="i" viewBox="0 0 24 24">${window.ICONS[name] || ""}</svg>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
const nTracks = (n) => `${n} ${plural(n, "трек", "трека", "треков")}`;
const nMin = (ms) => { const m = Math.round((ms || 0) / 60000); return `${m.toLocaleString("ru")} ${plural(m, "минута", "минуты", "минут")}`; };
const totalDur = (rows) => { const m = Math.round(rows.reduce((s, t) => s + (t.dur || 0), 0) / 60000); return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`; };
function icons(root = document) { $$("i[data-i]", root).forEach((el) => { el.outerHTML = svg(el.dataset.i); }); }

/* ---------------- связь с Python ---------------- */
let backend = null, rid = 0;
const pending = new Map();
const handlers = {};
function call(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rid;
    pending.set(id, { resolve, reject });
    backend.call(id, method, JSON.stringify(args));
  });
}
function onReply(id, json) {
  const p = pending.get(id); if (!p) return;
  pending.delete(id);
  const r = JSON.parse(json);
  r.ok ? p.resolve(r.data) : p.reject(new Error(r.error || "Ошибка"));
}
function onEvent(name, json) { (handlers[name] || []).forEach((h) => h(JSON.parse(json))); }
function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); }
function connect(ready) {
  if (window.__MOCK_API__) { backend = window.__MOCK_API__(onReply, onEvent); ready(); return; }
  new QWebChannel(qt.webChannelTransport, (ch) => {
    backend = ch.objects.api;
    backend.reply.connect(onReply);
    backend.event.connect(onEvent);
    ready();
  });
}

/* ---------------- расширения ---------------- */
const PAGES = {};          // страницы: PAGES.имя = async (page, arg, alive) => {...}
const READY = [];          // функции, которые вызываются после подключения к Python: READY.push((init) => ...)

/* ---------------- состояние ---------------- */
const S = {
  track: null, playing: false, loading: false, pos: 0, dur: 0, posAt: 0,
  queue: { wave: false, items: [], user: [], next: [] }, ctx: "",
  mode: "mix", modes: [], moods: [], playlists: [], volume: 70, energy: 0.3, tint: "#a8bcff",
  offline: false,
};
const bus = new EventTarget();
const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
const listen = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

/* ---------------- уведомления ---------------- */
function toast(text, kind = "info", ms = 3200) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 260); }, ms);
}
const fail = (e) => toast(e.message || String(e), "error", 6500);

/* ---------------- обложки ---------------- */
function cover(url, cls = "") {
  const img = url ? `<img src="${esc(url)}" loading="lazy" onload="this.classList.add('ok')" onerror="this.remove()">` : "";
  return `<div class="cover ${cls}"><span class="ph">${svg("music")}</span>${img}</div>`;
}
function mosaic(arts, cls = "") {
  const a = (arts || []).filter(Boolean);
  if (a.length < 4) return `<div class="mosaic one ${cls}">${cover(a[0] || "")}</div>`;
  return `<div class="mosaic ${cls}">${a.slice(0, 4).map((u) => cover(u)).join("")}</div>`;
}
const likedCover = (cls = "") => `<div class="liked-cover ${cls}">${svg("heart")}</div>`;
function setCover(el, url) {
  el.innerHTML = `<span class="ph">${svg("music")}</span>` + (url ? `<img src="${esc(url)}" onload="this.classList.add('ok')" onerror="this.remove()">` : "");
}
const big = (u) => (u || "").replace("-t300x300.", "-t500x500.");

/* цвет обложки для фона страницы (если картинка доступна для чтения) */
const colorCache = new Map();
function pageTintFrom(url, fallback) {
  const set = (c) => document.documentElement.style.setProperty("--page-tint", c);
  set(fallback || "var(--tint)");
  if (!url || url.startsWith("data:") === false && !url.startsWith("http")) return;
  if (colorCache.has(url)) { set(colorCache.get(url)); return; }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 16;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      let best = null, bw = -1;
      for (let i = 0; i < d.length; i += 4) {
        const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), s = mx ? (mx - mn) / mx : 0, v = mx / 255;
        const w = s * s * (0.3 + v);
        if (v > 0.2 && w > bw) { bw = w; best = [r, gg, b]; }
      }
      if (best) { const col = `rgb(${best.join(",")})`; colorCache.set(url, col); set(col); }
    } catch (_) { /* картинка без CORS — оставляем цвет по умолчанию */ }
  };
  img.src = url;
}

/* ---------------- воспроизведение ---------------- */
function playRows(rows, index = 0, ctx = "") {
  const ok = rows.filter((x) => !x.missing);
  if (!ok.length) { toast("Здесь нечего играть"); return; }
  const t = rows[index];
  const start = t ? Math.max(0, ok.indexOf(t)) : 0;
  return call("play", { ids: ok.map((x) => x.id), index: start, context: ctx }).catch(fail);
}
function shuffleRows(rows, ctx = "") {
  const ok = rows.filter((x) => !x.missing).slice();
  for (let i = ok.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ok[i], ok[j]] = [ok[j], ok[i]]; }
  return playRows(ok, 0, ctx);
}
function startWave(opts = {}) {
  emit("wave-busy", true);
  return call("wave", opts).then((r) => {
    if (r.cold) { toast("Волне пока не на что опереться — выбери настроение или добавь музыку"); emit("wave-cold"); }
    return r;
  }).catch(fail).finally(() => emit("wave-busy", false));
}
const isCurrent = (t) => S.track && t && S.track.id === t.id;

/* лайки синхронно везде */
function setLike(t, liked, btn) {
  return call("like", { id: t.id, liked }).then(() => {
    t.liked = liked;
    $$(`[data-like-id="${t.id}"]`).forEach((b) => { b.classList.toggle("on", liked); pop(b); });
    if (btn) pop(btn);
    if (isCurrent(t)) { S.track.liked = liked; emit("track-like", liked); }
    toast(liked ? "Добавлено в «Любимые треки»" : "Удалено из «Любимых треков»", "info", 2200);
    emit("library-changed");
  }).catch(fail);
}
function pop(b) { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); }

/* ---------------- контекстное меню ---------------- */
let menuEl = null, subEl = null;
function closeMenu() { menuEl?.remove(); subEl?.remove(); menuEl = subEl = null; }
function placeMenu(el, x, y) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  el.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
}
function buildMenu(items) {
  const el = document.createElement("div");
  el.className = "menu";
  el.innerHTML = items.map((it, i) => it === "-" ? "<hr>" : it.html ? it.html :
    `<button data-m="${i}" class="${it.danger ? "danger" : ""}">${it.icon ? svg(it.icon) : ""}<span>${esc(it.label)}</span>${it.sub ? `<span class="arr">${svg("chevron-right")}</span>` : ""}</button>`).join("");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]"); if (!b) return;
    const it = items[+b.dataset.m];
    if (it.sub) { e.stopPropagation(); return; }
    closeMenu(); it.run?.();
  });
  el.addEventListener("mouseover", (e) => {
    const b = e.target.closest("[data-m]"); if (!b || el !== menuEl) return;
    const it = items[+b.dataset.m];
    $$("button.open", el).forEach((x) => x.classList.remove("open"));
    subEl?.remove(); subEl = null;
    if (it.sub) {
      b.classList.add("open");
      subEl = buildMenu(it.sub());
      const r = b.getBoundingClientRect();
      placeMenu(subEl, r.right + 2, r.top - 4);
      if (subEl.getBoundingClientRect().left < r.right) subEl.style.left = (r.left - subEl.offsetWidth - 2) + "px";
    }
  });
  return el;
}
function openMenu(x, y, items) {
  closeMenu();
  menuEl = buildMenu(items);
  placeMenu(menuEl, x, y);
}
addEventListener("mousedown", (e) => { if (menuEl && !e.target.closest(".menu")) closeMenu(); });
addEventListener("blur", closeMenu);
addEventListener("resize", closeMenu);

function playlistSubmenu(t) {
  const own = S.playlists.filter((p) => p.source === "local");
  return [
    { icon: "plus", label: "Новый плейлист", run: () => createPlaylist(t) },
    ...(own.length ? ["-"] : []),
    ...own.map((p) => ({ label: p.name, run: () => call("playlist_add", { pid: p.id, id: t.id })
      .then((added) => { toast(added ? `Добавлено в «${p.name}»` : `Уже есть в «${p.name}»`); emit("playlists-changed"); }).catch(fail) })),
  ];
}
function trackMenu(t, extra = []) {
  const items = [
    { icon: "list-start", label: "Играть следующим", run: () => call("play_next", { id: t.id }).then(() => toast("Сыграет следующим")) },
    { icon: "list-plus", label: "Добавить в очередь", run: () => call("enqueue", { id: t.id }).then(() => toast("Добавлено в очередь")) },
    "-",
    { icon: "plus", label: "Добавить в плейлист", sub: () => playlistSubmenu(t) },
    { icon: "heart", label: t.liked ? "Убрать из «Любимых»" : "Добавить в «Любимые»", run: () => setLike(t, !t.liked) },
    t.off ? { icon: "trash-2", label: "Удалить из скачанного", run: () => call("offline_remove", { ids: [t.id] }).then(() => { t.off = false; toast("Удалено из скачанного"); emit("offline-changed"); }).catch(fail) }
      : { icon: "circle-arrow-down", label: "Скачать для офлайна", run: () => call("offline_add", { ids: [t.id] }).then(() => toast("Скачиваю…")).catch(fail) },
    "-",
    { icon: "radio", label: "Волна по треку", run: () => { go("wave"); startWave({ from_id: t.id }); } },
    { icon: "user", label: "Перейти к артисту", run: () => go("artist", t.ak) },
    ...extra,
  ];
  if (t.url) items.push("-", { icon: "external-link", label: "Открыть на SoundCloud", run: () => call("open_url", { url: t.url }) });
  return items;
}

/* ---------------- диалоги ---------------- */
function dialog({ title, text = "", value = null, ok = "Сохранить", danger = false }) {
  return new Promise((resolve) => {
    const m = $("#modal");
    m.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}
      ${value !== null ? `<div class="field"><input id="dlg-in" value="${esc(value)}" maxlength="100"></div>` : ""}
      <div class="btns"><button class="btn ghost" data-r="0">Отмена</button><button class="btn white" data-r="1">${esc(ok)}</button></div></div>`;
    m.classList.add("on");
    const inp = $("#dlg-in");
    if (inp) { inp.focus(); inp.select(); }
    const done = (r) => { m.classList.remove("on"); m.innerHTML = ""; resolve(r ? (inp ? inp.value.trim() : true) : null); };
    m.onclick = (e) => { if (e.target === m) done(false); const b = e.target.closest("[data-r]"); if (b) done(b.dataset.r === "1"); };
    m.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
  });
}
async function createPlaylist(addTrack) {
  const name = await dialog({ title: "Новый плейлист", value: `Мой плейлист №${S.playlists.filter((p) => p.source === "local").length + 1}`, ok: "Создать" });
  if (name === null) return;
  const pid = await call("playlist_create", { name: name || "Новый плейлист", add: addTrack ? addTrack.id : null }).catch(fail);
  if (!pid) return;
  toast(addTrack ? `Плейлист создан, трек добавлен` : "Плейлист создан");
  emit("playlists-changed");
  if (!addTrack) go("playlist", pid);
}

/* ---------------- карточки ---------------- */
function card({ art, title, sub, round = false, mosaicArts = null, liked = false, label = "", data = "" }) {
  const pic = liked ? likedCover() : mosaicArts ? mosaic(mosaicArts) : cover(art, round ? "round" : "");
  return `<button class="card${round ? " artist" : ""}" ${data}>
    <div class="art-wrap">${pic}${label ? `<div class="mix-label">${esc(label)}</div>` : ""}
      <span class="play-fab hover-play" data-play>${svg("play")}</span></div>
    <div class="t">${esc(title)}</div><div class="a">${esc(sub || "")}</div></button>`;
}
function section(title, sub, inner, opts = {}) {
  const id = "c" + Math.random().toString(36).slice(2, 8);
  return `<section class="sec"><div class="sec-head"><h2>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}</h2>
    ${opts.more ? `<a class="more" data-go="${opts.more}">Показать все</a>` : ""}
    ${opts.carousel !== false ? `<div class="arrows"><button data-scroll="${id}" data-dir="-1">${svg("chevron-left")}</button><button data-scroll="${id}" data-dir="1">${svg("chevron-right")}</button></div>` : ""}
    </div>${opts.carousel === false ? inner : `<div class="carousel" id="${id}">${inner}</div>`}</section>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-scroll]"); if (!b) return;
  const c = document.getElementById(b.dataset.scroll);
  c.scrollBy({ left: +b.dataset.dir * c.clientWidth * 0.9 });
});

/* ---------------- список треков ---------------- */
const CHUNK = 120;
function trackRow(t, i, opts) {
  const tags = (t.off ? `<span class="tag off" title="Скачан — играет без интернета">${svg("circle-arrow-down")}</span>` : "") + (t.ym ? `<span class="tag ym">Яндекс</span>` : "") + (t.sp ? `<span class="tag sp">Spotify</span>` : "") + (t.sc && !t.sp && !t.ym ? `<span class="tag sc">SoundCloud</span>` : "") +
    (t.missing ? `<span class="tag">нет на SC</span>` : "");
  return `<div class="tr${isCurrent(t) ? " playing" : ""}${t.missing ? " missing" : ""}${S.offline && !t.off ? " noff" : ""}" data-i="${i}" data-id="${t.id}"${opts.drag ? ' draggable="true"' : ""}>
    <div class="n"><span class="num">${i + 1}</span><span class="pl">${svg("play")}</span><span class="eq"><i></i><i></i><i></i></span></div>
    <div class="main-cell">${opts.noCover ? "" : cover(t.art)}<div><div class="t">${esc(t.title)}</div>
      <div class="a"><a data-artist="${esc(t.ak)}">${esc(t.artist)}</a></div></div></div>
    <div class="tags tags-cell">${tags}</div>
    <div class="d">${fmt(t.dur)}</div>
    <div class="acts"><button class="icon-btn heart${t.liked ? " on" : ""}" data-like data-like-id="${t.id}" title="Нравится">${svg("heart")}</button>
      <button class="icon-btn more" data-more title="Ещё">${svg("ellipsis")}</button></div>
  </div>`;
}
/* rows — треки; opts: ctx (подпись «играет из»), drag (перестановка), onReorder(ids), menuExtra(t), third(t), head */
function trackList(el, rows, opts = {}) {
  el.classList.add("tracks");
  el._rows = rows; el._opts = opts; el._shown = 0;
  el.innerHTML = opts.head === false ? "" : `<div class="tr head"><div class="n">#</div><div>Название</div><div class="tags-cell">Источник</div><div class="d">${svg("clock-3")}</div><div></div></div>`;
  moreRows(el);
  if (el._wired) return;
  el._wired = true;
  const scroller = $("#view");
  const onScroll = () => { if (el.isConnected && scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 700) moreRows(el); };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".tr[data-i]"); if (!row || e.target.closest("button,a")) return;
    play(+row.dataset.i);
  });
  const play = (i) => {
    const t = el._rows[i];
    if (t.missing) { toast("Этого трека нет на SoundCloud"); return; }
    if (isCurrent(t)) { call("toggle"); return; }
    playRows(el._rows, i, el._opts.ctx || "");
  };
  el.addEventListener("click", (e) => {
    const row = e.target.closest(".tr[data-i]"); if (!row) return;
    const t = el._rows[+row.dataset.i];
    const a = e.target.closest("[data-artist]");
    if (a) { go("artist", a.dataset.artist); return; }
    if (e.target.closest("[data-like]")) { setLike(t, !t.liked, e.target.closest("[data-like]")); return; }
    if (e.target.closest("[data-more]")) { const r = e.target.closest("[data-more]").getBoundingClientRect(); openMenu(r.left - 200, r.bottom + 4, trackMenu(t, el._opts.menuExtra ? el._opts.menuExtra(t) : [])); return; }
    if (e.target.closest(".n")) play(+row.dataset.i);
  });
  el.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".tr[data-i]"); if (!row) return;
    e.preventDefault();
    const t = el._rows[+row.dataset.i];
    openMenu(e.clientX, e.clientY, trackMenu(t, el._opts.menuExtra ? el._opts.menuExtra(t) : []));
  });
  /* перетаскивание: в плейлист слева или перестановка внутри своего плейлиста */
  el.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".tr[data-i]"); if (!row) return;
    const t = el._rows[+row.dataset.i];
    e.dataTransfer.setData("text/volna-track", String(t.id));
    e.dataTransfer.setData("text/volna-index", row.dataset.i);
    e.dataTransfer.effectAllowed = "copyMove";
    row.classList.add("dragging");
    el._dragI = +row.dataset.i;
  });
  el.addEventListener("dragend", () => { $$(".dragging,.over", el).forEach((x) => x.classList.remove("dragging", "over")); el._dragI = null; });
  el.addEventListener("dragover", (e) => {
    if (!el._opts.onReorder || el._dragI == null) return;
    const row = e.target.closest(".tr[data-i]"); if (!row) return;
    e.preventDefault();
    $$(".over", el).forEach((x) => x.classList.remove("over"));
    row.classList.add("over");
  });
  el.addEventListener("drop", (e) => {
    if (!el._opts.onReorder || el._dragI == null) return;
    const row = e.target.closest(".tr[data-i]"); if (!row) return;
    e.preventDefault();
    const from = el._dragI, to = +row.dataset.i;
    if (from === to) return;
    const rows2 = el._rows.slice();
    rows2.splice(to, 0, rows2.splice(from, 1)[0]);
    el._opts.onReorder(rows2.map((x) => x.id));
    trackList(el, rows2, el._opts);
  });
}
function moreRows(el) {
  const rows = el._rows, from = el._shown;
  if (!rows || from >= rows.length) return;
  const opts = { ...el._opts, drag: el._opts.drag !== false };
  el.insertAdjacentHTML("beforeend", rows.slice(from, from + CHUNK).map((t, k) => trackRow(t, from + k, opts)).join(""));
  el._shown = Math.min(rows.length, from + CHUNK);
}
function markPlaying() {
  $$(".tr[data-id]").forEach((r) => r.classList.toggle("playing", !!S.track && +r.dataset.id === S.track.id));
  $$("[data-playing-key]").forEach((b) => b.classList.toggle("playing", b.dataset.playingKey === S.ctx && S.playing));
}
