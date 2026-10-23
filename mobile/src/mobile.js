"use strict";
/* Volna Mobile — оболочка интерфейса для телефона: вход в аккаунт, нижние вкладки, «Медиатека», «Ещё»,
   кнопка «Назад» Android. Всё остальное — тот же интерфейс, что на ПК (core.js, pages.js, …). */
document.body.classList.add("mobile");
window.VOLNA_MOBILE_VERSION = "__VOLNA_VERSION__";   // подставляется при сборке из package.json

/* ================= вход ================= */
(() => {
  const { Accounts } = window.VS;
  const LOCK = '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const box = document.createElement("div");
  box.id = "m-login"; box.className = "on";
  box.innerHTML = `<div class="ml-bg"></div><div class="ml-box" id="ml-box"><div class="ml-spin"></div></div>`;
  document.body.append(box);
  const $l = (s) => box.querySelector(s);
  const ini = (n) => esc((n || "?").trim()[0].toUpperCase());
  let picked = null;

  async function enter(acc, pw, errEl) {
    try {
      const a = await Accounts.login(acc.id, pw);
      await window.VApp.start(a);
      box.classList.remove("on"); setTimeout(() => box.remove(), 400);
      const P = window.VP.P; if (P.Splash) P.Splash.hide().catch(() => {});
    } catch (e) {
      if (errEl) { errEl.textContent = e.message; const f = errEl.closest("form"); if (f) { f.classList.remove("shake"); void f.offsetWidth; f.classList.add("shake"); } }
      else toast(e.message, "error");
    }
  }
  function people() {
    const list = Accounts.list();
    $l("#ml-box").innerHTML = `<img class="ml-logo" src="assets/icon.png" alt=""><h1>Кто слушает?</h1><p class="ml-sub">У каждого своя медиатека, своя волна и свои настройки</p>
      <div class="ml-people">${list.map((a) => `<button class="ml-p" data-id="${a.id}" style="--c:${a.color}"><div class="ml-av">${ini(a.name)}${a.locked ? `<span class="ml-lock">${LOCK}</span>` : ""}</div><b>${esc(a.name)}</b></button>`).join("")}
        <button class="ml-p ml-add" data-new><div class="ml-av">+</div><b>Новый</b></button></div><div id="ml-pw"></div>`;
    box.querySelectorAll(".ml-p[data-id]").forEach((b) => (b.onclick = () => pick(b.dataset.id)));
    $l("[data-new]").onclick = () => createForm(false);
  }
  function pick(id) {
    picked = id; const a = Accounts.list().find((x) => x.id === id);
    box.querySelectorAll(".ml-p").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    if (!a.locked) { enter(a, ""); return; }
    $l("#ml-pw").innerHTML = `<form id="ml-f"><input id="ml-pass" type="password" placeholder="Пароль для «${esc(a.name)}»" autocomplete="current-password"><button class="ml-btn">Войти</button><div class="ml-err" id="ml-err"></div></form>`;
    $l("#ml-pass").focus();
    $l("#ml-f").onsubmit = (e) => { e.preventDefault(); enter(a, $l("#ml-pass").value, $l("#ml-err")); };
  }
  function createForm(first) {
    $l("#ml-box").innerHTML = `<img class="ml-logo" src="assets/icon.png" alt=""><h1>${first ? "Добро пожаловать" : "Новый аккаунт"}</h1>
      <p class="ml-sub">Своя медиатека, своя волна, свой вход в Яндекс</p>
      <form id="ml-f"><input id="ml-name" placeholder="Как тебя зовут?" maxlength="32" autocomplete="nickname">
        <input id="ml-p1" type="password" placeholder="Пароль (можно не ставить)" autocomplete="new-password">
        <input id="ml-p2" type="password" placeholder="Пароль ещё раз" autocomplete="new-password">
        <p class="ml-hint">Без пароля вход в один клик. Пароль защищает аккаунт от входа в приложении — файлы на телефоне он не шифрует.</p>
        <button class="ml-btn">${first ? "Начать" : "Создать"}</button><div class="ml-err" id="ml-err"></div>
        ${first ? "" : `<button type="button" class="ml-link" id="ml-back">← Назад</button>`}</form>`;
    if (!first) $l("#ml-back").onclick = people;
    $l("#ml-f").onsubmit = async (e) => {
      e.preventDefault();
      const name = $l("#ml-name").value.trim(), p1 = $l("#ml-p1").value, p2 = $l("#ml-p2").value, err = $l("#ml-err");
      if (p1 !== p2) { err.textContent = "Пароли не совпадают"; return; }
      try { const a = await Accounts.create(name, p1); await enter(a, p1, err); } catch (e2) { err.textContent = e2.message; }
    };
  }
  (async () => {
    await Accounts.load();
    const list = Accounts.list();
    if (!list.length) createForm(true);
    else if (list.length === 1 && !list[0].locked && !sessionStorage.getItem("volna.choose")) enter(list[0], "");
    else people();
    try { sessionStorage.removeItem("volna.choose"); } catch (_) { /* */ }
  })().catch((e) => { $l("#ml-box").innerHTML = `<p class="ml-err">Не получилось открыть данные: ${esc(e.message)}</p>`; });
})();

