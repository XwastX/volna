"use strict";
/* Volna Mobile — плеер: очередь, волна, звук (<audio> + WebAudio: эквалайзер, громкость, спектр),
   уведомление с кнопками и работа в фоне (плагин MediaSession запускает foreground-сервис). */
(() => {
  const { U, FS, DIR, P } = window.VP;
  const EQ_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const COMPLETE_RATIO = 0.8;

  class Player {
    constructor(app) {
      this.app = app;                     // { db, settings, sc, ym, offline, emit, slim }
      this.audio = new Audio(); this.audio.preload = "auto";
      this.userQueue = []; this.items = []; this.index = -1; this.wave = null; this.waveHistory = []; this.carry = null;
      this.current = null; this.req = 0; this.failStreak = 0; this.prefetched = new Set();
      this.offlineOnly = !!app.settings.get("offline_mode", false);
      this.stopAfter = false; this.hold = false; this.lastPosEmit = 0;
      this.ctx = null; this.gain = null; this.eq = []; this.analyser = null; this.specTimer = null;
      const a = this.audio;
      a.addEventListener("timeupdate", () => this.onTime());
      a.addEventListener("play", () => { this.emitPlaying(true); this.startSpectrum(); });
      a.addEventListener("pause", () => { this.emitPlaying(false); });
      a.addEventListener("ended", () => this.onEnded());
      a.addEventListener("error", () => { if (a.src && this.current) this.fail("Не удалось воспроизвести файл — пробую следующий"); });
      this.setVolume(app.settings.get("volume", 80), false);
      this.media();
    }
    get engineName() { return "volna"; }
    get playing() { return !this.audio.paused && !this.audio.ended; }
    emit(n, d) { this.app.emit(n, d); }
    emitPlaying(on) { this.emit("playing", on); if (P.Media) P.Media.setPlaybackState({ playbackState: on ? "playing" : "paused" }).catch(() => {}); }

    /* ---------------- звук ---------------- */
    graph() {
      if (this.ctx || this.app.settings.get("webaudio", true) === false) return;
      try {
        const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
        this.ctx = new C();
        const src = this.ctx.createMediaElementSource(this.audio);
        let node = src;
        this.eq = EQ_HZ.map((hz, i) => { const f = this.ctx.createBiquadFilter(); f.type = i === 0 ? "lowshelf" : i === 9 ? "highshelf" : "peaking"; f.frequency.value = hz; f.Q.value = 1.1; node.connect(f); node = f; return f; });
        this.gain = this.ctx.createGain(); node.connect(this.gain);
        this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.72;
        this.gain.connect(this.analyser); this.analyser.connect(this.ctx.destination);
        this.audio.volume = 1;
        this.applyAudio(); this.setVolume(this.app.settings.get("volume", 80), false);
      } catch (e) { console.warn("webaudio", e); this.ctx = null; }
    }
    applyAudio() {
      if (!this.eq.length) return;
      const on = !!this.app.settings.get("eq_on", false), g = this.app.settings.get("eq", new Array(10).fill(0));
      this.eq.forEach((f, i) => { f.gain.value = on ? U.clamp(+g[i] || 0, -12, 12) : 0; });
    }
    volumeRaw(v) { const x = U.clamp(v, 0, 100) / 100, y = x * x; if (this.gain) this.gain.gain.value = y; else this.audio.volume = y; }
    setVolume(v, save = true) { this.volumeRaw(v); if (save) this.app.settings.set("volume", v); }
    startSpectrum() {
      if (!this.analyser || this.specTimer) return;
      const data = new Uint8Array(this.analyser.frequencyBinCount), bands = 48, sr = this.ctx.sampleRate;
      const edges = Array.from({ length: bands + 1 }, (_, i) => Math.round(40 * Math.pow(16000 / 40, i / bands) / (sr / 2) * data.length));
      this.specTimer = setInterval(() => {
        if (this.audio.paused || document.hidden) { if (this.audio.paused) { clearInterval(this.specTimer); this.specTimer = null; } return; }
        this.analyser.getByteFrequencyData(data);
        const out = [];
        for (let b = 0; b < bands; b++) { let s = 0, n = 0; for (let i = edges[b]; i <= Math.max(edges[b], edges[b + 1] - 1); i++) { s += data[i] || 0; n++; } out.push(Math.round(Math.min(1, s / n / 230) * 1000) / 1000); }
        this.emit("spectrum", out);
      }, 40);
    }

    /* ---------------- системное уведомление и кнопки гарнитуры ---------------- */
    media() {
      const M = P.Media; if (!M) return;
      const h = (action, fn) => M.setActionHandler({ action }, fn).catch(() => {});
      h("play", () => this.toggle(true)); h("pause", () => this.toggle(false));
      h("nexttrack", () => this.next()); h("previoustrack", () => this.prev());
      h("seekto", (d) => { if (d && d.seekTime != null) this.seek(d.seekTime * 1000); });
      h("stop", () => this.toggle(false));
    }
    mediaMeta(t) {
      if (!P.Media || !t) return;
      const art = (t.artwork_url || "").replace("-t300x300.", "-t500x500.");
      P.Media.setMetadata({ title: t.title, artist: t.artist, album: t.album || "Volna", artwork: art ? [{ src: art, sizes: "500x500", type: "image/jpeg" }] : [] }).catch(() => {});
    }
    onTime() {
      const now = Date.now(); if (now - this.lastPosEmit < 450) return; this.lastPosEmit = now;
      const pos = Math.round(this.audio.currentTime * 1000), dur = this.duration();
      this.emit("position", { pos, dur });
      if (this.app.onPosition) this.app.onPosition(pos, dur);
      if (P.Media && dur && now % 5000 < 500) P.Media.setPositionState({ duration: dur / 1000, position: Math.min(pos, dur) / 1000, playbackRate: 1 }).catch(() => {});
    }
    duration() { const d = this.audio.duration; return isFinite(d) && d > 0 ? Math.round(d * 1000) : (this.current && this.current.duration_ms) || 0; }
    position() { return Math.round(this.audio.currentTime * 1000); }

    /* ---------------- откуда брать звук ---------------- */
    useYm(t) { const ym = this.app.ym; if (!ym || !t.ym_id || !ym.logged) return false; return this.app.settings.get("ym_prefer", true) !== false || !t.sc_id; }
    async fetch(t, progress, forceNet = false) {
      const row = t.id ? this.app.db.track(t.id) : null;
      const off = await this.app.offline.fileFor(row || t);
      if (off) return { path: off, dir: DIR.DATA };
      if (this.offlineOnly && !forceNet) throw new Error(`«${t.title || ""}» не скачан — в офлайн-режиме играют только скачанные треки`);
      const name = await this.fetchNet(t, progress);
      return { path: `audio/${name}`, dir: DIR.CACHE, name };
    }
    async fetchNet(t, progress) {
      const { sc, ym, db } = this.app; let ymErr = null;
      if (this.useYm(t)) { try { return await ym.stream(t.ym_id, progress); } catch (e) { ymErr = e; } }
      if (ymErr && !t.sc_id) {
        const c = await window.VSrc.findOnSoundCloud(sc, t.title, t.artist, t.duration_ms || 0);
        if (!c) throw new Error(`${String(ymErr.message).replace(/\.$/, "")}. На SoundCloud трек тоже не нашёлся.`);
        db.attachMatch(t.id, c); Object.assign(t, db.track(t.id));
        return sc.stream(t.sc_id, progress);
      }
      try { await this.resolve(t); return await sc.stream(t.sc_id, progress); }
      catch (e) { if (!ymErr && t.ym_id && ym && ym.logged) return ym.stream(t.ym_id, progress); throw e; }
    }
    async resolve(t) {
      if (t.sc_id) return;
      const c = await window.VSrc.findOnSoundCloud(this.app.sc, t.title, t.artist, t.duration_ms || 0);
      if (!c) {
        if (t.ym_id) throw new Error(`«${t.artist} — ${t.title}» есть только в Яндекс Музыке — войди в Яндекс в настройках, чтобы его слушать`);
        this.app.db.markMatchFailed(t.id); throw new Error(`«${t.artist} — ${t.title}» не нашёлся на SoundCloud`);
      }
      this.app.db.attachMatch(t.id, c); Object.assign(t, this.app.db.track(t.id));
    }

    /* ---------------- загрузка и переходы ---------------- */
    async load(t) {
      const req = ++this.req; this.audio.pause();
      t = { ...t }; delete t._logged;
      if (this.wave && this.waveHistory.length && this.waveHistory[this.waveHistory.length - 1].id === t.id) this.waveHistory[this.waveHistory.length - 1] = t;
      this.current = t; this.app.onTrack(t); this.emit("loading", { on: true, frac: 0 });
      try {
        const f = await this.fetch(t, (x) => { if (req === this.req) this.emit("loading", { on: true, frac: x }); });
        if (req !== this.req) return;
        const fresh = this.app.db.track(t.id); if (fresh) { Object.assign(this.current, { ...fresh, ...this.current, liked: fresh.liked, offline: fresh.offline }); }
        this.failStreak = 0; this.emit("loading", { on: false, frac: 1 });
        this.app.onTrack(this.current); this.mediaMeta(this.current);
        this.graph(); if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
        this.audio.src = await FS.src(f.path, f.dir);
        if (!this.hold) await this.audio.play().catch((e) => { if (e.name !== "AbortError") throw e; });
        this.app.db.log(t.id, "play", 0, this.wave ? "wave" : "list");
        this.prefetch();
      } catch (e) { if (req === this.req) this.fail(e.message || String(e)); }
    }
    prefetch() {
      const nx = this.upcoming(1)[0]; if (!nx || this.offlineOnly) return;
      const key = this.useYm(nx) ? `ym${nx.ym_id}` : nx.sc_id; if (!key || this.prefetched.has(key)) return;
      this.prefetched.add(key); this.fetch({ ...nx }).catch(() => {});
    }
    fail(msg) {
      this.emit("loading", { on: false, frac: 0 }); this.emit("toast", { text: msg, kind: "error" });
      this.failStreak++;
      if (this.current && this.failStreak < 4) { this.current._logged = true; this.advance(); }
    }
    onEnded() {
      this.finishCurrent(false);
      if (this.stopAfter) { this.stopAfter = false; this.audio.currentTime = 0; this.emit("sleep", { on: false, done: true }); return; }
      this.advance();
    }
    finishCurrent(manual) {
      const t = this.current; if (!t || t._logged) return; t._logged = true;
      const full = this.duration(), pos = manual ? this.position() : full, completed = !manual || pos >= (full || 1) * COMPLETE_RATIO;
      if (manual && pos < 1500) return;
      if (this.wave && this.waveHistory.includes(t)) { try { this.wave.onFinished(t, pos, completed); } catch (e) { console.warn(e); } }
      else this.app.db.log(t.id, completed ? "complete" : "skip", pos, "list");
    }
    advance() {
      if (this.userQueue.length) { const t = this.userQueue.shift(); this.queueChanged(); this.load(t); }
      else if (this.wave) this.nextFromWave();
      else if (this.index + 1 < this.items.length) { this.index++; this.load(this.items[this.index]); }
      else { this.audio.pause(); this.current = null; this.app.onTrack(null); }
    }
    async nextFromWave() {
      const w = this.wave, req = ++this.req;
      if (this.carry) { const t = this.carry; this.carry = null; this.waveHistory.push(t); this.queueChanged(); this.load(t); return; }
      this.emit("loading", { on: true, frac: 0 });
      let t;
      try { t = await w.next(); } catch (e) { if (req === this.req) this.fail(e.message); return; }
      if (req !== this.req || this.wave !== w) return;
      if (!t) { this.emit("loading", { on: false, frac: 0 }); this.emit("toast", { text: "Волне не из чего выбирать — добавь музыку в библиотеку", kind: "error" }); return; }
      this.waveHistory.push(t); this.queueChanged(); this.load(t);
    }
    queueChanged() { this.app.onQueue(); }

    /* ---------------- управление ---------------- */
    playList(tracks, start = 0) {
      this.hold = false; this.failStreak = 0; this.finishCurrent(true); this.carry = null; this.wave = null;
      this.items = tracks.slice(); this.index = U.clamp(start, 0, this.items.length - 1); this.prefetched.clear(); this.queueChanged();
      if (this.items.length) this.load(this.items[this.index]);
    }
    playWave(w) { this.hold = false; this.failStreak = 0; this.finishCurrent(true); this.carry = null; this.wave = w; this.items = []; this.index = -1; this.waveHistory = []; this.nextFromWave(); }
    stopWave() { this.carry = null; this.wave = null; this.queueChanged(); }
    toggle(force = null) {
      this.hold = false; this.graph();
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      const play = force === null ? this.audio.paused : force;
      if (play && this.current) this.audio.play().catch(() => {}); else if (!play) this.audio.pause();
    }
    next() { this.hold = false; this.failStreak = 0; this.finishCurrent(true); this.advance(); }
    prev() {
      this.hold = false;
      if (this.position() > 4000) { this.audio.currentTime = 0; return; }
      if (this.wave) { if (this.waveHistory.length >= 2) { this.finishCurrent(true); this.waveHistory.pop(); this.load(this.waveHistory[this.waveHistory.length - 1]); } return; }
      if (this.index > 0) { this.finishCurrent(true); this.index--; this.load(this.items[this.index]); }
    }
    seek(ms) { if (isFinite(this.audio.duration)) this.audio.currentTime = U.clamp(ms / 1000, 0, this.audio.duration); }
    upcoming(n = 6) { const rest = this.wave ? this.wave.peek(n) : this.items.slice(this.index + 1, this.index + 1 + n); return [...this.userQueue, ...rest].slice(0, n); }
    queueState(n = 60) { return { user: this.userQueue.slice(), next: this.wave ? this.wave.peek(20) : this.items.slice(this.index + 1, this.index + 1 + n), wave: !!this.wave }; }
    playNext(t) { this.userQueue.unshift(t); this.queueChanged(); if (!this.current) this.advance(); }
    enqueue(t) { this.userQueue.push(t); this.queueChanged(); if (!this.current) this.advance(); }
    queueRemove(kind, i) {
      if (kind === "user" && i >= 0 && i < this.userQueue.length) this.userQueue.splice(i, 1);
      else if (kind === "next") { if (this.wave) this.wave.removeAt(i); else if (this.index + 1 + i < this.items.length) this.items.splice(this.index + 1 + i, 1); }
      this.queueChanged();
    }
    queueMove(kind, src, dst) {
      let lst, off;
      if (kind === "user") { lst = this.userQueue; off = 0; } else if (kind === "next" && !this.wave) { lst = this.items; off = this.index + 1; } else return;
      const a = off + src, b = off + dst;
      if (a >= 0 && a < lst.length && b >= 0 && b < lst.length) { lst.splice(b, 0, lst.splice(a, 1)[0]); this.queueChanged(); }
    }
    queueJump(kind, i) {
      this.hold = false; this.finishCurrent(true);
      if (kind === "user" && i < this.userQueue.length) { const t = this.userQueue.splice(i, 1)[0]; this.queueChanged(); this.load(t); }
      else if (kind === "next" && !this.wave && this.index + 1 + i < this.items.length) { this.index += 1 + i; this.queueChanged(); this.load(this.items[this.index]); }
      else if (kind === "next" && this.wave) { this.carry = null; for (let k = 0; k < i; k++) this.wave.removeAt(0); this.nextFromWave(); }
    }
    likeCurrent() {
      const t = this.current; if (!t) return false;
      const row = this.app.db.track(t.id) || t, nv = !row.liked;
      this.app.db.setLike(t.id, nv); t.liked = +nv;
      if (nv && this.wave) this.wave.onLike(t).then(() => this.queueChanged()).catch(() => {});
      return nv;
    }
    async dislikeCurrent() {
      const t = this.current; if (!t) return;
      this.app.db.setDislike(t.id, true); t._logged = true;
      if (this.wave) { this.audio.pause(); try { await this.wave.onDislike(t); } catch (_) { /* */ } }
      this.next();
    }
  }
  window.VPlayer = Player;
})();
