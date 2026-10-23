"use strict";
/* Volna — плеер внизу, правая панель (сейчас играет / очередь), полноэкранный режим, волны на холстах. */

/* ---------------- события из Python ---------------- */
on("track", (t) => {
  const changed = !S.track || !t || S.track.id !== t.id;
  S.track = t;
  if (changed) { S.pos = 0; S.posAt = performance.now(); S.dur = t ? t.dur : 0; }
  paintTrack(changed);
  markPlaying();
});
on("playing", (v) => { S.playing = v; S.posAt = performance.now(); paintButtons(); markPlaying(); });
on("position", ({ pos, dur }) => { S.pos = pos; S.posAt = performance.now(); if (dur) S.dur = dur; });
on("loading", ({ on: v }) => { S.loading = v; paintButtons(); });
on("toast", ({ text, kind }) => toast(text, kind, kind === "error" ? 6000 : 3200));
on("tint", (c) => { S.tint = c || "#a8bcff"; document.documentElement.style.setProperty("--tint", S.tint); });
on("queue", (q) => { S.queue = q; S.ctx = q.ctx || ""; paintBadge(); if (rightTab === "queue" || rightTab === "now") paintRight(); emit("queue"); markPlaying(); });
listen("track-like", (liked) => { $$("#p-like, #now-like, #np-like").forEach((b) => { b.classList.toggle("on", liked); pop(b); }); });

function paintTrack(changed) {
  const t = S.track;
  $("#p-t").textContent = t ? t.title : "Ничего не играет";
  $("#p-t").classList.toggle("idle", !t);
  $("#p-a").textContent = t ? t.artist : "";
  $("#now-t").textContent = t ? t.title : "";
  $("#now-a").textContent = t ? t.artist : "";
  $$("#p-like, #now-like").forEach((b) => { b.classList.toggle("on", !!(t && t.liked)); if (t) b.dataset.likeId = t.id; });
  if (changed) {
    setCover($("#p-cover"), t && t.art);
    setCover($("#now-cover"), t && big(t.art));
    $("#now-blur").style.backgroundImage = t && t.art ? `url("${t.art}")` : "none";
  }
  document.title = t ? `${t.title} — ${t.artist}` : "Volna";
  if (changed) loadLyrics();
  if (rightTab === "now") paintRight();
}
function paintButtons() {
  const icon = S.loading ? "loader-circle" : S.playing ? "pause" : "play";
  $$("[data-ctrls] .play").forEach((b) => { b.innerHTML = svg(icon); b.classList.toggle("busy", S.loading); b.title = S.playing ? "Пауза" : "Играть"; });
  document.body.classList.toggle("paused", !S.playing);
  emit("play-state");
}
function paintBadge() {
  const b = $("#wave-badge");
  b.classList.toggle("on", !!S.queue.wave);
  const m = S.modes.find((x) => x.key === S.queue.mode);
  $("span", b).textContent = m ? `Волна: ${m.label.toLowerCase()}` : "Волна";
}

/* ---------------- управление ---------------- */
function act(a) {
  if (a === "toggle") { if (!S.track && !S.queue.wave) { startWave(); return; } call("toggle"); }
  else if (a === "next") call("next");
  else if (a === "prev") call("prev");
  else if (a === "dislike") { if (S.track) { call("dislike_current"); toast("Понял, такого будет меньше", "info", 2200); } }
  else if (a === "wavehere") { if (S.track) { startWave({ from_id: S.track.id }); toast("Запускаю волну по этому треку", "info", 2200); } }
}
function likeCurrent() {
  if (!S.track) return;
  setLike(S.track, !S.track.liked).then(() => {
    if (S.track && S.track.liked && S.queue.wave) toast("Волна подстроится под этот трек", "info", 2400);
  });
}
const curPos = () => (!S.playing || S.loading) ? S.pos : Math.min(S.dur || Infinity, S.pos + (performance.now() - S.posAt));