/* ================= вкладки и страницы ================= */
(() => {
  const tabs = document.createElement("nav");
  tabs.id = "tabbar";
  tabs.innerHTML = [["home", "house", "Главная"], ["wave", "waves", "Волна"], ["search", "search", "Поиск"], ["mlib", "library", "Медиатека"], ["more", "layout-grid", "Ещё"]]
    .map(([go, ic, label]) => `<button data-go="${go}">${svg(ic) || svg("music")}<span>${label}</span></button>`).join("");
  document.body.append(tabs);

  PAGES.mlib = async (page, _a, alive) => {
    await loadSidebar();
    const [st, off] = await Promise.all([call("stats"), call("offline_status").catch(() => ({}))]);
    if (stale(alive)) return;
    setTitle("Медиатека");
    document.documentElement.style.setProperty("--page-tint", "#3b4f9c");
    const srcLabel = (p) => ({ local: "Мой плейлист", spotify: "Spotify", yandex: "Яндекс Музыка", sc: "SoundCloud" }[p.source] || "Плейлист");
    const row = (route, pic, t, a) => `<button class="m-li" data-route="${route}">${pic}<div><div class="t">${esc(t)}</div><div class="a">${a}</div></div>${svg("chevron-right")}</button>`;
    page.innerHTML = `<div class="wash"></div><div class="content">
      <div class="m-head"><h1>Медиатека</h1><button class="icon-btn" id="m-new" title="Создать">${svg("plus")}</button></div>
      <div class="chips-row m-chips"><button class="chip" data-go="library">Все треки · ${st.lib || 0}</button><button class="chip" data-go="import">${svg("download")}Добавить музыку</button></div>
      <div class="m-list">
        ${row("liked:null", likedCover(), "Любимые треки", `Плейлист · ${nTracks(st.liked || 0)}`)}
        ${st.offline ? row("offline:null", offlineCover(), "Скачанное", `Без интернета · ${nTracks(st.offline)}`) : ""}
        ${(S.playlists || []).map((p) => row(`playlist:${p.id}`, mosaic(p.arts), p.name, `${srcLabel(p)} · ${nTracks(p.n)}`)).join("")}
        ${(S.smart || []).map((p) => row(`smart:${p.id}`, `<div class="smart-cover">${mosaic(p.arts)}<span>${svg("sparkles")}</span></div>`, p.name, `Умный плейлист · ${nTracks(p.n)}`)).join("")}
      </div>${(S.playlists || []).length ? "" : `<div class="empty"><h3>Здесь появятся плейлисты</h3><p>Добавь музыку из SoundCloud, Яндекса или по ссылке Spotify.</p></div>`}</div>`;
    page.addEventListener("click", (e) => {
      const b = e.target.closest(".m-li"); if (!b) return;
      const [name, arg] = b.dataset.route.split(":"); go(name, arg === "null" ? null : +arg);
    });
    page.addEventListener("contextmenu", (e) => {
      const b = e.target.closest(".m-li"); if (!b) return; e.preventDefault();
      const [name, arg] = b.dataset.route.split(":");
      if (name === "playlist") openMenu(e.clientX, e.clientY, playlistMenu(S.playlists.find((x) => x.id === +arg)));
      else if (name === "smart") openMenu(e.clientX, e.clientY, smartMenu(S.smart.find((x) => x.id === +arg)));
      else if (name === "liked") openMenu(e.clientX, e.clientY, shareItems("liked", null));
    });
    $("#m-new", page).onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left - 180, r.bottom + 4, [
      { icon: "plus", label: "Новый плейлист", run: () => createPlaylist() },
      { icon: "sparkles", label: "Умный плейлист", run: () => smartEditor() },
      { icon: "link", label: "Плейлист от друга", run: () => importFromFriend() }]); };
  };

  PAGES.more = async (page, _a, alive) => {
    const info = await call("account_info").catch(() => null);
    if (stale(alive)) return;
    setTitle("Ещё");
    document.documentElement.style.setProperty("--page-tint", "#7b4fd6");
    const me = info && info.me;
    const tile = (go, ic, t, s) => `<button class="m-tile" data-go="${go}">${svg(ic)}<b>${t}</b><span>${s}</span></button>`;
    page.innerHTML = `<div class="wash"></div><div class="content">
      ${me ? `<div class="m-me"><span class="acc-av" style="--c:${me.color}">${esc(me.name.trim()[0].toUpperCase())}</span><div><b>${esc(me.name)}</b><span>${me.locked ? "Вход по паролю" : "Вход без пароля"}</span></div>
        <button class="btn ghost" id="m-switch">${svg("users")}Сменить</button></div>` : ""}
      <div class="m-tiles">
        ${tile("dna", "dna", "Музыкальная ДНК", "Твой вкус и сравнение с друзьями")}
        ${tile("stats", "chart-column", "Статистика", "Минуты, топы, итоги")}
        ${tile("offline", "circle-arrow-down", "Скачанное", "Музыка без интернета")}
        ${tile("import", "download", "Добавить музыку", "SoundCloud, Яндекс, Spotify")}
        ${tile("settings", "settings", "Настройки", "Звук, вид, аккаунт, Яндекс")}
      </div>
      <p class="m-ver">Volna ${esc(window.VOLNA_MOBILE_VERSION)} для Android</p></div>`;
    const sw = $("#m-switch", page);
    if (sw) sw.onclick = () => { try { sessionStorage.setItem("volna.choose", "1"); } catch (_) { /* */ } call("account_switch"); };
  };

  READY.push(() => {
    try { closeRight(); } catch (_) { /* */ }
    /* настройки: убираем то, что есть только на компьютере */
    const base = PAGES.settings;
    PAGES.settings = async (page, arg, alive) => {
      await base(page, arg, alive);
      if (stale(alive)) return;
      $$(".set-sec", page).forEach((sec) => {
        const h = (sec.querySelector("h2") || {}).textContent || "";
        if (/Приложение|Discord|Last\.fm/.test(h)) sec.remove();
      });
      $$(".set-row", page).forEach((r) => { if (/Плавный переход|Выравнивать громкость|Мини-плеер|трей/i.test(r.textContent)) r.remove(); });
    };
    /* в полноэкранном плеере — кнопка очереди */
    const top = $("#now .top");
    if (top && !$("#now-queue")) {
      const b = document.createElement("button"); b.className = "icon-btn"; b.id = "now-queue"; b.title = "Очередь"; b.innerHTML = svg("list-video");
      b.onclick = () => openRight("queue"); top.insertBefore(b, $("#now-close"));
    }
    /* тап по мини-плееру открывает «Сейчас играет» */
    $(".p-left").addEventListener("click", (e) => { if (e.target.closest("button,a")) return; if (S.track) $("#now").classList.add("on"); });
    /* поиск в верхней панели — только на вкладке «Поиск» */
    const baseRender = render;
    render = async (...a) => {   // eslint-disable-line no-func-assign
      document.body.classList.toggle("route-search", !!route && route.name === "search");
      const r = await baseRender(...a);
      if (route && route.name === "search" && !$("#q").value) setTimeout(() => $("#q").focus(), 60);
      return r;
    };
    if (route && route.name === "home") go("home", null, { force: true, nohist: true });
  });

  /* кнопка «Назад» Android */
  const P = window.VP.P;
  if (P.App) P.App.addListener("backButton", () => {
    const m = $("#modal");
    if ($(".menu")) { closeMenu(); return; }
    if (m && m.classList.contains("on")) { m.click(); m.dispatchEvent(new MouseEvent("click", { bubbles: true })); m.classList.remove("on"); m.innerHTML = ""; return; }
    if ($("#recap") && $("#recap").classList.contains("on")) { $("#recap").classList.remove("on"); return; }
    if ($("#app").classList.contains("with-right")) { closeRight(); return; }
    if ($("#now").classList.contains("on")) { $("#now").classList.remove("on"); return; }
    if (typeof hist !== "undefined" && hist.length) { back(); return; }
    P.App.minimizeApp().catch(() => {});
  });
  if (P.StatusBar) { P.StatusBar.setBackgroundColor({ color: "#060a16" }).catch(() => {}); P.StatusBar.setStyle({ style: "DARK" }).catch(() => {}); }
})();
