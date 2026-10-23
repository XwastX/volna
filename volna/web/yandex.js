"use strict";
/* Volna — Яндекс Музыка: вход, импорт, настройки. Подключается до pages.js,
   поэтому страницы «Импорт» и «Настройки» оборачиваем уже после запуска (READY). */

const YM = { st: null, busy: false };
const YM_COLOR = "#ffcc00";

function ymStatus(force = false) {
  if (YM.st && !force) return Promise.resolve(YM.st);
  return call("ym_status").then((s) => (YM.st = s)).catch((e) => (YM.st = { available: false, logged: false, error: e.message }));
}
function ymRefresh() { $$("[data-ym-slot]").forEach((el) => ymRenderSlot(el)); }
function ymAvatar(st) {
  const letter = esc((st.name || "Я").slice(0, 1).toUpperCase());
  return `<div class="ym-ava" style="position:relative;width:44px;height:44px;flex:none;border-radius:50%;overflow:hidden;display:grid;place-items:center;background:${YM_COLOR};color:#111;font-weight:800">${letter}${
    st.avatar ? `<img src="${esc(st.avatar)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="this.remove()">` : ""}</div>`;
}

async function ymLogin(btn) {
  if (btn) btn.disabled = true;
  try {
    const info = await call("ym_login");
    if (!info) return;                       // окно закрыли
    YM.st = { ...(YM.st || {}), ...info };
    toast(`Вход выполнен: ${info.name}`);
    if (!info.plus) toast("Похоже, у аккаунта нет Плюса — Яндекс отдаст только 30-секундные превью", "error", 7000);
    ymRefresh();
  } catch (e) { fail(e); } finally { if (btn) btn.disabled = false; }
}
async function ymManual(input, btn) {
  const token = input.value.trim(); if (!token) { input.focus(); return; }
  btn.disabled = true;
  try {
    const info = await call("ym_token", { token });
    YM.st = { ...(YM.st || {}), ...info };
    input.value = "";
    toast(`Вход выполнен: ${info.name}`);
    ymRefresh();
  } catch (e) { fail(e); } finally { btn.disabled = false; }
}
async function ymLogout() {
  const ok = await dialog({ title: "Выйти из Яндекс Музыки?", text: "Импортированные треки останутся в медиатеке, но играть из Яндекса они не будут.", ok: "Выйти" });
  if (!ok) return;
  YM.st = await call("ym_logout").catch(fail) || { logged: false };
  ymRefresh();
}
function ymImport(btn) {
  if (YM.busy) return;
  YM.busy = true; btn.disabled = true;
  ymProg(true, "Подключаюсь к Яндекс Музыке…");
  call("ym_import").then((r) => {
    ymProg(false, `Готово: «Мне нравится» — ${nTracks(r.liked)}, плейлистов ${r.playlists}.`);
    toast("Музыка из Яндекса добавлена");
    emit("library-changed"); emit("playlists-changed");
    if (typeof refreshNums === "function") refreshNums();
  }).catch((e) => { ymProg(false); fail(e); ymStatus(true).then(ymRefresh); })
    .finally(() => { YM.busy = false; btn.disabled = false; });
}
function ymProg(on, text = "") {
  const bar = $("#ym-prog"); if (!bar) return;
  bar.classList.toggle("on", on); if (on) $("i", bar).style.width = "0";
  const t = $("#ym-text"); if (t) t.textContent = text;
}
on("progress", ({ task, frac, text }) => {
  if (task !== "ym") return;
  const bar = $("#ym-prog"); if (!bar) return;
  bar.classList.add("on"); $("i", bar).style.width = (frac * 100).toFixed(1) + "%";
  if (text) $("#ym-text").textContent = text;
});
on("ym", (info) => { YM.st = { ...(YM.st || {}), ...info }; if (!info.logged) YM.st.logged = false; ymRefresh(); });

/* ---------- блок входа/аккаунта (общий для «Импорта» и «Настроек») ---------- */
function ymRenderSlot(el) {
  const st = YM.st || { logged: false };
  const kind = el.dataset.ymSlot;
  if (!st.available) {
    el.innerHTML = `<p class="sub">Не установлена библиотека <b>yandex-music</b>. Запусти run.bat ещё раз — он доставит её.</p>`;
    return;
  }
  if (!st.logged) {
    el.innerHTML = `${st.error ? `<p class="sub" style="color:#ff7a7a">${esc(st.error)}</p>` : ""}
      <div class="line"><button class="btn white" data-ym="login">${svg("user")}Войти через Яндекс</button>
        <button class="btn ghost" data-ym="manual-toggle">Вставить токен вручную</button></div>
      <div class="line ym-manual" style="display:none;margin-top:10px"><div class="field">${svg("link")}<input data-ym-token placeholder="Токен или адрес с access_token=…"></div>
        <button class="btn" data-ym="manual">Сохранить</button></div>`;
  } else {
    const acc = `<div class="ym-acc" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">${ymAvatar(st)}
        <div style="min-width:0"><b>${esc(st.name || "Яндекс")}</b>
          <div class="sub" style="margin:2px 0 0">${st.offline ? "нет связи с Яндексом" : st.plus ? "Яндекс Плюс активен" : "без Плюса — только превью"}${st.login ? " · " + esc(st.login) : ""}</div></div></div>`;
    el.innerHTML = kind === "import"
      ? `${acc}<div class="line" style="margin-top:12px"><button class="btn white" data-ym="import"${YM.busy ? " disabled" : ""}>${svg("download")}Импортировать лайки и плейлисты</button>
          <button class="btn ghost" data-ym="logout">Выйти</button></div>`
      : `<div style="display:flex;align-items:center;gap:12px">${acc}<button class="btn ghost" data-ym="logout">Выйти</button></div>`;
  }
}
function ymWireSlot(el) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ym]"); if (!b) return;
    const act = b.dataset.ym;
    if (act === "login") ymLogin(b);
    else if (act === "logout") ymLogout();
    else if (act === "import") ymImport(b);
    else if (act === "manual-toggle") { const m = $(".ym-manual", el); m.style.display = m.style.display === "none" ? "" : "none"; $("[data-ym-token]", el)?.focus(); }
    else if (act === "manual") ymManual($("[data-ym-token]", el), b);
  });
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-ym-token]")) $("[data-ym=manual]", el)?.click(); });
}