/* ---------------- правая панель ---------------- */
let rightTab = null;
function openRight(tab) {
  if (rightTab === tab) { closeRight(); return; }
  rightTab = tab;
  $("#app").classList.add("with-right");
  $$(".rhead .tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#btn-now").classList.toggle("on", tab === "now");
  $("#btn-queue").classList.toggle("on", tab === "queue");
  $("#btn-lyrics").classList.toggle("on", tab === "lyrics");
  paintRight();
  try { localStorage.setItem("volna.right", tab); } catch (_) { /* нет хранилища — не страшно */ }
}
function closeRight() {
  rightTab = null;
  $("#app").classList.remove("with-right");
  $("#btn-now").classList.remove("on"); $("#btn-queue").classList.remove("on"); $("#btn-lyrics").classList.remove("on");
  try { localStorage.setItem("volna.right", ""); } catch (_) { /* */ }
}
let artistCardCache = {};
function paintRight() {
  const body = $("#rbody");
  body.classList.toggle("lyr", rightTab === "lyrics");
  if (rightTab === "lyrics") { body.innerHTML = `<div class="lyrics" id="side-lyrics"></div>`; paintLyrics(); return; }
  if (rightTab === "now") {
    const t = S.track;
    if (!t) { body.innerHTML = `<div class="empty"><h3>Тишина</h3><p>Включи что-нибудь — здесь появится обложка, артист и что играет дальше.</p></div>`; return; }
    const nxt = (S.queue.user[0] || S.queue.next[0] || S.queue.items[0]);
    body.innerHTML = `<div class="np-big">${cover(big(t.art))}
      <div class="row1"><div><div class="t">${esc(t.title)}</div><a class="a" data-artist="${esc(t.ak)}">${esc(t.artist)}</a></div>
      <button class="icon-btn heart${t.liked ? " on" : ""}" id="np-like" data-like-id="${t.id}">${svg("heart")}</button></div></div>
      <div class="np-card" data-artist="${esc(t.ak)}"><div class="ph-art" id="np-artist-art" style="background-image:url('${esc(big(t.art))}')"><span>Об исполнителе</span></div>
      <div class="body"><h4>${esc(t.artist)}</h4><p id="np-artist-meta">…</p></div></div>
      ${nxt ? `<div class="np-card next"><div class="lbl"><span>Дальше в очереди</span><a id="np-open-q">Открыть очередь</a></div>
        <div class="qi">${cover(nxt.art)}<div><div class="t">${esc(nxt.title)}</div><div class="a">${esc(nxt.artist)}</div></div></div></div>` : ""}`;
    $("#np-like").onclick = likeCurrent;
    const oq = $("#np-open-q"); if (oq) oq.onclick = () => openRight("queue");
    body.querySelectorAll("[data-artist]").forEach((a) => a.onclick = () => go("artist", a.dataset.artist));
    const key = t.ak;
    const fill = (d) => {
      const m = $("#np-artist-meta"); if (!m || !S.track || S.track.ak !== key) return;
      m.textContent = d.listened_ms > 60000 ? `Ты слушал ${nMin(d.listened_ms)}${d.liked ? `, в любимых ${nTracks(d.liked)}` : ""}` :
        d.known > 1 ? `${nTracks(d.known)} в твоей медиатеке и рекомендациях` : "Новый для тебя артист";
      if (d.avatar) $("#np-artist-art").style.backgroundImage = `url('${d.avatar}')`;
    };
    if (artistCardCache[key]) fill(artistCardCache[key]);
    else call("artist", { key }).then((d) => { artistCardCache[key] = d; fill(d); }).catch(() => {});
  } else if (rightTab === "queue") {
    const q = S.queue, t = S.track;
    const qi = (x, kind, i, drag) => `<div class="qi" data-kind="${kind}" data-i="${i}"${drag ? ' draggable="true"' : ""}>${cover(x.art)}
      <div><div class="t">${esc(x.title)}</div><div class="a">${esc(x.artist)}</div></div>
      <button class="icon-btn x" data-rm title="Убрать">${svg("x")}</button></div>`;
    body.innerHTML = (t ? `<div class="q-sec">Сейчас играет</div><div class="qi now">${cover(t.art)}<div><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div><span></span></div>` : "") +
      (q.user.length ? `<div class="q-sec">Далее в очереди</div>${q.user.map((x, i) => qi(x, "user", i, true)).join("")}` : "") +
      (q.next.length ? `<div class="q-sec">${q.wave ? "Дальше в волне" : "Далее"}${!q.wave && S.ctx ? ` <small>из «${esc(S.ctx)}»</small>` : ""}</div>${q.next.map((x, i) => qi(x, "next", i, !q.wave)).join("")}` : "") +
      (!t && !q.user.length && !q.next.length ? `<div class="empty"><h3>Очередь пуста</h3><p>Нажми «…» у любого трека → «Добавить в очередь».</p></div>` : "");
  }
}
function wireRight() {
  $$(".rhead .tabs button").forEach((b) => b.onclick = () => { rightTab = null; openRight(b.dataset.tab); });
  $("#right-close").onclick = closeRight;
  $("#btn-now").onclick = () => openRight("now");
  $("#btn-queue").onclick = () => openRight("queue");
  $("#btn-lyrics").onclick = () => openRight("lyrics");
  const body = $("#rbody");
  body.addEventListener("click", (e) => {
    const row = e.target.closest(".qi[data-kind]"); if (!row) return;
    const kind = row.dataset.kind, i = +row.dataset.i;
    if (e.target.closest("[data-rm]")) call("queue_remove", { kind, i });
    else call("queue_jump", { kind, i });
  });
  let drag = null;
  body.addEventListener("dragstart", (e) => { const r = e.target.closest(".qi[draggable]"); if (!r) return; drag = { kind: r.dataset.kind, i: +r.dataset.i }; r.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "q"); });
  body.addEventListener("dragend", () => { $$(".dragging,.over", body).forEach((x) => x.classList.remove("dragging", "over")); drag = null; });
  body.addEventListener("dragover", (e) => { const r = e.target.closest(".qi[draggable]"); if (!drag || !r || r.dataset.kind !== drag.kind) return; e.preventDefault(); $$(".over", body).forEach((x) => x.classList.remove("over")); r.classList.add("over"); });
  body.addEventListener("drop", (e) => { const r = e.target.closest(".qi[draggable]"); if (!drag || !r || r.dataset.kind !== drag.kind) return; e.preventDefault(); call("queue_move", { kind: drag.kind, src: drag.i, dst: +r.dataset.i }); });
  let saved = null;
  try { saved = localStorage.getItem("volna.right"); } catch (_) { /* */ }
  if (saved === "now" || saved === "queue" || saved === "lyrics" || saved === null) openRight(saved || "now");
}

