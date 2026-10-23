"use strict";
/* Volna — командная палитра (Ctrl+K), умные плейлисты, обмен с друзьями, Last.fm, обновления. */

/* ================= Командная палитра ================= */
const PAL = { open: false, items: [], sel: 0, seq: 0 };
function palCommands() {
  const cmds = [
    ["Играть / пауза", "play", () => act("toggle")],
    ["Следующий трек", "skip-forward", () => act("next")],
    ["Предыдущий трек", "skip-back", () => act("prev")],
    ["Нравится — текущий трек", "heart", () => likeCurrent()],
    ["Запустить мою волну", "waves", () => startWave()],
    ["Главная", "house", () => go("home")],
    ["Медиатека", "library", () => go("library")],
    ["Любимые треки", "heart", () => go("liked")],
    ["Статистика", "chart-column", () => go("stats")],
    ["Итоги месяца", "sparkles", () => openRecap("month")],
    ["Итоги года", "sparkles", () => openRecap("year")],
    ["Настройки", "settings", () => go("settings")],
    ["Импорт музыки", "download", () => go("import")],
    ["Текст песни", "mic-vocal", () => openRight("lyrics")],
    ["Очередь", "list-video", () => openRight("queue")],
    ["Во весь экран", "maximize-2", () => S.track && $("#now").classList.add("on")],
    ["Мини-плеер", "picture-in-picture-2", () => call("mini")],
    ["Новый плейлист", "plus", () => createPlaylist()],
    ["Новый умный плейлист", "sparkles", () => smartEditor()],
    ["Открыть плейлист друга", "link", () => importFromFriend()],
    ["Выключить таймер сна", "circle-off", () => call("sleep", { cancel: true }).then((st) => onEvent("sleep", JSON.stringify(st)))],
  ];
  if (PAGES.appearance) cmds.push(["Внешний вид", "sliders-horizontal", () => go("appearance")]);
  return cmds.map(([label, icon, run]) => ({ kind: "cmd", label, icon, run }));
}
function palParse(q) {
  // «таймер 30», «волна фонк», «громкость 40»
  const m1 = q.match(/^(таймер|сон|sleep)\s+(\d{1,3})/i);
  if (m1) return [{ kind: "cmd", icon: "moon", label: `Таймер сна: ${m1[2]} мин`, run: () => call("sleep", { minutes: +m1[2] }).then((st) => { onEvent("sleep", JSON.stringify(st)); toast(`Музыка затихнет через ${m1[2]} минут`); }) }];
  const m2 = q.match(/^(волна|wave)\s+(.+)/i);
  if (m2) return [{ kind: "cmd", icon: "waves", label: `Волна: «${m2[2]}»`, run: () => { go("wave"); startWave({ query: m2[2] }); } }];
  const m3 = q.match(/^(громкость|vol)\s+(\d{1,3})/i);
  if (m3) return [{ kind: "cmd", icon: "volume-2", label: `Громкость ${Math.min(100, +m3[2])}%`, run: () => setVol(Math.min(100, +m3[2])) }];
  return [];
}
const fuzzy = (hay, q) => {
  hay = (hay || "").toLowerCase(); q = q.toLowerCase().trim();
  if (!q) return 1;
  if (hay.startsWith(q)) return 3;
  if (hay.includes(q)) return 2;
  return q.split(/\s+/).every((w) => hay.includes(w)) ? 1.5 : 0;
};
async function palSearch(q) {
  const seq = ++PAL.seq;
  let items = palParse(q);
  const cmds = palCommands().map((c) => [c, fuzzy(c.label, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const pls = (S.playlists || []).map((p) => ({ kind: "pl", label: p.name, sub: "Плейлист", icon: "list-music", run: () => go("playlist", p.id) }))
    .concat((S.smart || []).map((p) => ({ kind: "pl", label: p.name, sub: "Умный плейлист", icon: "sparkles", run: () => go("smart", p.id) })))
    .filter((p) => fuzzy(p.label, q) > 0);
  items = items.concat(q ? cmds.slice(0, 5) : cmds.slice(0, 8), pls.slice(0, 5));
  render();
  if (q.trim().length >= 2) {
    const rows = await call("library", { search: q.trim() }).catch(() => []);
    if (seq !== PAL.seq || !PAL.open) return;
    const artists = [], seen = new Set();
    rows.forEach((t) => { if (!seen.has(t.ak) && fuzzy(t.artist, q) > 0) { seen.add(t.ak); artists.push(t); } });
    items = items.concat(
      artists.slice(0, 3).map((t) => ({ kind: "artist", label: t.artist, sub: "Исполнитель", art: t.art, round: true, run: () => go("artist", t.ak) })),
      rows.slice(0, 8).map((t, i) => ({ kind: "track", label: t.title, sub: t.artist, art: t.art, run: () => playRows(rows, i, `Поиск: ${q}`) })),
      [{ kind: "cmd", icon: "search", label: `Искать «${q.trim()}» на SoundCloud`, run: () => { $("#q").value = q.trim(); go("search", q.trim()); } }],
    );
    render();
  }
  function render() {
    if (!PAL.open) return;
    PAL.items = items; PAL.sel = Math.min(PAL.sel, Math.max(0, items.length - 1));
    $("#pal-list").innerHTML = items.map((it, i) => `<button class="pal-it${i === PAL.sel ? " on" : ""}" data-i="${i}">
      ${it.art !== undefined ? cover(it.art, it.round ? "round" : "") : `<span class="pal-ic">${svg(it.icon || "music")}</span>`}
      <span class="pal-tx"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span><kbd>Enter</kbd></button>`).join("")
      || `<div class="pal-empty">Ничего не нашлось. Попробуй «таймер 30» или «волна фонк».</div>`;
  }
}
function openPalette() {
  if (PAL.open) return;
  closeMenu();
  PAL.open = true; PAL.sel = 0;
  const el = document.createElement("div");
  el.id = "palette";
  el.innerHTML = `<div class="pal-box"><div class="pal-in">${svg("search")}<input id="pal-q" placeholder="Трек, плейлист или команда — например «таймер 30»" autocomplete="off"><kbd>Esc</kbd></div><div id="pal-list"></div>
    <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> выполнить</span><span>«волна фонк», «таймер 30», «громкость 40»</span></div></div>`;
  document.body.append(el);
  const q = $("#pal-q");
  q.focus();
  palSearch("");
  let t = 0;
  q.addEventListener("input", () => { clearTimeout(t); PAL.sel = 0; t = setTimeout(() => palSearch(q.value), 110); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!PAL.items.length) return;
      PAL.sel = (PAL.sel + (e.key === "ArrowDown" ? 1 : -1) + PAL.items.length) % PAL.items.length;
      $$(".pal-it").forEach((b, i) => { b.classList.toggle("on", i === PAL.sel); if (i === PAL.sel) b.scrollIntoView({ block: "nearest" }); });
    } else if (e.key === "Enter") { e.preventDefault(); palRun(PAL.sel); }
    else if (e.key === "Escape") { e.stopPropagation(); closePalette(); }
  });
  el.addEventListener("mousedown", (e) => { if (e.target === el) closePalette(); });
  $("#pal-list").addEventListener("click", (e) => { const b = e.target.closest(".pal-it"); if (b) palRun(+b.dataset.i); });
  $("#pal-list").addEventListener("mousemove", (e) => {
    const b = e.target.closest(".pal-it"); if (!b || +b.dataset.i === PAL.sel) return;
    PAL.sel = +b.dataset.i; $$(".pal-it").forEach((x, i) => x.classList.toggle("on", i === PAL.sel));
  });
}
function palRun(i) { const it = PAL.items[i]; closePalette(); if (it) Promise.resolve().then(it.run).catch(fail); }
function closePalette() { PAL.open = false; const el = $("#palette"); if (el) el.remove(); }
addEventListener("keydown", (e) => {
  if (PAL.open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePalette(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === "KeyK")) {
    if ($("#modal").classList.contains("on") || $("#recap").classList.contains("on")) return;
    e.preventDefault(); e.stopPropagation();
    PAL.open ? closePalette() : openPalette();
  }
}, true);

/* ================= Умные плейлисты ================= */
let SMART_SCHEMA = null;
async function smartSchema() { if (!SMART_SCHEMA) SMART_SCHEMA = await call("smart_schema"); return SMART_SCHEMA; }
PAGES.smart = async (page, sid, alive) => {
  await smartSchema();
  const sp = await call("smart_get", { sid });
  if (stale(alive)) return;
  setTitle(sp.name);
  pageTintFrom(sp.arts[0]);
  page.innerHTML = `<div class="wash"></div><div class="content">
    ${collectionHero({ kind: "Умный плейлист — обновляется сам", title: sp.name, meta: `${nTracks(sp.rows.length)}${sp.rows.length ? `, ${totalDur(sp.rows)}` : ""}<br><span class="smart-rules">${esc(describeRules(sp.rules))}</span>`, pic: smartCover(sp.arts) })}
    ${actionsBar(sp.rows, sp.name, `<button class="btn ghost" id="sm-edit">${svg("pencil")}Изменить правила</button><button class="icon-btn" id="sm-more" title="Ещё">${svg("ellipsis")}</button>`)}
    <div id="rows"></div></div>`;
  if (sp.rows.length) trackList($("#rows", page), sp.rows, { ctx: sp.name, drag: false });
  else $("#rows", page).innerHTML = `<div class="empty"><h3>Под правила пока ничего не подходит</h3><p>Измени условия — или послушай побольше, плейлист наполнится сам.</p></div>`;
  wireActions(page, sp.rows, sp.name);
  $("#sm-edit", page).onclick = () => smartEditor(sp);
  $("#sm-more", page).onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, smartMenu(sp)); };
};
function smartCover(arts) { return `<div class="smart-cover">${mosaic(arts)}<span>${svg("sparkles")}</span></div>`; }
function smartMenu(sp) {
  return [
    { icon: "play", label: "Слушать", run: () => call("smart_get", { sid: sp.id }).then((r) => playRows(r.rows, 0, sp.name)) },
    { icon: "pencil", label: "Изменить правила", run: () => call("smart_get", { sid: sp.id }).then((r) => smartEditor(r)) },
    "-",
    ...shareItems("smart", sp.id),
    "-",
    { icon: "trash-2", label: "Удалить", danger: true, run: async () => {
      const ok = await dialog({ title: "Удалить умный плейлист?", text: `«${sp.name}» исчезнет. Треки останутся в медиатеке.`, ok: "Удалить" });
      if (ok) { await call("smart_delete", { sid: sp.id }); toast("Умный плейлист удалён"); emit("playlists-changed"); if (route.name === "smart") go("home"); }
    } },
  ];
}
function describeRules(rules) {
  if (!SMART_SCHEMA || !rules) return "";
  const f = Object.fromEntries(SMART_SCHEMA.fields.map((x) => [x.key, x]));
  const parts = (rules.rules || []).map((r) => {
    const fd = f[r.field]; if (!fd) return "";
    if (fd.type === "bool") return `${fd.label.toLowerCase()}: ${r.op === "is" === !!r.value ? "да" : "нет"}`;
    const op = (SMART_SCHEMA.ops[fd.type] || {})[r.op] || "";
    let v = r.value;
    if (fd.type === "enum") v = (SMART_SCHEMA.sources.find((s) => s.key === v) || {}).label || v;
    if (fd.type === "days" || fd.type === "days_not") return `${fd.label.replace(/ \(дней\)/, "").toLowerCase()} ${v} дн.`;
    return `${fd.label.toLowerCase()} ${op} ${v}`;
  }).filter(Boolean);
  return (parts.join(rules.match === "any" ? " или " : ", ") || "все треки медиатеки").replace(/^./, (c) => c.toUpperCase());
}
async function smartEditor(sp = null) {
  const sch = await smartSchema();
  const state = sp ? JSON.parse(JSON.stringify(sp.rules)) : { match: "all", rules: [{ field: "liked", op: "is", value: true }], sort: "added", limit: 100 };
  let name = sp ? sp.name : "Умный плейлист";
  const m = $("#modal");
  const fieldOpts = (sel) => sch.fields.map((f) => `<option value="${f.key}"${f.key === sel ? " selected" : ""}>${esc(f.label)}</option>`).join("");
  const ruleRow = (r, i) => {
    const fd = sch.fields.find((f) => f.key === r.field) || sch.fields[0];
    const ops = sch.ops[fd.type];
    let val = "";
    if (fd.type === "enum") val = `<select data-k="value">${sch.sources.map((s) => `<option value="${s.key}"${s.key === r.value ? " selected" : ""}>${esc(s.label)}</option>`).join("")}</select>`;
    else if (fd.type === "text") val = `<input data-k="value" value="${esc(r.value ?? "")}" placeholder="например, phonk">`;
    else if (fd.type !== "bool") val = `<input data-k="value" type="number" min="0" step="${fd.type === "minutes" ? "0.5" : "1"}" value="${esc(r.value ?? 30)}">`;
    return `<div class="sm-rule" data-i="${i}"><select data-k="field">${fieldOpts(fd.key)}</select>
      <select data-k="op">${Object.entries(ops).map(([k, l]) => `<option value="${k}"${k === r.op ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
      ${val || "<span></span>"}<button class="icon-btn" data-rm title="Убрать условие">${svg("x")}</button></div>`;
  };
  const draw = () => {
    m.innerHTML = `<div class="dialog sm-dialog"><h3>${sp ? "Правила плейлиста" : "Новый умный плейлист"}</h3>
      ${sp ? "" : `<div class="chips-row" id="sm-presets" style="margin-bottom:14px">${sch.presets.map((p, i) => `<button class="chip" data-p="${i}">${esc(p.name)}</button>`).join("")}</div>`}
      <div class="field" style="margin-bottom:14px"><input id="sm-name" value="${esc(name)}" maxlength="100"></div>
      <div class="sm-match">Подходят треки, где выполняется <select id="sm-match"><option value="all"${state.match !== "any" ? " selected" : ""}>каждое условие</option><option value="any"${state.match === "any" ? " selected" : ""}>хотя бы одно</option></select></div>
      <div id="sm-rules">${state.rules.map(ruleRow).join("")}</div>
      <button class="btn ghost" id="sm-add" style="margin-top:8px">${svg("plus")}Добавить условие</button>
      <div class="sm-row2"><label>Порядок <select id="sm-sort">${sch.sorts.map((s) => `<option value="${s.key}"${s.key === state.sort ? " selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
        <label>Не больше <input id="sm-limit" type="number" min="1" max="2000" value="${state.limit || 100}"> треков</label></div>
      <div class="sm-preview" id="sm-preview">Считаю…</div>
      <div class="btns"><button class="btn ghost" data-r="0">Отмена</button><button class="btn white" data-r="1">${sp ? "Сохранить" : "Создать"}</button></div></div>`;
    m.classList.add("on");
    preview();
  };
  let pt = 0;
  const preview = () => { clearTimeout(pt); pt = setTimeout(() => call("smart_preview", { rules: state }).then((r) => {
    const el = $("#sm-preview"); if (!el) return;
    el.innerHTML = `<b>${nTracks(r.n)}</b><span>${r.sample.length ? r.sample.map(esc).join("<br>") : "Пока ничего не подходит"}</span>`;
  }).catch(() => {}), 200); };
  draw();
  const onField = (e) => {
    const t = e.target;
    if (t.id === "sm-name") { name = t.value; return; }
    if (t.id === "sm-match") state.match = t.value;
    else if (t.id === "sm-sort") state.sort = t.value;
    else if (t.id === "sm-limit") state.limit = +t.value || 100;
    else if (t.dataset.k) {
      const row = t.closest(".sm-rule"), r = state.rules[+row.dataset.i];
      if (t.dataset.k === "field") {
        if (e.type !== "change") return;
        const fd = sch.fields.find((f) => f.key === t.value);
        r.field = t.value; r.op = Object.keys(sch.ops[fd.type])[0];
        r.value = fd.type === "bool" ? true : fd.type === "enum" ? "spotify" : fd.type === "text" ? "" : 30;
        draw(); return;
      }
      r[t.dataset.k] = t.type === "number" ? +t.value : t.value;
    }
    preview();
  };
  m.oninput = onField; m.onchange = onField;
  m.onclick = async (e) => {
    if (e.target === m) { close(); return; }
    const pr = e.target.closest("[data-p]");
    if (pr) { const p = sch.presets[+pr.dataset.p]; Object.assign(state, JSON.parse(JSON.stringify(p.rules))); name = p.name; draw(); return; }
    if (e.target.closest("#sm-add")) { state.rules.push({ field: "genre", op: "contains", value: "" }); draw(); return; }
    const rm = e.target.closest("[data-rm]"); if (rm) { state.rules.splice(+rm.closest(".sm-rule").dataset.i, 1); draw(); return; }
    const b = e.target.closest("[data-r]"); if (!b) return;
    if (b.dataset.r === "0") { close(); return; }
    const id = await call("smart_save", { name, rules: state, sid: sp ? sp.id : null }).catch(fail);
    if (!id) return;
    close(); emit("playlists-changed"); toast(sp ? "Правила сохранены" : "Умный плейлист создан");
    go("smart", id, { force: true, nohist: !!sp });
  };
  m.onkeydown = (e) => { if (e.key === "Escape") close(); };
  function close() { m.classList.remove("on"); m.innerHTML = ""; m.oninput = m.onchange = m.onclick = m.onkeydown = null; }
}

/* ================= Обмен с друзьями ================= */
function shareItems(kind, key) {
  return [
    { icon: "link", label: "Поделиться кодом", run: () => call("share_code", { kind, key }).then((r) => {
      toast(`Код скопирован (${nTracks(r.tracks)}) — отправь его другу, он вставит его в Volna`, "info", 4500);
    }).catch(fail) },
    { icon: "download", label: "Сохранить файлом .volna", run: () => call("share_file", { kind, key }).then((r) => { if (r) toast("Файл сохранён — отправь его другу"); }).catch(fail) },
  ];
}
async function importFromFriend() {
  let clip = "";
  try { clip = await call("clipboard"); } catch (_) { /* */ }
  const pre = clip && clip.trim().startsWith("VOLNA1:") ? clip.trim() : "";
  const m = $("#modal");
  m.innerHTML = `<div class="dialog"><h3>Плейлист от друга</h3><p>Вставь код, который прислал друг, или открой файл .volna.${pre ? " Код из буфера обмена уже вставлен." : ""}</p>
    <div class="field"><input id="fr-code" placeholder="VOLNA1:…" value="${esc(pre)}"></div>
    <div class="btns"><button class="btn ghost" data-r="file">${svg("file-archive")}Открыть файл</button><span style="flex:1"></span><button class="btn ghost" data-r="0">Отмена</button><button class="btn white" data-r="1">Добавить</button></div></div>`;
  m.classList.add("on");
  $("#fr-code").focus();
  const close = () => { m.classList.remove("on"); m.innerHTML = ""; m.onclick = m.onkeydown = null; };
  const done = (r) => { if (!r) return; close(); toast(`Добавлено: «${r.name}», ${nTracks(r.tracks)}`); emit("playlists-changed"); go("playlist", r.pid); };
  m.onkeydown = (e) => { if (e.key === "Escape") close(); if (e.key === "Enter") m.querySelector('[data-r="1"]').click(); };
  m.onclick = (e) => {
    if (e.target === m) { close(); return; }
    const b = e.target.closest("[data-r]"); if (!b) return;
    if (b.dataset.r === "0") close();
    else if (b.dataset.r === "file") call("share_import", {}).then(done).catch(fail);
    else { const code = $("#fr-code").value.trim(); if (code) call("share_import", { code }).then(done).catch(fail); }
  };
}

/* ================= Настройки: Last.fm и обновления ================= */
READY.push(() => {
  const base = PAGES.settings;
  PAGES.settings = async (page, arg, alive) => {
    await base(page, arg, alive);
    if (stale(alive)) return;
    const content = $(".content", page);
    const anchor = [...$$(".set-sec", page)].find((s) => /Хранилище/.test(s.textContent)) || null;
    const tmp = document.createElement("div");
    tmp.innerHTML = `<section class="set-sec"><h2>${svg("audio-lines")}Last.fm</h2><div class="set-card" id="lfm-card"><div class="set-row"><div><b>Загружаю…</b></div></div></div></section>
      <section class="set-sec"><h2>${svg("refresh-cw")}Обновления</h2><div class="set-card" id="upd-card"></div></section>`;
    [...tmp.children].forEach((ch) => (anchor ? content.insertBefore(ch, anchor) : content.append(ch)));
    setTimeout(() => { paintLastfm(); paintUpdates(); });
  };
});
async function paintLastfm() {
  const card = $("#lfm-card"); if (!card) return;
  const st = await call("lfm_status").catch(() => null);
  if (!st || !$("#lfm-card")) return;
  if (!st.configured) {
    card.innerHTML = `<div class="set-row"><div><b>Скробблинг и умные рекомендации</b><span>Volna будет отправлять прослушивания в твой профиль Last.fm, а оттуда брать похожих артистов — волна станет разнообразнее.</span>
      <div class="set-help">Last.fm выдаёт ключи бесплатно, это пара минут:<ol><li>Открой last.fm/api/account/create (нужен аккаунт Last.fm)</li><li>В поле «Application name» напиши Volna, остальное можно не заполнять</li><li>Скопируй «API key» и «Shared secret» сюда</li></ol></div></div></div>
      <div class="set-row"><div class="field"><input id="lfm-key" placeholder="API key — 32 символа"></div><div class="field"><input id="lfm-secret" placeholder="Shared secret — 32 символа"></div>
        <button class="btn white" id="lfm-save">Сохранить</button></div>`;
    $("#lfm-save").onclick = () => call("lfm_set", { key: $("#lfm-key").value, secret: $("#lfm-secret").value }).then(() => { toast("Ключи сохранены — теперь войди в Last.fm"); paintLastfm(); }).catch(fail);
    return;
  }
  if (!st.logged) {
    card.innerHTML = `<div class="set-row"><div><b>Войди в Last.fm</b><span>Откроется браузер — подтверди доступ для Volna, вернись сюда и нажми «Я подтвердил».</span></div>
      <button class="btn white" id="lfm-login">Войти</button><button class="btn" id="lfm-done" hidden>Я подтвердил</button></div>
      <div class="set-row"><div><b>Похожие артисты в волне</b><span>Уже работают — для них хватает ключа (${esc(st.key)}).</span></div><span class="badge-ok">Включено</span></div>`;
    $("#lfm-login").onclick = () => call("lfm_login").then(() => { $("#lfm-done").hidden = false; toast("Подтверди доступ в браузере, потом нажми «Я подтвердил»", "info", 5000); }).catch(fail);
    $("#lfm-done").onclick = () => call("lfm_finish").then((r) => { toast(`Готово, ${r.user}!`); paintLastfm(); }).catch(fail);
    return;
  }
  const pr = st.profile || {};
  const sw = (key, on) => `<button class="switch${on ? " on" : ""}" data-lsw="${key}"></button>`;
  const all = await call("settings_get");
  card.innerHTML = `<div class="set-row"><div class="lfm-me">${pr.image ? cover(pr.image, "round") : ""}<div><b>${esc(pr.name || st.user)}</b><span>${pr.playcount ? `${pr.playcount.toLocaleString("ru")} скробблов` : "Подключено"}${st.pending ? `, ждут отправки: ${st.pending}` : ""}</span></div></div>
      <button class="btn ghost" id="lfm-out">Выйти</button></div>
    <div class="set-row"><div><b>Отправлять прослушивания</b><span>Трек засчитывается, если ты послушал половину или 4 минуты.</span></div>${sw("lastfm_scrobble", all.lastfm_scrobble !== false)}</div>
    <div class="set-row"><div><b>Лайки → «Любимые» на Last.fm</b><span>♥ в Volna ставит сердечко и там.</span></div>${sw("lastfm_love", all.lastfm_love !== false)}</div>`;
  $("#lfm-out").onclick = () => call("lfm_logout").then(paintLastfm);
  card.onclick = (e) => { const s = e.target.closest("[data-lsw]"); if (!s) return; const on2 = !s.classList.contains("on"); s.classList.toggle("on", on2); call("settings_set", { key: s.dataset.lsw, value: on2 }); };
}
async function paintUpdates() {
  const card = $("#upd-card"); if (!card) return;
  const st = await call("settings_get");
  card.innerHTML = `<div class="set-row"><div><b>Volna ${esc(window.VOLNA_VERSION || "")}</b><span id="upd-state">Обновления берутся из релизов на GitHub, куда ты выкладываешь установщик.</span></div>
      <button class="btn white" id="upd-check">Проверить</button></div>
    <div class="set-row"><div><b>Репозиторий GitHub</b><span>Например «egor/volna». У друзей с этим же адресом обновления будут приходить сами.</span></div>
      <div class="field" style="max-width:240px;flex:none"><input id="upd-repo" placeholder="логин/репозиторий" value="${esc(st.update_repo || "")}"></div></div>
    <div class="set-row"><div><b>Проверять при запуске</b></div><button class="switch${st.update_auto !== false ? " on" : ""}" id="upd-auto"></button></div>`;
  let t = 0;
  $("#upd-repo").oninput = (e) => { clearTimeout(t); t = setTimeout(() => call("settings_set", { key: "update_repo", value: e.target.value.trim() }), 400); };
  $("#upd-auto").onclick = (e) => { const on2 = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", on2); call("settings_set", { key: "update_auto", value: on2 }); };
  $("#upd-check").onclick = () => {
    $("#upd-state").textContent = "Проверяю…";
    call("update_check").then((r) => {
      const s = $("#upd-state"); if (!s) return;
      if (!r.configured) s.textContent = "Сначала укажи репозиторий GitHub.";
      else if (r.available && !r.installed) s.innerHTML = `Вышла версия <b>${esc(r.latest)}</b> — ты запускаешь Volna из исходников, просто обнови файлы проекта.`;
      else if (r.available) { s.innerHTML = `Доступна версия <b>${esc(r.latest)}</b>`; showUpdate(r); }
      else s.textContent = r.note || `У тебя последняя версия (${r.current}).`;
    }).catch((e) => { const s = $("#upd-state"); if (s) s.textContent = e.message; });
  };
}
function showUpdate(info) {
  if ($("#upd-banner")) return;
  const b = document.createElement("div");
  b.id = "upd-banner";
  b.innerHTML = `${svg("sparkles")}<div><b>Вышла Volna ${esc(info.latest)}</b><span>${esc((info.notes || "Новая версия готова к установке").split("\n")[0].slice(0, 120))}</span></div>
    <button class="btn white" id="upd-go">Обновить</button><button class="icon-btn" id="upd-x" title="Позже">${svg("x")}</button>`;
  document.body.append(b);
  $("#upd-x").onclick = () => b.remove();
  $("#upd-go").onclick = () => {
    $("#upd-go").disabled = true; $("#upd-go").textContent = "Скачиваю…";
    call("update_install", {}).then(() => toast("Устанавливаю — Volna перезапустится")).catch((e) => { fail(e); b.remove(); });
  };
}
on("update", showUpdate);
on("progress", ({ task, frac }) => { if (task === "update") { const g = $("#upd-go"); if (g) g.textContent = `Скачиваю ${Math.round(frac * 100)}%`; } });
READY.push((init) => { window.VOLNA_VERSION = init.version; });
