"use strict";
/* Volna — навигация и страницы. */

const MOOD_COLORS = ["#7a3cf0", "#e2552d", "#1e8a6e", "#c23a7a", "#2d6fe2", "#d18b12", "#8a2be2", "#0f7f9c", "#b4441f", "#4a6b16"];
const PERIODS = [{ key: "week", label: "Неделя" }, { key: "month", label: "Месяц" }, { key: "all", label: "Всё время" }];

/* ---------------- роутер ---------------- */
const hist = [], fwd = [];
let route = null, renderSeq = 0;
function go(name, arg = null, opts = {}) {
  if (route && route.name === name && route.arg === arg && !opts.force) { $("#view").scrollTo({ top: 0, behavior: "smooth" }); return; }
  if (route && !opts.nohist) { hist.push({ ...route, scroll: $("#view").scrollTop }); fwd.length = 0; }
  route = { name, arg };
  render(opts.scroll || 0);
}
function back() { if (!hist.length) return; fwd.push({ ...route, scroll: $("#view").scrollTop }); route = hist.pop(); render(route.scroll); }
function forward() { if (!fwd.length) return; hist.push({ ...route, scroll: $("#view").scrollTop }); route = fwd.pop(); render(route.scroll); }
async function render(scroll = 0) {
  const seq = ++renderSeq;
  const view = $("#view");
  tides.clear();
  closeMenu();
  $("#back").disabled = !hist.length; $("#fwd").disabled = !fwd.length;
  $$("[data-go]").forEach((b) => b.classList.toggle("on", b.dataset.go === route.name));
  $$(".li[data-route]").forEach((b) => b.classList.toggle("on", b.dataset.route === `${route.name}:${route.arg}`));
  if (route.name !== "search") $("#q").value = "", $("#searchbox").classList.remove("has");
  setTitle("");
  document.documentElement.style.setProperty("--page-tint", "var(--tint)");
  const page = document.createElement("div");
  page.className = "view-in";
  try {
    await PAGES[route.name](page, route.arg, () => seq === renderSeq);
  } catch (e) {
    page.innerHTML = `<div class="content"><div class="empty"><h3>Не получилось открыть</h3><p>${esc(e.message || e)}</p></div></div>`;
  }
  if (seq !== renderSeq) return;
  icons(page);
  view.replaceChildren(page);
  view.scrollTop = scroll;
  onViewScroll();
  markPlaying();
}
const stale = (alive) => !alive();
function setTitle(t) { $("#top-title").textContent = t; }
function onViewScroll() { $("#topbar").classList.toggle("solid", $("#view").scrollTop > 60); }

/* ---------------- левая колонка: медиатека ---------------- */
async function loadSidebar() {
  const [pls, st, sm] = await Promise.all([call("playlists"), call("stats"), call("smart_list").catch(() => [])]);
  S.playlists = pls; S.smart = sm;
  const srcLabel = (p) => ({ local: "Мой плейлист", spotify: "Spotify", yandex: "Яндекс Музыка", sc: "SoundCloud" }[p.source] || "Плейлист");
  const el = $("#lib-list");
  el.innerHTML = `<button class="li" data-route="liked:null" data-drop="liked">${likedCover()}<div><div class="t">Любимые треки</div><div class="a">Плейлист, ${nTracks(st.liked || 0)}</div></div></button>` +
    (st.offline ? `<button class="li" data-route="offline:null">${offlineCover()}<div><div class="t">Скачанное</div><div class="a">Без интернета, ${nTracks(st.offline)}</div></div></button>` : "") +
    pls.map((p) => `<button class="li" data-route="playlist:${p.id}" data-pid="${p.id}"${p.source === "local" ? ` data-drop="${p.id}"` : ""}>
      ${mosaic(p.arts)}<div><div class="t">${esc(p.name)}</div><div class="a">${srcLabel(p)}, ${nTracks(p.n)}</div></div></button>`).join("") +
    sm.map((p) => `<button class="li" data-route="smart:${p.id}" data-sid="${p.id}">
      <div class="smart-cover">${mosaic(p.arts)}<span>${svg("sparkles")}</span></div><div><div class="t">${esc(p.name)}</div><div class="a">Умный плейлист, ${nTracks(p.n)}</div></div></button>`).join("");
  if (route) $$(".li[data-route]").forEach((b) => b.classList.toggle("on", b.dataset.route === `${route.name}:${route.arg}`));
}
function wireSidebar() {
  const el = $("#lib-list");
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".li"); if (!b) return;
    const [name, arg] = b.dataset.route.split(":");
    go(name, arg === "null" ? null : +arg);
  });
  el.addEventListener("contextmenu", (e) => {
    const sb = e.target.closest(".li[data-sid]");
    if (sb) { e.preventDefault(); const sp = S.smart.find((x) => x.id === +sb.dataset.sid); openMenu(e.clientX, e.clientY, smartMenu(sp)); return; }
    const lb = e.target.closest('.li[data-route="liked:null"]');
    if (lb) { e.preventDefault(); openMenu(e.clientX, e.clientY, shareItems("liked", null)); return; }
    const b = e.target.closest(".li[data-pid]"); if (!b) return;
    e.preventDefault();
    const p = S.playlists.find((x) => x.id === +b.dataset.pid);
    openMenu(e.clientX, e.clientY, playlistMenu(p));
  });
  el.addEventListener("dragover", (e) => {
    const b = e.target.closest(".li[data-drop]"); if (!b || !e.dataTransfer.types.includes("text/volna-track")) return;
    e.preventDefault(); $$(".li.drop").forEach((x) => x !== b && x.classList.remove("drop")); b.classList.add("drop");
  });
  el.addEventListener("dragleave", (e) => { const b = e.target.closest(".li"); if (b && !b.contains(e.relatedTarget)) b.classList.remove("drop"); });
  el.addEventListener("drop", (e) => {
    const b = e.target.closest(".li[data-drop]"); if (!b) return;
    e.preventDefault(); b.classList.remove("drop");
    const id = +e.dataTransfer.getData("text/volna-track");
    if (b.dataset.drop === "liked") { call("like", { id, liked: true }).then(() => { toast("Добавлено в «Любимые треки»"); emit("library-changed"); }); return; }
    const p = S.playlists.find((x) => x.id === +b.dataset.drop);
    call("playlist_add", { pid: p.id, id }).then((ok) => { toast(ok ? `Добавлено в «${p.name}»` : `Уже есть в «${p.name}»`); emit("playlists-changed"); }).catch(fail);
  });
  $("#new-pl").onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [
      { icon: "plus", label: "Новый плейлист", run: () => createPlaylist() },
      { icon: "sparkles", label: "Умный плейлист по правилам", run: () => smartEditor() },
      { icon: "link", label: "Плейлист от друга", run: () => importFromFriend() },
    ]);
  };
}
function playlistMenu(p) {
  const items = [
    { icon: "play", label: "Слушать", run: () => call("playlist", { pid: p.id }).then((rows) => playRows(rows, 0, p.name)) },
    { icon: "shuffle", label: "Перемешать", run: () => call("playlist", { pid: p.id }).then((rows) => shuffleRows(rows, p.name)) },
    "-",
    ...shareItems("playlist", p.id),
  ];
  if (p.source === "local") items.push("-",
    { icon: "pencil", label: "Переименовать", run: async () => {
      const name = await dialog({ title: "Переименовать плейлист", value: p.name });
      if (name) { await call("playlist_rename", { pid: p.id, name }); emit("playlists-changed"); if (route.name === "playlist" && route.arg === p.id) go("playlist", p.id, { force: true, nohist: true }); }
    } });
  items.push({ icon: "trash-2", label: "Удалить", danger: true, run: async () => {
    const ok = await dialog({ title: "Удалить плейлист?", text: `«${p.name}» исчезнет из медиатеки. Сами треки останутся.`, ok: "Удалить" });
    if (ok) { await call("playlist_delete", { pid: p.id }); toast("Плейлист удалён"); emit("playlists-changed"); if (route.name === "playlist" && route.arg === p.id) go("home"); }
  } });
  return items;
}
listen("playlists-changed", loadSidebar);
listen("library-changed", () => { loadSidebar(); });
listen("offline-changed", () => { loadSidebar(); });