/* ---------------- волны на холстах ---------------- */
const tintNow = [168, 188, 255];
const hexRgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function stepTint() { const t = hexRgb(S.tint); for (let k = 0; k < 3; k++) tintNow[k] += (t[k] - tintNow[k]) * 0.04; }
const rgba = (a) => `rgba(${tintNow[0] | 0},${tintNow[1] | 0},${tintNow[2] | 0},${a})`;
function fit(c) {
  const dpr = devicePixelRatio || 1, r = c.getBoundingClientRect();
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return [w, h, dpr];
}
/* рельеф воды из контурных линий — для баннера на главной и страницы волны */
function drawTide(c, t, opts = {}) {
  if (!c || !c.isConnected || !c.offsetParent) return;
  const [w, h, dpr] = fit(c); if (!w || !h) return;
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  const V = window.UI_VIS || {}, style = V.style || "lines";   // стиль из «Внешнего вида»
  if (style === "off") return;
  if (V.motion === "off") t = 0; else if (V.motion === "reduced") t *= 0.35;
  const N = opts.lines || 26, e = S.energy;
  const top = opts.top ?? 0.12, span = opts.span ?? 0.8;
  const ink = (a) => opts.white ? `rgba(${V.ink || "255,255,255"},${a * 0.8})` : rgba(a.toFixed(3));
  const wave = (u, i, k, amp) => Math.sin(u * 5.1 + t * 0.00042 * (1 + e) + i * 0.37) * amp
    + Math.sin(u * 11.7 - t * 0.00063 + i * 0.21) * amp * 0.35
    + Math.sin(u * 2.3 + t * 0.00021 - k * 2.2) * amp * 0.8;
  if (style === "bars" || style === "mirror") {
    const n = Math.max(24, Math.floor(w / (9 * dpr))), bw = w / n, b = S.playing && S.bands;
    const mid = h * (top + span / 2), full = h * span * (opts.amp || 1);
    for (let j = 0; j < n; j++) {
      const u = (j + 0.5) / n;
      let v = (0.22 + 0.34 * (0.5 + 0.5 * Math.sin(u * 5.1 + t * 0.0009 * (1 + e))) + 0.22 * (0.5 + 0.5 * Math.sin(u * 13.7 - t * 0.0016))) * (0.45 + e * 0.7);
      if (b) v = v * 0.45 + (b[Math.floor(Math.abs(u - 0.5) * 2 * b.length * 0.8)] || 0) * 0.85;
      const bh = Math.max(2 * dpr, Math.min(1, v) * full * (style === "mirror" ? 1 : 1.15));
      const a = (0.12 + 0.3 * Math.pow(Math.sin(u * Math.PI), 1.5)) * (0.55 + e * 0.45) * (opts.alpha || 1);
      g.fillStyle = ink(a);
      if (style === "mirror") g.fillRect(j * bw + bw * 0.22, mid - bh / 2, bw * 0.56, bh);
      else g.fillRect(j * bw + bw * 0.22, h - bh, bw * 0.56, bh);
    }
    return;
  }
  for (let i = 0; i < N; i++) {
    const k = i / (N - 1), base = h * (top + k * span);
    const amp = h * (0.03 + 0.05 * Math.sin(k * Math.PI)) * (0.45 + e * 0.9) * (opts.amp || 1);
    const a = (0.06 + 0.55 * Math.pow(Math.sin(k * Math.PI), 2.2)) * (0.55 + e * 0.45) * (opts.alpha || 1);
    if (style === "dots") {
      if (i % 2) continue;
      g.fillStyle = ink(Math.min(1, a * 1.5));
      const r = (0.7 + 1.5 * Math.sin(k * Math.PI)) * dpr * (0.7 + e * 0.4);
      for (let x = (i % 4 ? 7 : 0) * dpr; x <= w; x += 14 * dpr) { g.beginPath(); g.arc(x, base + wave(x / w, i, k, amp), r, 0, Math.PI * 2); g.fill(); }
      continue;
    }
    g.beginPath();
    for (let x = 0; x <= w; x += 6 * dpr) {
      const y = base + wave(x / w, i, k, amp);
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = ink(a);
    g.lineWidth = (k > 0.45 && k < 0.55 ? 2 : 1.1) * dpr;
    g.stroke();
  }
}
function drawScrub(c, t, o) {
  if (!c.offsetParent) return;
  const [w, h, dpr] = fit(c); if (!w) return;
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  const p = c._drag != null ? c._drag : S.dur ? Math.min(1, curPos() / S.dur) : 0;
  const mid = h / 2, amp = (o.amp + (c._hover ? 1.5 : 0)) * dpr * (0.2 + S.energy * 0.8);
  const yAt = (x) => mid + Math.sin(x / (o.len * dpr) * Math.PI * 2 - t * 0.004) * amp;
  const px = p * w;
  g.lineCap = "round";
  g.beginPath(); g.moveTo(px, mid); g.lineTo(w, mid);
  g.strokeStyle = "rgba(168,188,255,.2)"; g.lineWidth = (c._hover ? 4 : 3) * dpr; g.stroke();
  if (px > 1) {
    g.beginPath(); for (let x = 0; x <= px; x += 2 * dpr) x ? g.lineTo(x, yAt(x)) : g.moveTo(x, yAt(x));
    g.strokeStyle = c._hover ? rgba(1) : "rgba(238,241,251,.95)"; g.lineWidth = (c._hover ? 3.2 : 2.6) * dpr; g.stroke();
  }
  if (c._hover || c._drag != null) { g.beginPath(); g.arc(px, yAt(px), 6 * dpr, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill(); }
}
function wireScrub(c) {
  const frac = (e) => Math.max(0, Math.min(1, (e.clientX - c.getBoundingClientRect().left) / c.getBoundingClientRect().width));
  c.addEventListener("mouseenter", () => { c._hover = true; });
  c.addEventListener("mouseleave", () => { c._hover = false; });
  c.addEventListener("mousedown", (e) => {
    if (!S.dur || !S.track) return;
    c._drag = frac(e);
    const mv = (ev) => { c._drag = frac(ev); };
    const up = (ev) => {
      const f = frac(ev); c._drag = null;
      S.pos = f * S.dur; S.posAt = performance.now();
      call("seek", { ms: Math.round(S.pos) });
      removeEventListener("mousemove", mv); removeEventListener("mouseup", up);
    };
    addEventListener("mousemove", mv); addEventListener("mouseup", up);
  });
}
const tides = new Set();   // холсты-волны активной страницы
function loop(t) {
  const target = !S.playing ? 0.28 : S.bands ? 0.45 + Math.min(1.1, S.level * 1.6) : 1;
  S.energy += (target - S.energy) * (S.bands ? 0.12 : 0.03);
  if (S.playing && performance.now() - S.bandsAt > 600) S.bands = null;   // движок замолчал — обычная анимация
  stepTint();
  tides.forEach((x) => drawTide(x.c, t, x.o));
  drawScrub($("#scrub"), t, { amp: 2.6, len: 20 });
  if ($("#now").classList.contains("on")) { drawScrub($("#now-scrub"), t, { amp: 5, len: 38 }); drawSpectrum($("#now-spectrum")); }
  tickLyrics();
  const pos = $("#scrub")._drag != null ? $("#scrub")._drag * S.dur : curPos();
  $$("[data-pos]").forEach((el) => { el.textContent = fmt(pos); });
  $$("[data-dur]").forEach((el) => { el.textContent = fmt(S.dur); });
  requestAnimationFrame(loop);
}

/* ---------------- громкость, полный экран, клавиши ---------------- */
let lastVol = 70;
function setVol(v, send = true) {
  S.volume = v; $("#vol").value = v; $("#vol").style.setProperty("--v", v + "%");
  $("#mute").innerHTML = svg(v === 0 ? "volume-x" : v < 50 ? "volume-1" : "volume-2");
  if (send) call("volume", { v });
}
function wirePlayer() {
  $$("[data-ctrls]").forEach((el) => el.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) act(b.dataset.act); }));
  $("#p-like").onclick = likeCurrent; $("#now-like").onclick = likeCurrent;
  $("#p-a").onclick = () => S.track && go("artist", S.track.ak);
  $("#now-a").onclick = () => { if (S.track) { $("#now").classList.remove("on"); go("artist", S.track.ak); } };
  $("#p-cover").onclick = $("#btn-full").onclick = () => S.track && $("#now").classList.add("on");
  $("#now-close").onclick = () => $("#now").classList.remove("on");
  $("#now-open").onclick = () => S.track && S.track.url && call("open_url", { url: S.track.url });
  $("#wave-badge").onclick = () => go("wave");
  $("#vol").oninput = (e) => setVol(+e.target.value);
  $("#vol").addEventListener("wheel", (e) => { e.preventDefault(); setVol(Math.max(0, Math.min(100, S.volume + (e.deltaY < 0 ? 5 : -5)))); }, { passive: false });
  $("#mute").onclick = () => { if (S.volume) { lastVol = S.volume; setVol(0); } else setVol(lastVol || 70); };
  wireScrub($("#scrub")); wireScrub($("#now-scrub"));
  $("#p-cover").addEventListener("contextmenu", (e) => { if (S.track) { e.preventDefault(); openMenu(e.clientX, e.clientY, trackMenu(S.track)); } });
  wireRight();
  wireExtras();
  /* горячие клавиши: карта из «Внешнего вида» (window.UI_KEYS), Ctrl+K свободен для палитры команд */
  addEventListener("keydown", (e) => {
    // поверх всего открыто окно (палитра, диалог, итоги) — клавиши плеера не трогаем, Esc закрывает только его
    if ($("#palette") || $("#modal").classList.contains("on") || $("#recap").classList.contains("on")) return;
    if (e.key === "Escape") { $("#now").classList.remove("on"); closeMenu(); }
    const K = window.UI_KEYS;
    if (!K) { if (e.code === "Space" && !e.target.matches("input, textarea")) { e.preventDefault(); act("toggle"); } return; }
    if (K.recording || (e.repeat && !/Arrow/.test(e.code))) return;
    const combo = K.combo(e);
    if (!combo || combo === "Ctrl+KeyK") return;
    const name = K.find(combo); if (!name) return;
    const a = K.actions[name];
    const typing = e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
    if (typing && !(a.global && (e.ctrlKey || e.altKey))) return;
    if ($("#recap").classList.contains("on") || $("#modal").classList.contains("on")) return;
    e.preventDefault();
    a.run();
  });
  requestAnimationFrame(loop);
}