/* ---------- «Импорт» ---------- */
function ymImportBox() {
  const box = document.createElement("div");
  box.className = "box ym-box";
  box.style.marginTop = "14px";
  box.innerHTML = `<h3><span class="dot" style="background:${YM_COLOR}"></span>Яндекс Музыка</h3>
    <p class="sub">Войди своим аккаунтом с Плюсом — подтянутся «Мне нравится» и твои плейлисты, а звук пойдёт прямо из Яндекса в высоком качестве.</p>
    <div data-ym-slot="import"></div>
    <div class="prog${YM.busy ? " on" : ""}" id="ym-prog"><i></i></div><p class="prog-text" id="ym-text"></p>`;
  const slot = $("[data-ym-slot]", box);
  ymRenderSlot(slot); ymWireSlot(slot);
  return box;
}

/* ---------- «Настройки» ---------- */
function ymSettingsSec() {
  const st = YM.st || {};
  const sec = document.createElement("section");
  sec.className = "set-sec ym-sec";
  const sw = (key, on) => `<button class="switch${on ? " on" : ""}" data-ym-sw="${key}" role="switch" aria-checked="${on}"></button>`;
  const ws = st.waveSource || "volna";
  sec.innerHTML = `<h2>${svg("music")}Яндекс Музыка</h2><div class="set-card">
    <div class="set-row"><div><b>Аккаунт</b><span>Вход нужен, чтобы импортировать лайки и плейлисты и слушать треки из Яндекса.</span></div></div>
    <div data-ym-slot="settings" style="padding:0 0 12px"></div>
    <div class="set-row"><div><b>Играть из Яндекса, если трек там есть</b><span>Иначе звук берётся с SoundCloud. Если Яндекс не отдал трек — приложение само попробует SoundCloud.</span></div>${sw("ym_prefer", st.prefer !== false)}</div>
    <div class="set-row"><div><b>Источник «Моей волны»</b><span>Volna подбирает треки сама по твоей медиатеке. Яндекс — это их «Моя волна» с учётом всей истории в Яндекс Музыке.</span></div>
      <div class="chips-row" data-ym-ws style="flex:none">
        <button class="chip${ws === "volna" ? " on" : ""}" data-ws="volna">Volna</button>
        <button class="chip${ws === "yandex" ? " on" : ""}" data-ws="yandex">Яндекс</button></div></div>
  </div>`;
  const slot = $("[data-ym-slot]", sec);
  ymRenderSlot(slot); ymWireSlot(slot);
  sec.addEventListener("click", (e) => {
    const s2 = e.target.closest("[data-ym-sw]");
    if (s2) {
      const on2 = !s2.classList.contains("on"); s2.classList.toggle("on", on2); s2.setAttribute("aria-checked", on2);
      call("ym_set", { key: s2.dataset.ymSw, value: on2 }).then((v) => { if (YM.st) YM.st.prefer = v; })
        .catch((err) => { s2.classList.toggle("on", !on2); fail(err); });
      return;
    }
    const c = e.target.closest("[data-ws]");
    if (c) {
      call("ym_set", { key: "wave_source", value: c.dataset.ws }).then((v) => {
        if (YM.st) YM.st.waveSource = v;
        $$("[data-ws]", sec).forEach((x) => x.classList.toggle("on", x.dataset.ws === v));
        toast(v === "yandex" ? "Волна теперь от Яндекса — запусти её заново" : "Волна снова своя — запусти её заново");
      }).catch(fail);
    }
  });
  return sec;
}

READY.push(() => {
  const origImport = PAGES.import;
  if (origImport) {
    PAGES.import = async (page, arg, alive) => {
      await Promise.all([origImport(page, arg, alive), ymStatus(true)]);
      if (!alive() || !page.querySelector(".content")) return;
      const box = ymImportBox();
      const after = page.querySelector(".sources");
      after ? after.after(box) : page.querySelector(".content").append(box);
      if (YM.st && YM.st.logged) { const m = page.querySelector(".hero .meta"); if (m) m.textContent = "Звук идёт из Яндекс Музыки, а если трека там нет — с SoundCloud."; }
    };
  }
  const origSettings = PAGES.settings;
  if (origSettings) {
    PAGES.settings = async (page, arg, alive) => {
      await Promise.all([origSettings(page, arg, alive), ymStatus(true)]);
      if (!alive() || !page.querySelector(".content")) return;
      const sec = ymSettingsSec();
      const anchor = $$(".set-sec", page).find((x) => /Хранилище/.test(x.textContent));
      anchor ? anchor.before(sec) : page.querySelector(".content").append(sec);
    };
  }
});
