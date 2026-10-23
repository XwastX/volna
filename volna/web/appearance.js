"use strict";
/* Volna — внешний вид: темы, фон, шрифты, плотность, раскладка, визуализатор, горячие клавиши.
   Настройки хранятся в Python (settings_set key "ui") и дублируются в localStorage — тема ставится до ответа Python. */

(() => {
  /* ---------------- значки, которых нет в icons.js ---------------- */
  Object.assign(window.ICONS, {
    palette: '<circle cx="13.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r="1.2" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    keyboard: '<path d="M10 8h.01M12 12h.01M14 8h.01M16 12h.01M18 8h.01M6 8h.01M7 16h10M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    "arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    "rotate-ccw": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    layout: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    blend: '<circle cx="9" cy="9" r="7"/><circle cx="15" cy="15" r="7"/>',
  });

  /* ---------------- цвета ---------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function toRgb(c) {
    c = String(c || "").trim();
    let m = c.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) { let h = m[1]; if (h.length === 3) h = h.split("").map((x) => x + x).join(""); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return m ? [+m[1], +m[2], +m[3]].map((x) => clamp(Math.round(x), 0, 255)) : null;
  }
  const hex = (rgb) => "#" + rgb.map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const A = toRgb(a), B = toRgb(b); return hex(A.map((x, i) => x + (B[i] - x) * t)); };
  const trip = (c) => toRgb(c).join(" ");
  const lum = (c) => { const [r, g, b] = toRgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function fromHsl([h, s, l]) {
    if (!s) return [l, l, l].map((x) => x * 255);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((x) => x * 255);
  }
  /* акцент из обложки на светлом фоне — притемнить, пока не станет читаемым */
  function readableOn(col, bg) {
    let [h, s, l] = toHsl(toRgb(col));
    s = Math.max(s, 0.45);
    let out = hex(fromHsl([h, s, l]));
    for (let i = 0; i < 20 && contrast(out, bg) < 3.6; i++) { l -= 0.04; out = hex(fromHsl([h, s, Math.max(0, l)])); }
    return out;
  }

  /* ---------------- темы ---------------- */
  const THEMES = [
    { id: "night", name: "Ночная вода", tone: "dark", v: { void: "#060a16", panel: "#0d1428", p2: "#141d37", p3: "#1c2748", p4: "#253360", foam: "#eef1fb", mist: "#9099b8", mist2: "#5e6887", moon: "#a8bcff", lantern: "#ffb089", hl: "#a8bcff" } },
    { id: "midnight", name: "Полночь", tone: "dark", note: "OLED", v: { void: "#000000", panel: "#0a0a0b", p2: "#141416", p3: "#1d1d20", p4: "#2a2a2f", foam: "#f2f2f4", mist: "#8e8e96", mist2: "#58585f", moon: "#8ec5ff", lantern: "#ff9f8a", hl: "#c8cad6" } },
    { id: "sakura", name: "Сакура", tone: "dark", v: { void: "#130a0f", panel: "#1e1018", p2: "#291621", p3: "#351c2b", p4: "#462438", foam: "#fbeef3", mist: "#bc96a8", mist2: "#7f5e6e", moon: "#ff9ec4", lantern: "#ffc29c", hl: "#ffb0cf" } },
    { id: "neon", name: "Неон Токио", tone: "dark", v: { void: "#07050f", panel: "#110b1f", p2: "#1a1030", p3: "#241543", p4: "#321c5c", foam: "#f4efff", mist: "#a093c8", mist2: "#655a8c", moon: "#ff4fb0", lantern: "#2be4ff", hl: "#c39bff" } },
    { id: "forest", name: "Лес", tone: "dark", v: { void: "#060c09", panel: "#0d1712", p2: "#13211a", p3: "#1a2c22", p4: "#233a2d", foam: "#ecf4ee", mist: "#8fa698", mist2: "#5a6f62", moon: "#8fd9a3", lantern: "#f2c46f", hl: "#a3dcb3" } },
    { id: "aurora", name: "Аврора", tone: "dark", v: { void: "#040a13", panel: "#091521", p2: "#0e1e2d", p3: "#14293b", p4: "#1b364b", foam: "#e8fbf6", mist: "#86a8aa", mist2: "#537174", moon: "#5ef0c8", lantern: "#c79bff", hl: "#86e8d4" } },
    { id: "graphite", name: "Графит", tone: "dark", v: { void: "#111213", panel: "#1a1b1d", p2: "#222326", p3: "#2b2d30", p4: "#37393d", foam: "#ececed", mist: "#9b9da2", mist2: "#66686d", moon: "#ffb547", lantern: "#ff7d6b", hl: "#c9ccd3" } },
    { id: "sand", name: "Песок", tone: "light", v: { void: "#e6ded0", panel: "#f7f2ea", p2: "#ede6da", p3: "#e2d9c9", p4: "#d5c9b5", foam: "#2a241d", mist: "#6b6256", mist2: "#9a9083", moon: "#b4532a", lantern: "#cf3f3f", hl: "#5f4b32" } },
    { id: "morning", name: "Утро", tone: "light", v: { void: "#dde3ec", panel: "#f6f8fb", p2: "#eaeef4", p3: "#dfe4ed", p4: "#cfd6e2", foam: "#18202f", mist: "#58627a", mist2: "#939db2", moon: "#3a5bd0", lantern: "#e0436f", hl: "#2c3a5c" } },
  ];
  const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

  /* из 4 базовых цветов собрать полную палитру */
  function derive(base, from) {
    const light = lum(base.bg) > 0.4;
    const { bg, panel, text, accent } = base;
    const towards = light ? text : mix(text, accent, 0.35);
    return {
      void: bg, panel, p2: mix(panel, towards, light ? 0.05 : 0.05), p3: mix(panel, towards, light ? 0.1 : 0.1), p4: mix(panel, towards, light ? 0.17 : 0.17),
      foam: text, mist: mix(text, panel, light ? 0.4 : 0.42), mist2: mix(text, panel, 0.62), moon: accent,
      lantern: from.v.lantern, hl: light ? mix(text, accent, 0.25) : mix(accent, text, 0.45), tone: light ? "light" : "dark",
    };
  }
  function palette(ui) {
    const th = themeById(ui.theme);
    if (!ui.colors) return { ...th.v, tone: th.tone, preset: true };
    return derive(ui.colors, th);
  }
  function themeVars(p) {
    const light = p.tone === "light";
    return {
      "--void": p.void, "--panel": p.panel, "--panel-2": p.p2, "--panel-3": p.p3, "--panel-4": p.p4,
      "--foam": p.foam, "--mist": p.mist, "--mist-2": p.mist2, "--moon": p.moon, "--lantern": p.lantern,
      "--hl": trip(p.hl), "--shade": trip(light ? p.panel : p.void), "--fg": trip(p.foam),
      "--bright": light ? mix(p.foam, "#000000", 0.5) : "#fff", "--thumb": light ? p.foam : "#fff",
      "--danger": light ? "#d23c3c" : "#ff9393", "--danger-text": light ? "#c22f2f" : "#ff9a9a",
      "--ok": light ? "#1d8048" : "#7be0a6", "--tag-sc": light ? "#b5501a" : "#ffab73", "--tag-sp": light ? "#16834a" : "#66e39b",
    };
  }

  const FONTS = {
    unbounded: { name: "Unbounded + Manrope", hint: "Как задумано", display: null, text: null },
    manrope: { name: "Только Manrope", hint: "Спокойнее и уже", display: '"Manrope", "Segoe UI", sans-serif', text: null },
    system: { name: "Системный", hint: "Segoe UI, как в Windows", display: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif', text: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
    serif: { name: "С засечками", hint: "Журнальные заголовки", display: 'Georgia, "Times New Roman", serif', text: null },
  };
  const HOME_SECS = [["quick", "Быстрые плитки"], ["wave", "Баннер «Моя волна»"], ["mixes", "Миксы для тебя"], ["recent", "Недавно играли"],
    ["artists", "Твои артисты"], ["forgotten", "Давно не слушал"], ["added", "Недавно добавлено"], ["recap", "Итоги месяца"], ["moods", "Настроения"]];

  /* ---------------- горячие клавиши ---------------- */
  const KEY_ACTIONS = [
    ["toggle", "Играть / пауза", "Space", () => act("toggle")],
    ["next", "Следующий трек", "Ctrl+ArrowRight", () => act("next")],
    ["prev", "Предыдущий трек", "Ctrl+ArrowLeft", () => act("prev")],
    ["like", "Нравится", "KeyL", () => likeCurrent()],
    ["volUp", "Громче", "Ctrl+ArrowUp", () => setVol(Math.min(100, S.volume + 5))],
    ["volDown", "Тише", "Ctrl+ArrowDown", () => setVol(Math.max(0, S.volume - 5))],
    ["seekFwd", "Вперёд на 5 секунд", "ArrowRight", () => seekBy(5000)],
    ["seekBack", "Назад на 5 секунд", "ArrowLeft", () => seekBy(-5000)],
    ["search", "Поиск", "Ctrl+KeyF", () => { $("#now").classList.remove("on"); $("#q").focus(); }, true],
    ["full", "Полноэкранный плеер", "KeyF", () => { const n = $("#now"); if (n.classList.contains("on")) n.classList.remove("on"); else if (S.track) n.classList.add("on"); }],
    ["mini", "Мини-плеер", "KeyM", () => $("#btn-mini").click()],
    ["lyrics", "Текст песни", "KeyT", () => openRight("lyrics")],
    ["queue", "Очередь", "KeyQ", () => openRight("queue")],
    ["wave", "Моя волна", "KeyW", () => startWave()],
  ];
  const RESERVED = { "Ctrl+KeyK": "палитра команд", "Alt+ArrowLeft": "назад по страницам", "Alt+ArrowRight": "вперёд по страницам",
    "Escape": "закрыть", "Tab": "переход по кнопкам", "Shift+Tab": "переход по кнопкам", "Enter": "нажать кнопку",
    "Ctrl+KeyC": "копировать", "Ctrl+KeyV": "вставить", "Ctrl+KeyX": "вырезать", "Ctrl+KeyA": "выделить всё", "Ctrl+KeyZ": "отменить" };
  function seekBy(d) {
    if (!S.track || !S.dur) return;
    const p = clamp(curPos() + d, 0, Math.max(0, S.dur - 800));
    S.pos = p; S.posAt = performance.now();
    call("seek", { ms: Math.round(p) });
  }
  function comboOf(e) {
    if (["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"].includes(e.key)) return null;
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl"); if (e.altKey) parts.push("Alt"); if (e.shiftKey) parts.push("Shift"); if (e.metaKey) parts.push("Win");
    parts.push(e.code || e.key);
    return parts.join("+");
  }
  const KEYNAMES = { Space: "Пробел", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Backspace: "⌫", Delete: "Del", Slash: "/",
    Backslash: "\\", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "−", Equal: "=",
    Backquote: "`", PageUp: "PgUp", PageDown: "PgDn", Insert: "Ins", NumpadAdd: "Num +", NumpadSubtract: "Num −", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadEnter: "Num Enter" };
  const keyLabel = (k) => KEYNAMES[k] || k.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad(\d)$/, "Num $1");
  const comboParts = (c) => c ? c.split("+").map(keyLabel) : [];
  const UI_KEYS = window.UI_KEYS = {
    actions: Object.fromEntries(KEY_ACTIONS.map(([id, label, def, run, global]) => [id, { label, def, run, global: !!global }])),
    map: {}, recording: false, combo: comboOf, label: (c) => comboParts(c).join(" + "),
    find(c) { if (!c || RESERVED[c] === "палитра команд") return null; for (const [id] of KEY_ACTIONS) if (this.map[id] === c) return id; return null; },
  };
  function rebuildKeys() { UI_KEYS.map = Object.fromEntries(KEY_ACTIONS.map(([id, , def]) => [id, ui.keys && id in ui.keys ? ui.keys[id] : def])); }

  /* ---------------- состояние ---------------- */
  const DEFAULTS = {
    v: 1, theme: "night", colors: null, accent: "cover",
    bg: { type: "solid", blur: 48, dim: 55, img: null },
    glass: false, panelAlpha: 100, glassBlur: 24,
    font: "unbounded", fontSize: 14, headScale: 100,
    density: "normal", radius: 14,
    left: 300, collapsed: false, right: "remember", bar: "full",
    home: { order: HOME_SECS.map((x) => x[0]), hidden: [] },
    vis: "lines", motion: "full", keys: {},
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function normalize(u) {
    const d = clone(DEFAULTS);
    if (!u || typeof u !== "object") return d;
    const out = { ...d, ...u, bg: { ...d.bg, ...(u.bg || {}) }, home: { ...d.home, ...(u.home || {}) }, keys: { ...(u.keys || {}) } };
    if (!THEMES.some((t) => t.id === out.theme)) out.theme = "night";
    if (out.colors && !["bg", "panel", "text", "accent"].every((k) => toRgb(out.colors[k]))) out.colors = null;
    if (out.colors) out.colors = Object.fromEntries(["bg", "panel", "text", "accent"].map((k) => [k, hex(toRgb(out.colors[k]))]));
    if (!FONTS[out.font]) out.font = "unbounded";
    const keys = HOME_SECS.map((x) => x[0]);
    out.home.order = (Array.isArray(out.home.order) ? out.home.order : []).filter((k) => keys.includes(k));
    keys.forEach((k) => { if (!out.home.order.includes(k)) out.home.order.push(k); });
    out.home.hidden = (Array.isArray(out.home.hidden) ? out.home.hidden : []).filter((k) => keys.includes(k));
    out.fontSize = clamp(+out.fontSize || 14, 12, 17); out.headScale = clamp(+out.headScale || 100, 80, 130);
    out.radius = clamp(+out.radius, 0, 24); if (Number.isNaN(out.radius)) out.radius = 14;
    out.left = clamp(+out.left || 300, 230, 420); out.panelAlpha = clamp(+out.panelAlpha || 100, 40, 100);
    out.glassBlur = clamp(+out.glassBlur || 0, 0, 40);
    out.bg.blur = clamp(+out.bg.blur || 0, 0, 80); out.bg.dim = clamp(+out.bg.dim || 0, 0, 90);
    if (!["solid", "wave", "cover", "gradient", "image"].includes(out.bg.type)) out.bg.type = "solid";
    for (const k of Object.keys(out.keys)) if (!UI_KEYS.actions[k] || typeof out.keys[k] !== "string") delete out.keys[k];
    return out;
  }
  const LS = "volna.ui", LS_IMG = "volna.ui.img";
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch (_) { return false; } };
  let ui = (() => { try { return normalize(JSON.parse(lsGet(LS) || "null")); } catch (_) { return normalize(null); } })();
  let bgImage = ui.bg.img && ui.bg.img !== "local" ? ui.bg.img : lsGet(LS_IMG);

  /* ---------------- применение ---------------- */
  const root = document.documentElement;
  const VIS = window.UI_VIS = { style: "lines", motion: "full", ink: null };
  const MANAGED = ["--void", "--panel", "--panel-2", "--panel-3", "--panel-4", "--foam", "--mist", "--mist-2", "--moon", "--lantern", "--hl", "--shade",
    "--fg", "--bright", "--thumb", "--danger", "--danger-text", "--ok", "--tag-sc", "--tag-sp", "--display", "--text", "--fz", "--fzh", "--rk",
    "--ui-left", "--pa", "--gb", "--bgblur", "--bgdim", ...HOME_SECS.map(([k]) => "--o-" + k)];
  let pal = palette(ui), coverTint = null;
  const isDefaultLook = () => ui.theme === "night" && !ui.colors;

  function apply(opts = {}) {
    pal = palette(ui);
    const st = root.style;
    if (opts.morph && ui.motion !== "off") { root.classList.add("ui-morph"); clearTimeout(apply._m); apply._m = setTimeout(() => root.classList.remove("ui-morph"), 650); }
    const vars = {};
    if (!isDefaultLook()) Object.assign(vars, themeVars(pal));
    const f = FONTS[ui.font];
    if (f.display) vars["--display"] = f.display;
    if (f.text) vars["--text"] = f.text;
    if (ui.fontSize !== 14) vars["--fz"] = String(ui.fontSize / 14);
    if (ui.headScale !== 100) vars["--fzh"] = String(ui.headScale / 100);
    if (ui.radius !== 14) vars["--rk"] = String(ui.radius / 14);
    if (ui.left !== 300) vars["--ui-left"] = ui.left + "px";
    vars["--pa"] = ui.panelAlpha + "%"; vars["--gb"] = (ui.glass ? ui.glassBlur : 0) + "px";
    vars["--bgblur"] = (ui.bg.type === "cover" || ui.bg.type === "image" ? ui.bg.blur : 0) + "px";
    vars["--bgdim"] = String(ui.bg.dim / 100);
    const def = DEFAULTS.home.order;
    if (ui.home.order.join() !== def.join()) ui.home.order.forEach((k, i) => { vars["--o-" + k] = String(i + 1); });
    MANAGED.forEach((k) => { if (!(k in vars)) st.removeProperty(k); });
    Object.entries(vars).forEach(([k, v]) => st.setProperty(k, v));
    root.dataset.tone = pal.tone;
    root.dataset.density = ui.density;
    root.dataset.motion = ui.motion;
    root.dataset.bar = ui.bar;
    root.dataset.bg = ui.bg.type;
    root.dataset.font = ui.font;
    if (ui.home.hidden.length) root.dataset.homeHide = ui.home.hidden.join(" "); else delete root.dataset.homeHide;
    root.classList.toggle("ui-glass", ui.glass || ui.panelAlpha < 100);
    root.classList.toggle("ui-collapsed", !!ui.collapsed);
    VIS.style = ui.vis; VIS.motion = ui.motion; VIS.ink = pal.tone === "light" ? toRgb(pal.foam).join(",") : null;
    applyTint();
    rebuildKeys();
    paintBg();
  }
  function applyTint() {
    let col;
    if (ui.accent === "off") col = pal.tone === "light" ? pal.foam : mix(pal.foam, pal.mist, 0.15);
    else if (ui.accent === "custom" || !coverTint) col = pal.moon;
    else col = coverTint;
    col = hex(toRgb(col) || toRgb(pal.moon));
    if (pal.tone === "light" && ui.accent !== "off") col = readableOn(col, pal.panel);
    S.tint = col;
    root.style.setProperty("--tint", col);
  }
  /* обработчик плеера уже записал --tint; переписываем по своим правилам */
  on("tint", (c) => { coverTint = c && toRgb(c) ? c : null; applyTint(); });

  /* ---------------- фон ---------------- */
  const bgEl = document.createElement("div");
  bgEl.id = "ui-bg";
  bgEl.innerHTML = `<div class="grad"></div><div class="img"></div><canvas></canvas><div class="dim"></div>`;
  document.body.prepend(bgEl);
  const bgCanvas = $("canvas", bgEl);
  let bgUrl = "";
  function paintBg() {
    const t = ui.bg.type;
    let url = "";
    if (t === "cover" && S.track && S.track.art) url = big(S.track.art);
    if (t === "image" && bgImage) url = bgImage;
    if (url !== bgUrl) { bgUrl = url; $(".img", bgEl).style.backgroundImage = url ? `url("${url.replace(/"/g, "%22")}")` : "none"; }
  }
  on("track", () => { if (ui.bg.type === "cover") paintBg(); });
  let bgLast = 0;
  function bgLoop(t) {
    requestAnimationFrame(bgLoop);
    if (ui.bg.type !== "wave") return;
    const every = ui.motion === "off" ? 250 : ui.motion === "reduced" ? 50 : 33;
    if (t - bgLast < every) return;
    bgLast = t;
    drawTide(bgCanvas, t, { lines: 34, top: 0.1, span: 0.82, alpha: 0.5, amp: 1.4 });
  }
  requestAnimationFrame(bgLoop);

  /* ---------------- сохранение ---------------- */
  let saveTimer = 0;
  function persist() {
    const forPy = clone(ui);
    if (bgImage && bgImage.length <= 200000) forPy.bg.img = bgImage;
    else forPy.bg.img = bgImage ? "local" : null;
    ui.bg.img = forPy.bg.img;
    const forLs = clone(forPy); if (forLs.bg.img && forLs.bg.img !== "local") forLs.bg.img = "local";
    lsSet(LS, JSON.stringify(forLs));
    lsSet(LS_IMG, bgImage || null);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (typeof backend !== "undefined" && backend) call("settings_set", { key: "ui", value: forPy }).catch(() => {}); }, 300);
  }
  function setPath(path, value) {
    const ks = path.split("."); let o = ui;
    ks.slice(0, -1).forEach((k) => { o = o[k]; });
    o[ks[ks.length - 1]] = value;
  }
  function update(path, value, opts = {}) {
    if (path) setPath(path, value);
    ui = normalize({ ...ui, bg: { ...ui.bg } });
    apply(opts);
    persist();
    syncPage();
  }

  /* правая панель при запуске: решаем до того, как player.js прочитает localStorage */
  if (ui.right === "hide") lsSet("volna.right", "");
  else if (ui.right === "show" && !["now", "queue", "lyrics"].includes(lsGet("volna.right"))) lsSet("volna.right", "now");
  apply();

  READY.push(() => {
    call("settings_get").then((st) => {
      if (st && st.ui && typeof st.ui === "object") {
        const fromPy = normalize(st.ui);
        if (st.ui.bg && st.ui.bg.img && st.ui.bg.img !== "local") bgImage = st.ui.bg.img;
        else if (!(st.ui.bg && st.ui.bg.img)) bgImage = null;
        const same = JSON.stringify({ ...fromPy, bg: { ...fromPy.bg, img: 0 } }) === JSON.stringify({ ...ui, bg: { ...ui.bg, img: 0 } });
        ui = fromPy;
        if (!same) { apply({ morph: false }); }
        persist();
      } else if (lsGet(LS)) persist();
    }).catch(() => {});
    /* ссылка «Внешний вид» сверху страницы настроек */
    const orig = PAGES.settings;
    if (orig) PAGES.settings = async (page, arg, alive) => {
      await orig(page, arg, alive);
      if (!alive()) return;
      const hero = $(".content > .hero", page);
      if (!hero) return;
      const sw = [pal.void, pal.panel, pal.moon, pal.lantern, pal.foam].map((c) => `<i style="background:${c}"></i>`).join("");
      hero.insertAdjacentHTML("afterend", `<section class="set-sec"><button class="ap-link" data-go="appearance">
        <div><b>Внешний вид</b><span>Тема «${esc(ui.colors ? themeById(ui.theme).name + " (своя)" : themeById(ui.theme).name)}», фон, шрифты, раскладка и горячие клавиши</span></div>
        <span class="sw">${sw}</span>${svg("chevron-right")}</button></section>`);
    };
  });

  /* ---------------- страница «Внешний вид» ---------------- */
  let pageEl = null;
  const seg = (path, opts) => `<div class="seg" role="radiogroup" data-seg="${path}">${opts.map(([v, l, ic]) => `<button data-v="${v}" role="radio">${ic ? svg(ic) : ""}${esc(l)}</button>`).join("")}</div>`;
  const range = (path, min, max, step = 1) => `<input class="range" type="range" min="${min}" max="${max}" step="${step}" data-range="${path}"><span class="val" data-val="${path}"></span>`;
  const sw = (path) => `<button class="switch" role="switch" data-sw="${path}"></button>`;
  const row = (title, sub, ctl) => `<div class="set-row"><div><b>${title}</b>${sub ? `<span>${sub}</span>` : ""}</div><div class="ctl">${ctl}</div></div>`;
  const FMT = {
    "bg.blur": (v) => v + " px", "bg.dim": (v) => v + "%", panelAlpha: (v) => v + "%", glassBlur: (v) => v + " px",
    fontSize: (v) => v + " px", headScale: (v) => v + "%", radius: (v) => v + " px", left: (v) => v + " px",
  };
  const getPath = (p) => p.split(".").reduce((o, k) => o[k], ui);
  const baseColors = () => ui.colors || { bg: pal.void, panel: pal.panel, text: pal.foam, accent: pal.moon };

  function themeCard(t) {
    const v = t.v;
    return `<button class="th-card" data-theme="${t.id}" title="${esc(t.name)}" style="--m-void:${v.void};--m-panel:${v.panel};--m-panel2:${v.p3};--m-text:${v.foam};--m-mist:${v.mist};--m-accent:${v.moon}">
      <span class="ok">${svg("check")}</span>
      <div class="th-mock"><i class="s"></i><i class="m"><b></b><em></em><em></em><u><s></s><s></s><s></s></u></i><i class="bar"></i></div>
      <div class="nm">${esc(t.name)}<small data-note="${t.id}">${t.note || (t.tone === "light" ? "светлая" : "")}</small></div></button>`;
  }

  PAGES.appearance = async (page) => {
    setTitle("Внешний вид");
    root.style.setProperty("--page-tint", "#3b4f9c");
    $$('.nav[data-go="settings"]').forEach((b) => b.classList.add("on"));
    pageEl = page;
    page.innerHTML = `<div class="wash"></div><div class="content ap">
    <div class="hero" style="min-height:0"><div><div class="kind">Настройки</div><h1>Внешний вид</h1>
      <div class="meta">Всё меняется сразу — смотри на само приложение. Настройки сохраняются автоматически.</div></div></div>

    <section class="set-sec"><h2>${svg("palette")}Тема</h2>
      <div class="th-grid">${THEMES.map(themeCard).join("")}</div></section>

    <section class="set-sec"><h2>${svg("blend")}Цвета</h2><div class="set-card">
      <div class="colors-grid">${[["bg", "Фон окна"], ["panel", "Панели"], ["text", "Текст"], ["accent", "Акцент темы"]].map(([k, l]) =>
        `<div class="set-row"><div><b>${l}</b><span class="hex" data-hex="${k}"></span></div><label class="swatch" title="${l}"><input type="color" data-color="${k}"><i></i></label></div>`).join("")}</div>
      ${row("Цвет акцента", "Кнопки, активные пункты, волны. «Из обложки» подстраивается под играющий трек.",
        seg("accent", [["cover", "Из обложки"], ["custom", "Цвет темы"], ["off", "Без цвета"]]))}
      <div class="set-row"><div><b>Свои цвета</b><span id="ap-colors-note"></span></div><button class="btn ghost" id="ap-colors-reset">${svg("rotate-ccw")}Вернуть цвета темы</button></div>
    </div></section>

    <section class="set-sec"><h2>${svg("image")}Фон</h2><div class="set-card">
      <div class="bg-grid">${[["solid", "Однотонный", ""], ["wave", "Волна", "wave"], ["cover", "Обложка трека", "cover"], ["gradient", "Градиент", "grad"], ["image", "Своя картинка", "image"]].map(([v, l, c]) =>
        `<button class="bg-opt" data-bg="${v}"><div class="pv ${c}"${v === "cover" ? ` id="ap-pv-cover"` : v === "image" ? ` id="ap-pv-image"` : ""}>${v === "image" ? svg("upload") : ""}</div>${l}</button>`).join("")}</div>
      <div class="set-row" id="ap-img-row"><div><b>Картинка</b><span id="ap-img-note">Выбери файл — он уменьшится до 1600 px и сохранится на этом компьютере.</span></div>
        <div class="ctl"><button class="btn" id="ap-img-pick">${svg("upload")}Выбрать файл</button><input type="file" accept="image/*" id="ap-img-file" hidden></div></div>
      ${row("Размытие", "Для обложки и своей картинки.", range("bg.blur", 0, 80))}
      ${row("Затемнение", "Чем больше, тем спокойнее фон и читаемее текст.", range("bg.dim", 0, 90))}
      ${row("Стекло", "Панели размывают то, что под ними.", sw("glass"))}
      ${row("Непрозрачность панелей", "Ниже 100% — сквозь панели виден фон.", range("panelAlpha", 40, 100))}
      ${row("Сила размытия стекла", "", range("glassBlur", 0, 40))}
    </div></section>

    <section class="set-sec"><h2>${svg("type")}Шрифт и текст</h2><div class="set-card">
      <div class="font-grid">${Object.entries(FONTS).map(([k, f]) => `<button class="font-opt" data-font="${k}">
        <div class="smp" style="font-family:${esc(f.display || '"Unbounded", "Segoe UI", sans-serif')}">Аа Волна</div>
        <div class="smp2" style="font-family:${esc(f.text || '"Manrope", "Segoe UI", sans-serif')}">${esc(f.hint)}</div><div class="nm">${esc(f.name)}</div></button>`).join("")}</div>
      ${row("Размер текста", "Основной текст в списках и меню.", range("fontSize", 12, 17, 0.5))}
      ${row("Размер заголовков", "", range("headScale", 80, 130, 5))}
    </div></section>

    <section class="set-sec"><h2>${svg("sliders-horizontal")}Плотность и форма</h2><div class="set-card">
      ${row("Плотность", "Компактная показывает больше треков на экране.", seg("density", [["normal", "Обычная"], ["compact", "Компактная"]]))}
      ${row("Скругление углов", "0 — строгие прямые углы.", range("radius", 0, 24))}
    </div></section>

    <section class="set-sec"><h2>${svg("layout")}Раскладка</h2><div class="set-card">
      ${row("Ширина левой колонки", "", range("left", 230, 420, 10))}
      ${row("Только значки слева", "Узкая колонка без подписей — больше места для музыки.", sw("collapsed"))}
      ${row("Правая панель при запуске", "«Запоминать» — как была при закрытии.", seg("right", [["remember", "Запоминать"], ["show", "Открыта"], ["hide", "Скрыта"]]))}
      ${row("Панель плеера", "", seg("bar", [["full", "Во всю ширину"], ["float", "Плавающая"]]))}
    </div></section>

    <section class="set-sec"><h2>${svg("house")}Главная</h2><p class="lead">Какие разделы показывать и в каком порядке.</p>
      <div class="set-card"><div class="home-list" id="ap-home"></div>
      <div class="set-row"><div></div><button class="reset-mini" id="ap-home-reset">Порядок по умолчанию</button></div></div></section>

    <section class="set-sec"><h2>${svg("audio-waveform")}Визуализатор и анимации</h2><div class="set-card">
      <div class="vis-preview" id="ap-vis"><canvas></canvas></div>
      ${row("Визуализатор", "Баннер волны, страница «Моя волна», фон и полноэкранный плеер.", seg("vis", [["lines", "Линии"], ["bars", "Столбики"], ["dots", "Точки"], ["mirror", "Зеркало"], ["off", "Выкл"]]))}
      ${row("Анимации", "«Меньше» убирает движение при переходах, «Выкл» — всё.", seg("motion", [["full", "Полные"], ["reduced", "Меньше"], ["off", "Выкл"]]))}
    </div></section>

    <section class="set-sec"><h2>${svg("keyboard")}Горячие клавиши</h2><p class="lead">Нажми на сочетание и затем нужные клавиши. Esc — отмена, Backspace — убрать. Ctrl+K занято палитрой команд. Клавиши не срабатывают, пока ты печатаешь.</p>
      <div class="set-card"><div class="keys-grid" id="ap-keys"></div>
      <div class="set-row"><div></div><button class="reset-mini" id="ap-keys-reset">Сбросить все клавиши</button></div></div></section>

    <section class="set-sec"><h2>${svg("download")}Файл темы</h2><div class="set-card">
      ${row("Поделиться темой", "Файл .volna-theme со всеми настройками этой страницы (и картинкой фона).",
        `<button class="btn" id="ap-export">${svg("download")}Сохранить</button><button class="btn ghost" id="ap-copy" title="Скопировать код темы">${svg("copy")}</button>`)}
      ${row("Загрузить тему", "Из файла .volna-theme.", `<button class="btn" id="ap-import">${svg("upload")}Открыть файл</button><input type="file" accept=".volna-theme,.json,application/json" id="ap-import-file" hidden>`)}
      ${row("Сбросить всё", "Вернуть «Ночную воду» и все настройки внешнего вида по умолчанию.", `<button class="btn ghost" id="ap-reset">${svg("rotate-ccw")}Сбросить</button>`)}
    </div></section>
    </div>`;
    wirePage(page);
    tides.add({ c: $("#ap-vis canvas", page), o: { lines: 20, top: 0.12, span: 0.7 } });
    syncPage(true);
  };

  function syncPage(first) {
    const p = pageEl;
    if (!p || (!first && !p.isConnected)) return;
    $$(".th-card", p).forEach((b) => b.classList.toggle("on", b.dataset.theme === ui.theme));
    $$("[data-note]", p).forEach((s) => { const t = themeById(s.dataset.note); s.textContent = ui.colors && t.id === ui.theme ? "изменена" : t.note || (t.tone === "light" ? "светлая" : ""); });
    $$("[data-seg]", p).forEach((g) => { const v = String(getPath(g.dataset.seg)); $$("button", g).forEach((b) => { b.classList.toggle("on", b.dataset.v === v); b.setAttribute("aria-checked", b.dataset.v === v); }); });
    $$("[data-sw]", p).forEach((s) => { const v = !!getPath(s.dataset.sw); s.classList.toggle("on", v); s.setAttribute("aria-checked", v); });
    $$("[data-range]", p).forEach((r) => {
      const v = getPath(r.dataset.range);
      if (document.activeElement !== r || +r.value !== v) r.value = v;
      r.style.setProperty("--v", (v - r.min) / (r.max - r.min) * 100 + "%");
      const lab = $(`[data-val="${r.dataset.range}"]`, p); if (lab) lab.textContent = (FMT[r.dataset.range] || String)(v);
    });
    const bc = baseColors();
    $$("[data-color]", p).forEach((inp) => { const v = bc[inp.dataset.color]; if (document.activeElement !== inp) inp.value = v; inp.nextElementSibling.style.background = v; });
    $$("[data-hex]", p).forEach((s) => { s.textContent = bc[s.dataset.hex]; });
    $("#ap-colors-note", p).textContent = ui.colors ? "Палитра изменена — основа «" + themeById(ui.theme).name + "»" : "Сейчас цвета темы «" + themeById(ui.theme).name + "»";
    $("#ap-colors-reset", p).disabled = !ui.colors;
    $$(".bg-opt", p).forEach((b) => b.classList.toggle("on", b.dataset.bg === ui.bg.type));
    $("#ap-pv-cover", p).style.backgroundImage = S.track && S.track.art ? `url("${S.track.art}")` : "";
    $("#ap-pv-image", p).style.backgroundImage = bgImage ? `url("${bgImage}")` : "";
    $("#ap-pv-image", p).innerHTML = bgImage ? "" : svg("upload");
    $("#ap-img-row", p).style.display = ui.bg.type === "image" ? "" : "none";
    $("#ap-img-note", p).textContent = bgImage ? "Картинка выбрана. Можно заменить другой." : "Выбери файл — он уменьшится до 1600 px и сохранится на этом компьютере.";
    const blurRow = $('[data-range="bg.blur"]', p).closest(".set-row"); blurRow.style.opacity = ["cover", "image"].includes(ui.bg.type) ? "" : ".45";
    $('[data-range="bg.dim"]', p).closest(".set-row").style.opacity = ui.bg.type === "solid" ? ".45" : "";
    $('[data-range="glassBlur"]', p).closest(".set-row").style.opacity = ui.glass ? "" : ".45";
    $('[data-range="left"]', p).closest(".set-row").style.opacity = ui.collapsed ? ".45" : "";
    $$(".font-opt", p).forEach((b) => b.classList.toggle("on", b.dataset.font === ui.font));
    paintHomeList(); paintKeys();
  }
  function paintHomeList() {
    const el = $("#ap-home", pageEl); if (!el) return;
    const o = ui.home.order, names = Object.fromEntries(HOME_SECS);
    el.innerHTML = o.map((k, i) => {
      const off = ui.home.hidden.includes(k);
      return `<div class="home-row${off ? " off" : ""}" data-k="${k}"><span class="n">${i + 1}</span><span class="nm">${esc(names[k])}</span>
        <button class="icon-btn" data-mv="-1" title="Выше"${i === 0 ? " disabled" : ""}>${svg("arrow-up")}</button>
        <button class="icon-btn" data-mv="1" title="Ниже"${i === o.length - 1 ? " disabled" : ""}>${svg("arrow-down")}</button>
        <button class="switch${off ? "" : " on"}" role="switch" aria-checked="${!off}" data-hs="${k}" title="${off ? "Показать" : "Скрыть"}"></button></div>`;
    }).join("");
  }
  let recording = null;
  function conflicts() {
    const seen = {}, out = {};
    for (const [id] of KEY_ACTIONS) { const c = UI_KEYS.map[id]; if (!c) continue; if (seen[c]) { out[id] = seen[c]; out[seen[c]] = id; } else seen[c] = id; }
    return out;
  }
  function paintKeys() {
    const el = $("#ap-keys", pageEl); if (!el) return;
    const cf = conflicts();
    el.innerHTML = KEY_ACTIONS.map(([id, label, def]) => {
      const c = UI_KEYS.map[id], rec = recording === id;
      const inner = rec ? (recording.live ? esc(recording.live) : "Нажми клавиши…") : c ? comboParts(c).map((p) => `<kbd>${esc(p)}</kbd>`).join('<span class="plus">+</span>') : `<span class="none">Не задано</span>`;
      return `<div class="key-row"><div class="nm">${esc(label)}${cf[id] ? `<small>Совпадает с «${esc(UI_KEYS.actions[cf[id]].label)}»</small>` : ""}</div>
        <button class="kbd-btn${rec ? " rec" : ""}${cf[id] ? " conflict" : ""}" data-key="${id}" title="Изменить">${inner}</button>
        <button class="icon-btn${c === def ? " hide" : ""}" data-key-reset="${id}" title="По умолчанию: ${esc(UI_KEYS.label(def))}">${svg("rotate-ccw")}</button></div>`;
    }).join("");
  }
  function stopRecording() {
    if (!recording) return;
    recording = null; UI_KEYS.recording = false;
    removeEventListener("mousedown", onRecordMouse, true);
    paintKeys();
  }
  /* слушатель ставится при загрузке — раньше всех остальных, чтобы запись сочетания перехватывала клавиши первой */
  addEventListener("keydown", (e) => { if (recording) onRecordKey(e); }, true);
  function onRecordMouse(e) { if (!e.target.closest(".kbd-btn.rec")) stopRecording(); }
  function onRecordKey(e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const id = recording && recording.id;
    if (!id) return;
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) { stopRecording(); return; }
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const keys = { ...ui.keys, [id]: "" }; stopRecording(); update("keys", keys); return;
    }
    const c = comboOf(e);
    if (!c) { recording.live = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean).join(" + ") + " + …"; paintKeys(); return; }
    if (RESERVED[c]) { toast(`${UI_KEYS.label(c)} занято: ${RESERVED[c]}`, "error", 3000); stopRecording(); return; }
    const other = KEY_ACTIONS.find(([o]) => o !== id && UI_KEYS.map[o] === c);
    const keys = { ...ui.keys, [id]: c };
    stopRecording();
    update("keys", keys);
    if (other) toast(`${UI_KEYS.label(c)} уже стоит на «${other[1]}» — поменяй одно из них`, "error", 4200);
    else toast(`«${UI_KEYS.actions[id].label}»: ${UI_KEYS.label(c)}`, "info", 1800);
  }

  function wirePage(p) {
    let colorRaf = 0, pendingColor = null;
    p.addEventListener("click", (e) => {
      const th = e.target.closest(".th-card[data-theme]");
      if (th) { ui.colors = null; update("theme", th.dataset.theme, { morph: true }); return; }
      const sg = e.target.closest("[data-seg] button");
      if (sg) { const path = sg.closest("[data-seg]").dataset.seg; update(path, sg.dataset.v, { morph: path === "accent" }); return; }
      const s = e.target.closest("[data-sw]");
      if (s) { update(s.dataset.sw, !getPath(s.dataset.sw)); return; }
      const b = e.target.closest(".bg-opt[data-bg]");
      if (b) {
        const v = b.dataset.bg;
        if (v === "image" && !bgImage) { $("#ap-img-file", p).click(); return; }
        chooseBg(v); return;
      }
      const f = e.target.closest(".font-opt[data-font]");
      if (f) { update("font", f.dataset.font); return; }
      const hs = e.target.closest("[data-hs]");
      if (hs) { const k = hs.dataset.hs, h = new Set(ui.home.hidden); h.has(k) ? h.delete(k) : h.add(k); update("home", { ...ui.home, hidden: [...h] }); return; }
      const mv = e.target.closest("[data-mv]");
      if (mv) {
        const k = mv.closest("[data-k]").dataset.k, o = ui.home.order.slice(), i = o.indexOf(k), j = i + +mv.dataset.mv;
        if (j < 0 || j >= o.length) return;
        [o[i], o[j]] = [o[j], o[i]];
        update("home", { ...ui.home, order: o });
        const btn = $(`[data-k="${k}"] [data-mv="${mv.dataset.mv}"]`, p); if (btn && !btn.disabled) btn.focus();
        return;
      }
      const kb = e.target.closest(".kbd-btn[data-key]");
      if (kb) {
        if (recording && recording.id === kb.dataset.key) { stopRecording(); return; }
        stopRecording();
        recording = { id: kb.dataset.key, live: "" }; UI_KEYS.recording = true;
        addEventListener("mousedown", onRecordMouse, true);
        paintKeys();
        const nb = $(`[data-key="${kb.dataset.key}"]`, p); if (nb) nb.focus();
        return;
      }
      const kr = e.target.closest("[data-key-reset]");
      if (kr) { const keys = { ...ui.keys }; delete keys[kr.dataset.keyReset]; update("keys", keys); return; }
    });
    $$("[data-range]", p).forEach((r) => r.addEventListener("input", () => {
      const step = +r.step || 1, v = Math.round(+r.value / step) * step;
      update(r.dataset.range, v);
    }));
    $$("[data-color]", p).forEach((inp) => inp.addEventListener("input", () => {
      pendingColor = { ...baseColors(), [inp.dataset.color]: inp.value };
      if (colorRaf) return;
      colorRaf = requestAnimationFrame(() => { colorRaf = 0; update("colors", pendingColor); });
    }));
    $("#ap-colors-reset", p).onclick = () => update("colors", null, { morph: true });
    $("#ap-home-reset", p).onclick = () => update("home", clone(DEFAULTS.home));
    $("#ap-keys-reset", p).onclick = () => { update("keys", {}); toast("Клавиши по умолчанию", "info", 1800); };
    $("#ap-img-pick", p).onclick = () => $("#ap-img-file", p).click();
    $("#ap-img-file", p).onchange = (e) => { const file = e.target.files[0]; e.target.value = ""; if (file) loadImage(file); };
    $("#ap-export", p).onclick = exportTheme;
    $("#ap-copy", p).onclick = () => {
      const txt = JSON.stringify(themeFile(), null, 1);
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast("Код темы скопирован"), () => toast("Не получилось скопировать", "error"));
    };
    $("#ap-import", p).onclick = () => $("#ap-import-file", p).click();
    $("#ap-import-file", p).onchange = (e) => { const file = e.target.files[0]; e.target.value = ""; if (file) importTheme(file); };
    $("#ap-reset", p).onclick = async () => {
      const ok = await dialog({ title: "Сбросить внешний вид?", text: "Тема, фон, шрифты, раскладка и горячие клавиши вернутся к настройкам по умолчанию.", ok: "Сбросить" });
      if (!ok) return;
      bgImage = null; ui = normalize(null); apply({ morph: true }); persist(); syncPage(); toast("Внешний вид сброшен");
    };
  }
  function chooseBg(v) {
    const patch = { ...ui.bg, type: v };
    if (v !== "solid" && ui.panelAlpha >= 100 && !ui.glass) {
      ui.panelAlpha = 82; ui.glass = true;
      toast("Панели стали полупрозрачными, чтобы фон было видно", "info", 2600);
    }
    update("bg", patch, { morph: true });
  }
  function loadImage(file) {
    if (!/^image\//.test(file.type)) { toast("Это не картинка", "error"); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.86, data = c.toDataURL("image/jpeg", q);
      while (data.length > 3500000 && q > 0.4) { q -= 0.12; data = c.toDataURL("image/jpeg", q); }
      bgImage = data;
      if (!lsSet(LS_IMG, data) && data.length > 200000) toast("Картинка слишком большая для хранилища — после перезапуска её может не быть", "error", 5000);
      chooseBg("image");
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast("Не получилось открыть картинку", "error"); };
    img.src = url;
  }
  function themeFile() {
    const u = clone(ui); delete u.bg.img;
    return { format: "volna-theme", version: 1, name: ui.colors ? `${themeById(ui.theme).name} (своя)` : themeById(ui.theme).name, ui: u, image: bgImage || undefined };
  }
  function exportTheme() {
    const data = themeFile();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `volna-${(data.name || "theme").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}.volna-theme`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Файл темы сохранён");
  }
  function importTheme(file) {
    const r = new FileReader();
    r.onload = () => {
      let d;
      try { d = JSON.parse(r.result); } catch (_) { toast("Файл повреждён — это не тема Volna", "error"); return; }
      if (!d || d.format !== "volna-theme" || typeof d.ui !== "object") { toast("Это не файл темы Volna", "error"); return; }
      const keepKeys = ui.keys;
      ui = normalize({ ...d.ui, keys: d.ui.keys || keepKeys });
      bgImage = typeof d.image === "string" && d.image.startsWith("data:image/") ? d.image : null;
      if (ui.bg.type === "image" && !bgImage) ui.bg.type = "solid";
      apply({ morph: true }); persist(); syncPage();
      toast(`Тема «${d.name || "без названия"}» загружена`);
    };
    r.onerror = () => toast("Не получилось прочитать файл", "error");
    r.readAsText(file);
  }

  window.UI_APPEARANCE = { get: () => clone(ui), set: (patch) => { ui = normalize({ ...ui, ...patch }); apply({ morph: true }); persist(); syncPage(); }, themes: THEMES };
})();