/* ---------------- спектр от звукового движка ---------------- */
S.bands = null; S.bandsAt = 0; S.level = 0;
const smooth = [];
on("spectrum", (b) => {
  S.bands = b; S.bandsAt = performance.now();
  const lows = b.slice(0, Math.max(3, Math.floor(b.length / 6)));
  S.level = lows.reduce((a, x) => a + x, 0) / lows.length;
});
function drawSpectrum(c) {
  if (!c) return;
  const [w, h, dpr] = fit(c); if (!w) return;
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  const style = (window.UI_VIS && window.UI_VIS.style) || "lines";   // «lines» — исходные скруглённые столбики
  if (style === "off") return;
  const b = S.bands;
  const n = style === "bars" ? 96 : style === "dots" ? 48 : 64;
  for (let i = 0; i < n; i++) {
    let v;
    if (b && S.playing) { const k = i / n * b.length; v = b[Math.floor(k)] || 0; }
    else v = S.playing ? 0.12 + 0.08 * Math.sin(performance.now() / 400 + i * 0.5) : 0.03;
    smooth[i] = (smooth[i] || 0) + (v - (smooth[i] || 0)) * 0.35;
    const bw = w / n, bh = Math.max(2 * dpr, smooth[i] * h * 0.95);
    if (style === "dots") {
      const step = 9 * dpr, cnt = Math.max(1, Math.round(bh / step)), r = Math.min(bw * 0.3, 3.2 * dpr);
      for (let j = 0; j < cnt; j++) { g.fillStyle = rgba(Math.max(0.1, 0.95 - j / (h / step)).toFixed(3)); g.beginPath(); g.arc(i * bw + bw / 2, h - step / 2 - j * step, r, 0, Math.PI * 2); g.fill(); }
      continue;
    }
    if (style === "mirror") {
      const m = h / 2, hh = Math.max(2 * dpr, smooth[i] * h * 0.9) / 2;
      const grd = g.createLinearGradient(0, m - hh, 0, m + hh);
      grd.addColorStop(0, rgba(0.15)); grd.addColorStop(0.5, rgba(0.95)); grd.addColorStop(1, rgba(0.15));
      g.fillStyle = grd;
      g.beginPath(); g.roundRect(i * bw + bw * 0.2, m - hh, bw * 0.6, hh * 2, 3 * dpr); g.fill();
      continue;
    }
    const grd = g.createLinearGradient(0, h - bh, 0, h);
    grd.addColorStop(0, rgba(0.9)); grd.addColorStop(1, rgba(0));
    g.fillStyle = grd;
    g.beginPath();
    if (style === "bars") g.rect(i * bw + bw * 0.12, h - bh, bw * 0.76, bh);
    else g.roundRect(i * bw + bw * 0.18, h - bh, bw * 0.64, bh, [4 * dpr, 4 * dpr, 0, 0]);
    g.fill();
  }
}