/* ---------------- общие куски страниц ---------------- */
function collectionHero({ kind, title, meta, pic, round = false }) {
  return `<div class="hero"><div class="big-cover${round ? " round" : ""}">${pic}</div>
    <div><div class="kind">${esc(kind)}</div><h1 class="${title.length > 12 ? "long" : ""}">${esc(title)}</h1><div class="meta">${meta}</div></div></div>`;
}
function actionsBar(rows, ctx, extra = "") {
  return `<div class="actions"><button class="play-fab" data-act-play data-playing-key="${esc(ctx)}">${svg("play")}</button>
    <button class="icon-btn" data-act-shuffle title="Перемешать">${svg("shuffle")}</button>${extra}</div>`;
}
function wireActions(page, rows, ctx) {
  const p = $("[data-act-play]", page);
  if (p) p.onclick = () => { if (S.ctx === ctx && S.track && !S.queue.wave) call("toggle"); else playRows(rows, 0, ctx); };
  const s = $("[data-act-shuffle]", page);
  if (s) s.onclick = () => shuffleRows(rows, ctx);
}
function wireCards(root, handlers2) {
  root.addEventListener("click", (e) => {
    const c = e.target.closest("[data-kind]"); if (!c) return;
    const h = handlers2[c.dataset.kind]; if (!h) return;
    h(c.dataset.key, !!e.target.closest("[data-play]"), c);
  });
}

/* ================= Главная ================= */
PAGES.home = async (page, _a, alive) => {
  const h = await call("home");
  if (stale(alive)) return;
  const quick = [`<button class="qt" data-kind="liked">${likedCover()}<div class="t">Любимые треки</div><span class="play-fab" data-play>${svg("play")}</span></button>`]
    .concat(h.playlists.slice(0, 7).map((p) => `<button class="qt" data-kind="playlist" data-key="${p.id}">${mosaic(p.arts)}<div class="t">${esc(p.name)}</div><span class="play-fab" data-play>${svg("play")}</span></button>`));
  const moods = h.moods.map((m, i) => `<button class="mood" data-kind="mood" data-key="${esc(m.query)}" style="background:${MOOD_COLORS[i % MOOD_COLORS.length]}">${esc(m.label)}</button>`).join("");
  const trackCards = (rows) => rows.map((t) => card({ art: t.art, title: t.title, sub: t.artist, data: `data-kind="track" data-key="${t.id}"` })).join("");
  page.innerHTML = `<div class="wash"></div><div class="content">
    <div class="greet">${esc(h.greet)}</div>
    ${h.empty ? "" : `<div class="quick" data-sec="quick">${quick.join("")}</div>`}
    <div class="wave-banner" id="home-wave" data-sec="wave"><canvas></canvas><div class="body">
      <button class="play-fab" id="home-wave-play" title="Запустить волну">${svg("play")}</button>
      <div><h2>Моя волна</h2><p id="home-wave-now">${h.empty ? "Начни с настроения ниже — или добавь свою музыку" : "Бесконечный поток под твой вкус. Лайки и скипы меняют его на лету"}</p></div>
      <div class="chips-row" id="home-modes">${S.modes.map((m) => `<button class="chip${m.key === S.mode ? " on" : ""}" data-mode="${m.key}">${esc(m.label)}</button>`).join("")}</div></div></div>
    ${h.empty ? `<section class="sec"><div class="empty"><h3>Твоя медиатека пока пустая</h3><p>Подтяни лайки и плейлисты из SoundCloud и Spotify — главная наполнится миксами, артистами и историей.</p>
      <button class="btn white" data-go="import">${svg("download")}Добавить музыку</button></div></section>` : ""}
    <div id="mixes-slot" data-sec="mixes">${h.empty ? "" : section("Миксы для тебя", "Собираю похожие треки…", Array.from({ length: 6 }, () => `<div class="card"><div class="skeleton" style="aspect-ratio:1"></div></div>`).join(""))}</div>
    ${h.recent.length ? `<div data-sec="recent">${section("Недавно играли", "", trackCards(h.recent))}</div>` : ""}
    ${h.artists.length ? `<div data-sec="artists">${section("Твои артисты", "Те, кого ты слушаешь больше всех", h.artists.map((a) => card({ art: a.art, title: a.name, sub: "Исполнитель", round: true, data: `data-kind="artist" data-key="${esc(a.key)}"` })).join(""))}</div>` : ""}
    ${h.forgotten.length ? `<div data-sec="forgotten">${section("Давно не слушал", "Любимые треки, которые давно не играли", trackCards(h.forgotten))}</div>` : ""}
    ${h.added.length ? `<div data-sec="added">${section("Недавно добавлено", "", trackCards(h.added), { more: "library" })}</div>` : ""}
    ${h.empty ? "" : `<button class="recap-cta" id="home-recap" data-sec="recap">${svg("sparkles")}<div><b>Твои итоги месяца</b><span>Сколько ты слушал, главный артист, трек, который ты не мог выключить</span></div></button>`}
    <section class="sec" data-sec="moods"><div class="sec-head"><h2>Настроение<small>Волна по жанру — сразу, без медиатеки</small></h2></div><div class="moods">${moods}</div></section>
  </div>`;
  const all = { recent: h.recent, forgotten: h.forgotten, added: h.added };
  const findTrack = (id) => Object.values(all).flat().find((t) => t.id === +id);
  wireCards(page, {
    liked: (_k, playNow) => playNow ? call("library", { liked: true }).then((r) => playRows(r, 0, "Любимые треки")) : go("liked"),
    playlist: (k, playNow) => playNow ? call("playlist", { pid: +k }).then((r) => playRows(r, 0, h.playlists.find((p) => p.id === +k)?.name || "")) : go("playlist", +k),
    artist: (k, playNow) => playNow ? startWave({ query: h.artists.find((a) => a.key === k)?.name }) : go("artist", k),
    track: (k, playNow, el) => {
      const sec = el.closest(".carousel"); const rows = [...sec.querySelectorAll("[data-kind=track]")].map((c) => findTrack(c.dataset.key));
      playRows(rows, rows.findIndex((t) => t.id === +k));
    },
    mix: (k, playNow) => playNow ? call("mix", { key: k }).then((m) => playRows(m.rows, 0, m.title)).catch(fail) : go("mix", k),
    mood: (q, _p, el) => { el.classList.add("busy"); startWave({ query: q }).finally(() => el.classList.remove("busy")); },
  });
  page.addEventListener("contextmenu", (e) => {
    const c = e.target.closest("[data-kind=track]"); if (!c) return;
    e.preventDefault(); openMenu(e.clientX, e.clientY, trackMenu(findTrack(c.dataset.key)));
  });
  const rc = $("#home-recap", page); if (rc) rc.onclick = () => openRecap("month");
  // волна
  const banner = $("#home-wave", page);
  tides.add({ c: $("canvas", banner), o: { lines: 22, top: 0.05, span: 0.7, white: true, alpha: 0.75 } });
  banner.onclick = (e) => {
    if (e.target.closest("[data-mode]")) return;
    if (e.target.closest("#home-wave-play") && S.queue.wave) { call("toggle"); return; }
    if (e.target.closest("#home-wave-play")) startWave(); else go("wave");
  };
  $("#home-modes", page).onclick = (e) => {
    const b = e.target.closest("[data-mode]"); if (!b) return;
    S.mode = b.dataset.mode; $$("#home-modes .chip").forEach((x) => x.classList.toggle("on", x === b));
    call("set_mode", { mode: S.mode }); if (S.queue.wave) startWave({ mode: S.mode });
  };
  paintWaveButtons();
  // миксы — из сети, в фоне
  if (!h.empty) call("mixes").then((mixes) => {
    if (stale(alive)) return;
    const slot = $("#mixes-slot");
    if (!slot) return;
    slot.innerHTML = mixes.length ? section("Миксы для тебя", "Обновляются каждый день",
      mixes.map((m) => card({ mosaicArts: m.arts, title: m.title, sub: m.sub, label: m.title.replace("Микс: ", ""), data: `data-kind="mix" data-key="${esc(m.key)}"` })).join("")) : "";
    icons(slot);
  }).catch(() => { const s = $("#mixes-slot"); if (s) s.innerHTML = ""; });
};
function paintWaveButtons() {
  const icon = S.queue.wave ? (S.loading ? "loader-circle" : S.playing ? "pause" : "play") : "play";
  $$("#home-wave-play, #wave-play").forEach((b) => { b.innerHTML = svg(icon); b.classList.toggle("busy", S.queue.wave && S.loading); });
  const t = S.track;
  const now = $("#home-wave-now"); if (now && S.queue.wave && t) now.innerHTML = `Сейчас: <b>${esc(t.title)}</b> — ${esc(t.artist)}`;
  const wnow = $("#wave-now"); if (wnow && S.queue.wave && t) wnow.innerHTML = `Сейчас: <b>${esc(t.title)}</b> — ${esc(t.artist)}`;
  const strip = $("#wave-next");
  if (strip) strip.innerHTML = S.queue.wave && S.queue.items.length ? `<span>Дальше</span>${S.queue.items.slice(0, 5).map((x) => cover(x.art)).join("")}` : "";
}
listen("play-state", paintWaveButtons);
listen("queue", paintWaveButtons);
on("track", () => setTimeout(paintWaveButtons));
listen("wave-busy", (b) => { $$("#home-wave-play, #wave-play").forEach((x) => { if (b) { x.innerHTML = svg("loader-circle"); x.classList.add("busy"); } else x.classList.remove("busy"); }); if (!b) paintWaveButtons(); });

