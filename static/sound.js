"use strict";
// Sound effects: audio files in Sounds/ (made by make_sounds.py), played with Web Audio.
// The game calls sfx("hit_heavy"); Sounds/hit_heavy.wav plays, or one of its variants
// (hit_heavy-2.wav, ...) at random. An effect without a file is simply silent. vo_* names are
// announcer lines; the music ducks under them.

const SFX_VOLUME = 0.45;

const sound = {
  ctx: null, out: null,
  files: {},       // effect name -> [urls] from /api/sounds
  buffers: {},     // url -> Promise<AudioBuffer | null>
  centerX: null,   // world x the stereo field is centered on (set by the match each tick)
  muted: (() => { try { return localStorage.getItem("unk.sfxMuted") === "1"; } catch { return false; } })(),

  // Browsers only allow audio after a user gesture, so this runs on the first click or key.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.out = this.ctx.createGain();
      this.out.gain.value = SFX_VOLUME;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.preload();
  },

  async loadFiles() {
    try {
      this.files = await fetch("/api/sounds").then(r => r.ok ? r.json() : {});
    } catch { this.files = {}; }
    this.preload();
  },

  // Decode everything up front so the first hit isn't late (needs the context, so after a gesture).
  preload() {
    if (!this.ctx) return;
    for (const url of Object.values(this.files).flat()) {
      this.buffers[url] ||= fetch(url).then(r => r.arrayBuffer())
        .then(b => this.ctx.decodeAudioData(b)).catch(() => null);
    }
  },

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem("unk.sfxMuted", this.muted ? "1" : "0"); } catch {}
  },

  // Where a sound at world x goes: panned left or right of the screen's centre.
  panTo(x, dest) {
    if (x === null || this.centerX === null || !this.ctx.createStereoPanner) return dest;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, (x - this.centerX) / 160)) * 0.6;
    pan.connect(dest);
    return pan;
  },

  has(name) { return Boolean(this.files[name]?.length); },

  // play("hit_heavy", { x: fighter.x }) pans by world position.
  async play(name, { x = null } = {}) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || this.muted) return;
    if (!this.has(name)) { SYNTH[name]?.(ctx, this.panTo(x, this.out)); return; }
    const urls = this.files[name], url = urls[Math.floor(Math.random() * urls.length)];
    this.buffers[url] ||= fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).catch(() => null);
    const buffer = await this.buffers[url];
    if (!buffer) {  // undecodable file: stop picking it
      this.files[name] = urls.filter(u => u !== url);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.panTo(x, this.out));
    src.start();
    // Duck the music under the announcer so the call is clear.
    if (name.startsWith("vo_") && typeof music !== "undefined") {
      music.duck(true);
      clearTimeout(this.unduck);
      this.unduck = setTimeout(() => music.duck(false), buffer.duration * 1000);
    }
  },
};

// Effects made on the spot when there's no file for them.
const SYNTH = {
  laser(ctx, dest) {  // a short falling "pew"
    const t = ctx.currentTime, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1500, t);
    osc.frequency.exponentialRampToValueAtTime(240, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(g).connect(dest);
    osc.start(t); osc.stop(t + 0.2);
  },
};

const sfx = (name, opts) => sound.play(name, opts);

window.addEventListener("pointerdown", () => sound.unlock(), true);
window.addEventListener("keydown", () => sound.unlock(), true);
sound.loadFiles();