/* ---------------- тексты песен ---------------- */
const LY = { id: null, data: null, loading: false, idx: -1 };
function loadLyrics() {
  const t = S.track;
  LY.id = t ? t.id : null; LY.data = null; LY.idx = -1;
  if (!t) { paintLyrics(); return; }
  LY.loading = true; paintLyrics();
  const id = t.id;
  call("lyrics", { id }).then((d) => { if (LY.id !== id) return; LY.data = d; LY.loading = false; paintLyrics(); })
    .catch(() => { if (LY.id !== id) return; LY.data = { found: false, error: true }; LY.loading = false; paintLyrics(); });
}
function lyricsHtml() {
  const d = LY.data;
  if (!S.track) return `<div class="msg"><h3>Тишина</h3>Включи трек — здесь появится его текст.</div>`;
  if (LY.loading) return `<div class="msg">Ищу текст…</div>`;
  if (!d || !d.found) return `<div class="msg"><h3>${d && d.error ? "Нет связи с базой текстов" : "Текст не найден"}</h3>${d && d.error ? "Проверь интернет и включи трек ещё раз." : "Для этого трека в открытой базе LRCLIB текста пока нет."}</div>`;
  if (d.instrumental) return `<div class="msg"><h3>Инструментал</h3>Здесь нет слов — просто слушай.</div>`;
  if (d.synced && d.synced.length) return d.synced.map((l, i) => `<div class="ln${l.text ? "" : " gap"}" data-i="${i}" data-t="${l.t}">${esc(l.text) || "♪"}</div>`).join("");
  return `<div class="note">Текст без привязки ко времени</div><div class="plain">${esc(d.plain)}</div>`;
}
function paintLyrics() {
  const synced = !!(LY.data && LY.data.synced && LY.data.synced.length);
  $("#now").classList.toggle("no-lyrics", !(LY.data && LY.data.found && !LY.data.instrumental));
  for (const id of ["#now-lyrics", "#side-lyrics"]) {
    const el = $(id); if (!el) continue;
    el.innerHTML = lyricsHtml();
    el.classList.toggle("synced", synced);
    el.onclick = (e) => { const ln = e.target.closest(".ln"); if (ln) { S.pos = +ln.dataset.t; S.posAt = performance.now(); call("seek", { ms: +ln.dataset.t }); LY.idx = -1; } };
  }
  LY.idx = -1;
}
function tickLyrics() {
  const d = LY.data;
  if (!d || !d.synced || !d.synced.length) return;
  const pos = curPos() + 250;
  let lo = 0, hi = d.synced.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (d.synced[m].t <= pos) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx === LY.idx) return;
  LY.idx = idx;
  for (const id of ["#now-lyrics", "#side-lyrics"]) {
    const el = $(id); if (!el || !el.offsetParent) continue;
    $$(".ln", el).forEach((ln, i) => { ln.classList.toggle("cur", i === idx); ln.classList.toggle("past", i < idx); });
    const cur = $(`.ln[data-i="${idx}"]`, el);
    if (cur && !el.matches(":hover")) el.scrollTo({ top: cur.offsetTop - el.clientHeight * 0.38, behavior: "smooth" });
  }
}