/* ================= Моя волна ================= */
PAGES.wave = async (page) => {
  page.style.height = "100%";
  page.innerHTML = `<div class="wave-page"><canvas></canvas><div class="fade"></div><div class="inner">
    <h1>Моя волна</h1><p class="now" id="wave-now">Поток из твоих лайков, Spotify и похожих треков. Лайки и скипы меняют его на лету</p>
    <div class="row"><button class="play-fab" id="wave-play">${svg("play")}</button>
      <div class="chips-row" id="wave-modes">${S.modes.map((m) => `<button class="chip${m.key === S.mode ? " on" : ""}" data-mode="${m.key}">${esc(m.label)}</button>`).join("")}</div>
      <div class="next-strip" id="wave-next"></div></div>
    <div class="chips-row moods-row" id="wave-energy">${[{ key: "", label: "Любое настроение" }].concat(S.waveMoods).map((m) => `<button class="chip${m.key === S.waveMood ? " on" : ""}" data-e="${m.key}">${esc(m.label)}</button>`).join("")}</div>
    <div class="chips-row moods-row" style="margin-top:10px" id="wave-moods">${S.moods.map((m) => `<button class="chip" data-q="${esc(m.query)}">${esc(m.label)}</button>`).join("")}</div>
  </div></div>`;
  tides.add({ c: $("canvas", page), o: { lines: 30, top: 0.06, span: 0.62 } });
  $("#wave-play", page).onclick = () => S.queue.wave ? call("toggle") : startWave();
  $("#wave-modes", page).onclick = (e) => {
    const b = e.target.closest("[data-mode]"); if (!b) return;
    S.mode = b.dataset.mode; $$("#wave-modes .chip").forEach((x) => x.classList.toggle("on", x === b));
    call("set_mode", { mode: S.mode }); if (S.queue.wave) startWave({ mode: S.mode });
  };
  $("#wave-moods", page).onclick = (e) => { const b = e.target.closest("[data-q]"); if (b) startWave({ query: b.dataset.q }); };
  $("#wave-energy", page).onclick = (e) => {
    const b = e.target.closest("[data-e]"); if (!b) return;
    S.waveMood = b.dataset.e; $$("#wave-energy .chip").forEach((x) => x.classList.toggle("on", x === b));
    call("settings_set", { key: "wave_mood", value: S.waveMood }).then(() => { if (S.queue.wave) startWave(); });
  };
  setTimeout(paintWaveButtons);
};

/* ================= Поиск ================= */
let searchTimer = 0, searchSeq = 0;
PAGES.search = async (page, q, alive) => {
  q = (q || "").trim();
  if (!q) {
    const h = await call("home");
    if (stale(alive)) return;
    page.innerHTML = `<div class="content" style="padding-top:84px"><section class="sec" style="margin-top:0"><div class="sec-head"><h2>Найти по настроению<small>Каждая плитка запускает волну</small></h2></div>
      <div class="moods">${h.moods.map((m, i) => `<button class="mood" data-q="${esc(m.query)}" style="background:${MOOD_COLORS[i % MOOD_COLORS.length]}">${esc(m.label)}</button>`).join("")}</div></section>
      ${h.recent.length ? `<section class="sec"><div class="sec-head"><h2>Недавно играли</h2></div><div id="s-recent"></div></section>` : ""}</div>`;
    page.addEventListener("click", (e) => { const b = e.target.closest("[data-q]"); if (b) startWave({ query: b.dataset.q }); });
    if (h.recent.length) trackList($("#s-recent", page), h.recent.slice(0, 8), { ctx: "Недавно играли", head: false });
    return;
  }
  setTitle(`«${q}»`);
  page.innerHTML = `<div class="content" style="padding-top:84px"><div class="empty"><p>Ищу «${esc(q)}» на SoundCloud…</p></div></div>`;
  const seq = ++searchSeq;
  call("search", { q }).then((r) => {
    if (seq !== searchSeq || stale(alive)) return;
    const c = $(".content", page) || page;
    if (r.added) { c.innerHTML = `<div class="empty"><h3>Добавлено в медиатеку</h3><p>${esc(r.added.name)}</p></div>`; emit("library-changed"); return; }
    const rows = r.rows;
    if (!rows.length) { c.innerHTML = `<div class="empty"><h3>Ничего не нашлось по «${esc(q)}»</h3><p>Проверь написание или попробуй название трека вместе с артистом.</p></div>`; return; }
    const top = rows[0];
    const artists = []; const seen = new Set();
    rows.forEach((t) => { if (!seen.has(t.ak)) { seen.add(t.ak); artists.push(t); } });
    c.innerHTML = `<div class="top-result"><section><div class="sec-head"><h2>Лучший результат</h2></div>
        <button class="big-card" data-top>${cover(top.art)}<div class="t">${esc(top.title)}</div><div class="a">Трек, ${esc(top.artist)}</div>
        <span class="play-fab">${svg("play")}</span></button></section>
      <section><div class="sec-head"><h2>Треки</h2></div><div class="mini" id="s-top"></div></section></div>
      ${section("Исполнители", "", artists.slice(0, 12).map((t) => card({ art: t.art, title: t.artist, sub: "Исполнитель", round: true, data: `data-kind="artist" data-key="${esc(t.ak)}"` })).join(""))}
      <section class="sec"><div class="sec-head"><h2>Все треки</h2></div><div id="s-all"></div></section>`;
    icons(c);
    $("[data-top]", c).onclick = () => playRows(rows, 0, `Поиск: ${q}`);
    trackList($("#s-top", c), rows.slice(0, 4), { ctx: `Поиск: ${q}`, head: false });
    trackList($("#s-all", c), rows, { ctx: `Поиск: ${q}` });
    wireCards(c, { artist: (k) => go("artist", k) });
    markPlaying();
  }).catch((e) => { const c = $(".content", page); if (c) c.innerHTML = `<div class="empty"><h3>Поиск не удался</h3><p>${esc(e.message)}</p></div>`; });
};
function wireSearch() {
  const q = $("#q");
  q.addEventListener("input", () => {
    $("#searchbox").classList.toggle("has", !!q.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { const v = q.value.trim(); if (route.name === "search") { route.arg = v; render(); } else go("search", v); q.focus(); }, 450);
  });
  q.addEventListener("focus", () => { if (route.name !== "search") go("search", q.value.trim() || null); });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(searchTimer); route.arg = q.value.trim(); render(); } });
  $("#q-clear").onclick = (e) => { e.preventDefault(); q.value = ""; $("#searchbox").classList.remove("has"); route.arg = null; render(); q.focus(); };
}

