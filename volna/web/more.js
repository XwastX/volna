"use strict";
/* Volna 0.6 — офлайн-режим, «Музыкальная ДНК», режим вечеринки. */

/* ================= Офлайн ================= */
const offlineCover = (cls = "") => `<div class="offline-cover ${cls}">${svg("circle-arrow-down")}</div>`;
const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
const fmtBytes = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(".", ",")} ГБ` : `${Math.round((n || 0) / 1e6)} МБ`;
S.dl = { active: false, done: 0, total: 0 };

function offlineItems(kind, key) {
  return [
    { icon: "circle-arrow-down", label: "Скачать для офлайна", run: () => call("offline_add", { kind, key }).then((r) => {
      toast(r.added ? `Скачиваю ${nTracks(r.added)}${r.already ? ` (ещё ${r.already} уже скачано)` : ""}` : "Всё уже скачано");
    }).catch(fail) },
    { icon: "trash-2", label: "Удалить из скачанного", run: () => call("offline_remove", { kind, key }).then((r) => {
      toast(r.removed ? `Удалено из скачанного: ${nTracks(r.removed)}` : "Здесь ничего не скачано"); emit("offline-changed");
    }).catch(fail) },
  ];
}
/* «Поделиться» уже есть в меню плейлистов, «Любимых» и умных плейлистов — добавляем туда скачивание */
{
  const baseShare = shareItems;
  shareItems = (kind, key) => [...baseShare(kind, key), "-", ...offlineItems(kind, key)];   // eslint-disable-line no-func-assign
}

PAGES.offline = async (page, _a, alive) => {
  const d = await call("offline_list");
  if (stale(alive)) return;
  setTitle("Скачанное");
  document.documentElement.style.setProperty("--page-tint", "#1f8a6a");
  const rows = d.rows;
  page.innerHTML = `<div class="wash"></div><div class="content">
    ${collectionHero({ kind: "Без интернета", title: "Скачанное", meta: `${nTracks(rows.length)}${rows.length ? `, ${totalDur(rows)}` : ""} · ${fmtBytes(d.bytes)} на диске`, pic: offlineCover() })}
    ${actionsBar(rows, "Скачанное", `<button class="btn ghost" id="off-mode">${svg(S.offline ? "wifi" : "wifi-off")}${S.offline ? "Выключить офлайн-режим" : "Включить офлайн-режим"}</button>
      <button class="icon-btn" id="off-more" title="Ещё">${svg("ellipsis")}</button>`)}
    <div id="dl-box"></div><div id="rows"></div></div>`;
  if (rows.length) trackList($("#rows", page), rows, { ctx: "Скачанное" });
  else $("#rows", page).innerHTML = `<div class="empty"><h3>Пока ничего не скачано</h3><p>Открой плейлист или «Любимые треки» → «…» → «Скачать для офлайна». Можно включить автоскачивание лайков в настройках.</p></div>`;
  wireActions(page, rows, "Скачанное");
  $("#off-mode", page).onclick = () => setOffline(!S.offline);
  $("#off-more", page).onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [
      { icon: "trash-2", label: "Удалить всё скачанное", danger: true, run: async () => {
        const ok = await dialog({ title: "Удалить всё скачанное?", text: `${nTracks(rows.length)} пропадут с диска (${fmtBytes(d.bytes)}). Из медиатеки они не удалятся.`, ok: "Удалить" });
        if (ok) call("offline_remove", { kind: "offline" }).then(() => { toast("Скачанное удалено"); emit("offline-changed"); go("offline", null, { force: true, nohist: true }); }).catch(fail);
      } },
    ]);
  };
  paintDl();
};

function paintDl() {
  const s = S.dl, pill = $("#offline-pill");
  if (pill) {
    pill.classList.toggle("on", S.offline);
    pill.classList.toggle("dl", !!s.active);
    pill.innerHTML = svg(S.offline ? "wifi-off" : s.active ? "circle-arrow-down" : "wifi") + (s.active ? `<span>${s.done}/${s.total}</span>` : "");
    pill.title = s.active ? `Скачиваю: ${s.current || ""}` : S.offline ? "Офлайн-режим включён — играет только скачанное" : "Офлайн-режим: играть только скачанное";
  }
  const box = $("#dl-box"); if (!box) return;
  if (!s.active) { box.innerHTML = ""; return; }
  const frac = s.total ? (s.done + (s.frac || 0)) / s.total : 0;
  box.innerHTML = `<div class="dl-card"><div><b>Скачиваю ${s.done + 1} из ${s.total}</b><span>${esc(s.current || "")}</span>
    <div class="dl-bar"><i style="width:${Math.round(frac * 100)}%"></i></div></div><button class="btn ghost" id="dl-stop">Остановить</button></div>`;
  $("#dl-stop").onclick = () => call("offline_cancel");
}
let dlLastDone = -1;
on("offline", (s) => {
  S.dl = s; paintDl();
  if (s.done !== dlLastDone) {
    dlLastDone = s.done;
    clearTimeout(paintDl._t);
    paintDl._t = setTimeout(() => { emit("offline-changed"); if (route && route.name === "offline" && !s.active) go("offline", null, { force: true, nohist: true, scroll: $("#view").scrollTop }); }, 400);
  }
});
on("offline_mode", (on2) => { S.offline = on2; paintDl(); document.body.classList.toggle("offline", on2); });
function setOffline(on2) {
  return call("offline_mode", { on: on2 }).then(() => {
    toast(on2 ? "Офлайн-режим: играют только скачанные треки, волна — из скачанного" : "Офлайн-режим выключен");
    if (route) go(route.name, route.arg, { force: true, nohist: true, scroll: $("#view").scrollTop });
  }).catch(fail);
}
READY.push((init) => {
  S.offline = !!init.offline;
  document.body.classList.toggle("offline", S.offline);
  $("#offline-pill").onclick = () => setOffline(!S.offline);
  call("offline_status").then((s) => { S.dl = s; paintDl(); }).catch(() => paintDl());
  /* настройки: раздел «Офлайн» */
  const base = PAGES.settings;
  PAGES.settings = async (page, arg, alive) => {
    await base(page, arg, alive);
    if (stale(alive)) return;
    const [st, list] = await Promise.all([call("offline_status"), call("offline_list")]);
    if (stale(alive)) return;
    const content = $(".content", page);
    const anchor = [...$$(".set-sec", page)].find((s) => /Хранилище/.test(s.textContent)) || null;
    const sec = document.createElement("section");
    sec.className = "set-sec";
    sec.innerHTML = `<h2>${svg("circle-arrow-down")}Офлайн</h2><div class="set-card">
      <div class="set-row"><div><b>Офлайн-режим</b><span>Играют только скачанные треки, «Моя волна» собирается из скачанного. Включается и значком Wi‑Fi сверху.</span></div><button class="switch${S.offline ? " on" : ""}" id="off-sw"></button></div>
      <div class="set-row"><div><b>Скачивать лайки автоматически</b><span>Поставил ♥ — трек сразу сохраняется на диск.</span></div><button class="switch${st.auto ? " on" : ""}" id="off-auto"></button></div>
      <div class="set-row"><div><b>Скачано</b><span>${nTracks(list.rows.length)}, ${fmtBytes(list.bytes)}. Файлы лежат в папке Volna и не удаляются при очистке кэша.</span></div>
        <button class="btn ghost" id="off-liked">Скачать «Любимые»</button><button class="btn ghost" data-go="offline">Открыть</button></div></div>`;
    anchor ? content.insertBefore(sec, anchor) : content.append(sec);
    $("#off-sw", sec).onclick = (e) => { const v = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", v); setOffline(v); };
    $("#off-auto", sec).onclick = (e) => { const v = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", v); call("offline_auto", { on: v }); };
    $("#off-liked", sec).onclick = () => call("offline_add", { kind: "liked" }).then((r) => toast(r.added ? `Скачиваю ${nTracks(r.added)}` : "Все любимые уже скачаны")).catch(fail);
  };
});

/* ================= Музыкальная ДНК ================= */
const DNA_COLORS = ["#8fa8ff", "#c38bff", "#ff8fb1", "#ffb86b", "#5fe3a1", "#5fd3ff", "#ffd23f", "#ff7a7a"];
function dnaHelix(genres) {
  const N = 44, W = 880, H = 170, mid = H / 2, amp = 56;
  const colors = [];
  genres.forEach((g, i) => { const k = Math.max(1, Math.round(g.share * N)); for (let j = 0; j < k; j++) colors.push(DNA_COLORS[i % DNA_COLORS.length]); });
  while (colors.length < N) colors.push("rgb(var(--hl) / .25)");
  let rungs = "", a = "", b = "";
  for (let i = 0; i < N; i++) {
    const x = 20 + i * ((W - 40) / (N - 1)), ph = i * 0.42, y1 = mid + amp * Math.sin(ph), y2 = mid - amp * Math.sin(ph);
    const depth = (Math.cos(ph) + 1) / 2;
    rungs += `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${colors[i]}" stroke-width="${4 + depth * 3}" stroke-linecap="round" opacity="${0.45 + depth * 0.55}" style="animation-delay:${(i * 0.04).toFixed(2)}s"/>`;
    a += `<circle cx="${x}" cy="${y1}" r="${3 + depth * 3}" fill="${colors[i]}"/>`;
    b += `<circle cx="${x}" cy="${y2}" r="${3 + (1 - depth) * 3}" fill="${colors[(i + 7) % N]}" opacity=".85"/>`;
  }
  return `<svg class="helix" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${rungs}${a}${b}</svg>`;
}
function meter(label, val, left, right, hint) {
  const v = val == null ? null : Math.max(0, Math.min(100, val));
  return `<div class="dna-meter"><div class="dm-top"><b>${esc(label)}</b><em>${v == null ? "—" : v}</em></div>
    <div class="dm-track"><i style="width:${v == null ? 0 : v}%"></i></div><div class="dm-ends"><span>${esc(left)}</span><span>${esc(right)}</span></div>
    ${hint ? `<p>${esc(hint)}</p>` : ""}</div>`;
}
function bars(items, colorFn) {
  const max = Math.max(0.0001, ...items.map((x) => x.share));
  return items.map((x, i) => `<div class="dna-bar"><span>${esc(x.label)}</span><div><i style="width:${(x.share / max) * 100}%;background:${colorFn(i)}"></i></div><em>${Math.round(x.share * 100)}%</em></div>`).join("");
}
PAGES.dna = async (page, _a, alive) => {
  setTitle("Музыкальная ДНК");
  document.documentElement.style.setProperty("--page-tint", "#7b4fd6");
  $("#view").replaceChildren(Object.assign(document.createElement("div"), { className: "view-in", innerHTML:
    `<div class="wash"></div><div class="content"><div class="dna-loading">${dnaHelix([])}<p>Читаю твою музыкальную ДНК…</p></div></div>` }));
  const d = await call("dna");
  if (stale(alive)) return;
  if (d.empty) {
    page.innerHTML = `<div class="wash"></div><div class="content"><div class="hero" style="min-height:0"><div><div class="kind">Портрет вкуса</div><h1>Музыкальная ДНК</h1></div></div>
      <div class="empty"><h3>Пока мало данных</h3><p>Нужно хотя бы 5 треков, которые ты лайкнул или дослушал. Импортируй медиатеку или послушай волну — и возвращайся.</p><button class="btn white" data-go="import">Добавить музыку</button></div></div>`;
    return;
  }
  const ar = d.archetype;
  page.innerHTML = `<div class="wash"></div><div class="content dna">
    <div class="dna-hero">${dnaHelix(d.genres)}
      <div class="dna-id"><div class="kind">Твоя музыкальная ДНК · ${nTracks(d.n)} в анализе</div><h1>${esc(ar.title)}</h1><p>${esc(ar.text)}${ar.second ? `. А ещё немного — «${esc(ar.second)}»` : ""}.</p>
        <div class="chips-row">${d.genres.slice(0, 5).map((g, i) => `<span class="dna-chip" style="--c:${DNA_COLORS[i % DNA_COLORS.length]}">${esc(g.label)}</span>`).join("")}</div></div></div>
    <div class="dna-grid">
      <div class="dna-tile big"><b>${d.rarity == null ? "?" : d.rarity}</b><span>${esc(d.rarityLabel)}</span>
        <p>${d.medianPlays ? `У типичного трека в твоей медиатеке ~${d.medianPlays.toLocaleString("ru")} прослушиваний на SoundCloud` : "Считаю по числу прослушиваний на SoundCloud — для этого нужен интернет"}</p></div>
      <div class="dna-tile"><b>${d.artistsTotal}</b><span>${plural(d.artistsTotal, "артист", "артиста", "артистов")}</span></div>
      <div class="dna-tile"><b>${d.avgYear || "—"}</b><span>средний год твоих треков</span></div>
      <div class="dna-tile"><b>${esc(d.chrono || "—")}</b><span>когда ты слушаешь больше всего</span></div>
    </div>
    <div class="dna-cols">
      <section class="dna-card">${meter("Андеграунд-метр", d.rarity, "мейнстрим", "андеграунд")}
        ${meter("Всеядность", d.diversity, "один жанр", "всё подряд")}
        ${meter("Верность артистам", d.loyalty, "все понемногу", "свои любимчики")}
        ${meter("Энергия", d.energy, "спокойно", "громко и быстро")}</section>
      <section class="dna-card"><h3>Жанры</h3>${bars(d.genres, (i) => DNA_COLORS[i % DNA_COLORS.length])}
        ${d.decades.length ? `<h3 style="margin-top:22px">Эпохи</h3>${bars(d.decades, () => "var(--lantern)")}` : ""}</section>
    </div>
    ${section("Твоя основа", "Артисты, которые сильнее всего определяют вкус", d.artists.map((a) => card({ art: a.art, title: a.name, sub: `${Math.round(a.share * 100)}% вкуса`, round: true, data: `data-kind="artist" data-key="${esc(a.key)}"` })).join(""))}
    ${d.gems.length ? section("Редкие находки", "Любимые треки, которые мало кто слышал", d.gems.map((t) => card({ art: t.art, title: t.title, sub: `${t.artist} · ${t.plays.toLocaleString("ru")} прослушиваний`, data: `data-kind="track" data-key="${t.id}"` })).join("")) : ""}
    <section class="dna-card dna-friend"><h3>${svg("users")}Сравнить с другом</h3>
      <p>Отправь другу свой код ДНК, а его код вставь сюда — Volna посчитает, насколько совпадают вкусы, и покажет, что послушать у него.</p>
      <div class="dna-actions"><button class="btn white" id="dna-copy">${svg("copy")}Скопировать мой код</button>
        <div class="field"><input id="dna-code" placeholder="VOLNADNA1:… — код друга"></div><button class="btn" id="dna-cmp">Сравнить</button></div>
      <div id="dna-result"></div></section>
  </div>`;
  wireCards(page, {
    artist: (key) => go("artist", key),
    track: (key) => call("play", { ids: [+key], index: 0, context: "Музыкальная ДНК" }).catch(fail),
  });
  $("#dna-copy", page).onclick = async () => {
    const name = await dialog({ title: "Как тебя подписать?", text: "Друг увидит это имя в сравнении.", value: lsGet("dna-name"), ok: "Скопировать код" });
    if (name === null) return;
    try { localStorage.setItem("dna-name", name); } catch (_) { /* */ }
    call("dna_code", { name }).then(() => toast("Код ДНК скопирован — отправь его другу")).catch(fail);
  };
  call("clipboard").then((c) => { const i = $("#dna-code"); if (i && !i.value && (c || "").trim().startsWith("VOLNADNA1:")) i.value = c.trim(); }).catch(() => {});
  $("#dna-cmp", page).onclick = () => {
    const code = $("#dna-code").value.trim();
    if (!code) { toast("Вставь код друга"); return; }
    call("dna_compare", { code }).then(showCompare).catch(fail);
  };
};
function showCompare(c) {
  const box = $("#dna-result"); if (!box) return;
  const part = (l, v) => `<div class="dna-bar"><span>${l}</span><div><i style="width:${v}%;background:var(--tint)"></i></div><em>${v}%</em></div>`;
  box.innerHTML = `<div class="dna-match">
    <div class="ring" style="--p:${c.score}"><b>${c.score}%</b></div>
    <div><div class="kind">Ты и ${esc(c.name)}${c.type ? ` (${esc(c.type)})` : ""}</div><h2>${esc(c.verdict)}</h2>
      ${part("Артисты", c.parts.artists)}${part("Жанры", c.parts.genres)}${part("Эпохи", c.parts.eras)}</div></div>
    ${c.common.length ? `<h4>Вы оба слушаете</h4><div class="chips-row">${c.common.map((n) => `<span class="chip">${esc(n)}</span>`).join("")}</div>` : `<h4>Общих артистов пока нет</h4>`}
    ${c.commonGenres.length ? `<h4>Общие жанры</h4><div class="chips-row">${c.commonGenres.map((n) => `<span class="chip">${esc(n)}</span>`).join("")}</div>` : ""}
    ${c.discover.length ? `<h4>Послушай у ${esc(c.name)}</h4><div class="chips-row">${c.discover.map((a) => `<button class="chip" data-wave="${esc(a.name)}">${svg("radio")}${esc(a.name)}</button>`).join("")}</div>` : ""}`;
  box.onclick = (e) => { const b = e.target.closest("[data-wave]"); if (b) { go("wave"); startWave({ query: b.dataset.wave }); } };
}