/* ---------------- таймер сна, мини-плеер, команды извне ---------------- */
let sleepState = { on: false };
function paintSleep() {
  const b = $("#btn-sleep");
  b.classList.toggle("on", !!sleepState.on);
  let label = "";
  if (sleepState.track) label = "1";
  else if (sleepState.end) label = Math.max(1, Math.ceil((sleepState.end - Date.now()) / 60000)) + "";
  b.innerHTML = svg("moon") + (sleepState.on ? `<small>${label === "1" && sleepState.track ? "трек" : label}</small>` : "");
  b.title = sleepState.on ? (sleepState.track ? "Пауза после этого трека" : `Пауза через ${label} мин`) : "Таймер сна";
}
on("sleep", (st) => { sleepState = st; paintSleep(); if (st.done) toast("Спокойной ночи — музыка на паузе", "info", 4000); });
setInterval(() => { if (sleepState.on && sleepState.end) paintSleep(); }, 20000);
function sleepMenu(x, y) {
  const set = (args, msg) => call("sleep", args).then((st) => { sleepState = st; paintSleep(); if (msg) toast(msg, "info", 2400); });
  const items = [15, 30, 45, 60, 90].map((m) => ({ icon: "timer", label: `Через ${m} минут`, run: () => set({ minutes: m }, `Музыка затихнет через ${m} минут`) }));
  items.push({ icon: "music", label: "В конце этого трека", run: () => set({ track: true }, "Пауза после этого трека") });
  if (sleepState.on) items.push("-", { icon: "circle-off", label: "Выключить таймер", run: () => set({ cancel: true }, "Таймер выключен") });
  openMenu(x, y, items);
}
on("remote", (cmd) => { if (cmd === "wave") startWave(); });
on("track-like", (liked) => { if (S.track) { S.track.liked = liked; emit("track-like", liked); } });
function wireExtras() {
  $("#btn-sleep").onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); sleepMenu(r.left - 180, r.top - 330); };
  $("#btn-mini").onclick = () => call("mini").then((on2) => { $("#btn-mini").classList.toggle("on", !!on2); toast(on2 ? "Мини-плеер открыт поверх всех окон" : "Мини-плеер закрыт", "info", 2200); });
  paintSleep();
  paintLyrics();
}