/* ================= Медиатека ================= */
let libFilter = "all", libQuery = "";
PAGES.library = async (page, _a, alive) => {
  const rows = await call("library", { source: ["sc", "spotify"].includes(libFilter) ? libFilter : "all", liked: libFilter === "liked", search: libQuery });
  if (stale(alive)) return;
  setTitle("Медиатека");
  page.innerHTML = `<div class="wash" style="--page-tint:#3b4f9c"></div><div class="content">
    <div class="hero" style="min-height:0"><div><div class="kind">Вся музыка</div><h1>Медиатека</h1><div class="meta">${nTracks(rows.length)}${rows.length ? `, ${totalDur(rows)}` : ""}</div></div></div>
    <div class="actions">${rows.length ? `<button class="play-fab" data-act-play data-playing-key="Медиатека">${svg("play")}</button><button class="icon-btn" data-act-shuffle title="Перемешать">${svg("shuffle")}</button>` : ""}
      <div class="chips-row" id="lib-chips">${[["all", "Всё"], ["liked", "Любимые"], ["sc", "SoundCloud"], ["spotify", "Spotify"]].map(([k, l]) => `<button class="chip${k === libFilter ? " on" : ""}" data-f="${k}">${l}</button>`).join("")}</div>
      <div class="spacer" style="flex:1"></div>
      <div class="field" style="max-width:280px;background:var(--panel-2)">${svg("search")}<input id="lib-q" placeholder="Найти в медиатеке" value="${esc(libQuery)}"></div></div>
    <div id="lib-rows"></div></div>`;
  if (!rows.length) {
    $("#lib-rows", page).innerHTML = libQuery || libFilter !== "all"
      ? `<div class="empty"><h3>Ничего не нашлось</h3><p>Попробуй другой фильтр или запрос.</p></div>`
      : `<div class="empty"><h3>Здесь будет твоя музыка</h3><p>Импортируй лайки и плейлисты из SoundCloud и Spotify.</p><button class="btn white" data-go="import">${svg("download")}Добавить музыку</button></div>`;
  } else trackList($("#lib-rows", page), rows, { ctx: "Медиатека" });
  wireActions(page, rows, "Медиатека");
  $("#lib-chips", page).onclick = (e) => { const b = e.target.closest("[data-f]"); if (!b) return; libFilter = b.dataset.f; go("library", null, { force: true, nohist: true }); };
  let t = 0;
  $("#lib-q", page).addEventListener("input", (e) => {
    clearTimeout(t); t = setTimeout(() => { libQuery = e.target.value.trim(); go("library", null, { force: true, nohist: true, scroll: 0 }); setTimeout(() => { const i = $("#lib-q"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 50); }, 280);
  });
};

/* ================= Любимые треки ================= */
PAGES.liked = async (page, _a, alive) => {
  const rows = await call("library", { liked: true });
  if (stale(alive)) return;
  setTitle("Любимые треки");
  document.documentElement.style.setProperty("--page-tint", "#5236d6");
  page.innerHTML = `<div class="wash"></div><div class="content">
    ${collectionHero({ kind: "Плейлист", title: "Любимые треки", meta: `${nTracks(rows.length)}${rows.length ? `, ${totalDur(rows)}` : ""}`, pic: likedCover() })}
    ${actionsBar(rows, "Любимые треки", `<button class="icon-btn" id="liked-share" title="Поделиться">${svg("link")}</button>`)}<div id="rows"></div></div>`;
  if (rows.length) trackList($("#rows", page), rows, { ctx: "Любимые треки" });
  else $("#rows", page).innerHTML = `<div class="empty"><h3>Пока пусто</h3><p>Нажимай ♥ у треков — они соберутся здесь. Лайки из SoundCloud и Spotify попадут сюда после импорта.</p></div>`;
  wireActions(page, rows, "Любимые треки");
  $("#liked-share", page).onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, shareItems("liked", null)); };
};

/* ================= Плейлист ================= */
PAGES.playlist = async (page, pid, alive) => {
  const [info, rows] = await Promise.all([call("playlist_info", { pid }), call("playlist", { pid })]);
  if (stale(alive)) return;
  setTitle(info.name);
  pageTintFrom(info.arts[0]);
  const local = info.source === "local";
  const src = local ? "Мой плейлист" : info.source === "spotify" ? "Плейлист из Spotify" : "Плейлист из SoundCloud";
  page.innerHTML = `<div class="wash"></div><div class="content">
    ${collectionHero({ kind: src, title: info.name, meta: `${nTracks(rows.length)}${rows.length ? `, ${totalDur(rows)}` : ""}`, pic: mosaic(info.arts) })}
    ${actionsBar(rows, info.name, `<button class="icon-btn" data-pl-more title="Ещё">${svg("ellipsis")}</button>`)}<div id="rows"></div></div>`;
  const el = $("#rows", page);
  if (rows.length) trackList(el, rows, {
    ctx: info.name,
    onReorder: local ? (ids) => call("playlist_reorder", { pid, ids }).then(() => emit("playlists-changed")) : null,
    menuExtra: local ? (t) => ["-", { icon: "trash-2", label: "Убрать из плейлиста", danger: true, run: () => call("playlist_remove", { pid, id: t.id }).then(() => { toast("Убрано из плейлиста"); emit("playlists-changed"); go("playlist", pid, { force: true, nohist: true, scroll: $("#view").scrollTop }); }) }] : null,
  });
  else el.innerHTML = `<div class="empty"><h3>Плейлист пуст</h3><p>Перетащи сюда трек из любого списка на название плейлиста слева, или нажми «…» у трека → «Добавить в плейлист».</p></div>`;
  wireActions(page, rows, info.name);
  $("[data-pl-more]", page).onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, playlistMenu(info)); };
};

/* ================= Микс ================= */
PAGES.mix = async (page, key, alive) => {
  page.innerHTML = `<div class="content"><div class="empty"><p>Собираю микс…</p></div></div>`;
  const m = await call("mix", { key });
  if (stale(alive)) return;
  setTitle(m.title);
  pageTintFrom(m.arts[0]);
  page.innerHTML = `<div class="wash"></div><div class="content">
    ${collectionHero({ kind: "Микс дня", title: m.title, meta: `${esc(m.sub)}<br>${nTracks(m.rows.length)}, ${totalDur(m.rows)}`, pic: mosaic(m.arts) })}
    ${actionsBar(m.rows, m.title)}<div id="rows"></div></div>`;
  trackList($("#rows", page), m.rows, { ctx: m.title });
  wireActions(page, m.rows, m.title);
};