/* ================= Вечеринка ================= */
let PARTY = { on: false };
PAGES.party = async (page, _a, alive) => {
  const [p, st] = await Promise.all([call("party_state"), call("settings_get")]);
  if (stale(alive)) return;
  PARTY = p;
  setTitle("Вечеринка");
  document.documentElement.style.setProperty("--page-tint", "#d6457b");
  if (!p.on) {
    page.innerHTML = `<div class="wash"></div><div class="content">
      <div class="party-intro">${svg("party-popper")}
        <div class="kind">Режим вечеринки</div><h1>Музыку выбирают все</h1>
        <p>Гости сканируют QR-код телефоном, ищут треки и кидают их в очередь. Чем больше голосов — тем раньше трек заиграет. Приложения ставить не нужно, хватит браузера.</p>
        <ul><li>${svg("wifi")}Телефоны должны быть в той же Wi‑Fi сети, что и компьютер</li>
          <li>${svg("thumbs-up")}Каждый гость держит в очереди до 3 треков и голосует за чужие</li>
          <li>${svg("skip-forward")}Если половина гостей против трека — он пропускается</li></ul>
        <div class="party-start"><button class="btn white big" id="party-go">${svg("party-popper")}Начать вечеринку</button>
          <label class="party-opt"><button class="switch${st.party_skip !== false ? " on" : ""}" id="party-skip"></button>Голосование за пропуск</label></div>
        <p class="hint">При первом запуске Windows спросит про доступ к сети — разреши для «Частных сетей», иначе телефоны не подключатся.</p></div></div>`;
    $("#party-go", page).onclick = () => { $("#party-go").disabled = true; call("party_start").then((r) => { PARTY = r; paintPartyLive(); go("party", null, { force: true, nohist: true }); toast("Вечеринка началась! Покажи гостям QR-код"); }).catch((e) => { fail(e); $("#party-go").disabled = false; }); };
    $("#party-skip", page).onclick = (e) => { const v = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", v); call("party_allow_skip", { on: v }); };
    return;
  }
  page.innerHTML = `<div class="wash"></div><div class="content party-live">
    <div class="party-qr"><div class="qr-box">${p.qr || ""}</div>
      <div class="kind">Наведи камеру телефона</div><div class="party-url" id="party-url">${esc(p.url)}</div>
      <div class="party-btns"><button class="btn ghost" id="party-copy">${svg("copy")}Ссылка</button><button class="btn ghost" id="party-big">${svg("maximize-2")}На весь экран</button></div>
      <div class="party-guests" id="party-guests"></div>
      <div class="party-btns"><label class="party-opt"><button class="switch${p.allowSkip ? " on" : ""}" id="party-skip"></button>Пропуск голосованием</label></div>
      <button class="btn danger-btn" id="party-stop">Закончить вечеринку</button></div>
    <div class="party-queue"><div class="pq-head"><h2>Очередь гостей</h2><span class="pq-sub">Выше — то, за что больше голосов</span><button class="btn ghost" id="party-clear">Очистить</button></div>
      <div id="party-list"></div></div></div>`;
  $("#party-copy", page).onclick = () => { call("clipboard_set", { text: p.url }).then(() => toast("Ссылка скопирована")).catch(fail); };
  $("#party-big", page).onclick = () => partyFullscreen();
  $("#party-stop", page).onclick = async () => {
    const ok = await dialog({ title: "Закончить вечеринку?", text: "Гости больше не смогут добавлять треки. Музыка продолжит играть.", ok: "Закончить" });
    if (ok) call("party_stop").then(() => { PARTY = { on: false }; paintPartyLive(); go("party", null, { force: true, nohist: true }); });
  };
  $("#party-clear", page).onclick = () => call("party_clear");
  $("#party-skip", page).onclick = (e) => { const v = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", v); call("party_allow_skip", { on: v }); };
  $("#party-list", page).onclick = (e) => {
    const b = e.target.closest("[data-pq-x]"); if (b) call("party_remove", { qid: +b.dataset.pqX });
  };
  paintPartyQueue();
};
function paintPartyQueue() {
  const g = $("#party-guests");
  if (g) g.innerHTML = `<b>${PARTY.guests || 0}</b> ${plural(PARTY.guests || 0, "гость", "гостя", "гостей")} на вечеринке${(PARTY.names || []).length ? `<div class="chips-row">${PARTY.names.map((n) => `<span class="chip">${esc(n)}</span>`).join("")}</div>` : ""}`;
  const el = $("#party-list"); if (!el) return;
  const q = PARTY.queue || [];
  const seen = paintPartyQueue.seen || (paintPartyQueue.seen = new Set());
  el.innerHTML = q.length ? q.map((t, i) => `<div class="pq-row${i === 0 ? " first" : ""}${seen.has(t.qid) ? "" : " new"}">${cover(t.art)}<div class="pq-meta"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)} · от ${esc(t.by)}</div></div>
      <span class="pq-votes">${svg("thumbs-up")}${t.votes}</span><button class="icon-btn" data-pq-x="${t.qid}" title="Убрать">${svg("x")}</button></div>`).join("")
    : `<div class="empty"><h3>Пока пусто</h3><p>Как только гости добавят треки, они появятся здесь и заиграют после текущего.</p></div>`;
  q.forEach((t) => seen.add(t.qid));
}
function partyFullscreen() {
  const m = $("#modal");
  m.innerHTML = `<div class="party-full"><div class="qr-box">${PARTY.qr || ""}</div><h2>Скинь трек в очередь</h2><p>Наведи камеру телефона на QR-код · Wi‑Fi та же, что у компьютера</p><button class="btn white" data-r="0">Закрыть</button></div>`;
  m.classList.add("on");
  m.onclick = (e) => { if (e.target === m || e.target.closest("[data-r]")) { m.classList.remove("on"); m.innerHTML = ""; m.onclick = null; } };
}
function paintPartyLive() { const b = $("#party-live"); if (b) b.hidden = !PARTY.on; }
on("party", (p) => {
  PARTY = p.on ? { ...PARTY, ...p } : { on: false };
  paintPartyLive();
  if (route && route.name === "party") { if (!p.on) go("party", null, { force: true, nohist: true }); else paintPartyQueue(); }
});
READY.push(() => {
  call("party_state").then((p) => { PARTY = p; paintPartyLive(); }).catch(() => {});
  setInterval(() => { if (PARTY.on && route && route.name === "party") call("party_state").then((p) => { PARTY = p; paintPartyQueue(); }).catch(() => {}); }, 4000);
});

/* ================= Аккаунт ================= */
let ME = null;
function accountChip() {
  const brand = $(".brand"); if (!brand || !ME) return;
  let b = $("#acc-chip");
  if (!b) { b = document.createElement("button"); b.id = "acc-chip"; b.className = "acc-chip"; brand.append(b); }
  b.style.setProperty("--c", ME.color);
  b.title = `${ME.name} — аккаунт`;
  b.textContent = (ME.name || "?").trim()[0].toUpperCase();
  b.onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.bottom + 6, [
      { icon: "user", label: ME.name, run: () => go("settings") },
      "-",
      { icon: "users", label: "Сменить аккаунт", run: switchAccount },
    ]);
  };
}
async function switchAccount() {
  const ok = await dialog({ title: "Сменить аккаунт?", text: "Volna покажет экран выбора аккаунта.", ok: "Сменить" });
  if (ok) call("account_switch").catch(fail);
}
function passDialog({ title, text, fields, ok }) {
  return new Promise((resolve) => {
    const m = $("#modal");
    m.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}
      ${fields.map((f, i) => `<div class="field" style="margin-top:10px"><input type="password" data-f="${i}" placeholder="${esc(f)}"></div>`).join("")}
      <div class="btns"><button class="btn ghost" data-r="0">Отмена</button><button class="btn white" data-r="1">${esc(ok)}</button></div></div>`;
    m.classList.add("on");
    const ins = [...m.querySelectorAll("input")]; ins[0] && ins[0].focus();
    const done = (r) => { m.classList.remove("on"); m.innerHTML = ""; m.onclick = m.onkeydown = null; resolve(r); };
    m.onclick = (e) => { if (e.target === m) done(null); const b = e.target.closest("[data-r]"); if (b) done(b.dataset.r === "1" ? ins.map((x) => x.value) : null); };
    m.onkeydown = (e) => { if (e.key === "Enter") done(ins.map((x) => x.value)); if (e.key === "Escape") done(null); };
  });
}
READY.push(() => {
  call("account_info").then((r) => { ME = r.me; accountChip(); }).catch(() => {});
  const base = PAGES.settings;
  PAGES.settings = async (page, arg, alive) => {
    await base(page, arg, alive);
    if (stale(alive)) return;
    const info = await call("account_info").catch(() => null);
    if (stale(alive) || !info || !info.me) return;
    ME = info.me;
    const me = info.me;
    const sec = document.createElement("section");
    sec.className = "set-sec";
    sec.innerHTML = `<h2>${svg("user")}Аккаунт</h2><div class="set-card">
      <div class="set-row"><div class="acc-me"><span class="acc-av" style="--c:${me.color}">${esc(me.name.trim()[0].toUpperCase())}</span>
        <div><b>${esc(me.name)}</b><span>${me.locked ? "Вход по паролю" : "Вход без пароля"} · аккаунтов на этом ${document.body.classList.contains("mobile") ? "телефоне" : "компьютере"}: ${info.all.length}</span></div></div>
        <button class="btn ghost" id="acc-switch">${svg("users")}Сменить аккаунт</button></div>
      <div class="set-row"><div><b>Имя</b><span>Видно на экране выбора аккаунта и в режиме вечеринки.</span></div><button class="btn ghost" id="acc-rename">Изменить</button></div>
      <div class="set-row"><div><b>Пароль</b><span>${me.locked ? "Можно сменить или убрать." : "Без пароля любой, у кого в руках это устройство, войдёт в аккаунт в один клик."}</span></div>
        <button class="btn ghost" id="acc-pass">${me.locked ? "Сменить пароль" : "Поставить пароль"}</button></div>
      <div class="set-row"><div><b>Удалить аккаунт</b><span>Медиатека, лайки, плейлисты и настройки этого аккаунта будут удалены. Другие аккаунты не пострадают.</span></div>
        <button class="btn danger-btn" id="acc-del" style="width:auto;margin:0">Удалить</button></div></div>`;
    const first = $(".set-sec", page);
    first ? first.parentNode.insertBefore(sec, first) : $(".content", page).append(sec);
    $("#acc-switch", sec).onclick = switchAccount;
    $("#acc-rename", sec).onclick = async () => {
      const name = await dialog({ title: "Имя аккаунта", value: me.name }); if (!name) return;
      call("account_rename", { name }).then((a) => { ME = a; accountChip(); toast("Имя изменено"); go("settings", null, { force: true, nohist: true }); }).catch(fail);
    };
    $("#acc-pass", sec).onclick = async () => {
      const f = me.locked ? ["Текущий пароль", "Новый пароль (пусто — убрать)", "Новый пароль ещё раз"] : ["Новый пароль", "Ещё раз"];
      const v = await passDialog({ title: me.locked ? "Сменить пароль" : "Поставить пароль", fields: f, ok: "Сохранить" }); if (!v) return;
      const [old, n1, n2] = me.locked ? v : ["", v[0], v[1]];
      if (n1 !== n2) { toast("Пароли не совпадают", "error"); return; }
      call("account_password", { old, new: n1 }).then(() => { toast(n1 ? "Пароль сохранён" : "Пароль убран"); go("settings", null, { force: true, nohist: true }); }).catch(fail);
    };
    $("#acc-del", sec).onclick = async () => {
      const ok = await dialog({ title: `Удалить аккаунт «${me.name}»?`, text: "Медиатеку и настройки этого аккаунта нельзя будет вернуть. Volna перезапустится.", ok: "Удалить навсегда" });
      if (!ok) return;
      let pw = "";
      if (me.locked) { const v = await passDialog({ title: "Подтверди паролем", fields: ["Пароль"], ok: "Удалить" }); if (!v) return; pw = v[0]; }
      call("account_delete", { password: pw }).catch(fail);
    };
  };
});