/* ================= Артист ================= */
PAGES.artist = async (page, key, alive) => {
  const a = await call("artist", { key });
  if (stale(alive)) return;
  setTitle(a.name);
  pageTintFrom(a.art);
  const bg = big(a.avatar || a.art);
  const stats = [];
  if (a.listened_ms > 60000) stats.push(`ты слушал ${nMin(a.listened_ms)}`);
  if (a.liked) stats.push(`в любимых ${nTracks(a.liked)}`);
  if (a.mine.length) stats.push(`в медиатеке ${nTracks(a.mine.length)}`);
  page.innerHTML = `<div class="content">
    <div class="artist-hero" id="a-hero" style="background-image:url('${esc(bg)}')"><div class="blur"></div><div>
      ${cover(bg, "round avatar")}<div><div class="kind">Исполнитель</div><h1>${esc(a.name)}</h1>
      <div class="meta">${stats.length ? esc(stats.join(", ").replace(/^./, (c) => c.toUpperCase())) : "Пока ты его не слушал"}</div></div></div></div>
    <div class="actions"><button class="play-fab" id="a-play" data-playing-key="${esc(a.name)}">${svg("play")}</button>
      <button class="btn ghost" id="a-wave">${svg("radio")}Волна по артисту</button></div>
    <section class="sec" style="margin-top:8px"><div class="sec-head"><h2>Популярное</h2></div><div id="a-top"><div class="empty"><p>Загружаю с SoundCloud…</p></div></div></section>
    ${a.mine.length ? `<section class="sec"><div class="sec-head"><h2>В твоей медиатеке</h2></div><div id="a-mine"></div></section>` : ""}
    <div id="a-similar"></div></div>`;
  if (a.mine.length) trackList($("#a-mine", page), a.mine, { ctx: a.name });
  let topRows = [];
  $("#a-play", page).onclick = () => playRows(topRows.length ? topRows : a.mine, 0, a.name);
  $("#a-wave", page).onclick = () => { go("wave"); startWave({ query: a.name }); };
  call("artist_online", { key, name: a.name }).then((o) => {
    if (stale(alive)) return;
    topRows = o.top;
    const top = $("#a-top");
    if (top) {
      if (o.top.length) trackList(top, o.top, { ctx: a.name, head: false });
      else top.innerHTML = `<div class="empty"><p>На SoundCloud не нашлось треков именно этого артиста.</p></div>`;
    }
    if (o.avatar) { const h = $("#a-hero"); if (h) { h.style.backgroundImage = `url('${o.avatar}')`; setCover($(".avatar", h), o.avatar); } }
    const sim = $("#a-similar");
    if (sim && o.similar.length) {
      sim.innerHTML = section("Похожие исполнители", "", o.similar.map((s) => card({ art: s.art, title: s.name, sub: "Исполнитель", round: true, data: `data-kind="artist" data-key="${esc(s.key)}"` })).join(""));
      icons(sim);
      wireCards(sim, { artist: (k, playNow) => playNow ? startWave({ query: o.similar.find((x) => x.key === k)?.name }) : go("artist", k) });
    }
    markPlaying();
  }).catch(() => { const top = $("#a-top"); if (top) top.innerHTML = `<div class="empty"><p>Не получилось загрузить с SoundCloud — проверь интернет.</p></div>`; });
};

/* ================= Статистика ================= */
let statPeriod = "month";
PAGES.stats = async (page, _a, alive) => {
  const d = await call("stats_page", { period: statPeriod });
  if (stale(alive)) return;
  setTitle("Статистика");
  document.documentElement.style.setProperty("--page-tint", "#3b4f9c");
  const T = d.totals;
  const maxA = Math.max(1, ...d.artists.map((x) => x.ms)), maxT = Math.max(1, ...d.tracks.map((x) => x.ms));
  const maxH = Math.max(1, ...d.hours), maxG = Math.max(1, ...d.genres.map((g) => g.ms));
  const periodText = { week: "за последние 7 дней", month: "за последние 30 дней", all: "за всё время, включая историю Spotify" }[statPeriod];
  const empty = !T.ms;
  page.innerHTML = `<div class="wash"></div><div class="content">
    <div class="hero" style="min-height:0"><div><div class="kind">Твоя музыка ${esc(periodText)}</div><h1>Статистика</h1></div></div>
    <button class="recap-cta" id="recap-open">${svg("sparkles")}<div><b>Твои итоги</b><span>Месяц и год в музыке — как истории, можно показать друзьям</span></div></button>
    <div class="chips-row" id="st-period" style="margin-top:18px">${PERIODS.map((p) => `<button class="chip${p.key === statPeriod ? " on" : ""}" data-p="${p.key}">${p.label}</button>`).join("")}</div>
    ${empty ? `<div class="empty"><h3>Пока нечего считать</h3><p>Послушай что-нибудь — здесь появятся любимые артисты, треки и время, когда ты слушаешь музыку чаще всего. Если импортировать историю Spotify, раздел «Всё время» заполнится сразу.</p></div>` : `
    <div class="stat-hero"><div><b>${Math.round(T.ms / 60000).toLocaleString("ru")}</b><span>${plural(Math.round(T.ms / 60000), "минута", "минуты", "минут")} музыки</span></div>
      <div><b>${T.tracks.toLocaleString("ru")}</b><span>${plural(T.tracks, "разный трек", "разных трека", "разных треков")}</span></div>
      <div><b>${T.artists.toLocaleString("ru")}</b><span>${plural(T.artists, "исполнитель", "исполнителя", "исполнителей")}</span></div></div>
    <div class="two-col">
      <section class="sec"><div class="sec-head"><h2>Топ исполнителей</h2></div>${d.artists.map((a, i) => `<button class="rank" data-artist="${esc(a.key)}">
        <span class="pos">${i + 1}</span>${cover(a.art, "round")}<div><div class="t">${esc(a.name)}</div><div class="bar"><i data-w="${(a.ms / maxA * 100).toFixed(1)}"></i></div></div><span class="v">${nMin(a.ms)}</span></button>`).join("")}</section>
      <section class="sec"><div class="sec-head"><h2>Топ треков</h2></div>${d.tracks.map((t, i) => `<button class="rank" data-track="${i}">
        <span class="pos">${i + 1}</span>${cover(t.art)}<div><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div><div class="bar"><i data-w="${(t.ms / maxT * 100).toFixed(1)}"></i></div></div><span class="v">${t.plays} ${plural(t.plays, "раз", "раза", "раз")}</span></button>`).join("")}</section>
    </div>
    <div class="two-col">
      <section class="sec"><div class="sec-head"><h2>Когда ты слушаешь<small>Минуты по часам суток</small></h2></div>
        <div class="hours">${d.hours.map((m, h) => `<div class="h"><i data-h="${(m / maxH * 100).toFixed(1)}"></i><span class="tip">${String(h).padStart(2, "0")}:00, ${m} мин</span></div>`).join("")}</div>
        <div class="hours-x"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span></div></section>
      <section class="sec"><div class="sec-head"><h2>Жанры<small>По времени прослушивания</small></h2></div>
        ${d.genres.length ? d.genres.map((g) => `<div class="genre"><span class="name">${esc(g.name)}</span><div class="bar"><i data-w="${(g.ms / maxG * 100).toFixed(1)}"></i></div><span class="v">${nMin(g.ms)}</span></div>`).join("") : `<p class="sub" style="color:var(--mist)">У треков нет жанров — они появятся для музыки с SoundCloud.</p>`}</section>
    </div>`}</div>`;
  $("#recap-open", page).onclick = () => openRecap(statPeriod === "all" ? "year" : "month");
  $("#st-period", page).onclick = (e) => { const b = e.target.closest("[data-p]"); if (!b) return; statPeriod = b.dataset.p; go("stats", null, { force: true, nohist: true }); };
  page.addEventListener("click", (e) => {
    const a = e.target.closest("[data-artist]"); if (a) { go("artist", a.dataset.artist); return; }
    const t = e.target.closest("[data-track]"); if (t) playRows(d.tracks, +t.dataset.track, "Статистика");
  });
  requestAnimationFrame(() => setTimeout(() => {
    $$("[data-w]").forEach((i) => { i.style.width = i.dataset.w + "%"; });
    $$("[data-h]").forEach((i) => { i.style.height = i.dataset.h + "%"; });
  }, 60));
};

/* ================= Импорт ================= */
let matching = false;
PAGES.import = async (page, _a, alive) => {
  const [init, st] = await Promise.all([call("init"), call("stats")]);
  if (stale(alive)) return;
  setTitle("Импорт");
  page.innerHTML = `<div class="wash" style="--page-tint:#ff7a2a"></div><div class="content">
    <div class="hero" style="min-height:0"><div><div class="kind">Добавить музыку</div><h1>Импорт</h1>
      <div class="meta">Звук всегда идёт с SoundCloud. Треки из Spotify приложение находит там само.</div></div></div>
    <div class="sources">
      <div class="box"><h3><span class="dot" style="background:#ff8a3d"></span>SoundCloud</h3>
        <p class="sub">Ссылка на твой профиль — подтянутся публичные лайки и плейлисты. Входить не нужно.</p>
        <div class="line"><div class="field"><input id="sc-url" placeholder="soundcloud.com/твой-ник" value="${esc(init.scProfile || "")}"></div><button class="btn white" id="sc-import">Импортировать</button></div>
        <p class="or">Или отдельный трек, плейлист или альбом</p>
        <div class="line"><div class="field">${svg("link")}<input id="sc-link" placeholder="Ссылка на SoundCloud"></div><button class="btn" id="sc-add">Добавить</button></div>
        <div class="prog" id="sc-prog"><i></i></div><p class="prog-text" id="sc-text"></p></div>
      <div class="box"><h3><span class="dot" style="background:#1ed760"></span>Spotify</h3>
        <p class="sub">Самый полный способ — выгрузка данных: лайки, все плейлисты и история, по которой волна узнаёт твой вкус.</p>
        <ol class="steps"><li>spotify.com → Профиль → Аккаунт → Конфиденциальность</li><li>«Скачать данные» → «Данные аккаунта», подтверди по почте</li><li>Через несколько дней придёт ZIP — выбери его здесь</li></ol>
        <button class="btn white" id="sp-zip">${svg("file-archive")}Выбрать ZIP</button>
        <p class="or">Или публичный плейлист по ссылке (обычно до ~100 треков)</p>
        <div class="line"><div class="field">${svg("link")}<input id="sp-link" placeholder="open.spotify.com/playlist/…"></div><button class="btn" id="sp-add">Добавить</button></div>
        <div class="prog" id="sp-prog"><i></i></div><p class="prog-text" id="sp-text"></p></div>
    </div>
    <div class="box" style="margin-top:14px"><h3>Треки Spotify на SoundCloud</h3>
      <p class="sub">Найди всё заранее, чтобы волна и миксы могли брать любые треки из медиатеки. Можно остановить и продолжить позже.</p>
      <div class="line" style="align-items:center"><div class="nums"><div><b id="m-lib">${st.lib}</b><span>в медиатеке</span></div><div><b id="m-pending">${st.pending}</b><span>ждут поиска</span></div><div><b id="m-failed">${st.failed}</b><span>нет на SoundCloud</span></div></div>
        <button class="btn white" id="match-btn">${matching ? `${svg("x")}Остановить` : `${svg("search")}Найти на SoundCloud`}</button></div>
      <div class="prog${matching ? " on" : ""}" id="m-prog"><i></i></div><p class="prog-text" id="m-text"></p></div></div>`;
  wireImport(page);
};
function progUI(p, on, text = "") {
  const bar = $(`#${p}-prog`); if (!bar) return;
  bar.classList.toggle("on", on); if (on) $("i", bar).style.width = "0";
  const t = $(`#${p}-text`); if (t) t.textContent = text;
}
async function busy(btn, fn) { btn.disabled = true; try { return await fn(); } finally { btn.disabled = false; } }
function refreshNums() { call("stats").then((s) => { [["m-lib", s.lib], ["m-pending", s.pending], ["m-failed", s.failed]].forEach(([id, v]) => { const e = $("#" + id); if (e) e.textContent = v; }); }); }
function startMatch() {
  if (matching) { call("match", { stop: true }); const b = $("#match-btn"); if (b) b.textContent = "Останавливаю…"; return; }
  matching = true;
  const b = $("#match-btn"); if (b) b.innerHTML = `${svg("x")}Остановить`;
  progUI("m", true, "Ищу треки на SoundCloud…");
  call("match").then((r) => {
    const msg = r && r.total ? `Нашлось ${r.found} из ${r.total}. Нет на SoundCloud: ${r.failed}.` : "Все треки Spotify уже проверены.";
    progUI("m", false, msg); toast(msg);
  }).catch((e) => { progUI("m", false); fail(e); })
    .finally(() => { matching = false; const b2 = $("#match-btn"); if (b2) b2.innerHTML = `${svg("search")}Найти на SoundCloud`; refreshNums(); emit("library-changed"); });
}
on("progress", ({ task, frac, text }) => {
  const p = { sc: "sc", spotify: "sp", match: "m" }[task]; if (!p) return;
  const bar = $(`#${p}-prog`); if (!bar) return;
  bar.classList.add("on"); $("i", bar).style.width = (frac * 100).toFixed(1) + "%";
  if (text) $(`#${p}-text`).textContent = text;
  if (task === "match" && Math.random() < 0.1) refreshNums();
});
function wireImport(page) {
  $("#sc-import", page).onclick = (e) => {
    const url = $("#sc-url").value.trim(); if (!url) { $("#sc-url").focus(); return; }
    busy(e.currentTarget, async () => {
      progUI("sc", true, "Ищу профиль…");
      try { const r = await call("import_sc_profile", { url }); progUI("sc", false, `Готово: ${r.user} — лайков ${r.likes}, плейлистов ${r.playlists}.`); toast("Музыка из SoundCloud добавлена"); refreshNums(); emit("library-changed"); }
      catch (err) { progUI("sc", false); fail(err); }
    });
  };
  $("#sc-add", page).onclick = (e) => {
    const url = $("#sc-link").value.trim(); if (!url) return;
    busy(e.currentTarget, async () => {
      try { const r = await call("import_sc_link", { url }); $("#sc-link").value = ""; progUI("sc", false, `Добавлено: ${r.name}`); refreshNums(); emit("library-changed"); }
      catch (err) { fail(err); }
    });
  };
  $("#sp-zip", page).onclick = (e) => busy(e.currentTarget, async () => {
    try {
      progUI("sp", true, "Жду файл…");
      const r = await call("import_spotify_zip");
      if (!r) { progUI("sp", false); return; }
      progUI("sp", false, `Готово: лайков ${r.liked}, плейлистов ${r.playlists}, из истории ${nTracks(r.history_tracks)}.`);
      refreshNums(); emit("library-changed"); if (!matching) startMatch();
    } catch (err) { progUI("sp", false); fail(err); }
  });
  $("#sp-add", page).onclick = (e) => {
    const url = $("#sp-link").value.trim(); if (!url) return;
    busy(e.currentTarget, async () => {
      try { const r = await call("import_spotify_link", { url }); $("#sp-link").value = ""; progUI("sp", false, `«${r.name}»: ${nTracks(r.tracks)}`); refreshNums(); emit("library-changed"); if (!matching) startMatch(); }
      catch (err) { fail(err); }
    });
  };
  $("#match-btn", page).onclick = startMatch;
  [["#sc-url", "#sc-import"], ["#sc-link", "#sc-add"], ["#sp-link", "#sp-add"]].forEach(([i, b]) =>
    $(i, page).addEventListener("keydown", (e) => { if (e.key === "Enter") $(b, page).click(); }));
}

/* ---------------- запуск ---------------- */
function boot() {
  icons();
  wirePlayer();
  wireSidebar();
  wireSearch();
  $("#view").addEventListener("scroll", onViewScroll, { passive: true });
  $("#back").onclick = back; $("#fwd").onclick = forward;
  addEventListener("mouseup", (e) => { if (e.button === 3) back(); if (e.button === 4) forward(); });
  addEventListener("keydown", (e) => { if (e.altKey && e.key === "ArrowLeft") back(); if (e.altKey && e.key === "ArrowRight") forward(); });
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]"); if (g && !g.closest(".li")) { go(g.dataset.go); return; }
    const a = e.target.closest("a[data-artist]"); if (a && !a.closest(".tracks")) go("artist", a.dataset.artist);
  });
  connect(async () => {
    const init = await call("init");
    S.mode = init.mode; S.modes = init.modes; S.moods = init.moods;
    S.waveMoods = init.waveMoods || []; S.waveMood = init.waveMood || "";
    setVol(init.volume, false);
    if (init.track) onEvent("track", JSON.stringify(init.track));
    await loadSidebar();
    READY.forEach((f) => { try { f(init); } catch (e) { console.error(e); } });
    go("home");
    call("queue");
  });
}
boot();


/* ================= Настройки ================= */
const EQ_HZ = ["31", "62", "125", "250", "500", "1к", "2к", "4к", "8к", "16к"];
const EQ_PRESETS = {
  "Ровно": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Бас": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  "Фонк": [7, 6, 3, 0, -1, 0, 1, 3, 4, 3],
  "Вокал": [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  "Рок": [4, 3, 2, 0, -1, 0, 2, 3, 4, 4],
  "Электроника": [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  "Ночь": [2, 2, 1, 0, 0, -1, -2, -3, -4, -5],
};
PAGES.settings = async (page, _a, alive) => {
  const [st, cache] = await Promise.all([call("settings_get"), call("cache_info")]);
  if (stale(alive)) return;
  setTitle("Настройки");
  document.documentElement.style.setProperty("--page-tint", "#3b4f9c");
  const sw = (key, on) => `<button class="switch${on ? " on" : ""}" data-sw="${key}" role="switch" aria-checked="${on}"></button>`;
  const engineOk = st.engine === "volna";
  page.innerHTML = `<div class="wash"></div><div class="content">
    <div class="hero" style="min-height:0"><div><div class="kind">Volna</div><h1>Настройки</h1></div></div>
    <section class="set-sec"><h2>${svg("audio-lines")}Звук</h2><div class="set-card">
      <div class="set-row"><div><b>Звуковой движок</b><span>${engineOk ? "Свой движок Volna: плавные переходы, эквалайзер, выравнивание громкости и живая визуализация." : "Стандартный плеер Qt — переходы, эквалайзер и выравнивание громкости недоступны. Проверь, что run.bat поставил все библиотеки."}</span></div>
        <span class="${engineOk ? "badge-ok" : "badge-warn"}">${engineOk ? "Работает" : "Упрощённый режим"}</span></div>
      <div class="set-row"><div><b>Плавный переход между треками</b><span>Следующий трек начинается, пока текущий затихает. 0 — без перехода, но и без пауз между треками.</span></div>
        <input class="range" type="range" min="0" max="12" step="1" value="${st.crossfade}" data-range="crossfade"><span class="val" id="v-crossfade">${st.crossfade ? st.crossfade + " с" : "выкл"}</span></div>
      <div class="set-row"><div><b>Выравнивать громкость</b><span>На SoundCloud треки бывают очень тихими и очень громкими — приложение подстроит их под один уровень.</span></div>${sw("normalize", st.normalize)}</div>
      <div class="set-row"><div><b>Эквалайзер</b><span>Подстрой звук под наушники или жанр.</span></div>${sw("eq_on", st.eq_on)}</div>
      <div class="eq-wrap${st.eq_on ? "" : " off"}" id="eq-wrap">
        <div class="chips-row" id="eq-presets" style="padding-top:6px">${Object.keys(EQ_PRESETS).map((k) => `<button class="chip" data-preset="${k}">${k}</button>`).join("")}</div>
        <canvas class="eq-curve" id="eq-curve"></canvas>
        <div class="eqz">${st.eq.map((g, i) => `<div class="eq-band"><span class="db" id="db-${i}">${g > 0 ? "+" : ""}${g}</span><input type="range" min="-12" max="12" step="1" value="${g}" data-band="${i}" orient="vertical"><span class="hz">${EQ_HZ[i]}</span></div>`).join("")}</div>
      </div>
    </div></section>
    <section class="set-sec"><h2>${svg("settings")}Приложение</h2><div class="set-card">
      <div class="set-row"><div><b>Сворачивать в трей при закрытии</b><span>Крестик прячет окно, музыка продолжает играть. Выйти — правый клик по значку Volna у часов.</span></div>${sw("close_to_tray", st.close_to_tray)}</div>
      <div class="set-row"><div><b>Мини-плеер поверх всех окон</b><span>Маленькое окошко с обложкой и кнопками — можно перетащить куда угодно. Двойной клик открывает Volna.</span></div>
        <button class="btn" id="set-mini">${svg("picture-in-picture-2")}${st.mini_on ? "Закрыть" : "Открыть"}</button></div>
      <div class="set-row"><div><b>Медиаклавиши и окно музыки Windows</b><span>Клавиши ⏯ ⏭ ⏮ на клавиатуре${st.media === "smtc" ? " и плашка с обложкой в Windows работают" : " работают"} автоматически.</span></div>
        <span class="${st.media ? "badge-ok" : "badge-warn"}">${st.media === "smtc" ? "Включено" : st.media === "hotkeys" ? "Только клавиши" : "Недоступно"}</span></div>
    </div></section>
    <section class="set-sec"><h2>${svg("message-circle")}Discord</h2><div class="set-card">
      <div class="set-row"><div><b>Показывать в Discord, что ты слушаешь</b><span>Друзья увидят «Слушает» с треком, артистом и обложкой. Сейчас: ${esc(st.discord_status || "выключено")}.</span></div>${sw("discord_on", st.discord_on)}</div>
      <div class="set-row"><div><b>ID приложения Discord</b>
        <div class="set-help">Discord показывает статус только от зарегистрированного приложения — это бесплатно и на 2 минуты:
          <ol><li>Открой discord.com/developers/applications → «New Application», назови <b style="display:inline">Volna</b> (это имя будет в статусе)</li>
          <li>Скопируй «Application ID» и вставь сюда</li><li>Discord должен быть запущен на этом компьютере</li></ol></div></div>
        <div class="field" style="max-width:260px;flex:none"><input id="discord-id" placeholder="123456789012345678" value="${esc(st.discord_id)}"></div></div>
    </div></section>
    <section class="set-sec"><h2>${svg("hard-drive")}Хранилище</h2><div class="set-card">
      <div class="set-row"><div><b>Кэш треков</b><span>Скачанные треки хранятся временно, чтобы переключение было мгновенным. Сейчас ${cache.mb} МБ, лимит 400 МБ.</span></div>
        <button class="btn ghost" id="set-cache">Очистить</button></div>
    </div></section></div>`;
  const save = (key, value) => call("settings_set", { key, value }).catch(fail);
  page.addEventListener("click", (e) => {
    const s2 = e.target.closest("[data-sw]"); if (!s2) return;
    const on = !s2.classList.contains("on"); s2.classList.toggle("on", on); s2.setAttribute("aria-checked", on);
    save(s2.dataset.sw, on);
    if (s2.dataset.sw === "eq_on") $("#eq-wrap").classList.toggle("off", !on);
    if (s2.dataset.sw === "discord_on") setTimeout(() => go("settings", null, { force: true, nohist: true, scroll: $("#view").scrollTop }), 2500);
  });
  const cf = $("[data-range=crossfade]", page);
  const paintRange = (el) => el.style.setProperty("--v", (el.value - el.min) / (el.max - el.min) * 100 + "%");
  paintRange(cf);
  cf.oninput = () => { paintRange(cf); $("#v-crossfade").textContent = +cf.value ? cf.value + " с" : "выкл"; };
  cf.onchange = () => save("crossfade", +cf.value);
  const eq = st.eq.slice();
  let eqTimer = 0;
  const pushEq = () => { clearTimeout(eqTimer); eqTimer = setTimeout(() => save("eq", eq), 120); drawEq(); };
  $$("[data-band]", page).forEach((el) => el.addEventListener("input", () => {
    eq[+el.dataset.band] = +el.value; $(`#db-${el.dataset.band}`).textContent = (el.value > 0 ? "+" : "") + el.value; pushEq();
  }));
  $("#eq-presets", page).onclick = (e) => {
    const b = e.target.closest("[data-preset]"); if (!b) return;
    EQ_PRESETS[b.dataset.preset].forEach((g, i) => { eq[i] = g; const el = $(`[data-band="${i}"]`); el.value = g; $(`#db-${i}`).textContent = (g > 0 ? "+" : "") + g; });
    $$("#eq-presets .chip").forEach((x) => x.classList.toggle("on", x === b));
    pushEq();
  };
  function drawEq() {
    const c = $("#eq-curve"); if (!c) return;
    const [w, h, dpr] = fit(c); const g = c.getContext("2d");
    g.clearRect(0, 0, w, h);
    g.strokeStyle = "rgba(168,188,255,.15)"; g.lineWidth = dpr; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    const pts = eq.map((v, i) => [(i + 0.5) / eq.length * w, h / 2 - v / 12 * (h / 2 - 6 * dpr)]);
    g.beginPath(); g.moveTo(0, pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2; g.quadraticCurveTo(pts[i][0], pts[i][1], mx, (pts[i][1] + pts[i + 1][1]) / 2); }
    g.lineTo(w, pts[pts.length - 1][1]);
    g.strokeStyle = rgba(1); g.lineWidth = 2.5 * dpr; g.stroke();
    g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = rgba(0.12); g.fill();
  }
  setTimeout(drawEq, 50);
  $("#set-mini", page).onclick = () => call("mini").then((on2) => { $("#set-mini").innerHTML = `${svg("picture-in-picture-2")}${on2 ? "Закрыть" : "Открыть"}`; $("#btn-mini").classList.toggle("on", !!on2); });
  $("#set-cache", page).onclick = () => call("cache_clear").then((n) => { toast(`Удалено файлов: ${n}`); go("settings", null, { force: true, nohist: true }); });
  let dt = 0;
  $("#discord-id", page).addEventListener("input", (e) => { clearTimeout(dt); dt = setTimeout(() => save("discord_id", e.target.value.trim()), 500); });
};

/* ================= Итоги ================= */
const RC_BG = [
  ["#3a1fb8", "#ff5e8a"], ["#0d6b5e", "#a4ff6b"], ["#b4441f", "#ffd25e"], ["#1b2b8f", "#47d1ff"],
  ["#7a1f6b", "#ff9a5e"], ["#121a3a", "#8f6bff"], ["#0f5a8a", "#ff6bd5"],
];
let rcTimer = 0, rcIdx = 0, rcSlides = [];
async function openRecap(period = "month") {
  const d = await call("recap", { period }).catch(fail);
  if (!d) return;
  const el = $("#recap");
  const per = period === "year" ? "этот год" : "этот месяц";
  const T = d.totals, min = Math.round(T.ms / 60000);
  const bg = (i) => `<div class="bg" style="background:linear-gradient(140deg, ${RC_BG[i % RC_BG.length][0]}, #060a16 75%)">
    <div class="blob" style="width:50vw;height:50vw;left:-10vw;top:-10vw;background:${RC_BG[i % RC_BG.length][1]}"></div>
    <div class="blob" style="width:40vw;height:40vw;right:-10vw;bottom:-15vw;background:${RC_BG[(i + 3) % RC_BG.length][1]};animation-delay:-6s"></div></div>`;
  const slides = [];
  if (!min) {
    slides.push(`<div class="in"><div class="kicker rise">Итоги за ${per}</div><div class="big rise">Пока тихо</div><div class="sub2 rise">Послушай музыку в Volna — итоги соберутся сами. История Spotify сюда не входит, только то, что играло в приложении.</div></div>`);
  } else {
    slides.push(`<div class="in"><div class="kicker rise">Volna — итоги за ${per}</div><div class="big rise">Ты слушал музыку</div><div class="huge rise">${min.toLocaleString("ru")}</div><div class="big rise">${plural(min, "минуту", "минуты", "минут")}</div>
      <div class="sub2 rise">Это ${(min / 60).toFixed(1).replace(".", ",")} ч, ${d.days} ${plural(d.days, "день", "дня", "дней")} с музыкой${d.busiest && d.busiest.ms ? `, а рекордный день — ${new Date(d.busiest.day).toLocaleDateString("ru", { day: "numeric", month: "long" })}: ${Math.round(d.busiest.ms / 60000)} мин` : ""}.</div></div>`);
    const a0 = d.artists[0];
    if (a0) slides.push(`<div class="in rc-row"><div class="zoom">${cover(a0.art, "rc-art")}</div><div><div class="kicker rise">Твой главный артист</div><div class="big rise">${esc(a0.name)}</div>
      <div class="sub2 rise">${nMin(a0.ms)} вместе. Пожалуй, вы теперь близко знакомы.</div></div></div>`);
    if (d.artists.length > 1) slides.push(`<div class="in"><div class="kicker rise">Топ-5 артистов</div><div class="rc-list">${d.artists.map((a, i) => `<div class="it rise"><span class="n">${i + 1}</span>${cover(a.art, "round")}<div>${esc(a.name)}<small>${nMin(a.ms)}</small></div></div>`).join("")}</div></div>`);
    if (d.tracks.length) slides.push(`<div class="in"><div class="kicker rise">Трек, который ты не мог выключить</div>
      <div class="rc-row"><div class="zoom">${cover(d.tracks[0].artHi || d.tracks[0].art, "rc-art sq")}</div>
        <div><div class="big rise">${esc(d.tracks[0].title)}</div><div class="sub2 rise">${esc(d.tracks[0].artist)} — ${d.tracks[0].plays} ${plural(d.tracks[0].plays, "раз", "раза", "раз")}</div>
        <div class="rc-list">${d.tracks.slice(1).map((t, i) => `<div class="it rise"><span class="n">${i + 2}</span>${cover(t.art)}<div>${esc(t.title)}<small>${esc(t.artist)}</small></div></div>`).join("")}</div></div></div></div>`);
    const g0 = d.genres[0];
    const hour = d.peak_hour;
    const owl = d.total_min && d.night_min / d.total_min > 0.25;
    slides.push(`<div class="in"><div class="kicker rise">Твой ритм</div>
      ${hour !== null ? `<div class="big rise">${owl ? "Ночная сова" : hour < 12 ? "Утренний человек" : hour < 18 ? "Музыка днём" : "Вечерний слушатель"}</div><div class="sub2 rise">Чаще всего музыка играет около ${String(hour).padStart(2, "0")}:00${owl ? ", и четверть всего — глубокой ночью" : ""}.</div>` : ""}
      ${g0 ? `<div class="sub2 rise">Любимый жанр — <b>${esc(g0.name)}</b>${d.genres[1] ? `, следом ${esc(d.genres[1].name)}` : ""}.</div>` : ""}
      <div class="sub2 rise">Новых артистов: <b>${d.new_artists}</b>. Лайков: <b>${d.likes}</b>.</div></div>`);
    slides.push(`<div class="in"><div class="kicker rise">Итоги за ${per}</div><div class="big rise">${min.toLocaleString("ru")} минут.<br>${T.artists} ${plural(T.artists, "артист", "артиста", "артистов")}.<br>${T.tracks} ${plural(T.tracks, "трек", "трека", "треков")}.</div>
      <div class="sub2 rise">Сделай скриншот и отправь друзьям — пусть завидуют.</div>
      <div class="rc-share rise"><button class="btn white" data-rc-wave>${svg("radio")}Запустить волну</button></div></div>`);
  }
  rcSlides = slides;
  el.innerHTML = `<div class="rc-bars">${slides.map(() => "<i><b></b></i>").join("")}</div>
    <button class="icon-btn rc-close" title="Закрыть (Esc)">${svg("x")}</button>
    ${slides.map((h, i) => `<section class="slide" data-i="${i}">${bg(i)}${h}</section>`).join("")}
    <div class="rc-nav prev"></div><div class="rc-nav next"></div>`;
  el.classList.add("on");
  el.onclick = (e) => {
    if (e.target.closest(".rc-close")) { closeRecap(); return; }
    if (e.target.closest("[data-rc-wave]")) { closeRecap(); startWave(); return; }
    if (e.target.closest(".rc-nav.prev")) showSlide(rcIdx - 1);
    else if (e.target.closest(".rc-nav.next")) showSlide(rcIdx + 1);
  };
  showSlide(0);
}
function showSlide(i) {
  if (i < 0) i = 0;
  if (i >= rcSlides.length) { closeRecap(); return; }
  rcIdx = i;
  $$("#recap .slide").forEach((s, k) => s.classList.toggle("on", k === i));
  $$("#recap .rc-bars i").forEach((b, k) => { b.classList.toggle("done", k < i); const bar = $("b", b); bar.style.transition = "none"; bar.style.width = k < i ? "100%" : "0"; });
  const cur = $$("#recap .rc-bars i")[i];
  if (cur) requestAnimationFrame(() => requestAnimationFrame(() => { const bar = $("b", cur); bar.style.transition = "width 7s linear"; bar.style.width = "100%"; }));
  clearTimeout(rcTimer);
  if (i < rcSlides.length - 1) rcTimer = setTimeout(() => showSlide(i + 1), 7000);
}
function closeRecap() { clearTimeout(rcTimer); $("#recap").classList.remove("on"); $("#recap").innerHTML = ""; }
addEventListener("keydown", (e) => {
  if (!$("#recap").classList.contains("on")) return;
  if (e.key === "Escape") closeRecap();
  if (e.key === "ArrowRight") showSlide(rcIdx + 1);
  if (e.key === "ArrowLeft") showSlide(rcIdx - 1);
});
