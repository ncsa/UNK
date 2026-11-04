"use strict";
// UNK Fighter — SNES-style 1v1 fighting game. Renders at 384x224 and is scaled up by CSS.
// Characters come from /api/characters (built by add_character.py), arenas from /api/arenas.

const W = 384, H = 224, GROUND = 210;      // GROUND = screen y of the floor
const TICK = 1000 / 60;
const GRAVITY = 0.32;
const ROUND_SECONDS = 99, ROUNDS_TO_WIN = 2, MAX_ROUNDS = 5;
const PUSH_DISTANCE = 34;                    // fighters can't overlap closer than this
const ATTACK_KEYS = { j: "LMB", k: "RMB" };  // keyboard punch / kick, alongside the mouse buttons
const SEQ_GAP = 450;                         // ms allowed between inputs of a special sequence
const FONT = "'Press Start 2P', monospace";

const ATTACKS = {
  punch: { startup: 5, active: 5, recovery: 8, damage: s => s.punch_damage, hitstun: 14, push: 2.2 },
  kick:  { startup: 8, active: 6, recovery: 12, damage: s => s.kick_damage, hitstun: 18, push: 3.0 },
};
const SPECIAL = { startup: 14, active: 16, recovery: 18, cooldown: 240 };
const STUN_TICKS = 110;

// ---------------------------------------------------------------- helpers

const $ = id => document.getElementById(id);
const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
const loadImage = src => new Promise((ok, fail) => {
  const img = new Image(); img.onload = () => ok(img); img.onerror = () => fail(new Error(src)); img.src = src;
});
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function weightedPick(options) {
  const total = options.reduce((s, o) => s + Math.max(0, o.w), 0);
  let r = Math.random() * total;
  for (const o of options) if ((r -= Math.max(0, o.w)) <= 0) return o.v;
  return options[options.length - 1].v;
}

async function loadCharacter(summary) {
  const v = summary.version || "";  // cache-buster from the server, changes on each rebuild
  const sheet = await getJSON(summary.sheet + v);
  const base = summary.sheet.replace(/sheet\.json$/, "");
  const props = {};
  for (const [id, path] of Object.entries(sheet.props || {})) props[id] = await loadImage(base + path + v).catch(() => null);
  return { ...summary, sheetData: sheet, img: await loadImage(base + sheet.image + v), props };
}

// ---------------------------------------------------------------- fighter

class Fighter {
  constructor(char, isPlayer) {
    this.char = char;
    this.stats = char.stats;
    this.isPlayer = isPlayer;
    this.rounds = 0;
  }

  reset(x, facing) {
    Object.assign(this, {
      x, y: 0, vx: 0, vy: 0, facing, health: this.stats.health, trail: this.stats.health,
      state: "idle", t: 0, hasHit: false, hitCount: 0, stunFor: 0, cooldown: 0,
      special: null, shout: null, holdingBack: false,
    });
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state; this.t = 0; this.hasHit = false; this.hitCount = 0;
  }

  get airborne() { return this.y > 0 || this.vy > 0; }
  get attacking() { return this.state in ATTACKS || this.state.startsWith("special"); }
  get canAct() { return ["idle", "walk", "crouch", "jump"].includes(this.state); }

  anim(name) {
    const anims = this.char.sheetData.animations;
    return anims[name] || anims.idle;
  }

  currentFrame() {
    const s = this.state;
    let anim, i = 0;
    if (s in ATTACKS) {
      anim = this.anim(s); i = this.t < ATTACKS[s].startup ? 0 : 1;
    } else if (s.startsWith("special")) {
      anim = this.anim(s); i = this.t < SPECIAL.startup ? 0 : 1;
    } else if (s === "dizzy") {
      anim = this.anim("hit");
    } else {
      anim = this.anim(s);
      if (anim.loop) i = Math.floor(this.t / (60 / anim.fps));
    }
    return anim.frames[i % anim.frames.length];
  }

  // Box relative to the feet anchor -> world box, mirrored when facing left.
  worldBox(box) {
    const [l, t, w, h] = box;
    return { x: this.facing > 0 ? this.x + l : this.x - l - w, y: GROUND - this.y + t, w, h };
  }

  hurtBox() { return this.worldBox(this.currentFrame().hurt); }

  hitBox() {
    const f = this.currentFrame();
    // Sprite-derived boxes can be thin; guarantee a fair reach.
    const box = f.hit ? [...f.hit] : [8, -Math.round(f.h * 0.75), 30, 24];
    if (box[2] < 26) box[2] = 26;
    return this.worldBox(box);
  }

  update(input, opp, match) {
    this.t++;
    if (this.cooldown > 0 && --this.cooldown === 0 && this.isPlayer) sfx("ready");
    if (this.shout && --this.shout.t <= 0) this.shout = null;
    this.holdingBack = input.move === -this.facing && !this.airborne;

    switch (this.state) {
      case "ko": case "victory": case "defeat":
        break;
      case "hit":
        if (this.t >= this.stunFor) this.setState(this.airborne ? "jump" : "idle");
        break;
      case "dizzy":
        if (this.t >= this.stunFor) this.setState("idle");
        break;
      case "block":
        if (this.t >= this.stunFor) this.setState("idle");
        break;
      default:
        if (this.state in ATTACKS) {
          const a = ATTACKS[this.state];
          if (this.t >= a.startup + a.active + a.recovery) this.setState(this.airborne ? "jump" : "idle");
        } else if (this.state.startsWith("special")) {
          this.updateSpecial(opp, match);
        }
    }

    if (this.canAct) this.handleInput(input, opp);

    // physics
    this.x += this.vx;
    if (this.airborne) {
      this.y += this.vy; this.vy -= GRAVITY;
      if (this.y <= 0) {
        this.y = 0; this.vy = 0;
        if (this.state === "jump") { this.setState("idle"); this.vx = 0; sfx("land", { x: this.x }); }
        if (this.state === "ko") this.vx *= 0.5;
      }
    } else if (["hit", "block", "ko", "dizzy"].includes(this.state) || this.state.startsWith("special")) {
      this.vx *= 0.82;
    }
    if (!this.airborne && this.canAct && this.state !== "walk") this.vx = 0;
    this.x = clamp(this.x, 18, match.stageWidth - 18);
  }

  handleInput(input, opp) {
    if (!this.airborne) this.facing = opp.x >= this.x ? 1 : -1;
    if (input.special && this.cooldown === 0) return this.startSpecial(input.special);
    if (input.attack) {
      this.setState(input.attack);
      sfx(`${input.attack}_whoosh`, { x: this.x });
      if (!this.airborne) this.vx = 0;
      return;
    }
    if (this.airborne) return;
    if (input.jump) {
      this.vy = this.stats.jump_power; this.y = 0.01;
      this.vx = input.move * this.stats.walk_speed * 1.1;
      this.setState("jump");
    } else if (input.crouch) {
      this.setState("crouch"); this.vx = 0;
    } else if (input.move) {
      this.setState("walk");
      this.vx = input.move * this.stats.walk_speed * (input.move === this.facing ? 1 : 0.75);
    } else {
      this.setState("idle");
    }
  }

  startSpecial(sp) {
    this.special = sp;
    this.setState(sp.id);
    this.cooldown = SPECIAL.cooldown;
    if (!this.airborne) this.vx = 0;
    if (sp.shout) this.shout = { text: sp.shout, t: 100 };
    sfx("special", { x: this.x });
  }

  updateSpecial(opp, match) {
    const sp = this.special, t = this.t, s = SPECIAL;
    const dmg = this.stats.special_damage;
    if (t === s.startup) {
      if (sp.effect === "projectile") match.spawnProjectile(this, sp);
      if (sp.effect === "stun") match.spawnDrop(this, opp, sp);
    }
    if (t >= s.startup && t < s.startup + s.active) {
      if (sp.effect === "melee" && !this.hasHit) {
        if (overlap(this.worldBox([0, -100, 64, 90]), opp.hurtBox())) {
          this.hasHit = true;
          opp.receive(this, dmg, match, { hitstun: 30, push: 5, launch: 4 });
        }
      } else if (sp.effect === "area" && (t - s.startup) % 5 === 0 && this.hitCount < 3) {
        if (overlap(this.worldBox([-58, -100, 116, 96]), opp.hurtBox())) {
          this.hitCount++;
          opp.receive(this, Math.ceil(dmg / 3), match, { hitstun: 12, push: 1.5 });
        }
      }
      if (sp.effect === "area") this.facing = (Math.floor(t / 4) % 2) ? 1 : -1;  // spin
    }
    if (t >= s.startup + s.active + s.recovery) {
      this.facing = opp.x >= this.x ? 1 : -1;
      this.setState(this.airborne ? "jump" : "idle");
    }
  }

  receive(attacker, damage, match, { hitstun = 16, push = 2.5, stun = 0, unblockable = false, launch = 0 } = {}) {
    if (["ko", "victory", "defeat"].includes(this.state)) return;
    const blocking = !unblockable && this.holdingBack && ["idle", "walk", "crouch", "block"].includes(this.state);
    const box = this.hurtBox();
    const sparkX = attacker.x < this.x ? box.x + 4 : box.x + box.w - 4;
    if (blocking) {
      this.health -= damage * (1 - this.stats.block);
      this.setState("block"); this.stunFor = 10;
      this.vx = push * 0.6 * Math.sign(this.x - attacker.x || attacker.facing);
      match.spark(sparkX, box.y + 30, true);
      sfx("block", { x: this.x });
    } else {
      this.health -= damage;
      if (stun) { this.setState("dizzy"); this.stunFor = stun; sfx("dizzy", { x: this.x }); }
      else { this.setState("hit"); this.stunFor = hitstun; }
      this.vx = push * Math.sign(this.x - attacker.x || attacker.facing);
      if (launch || this.airborne) { this.vy = launch || 2.5; this.y = Math.max(this.y, 0.01); }
      match.spark(sparkX, box.y + 26, false);
      const heavy = stun || launch || damage >= attacker.stats.kick_damage;
      sfx(heavy ? "hit_heavy" : "hit_light", { x: this.x });
      match.shake = 6;
    }
    if (this.health <= 0) {
      this.health = 0;
      sfx("ko", { x: this.x });
      this.setState("ko");
      this.vy = 4.5; this.y = Math.max(this.y, 0.01);
      this.vx = 2.5 * Math.sign(this.x - attacker.x || attacker.facing);
    }
  }

  draw(ctx, camX) {
    const f = this.currentFrame();
    const img = this.char.img;
    const px = Math.round(this.x - camX), py = Math.round(GROUND - this.y);
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(px, GROUND + 1, Math.max(10, 22 - this.y / 6), 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(px, py);
    if (this.state === "ko" && !this.airborne && this.char.sheetData.animations.ko === undefined) ctx.rotate(Math.PI / 2);
    if (this.facing < 0) ctx.scale(-1, 1);
    const flash = this.state === "hit" && this.t < 4;
    if (flash) ctx.filter = "brightness(2.2)";
    if (this.state === "dizzy") ctx.translate(Math.sin(this.t / 3) * 2, 0);
    ctx.drawImage(img, f.x, f.y, f.w, f.h, -f.ax, -f.ay, f.w, f.h);
    ctx.restore();

    const top = py - f.ay;
    if (this.state === "dizzy") drawDizzy(ctx, px, top - 6, this.t);
    if (this.shout) drawBubble(ctx, this.shout.text, px, top - 8, camX);
  }
}

function drawDizzy(ctx, x, y, t) {
  ctx.font = `8px ${FONT}`;
  ctx.textAlign = "center";
  for (let i = 0; i < 3; i++) {
    const a = t / 10 + i * (Math.PI * 2 / 3);
    ctx.fillStyle = i === 1 ? "#fff" : "#ffd23f";
    ctx.fillText(i === 1 ? "?" : "*", x + Math.cos(a) * 14, y + Math.sin(a) * 4);
  }
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function drawBubble(ctx, text, x, bottom) {
  ctx.font = `8px ${FONT}`;
  const lines = wrapText(ctx, text.toUpperCase(), 130);
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 10;
  const h = lines.length * 10 + 6;
  const bx = clamp(Math.round(x - w / 2), 2, W - w - 2), by = Math.max(2, Math.round(bottom - h - 6));
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
  ctx.fillRect(bx, by, w, h); ctx.strokeRect(bx, by, w, h);
  ctx.beginPath(); ctx.moveTo(x - 4, by + h); ctx.lineTo(x, by + h + 6); ctx.lineTo(x + 4, by + h); ctx.fill();
  ctx.fillStyle = "#000"; ctx.textAlign = "left";
  lines.forEach((l, i) => ctx.fillText(l, bx + 5, by + 12 + i * 10));
}

// ---------------------------------------------------------------- input

class PlayerInput {
  constructor() {
    this.keys = new Set();
    this.buffer = [];        // recent {token, time} for special-move sequences
    this.pending = null;     // {attack|special, expires}
    this.onKeyDown = e => {
      const k = e.key.toLowerCase();
      if (k.length !== 1) return;
      if (ATTACK_KEYS[k]) {               // J punch, K kick (same tokens as the mouse buttons)
        if (!e.repeat) this.attack(ATTACK_KEYS[k]);
        return;
      }
      if (!"wasd".includes(k)) return;
      if (!e.repeat) this.push(this.relative(k.toUpperCase()));
      this.keys.add(k);
    };
    this.onKeyUp = e => this.keys.delete(e.key.toLowerCase());
    this.onMouse = e => {
      if (e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      this.attack(e.button === 0 ? "LMB" : "RMB");
    };
    this.onContext = e => e.preventDefault();
    this.onBlur = () => this.keys.clear();
  }

  attach(fighter) {
    this.fighter = fighter;
    this.specials = fighter.char.specials;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousedown", this.onMouse);
    window.addEventListener("contextmenu", this.onContext);
    window.addEventListener("blur", this.onBlur);
  }

  detach() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousedown", this.onMouse);
    window.removeEventListener("contextmenu", this.onContext);
    window.removeEventListener("blur", this.onBlur);
  }

  // Special inputs are written for a fighter facing right (D = toward the opponent); when facing
  // left, A and D swap so every move keeps working from either side, as in any fighting game.
  relative(token) {
    if (this.fighter?.facing >= 0) return token;
    return { A: "D", D: "A" }[token] || token;
  }

  attack(token) {
    this.push(token);
    const sp = this.matchSpecial();
    this.pending = sp ? { special: sp, expires: performance.now() + 150 }
                      : { attack: token === "LMB" ? "punch" : "kick", expires: performance.now() + 150 };
  }

  push(token) {
    const now = performance.now();
    this.buffer.push({ token, time: now });
    this.buffer = this.buffer.filter(b => now - b.time < 2000).slice(-10);
  }

  matchSpecial() {
    // Longest sequence wins so A,D,A,D,LMB beats a shorter overlapping sequence.
    const sorted = [...this.specials].sort((a, b) => b.input.length - a.input.length);
    for (const sp of sorted) {
      const seq = sp.input, recent = this.buffer.slice(-seq.length);
      if (recent.length !== seq.length) continue;
      if (!recent.every((b, i) => b.token === seq[i])) continue;
      if (!recent.every((b, i) => i === 0 || b.time - recent[i - 1].time <= SEQ_GAP)) continue;
      this.buffer = [];
      return sp;
    }
    return null;
  }

  read() {
    const k = this.keys;
    const input = { move: (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0), jump: k.has("w"), crouch: k.has("s") };
    if (this.pending && performance.now() > this.pending.expires) this.pending = null;
    return input;
  }

  // Called after the fighter has seen the input, so a buffered press survives until it can act.
  consume(fighter) {
    if (!this.pending) return {};
    if (!fighter.canAct || (this.pending.special && fighter.cooldown > 0)) return {};
    const p = this.pending; this.pending = null;
    return p.special ? { special: p.special } : { attack: p.attack };
  }
}

// ---------------------------------------------------------------- AI

class AI {
  // Uses the character's trait weights (0..1): punch, kick, jump, block, special, aggression, mobility.
  constructor(fighter) {
    this.f = fighter;
    this.tr = fighter.char.ai;
    this.queue = [];
  }

  input(opp) {
    const f = this.f, tr = this.tr;
    const toward = opp.x >= f.x ? 1 : -1;
    const dist = Math.abs(opp.x - f.x);

    // React to an attack in progress: block with probability from the block trait.
    const threatened = (opp.attacking && dist < 95 && opp.t < 4) || this.incoming;
    if (threatened && !this.blockRolled) {
      this.blockRolled = true;
      if (Math.random() < tr.block * 0.75) this.queue = [{ in: { move: -toward }, ticks: 22 }];
    }
    if (!opp.attacking) this.blockRolled = false;

    if (this.queue.length) {
      const step = this.queue[0];
      if (--step.ticks <= 0) this.queue.shift();
      const inp = { ...step.in };
      if (inp.move === "toward") inp.move = toward;
      if (inp.move === "away") inp.move = -toward;
      return inp;
    }
    if (!f.canAct) return {};

    const specials = f.char.specials.filter(() => f.cooldown === 0);
    const ranged = specials.filter(s => s.effect === "projectile" || s.effect === "stun");
    const close = specials.filter(s => s.effect === "melee" || s.effect === "area" || s.effect === "stun");
    const think = Math.round(rand(6, 22) * (1.3 - tr.aggression));
    let action;
    if (dist > 70) {
      action = weightedPick([
        { v: "approach", w: 0.4 + tr.aggression * 1.6 },
        { v: "jumpin", w: tr.jump * 0.9 },
        { v: "wait", w: 1 - tr.aggression },
        { v: "retreat", w: (1 - tr.aggression) * 0.3 },
        { v: "ranged", w: ranged.length && dist > 110 ? tr.special * 0.7 : 0 },
      ]);
    } else {
      action = weightedPick([
        { v: "punch", w: tr.punch * 1.6 },
        { v: "kick", w: tr.kick * 1.6 },
        { v: "close", w: close.length ? tr.special * 0.5 : 0 },
        { v: "block", w: tr.block * 0.4 },
        { v: "retreat", w: (1 - tr.aggression) * 0.5 + tr.mobility * 0.2 },
        { v: "jumpback", w: tr.jump * 0.25 },
        { v: "wait", w: 0.25 },
      ]);
    }
    const pick = list => list[Math.floor(Math.random() * list.length)];
    const plans = {
      approach: [{ in: { move: "toward" }, ticks: Math.round(rand(12, 36)) }],
      retreat: [{ in: { move: "away" }, ticks: Math.round(rand(10, 24)) }],
      wait: [{ in: {}, ticks: think }],
      block: [{ in: { move: "away" }, ticks: 26 }],
      jumpin: [{ in: { move: "toward", jump: true }, ticks: 1 }, { in: { move: "toward" }, ticks: 14 },
               { in: { attack: Math.random() < tr.kick ? "kick" : "punch" }, ticks: 1 }],
      jumpback: [{ in: { move: "away", jump: true }, ticks: 1 }],
      punch: [{ in: { attack: "punch" }, ticks: 1 }, { in: {}, ticks: think }],
      kick: [{ in: { attack: "kick" }, ticks: 1 }, { in: {}, ticks: think }],
      ranged: [{ in: { special: pick(ranged) }, ticks: 1 }, { in: {}, ticks: 20 }],
      close: [{ in: { special: pick(close) }, ticks: 1 }, { in: {}, ticks: 20 }],
    };
    this.queue = plans[action].map(s => ({ ...s, in: { ...s.in } }));
    return {};
  }
}

// ---------------------------------------------------------------- music

// The arena's theme loops during a match. M toggles it; the choice is remembered per browser.
const MUSIC_VOLUME = 0.5;
const music = {
  audio: null,
  muted: (() => { try { return localStorage.getItem("unk.muted") === "1"; } catch { return false; } })(),

  play(src) {
    this.stop();
    if (!src) return;
    this.audio = new Audio(src);
    this.audio.loop = true;
    this.audio.volume = MUSIC_VOLUME;
    this.audio.muted = this.muted;
    const audio = this.audio;
    audio.play().catch(e => {  // a missing or bad file just stays silent
      if (e.name !== "NotAllowedError") return;
      // Autoplay blocked until the user interacts: start on the first click or key instead.
      const retry = () => {
        window.removeEventListener("pointerdown", retry); window.removeEventListener("keydown", retry);
        if (this.audio === audio) audio.play().catch(() => {});
      };
      window.addEventListener("pointerdown", retry); window.addEventListener("keydown", retry);
    });
  },
  stop() {
    if (this.audio) { this.audio.pause(); this.audio.src = ""; this.audio = null; }
  },
  duck(on) {
    if (this.audio) this.audio.volume = on ? MUSIC_VOLUME * 0.3 : MUSIC_VOLUME;
  },
  toggleMute() {
    this.muted = !this.muted;
    if (this.audio) this.audio.muted = this.muted;
    try { localStorage.setItem("unk.muted", this.muted ? "1" : "0"); } catch {}
  },
};

// ---------------------------------------------------------------- match

class Match {
  constructor({ player, opponent, arena, arenaImg, onEnd }) {
    this.canvas = $("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.arena = arena; this.arenaImg = arenaImg;
    this.stageWidth = Math.max(W, arenaImg.width);
    this.p1 = new Fighter(player, true);
    this.p2 = new Fighter(opponent, false);
    this.input = new PlayerInput();
    this.ai = new AI(this.p2);
    this.onEnd = onEnd;
    this.round = 0;
    this.totalTicks = 0;
    this.debug = false;
    this.paused = false;
    this.onKey = e => {
      if (e.key === "Escape") { this.paused = !this.paused; music.duck(this.paused); sfx("pause"); }
      if (e.key === "`") this.debug = !this.debug;
      // Sound toggles only while paused: N and M sit right under the J/K attack keys.
      if (this.paused && e.key.toLowerCase() === "m") music.toggleMute();
      if (this.paused && e.key.toLowerCase() === "n") sound.toggleMute();
      if (this.paused && e.key.toLowerCase() === "q") this.finish(true);
    };
  }

  start() {
    this.input.attach(this.p1);
    window.addEventListener("keydown", this.onKey);
    music.play(this.arena.music);
    this.nextRound();
    this.last = performance.now();
    this.acc = 0;
    this.running = true;
    requestAnimationFrame(this.frame.bind(this));
  }

  stop() {
    this.running = false;
    this.input.detach();
    window.removeEventListener("keydown", this.onKey);
    music.stop();
  }

  nextRound() {
    this.round++;
    const mid = this.stageWidth / 2;
    this.p1.reset(mid - 70, 1);
    this.p2.reset(mid + 70, -1);
    this.projectiles = []; this.drops = []; this.sparks = [];
    this.phase = "intro"; this.phaseT = 0;
    this.timer = ROUND_SECONDS; this.timerTicks = 0;
    this.shake = 0; this.banner = null;
    this.ai.queue = [];
    if (this.round === 1 && Math.random() < 0.8) {
      const taunts = this.p2.char.taunts;
      if (taunts?.length) this.p2.shout = { text: taunts[Math.floor(Math.random() * taunts.length)], t: 110 };
    }
  }

  frame(now) {
    if (!this.running) return;
    this.acc = Math.min(this.acc + (now - this.last), 250);
    this.last = now;
    while (this.acc >= TICK) {
      if (!this.paused) this.update();
      this.acc -= TICK;
    }
    this.draw();
    requestAnimationFrame(this.frame.bind(this));
  }

  update() {
    this.phaseT++;
    const { p1, p2 } = this;
    const live = this.phase === "fight";

    let in1 = { move: 0 }, in2 = {};
    if (live) {
      in1 = { ...this.input.read(), ...this.input.consume(p1) };
      in2 = this.ai.input(p1);
      this.totalTicks++;
      if (++this.timerTicks >= 60) {
        this.timerTicks = 0; this.timer--;
        if (this.timer > 0 && this.timer <= 10) sfx("tick");
      }
    } else {
      this.input.read();
    }
    sound.centerX = (p1.x + p2.x) / 2;
    p1.update(in1, p2, this);
    p2.update(in2, p1, this);

    if (live) {
      this.resolveHits(p1, p2);
      this.resolveHits(p2, p1);
      this.updateProjectiles();
      this.updateDrops();
    }
    this.separate();
    for (const f of [p1, p2]) f.trail = Math.max(f.health, f.trail - 0.35);
    this.sparks = this.sparks.filter(s => ++s.t < 12);
    if (this.shake > 0) this.shake--;
    this.ai.incoming = this.projectiles.some(p => p.owner === p1 && Math.abs(p.x - p2.x) < 90);

    switch (this.phase) {
      case "intro":
        this.banner = this.phaseT < 80 ? `ROUND ${this.round}` : "FIGHT!";
        if (this.phaseT === 1) sfx("round");
        if (this.phaseT === 20) sfx(this.round === MAX_ROUNDS || (this.p1.rounds === ROUNDS_TO_WIN - 1 &&
          this.p2.rounds === ROUNDS_TO_WIN - 1) ? "vo_final_round" : `vo_round_${this.round}`);
        if (this.phaseT === 80) { sfx("fight"); sfx("vo_fight"); }
        if (this.phaseT >= 120) { this.phase = "fight"; this.banner = null; }
        break;
      case "fight":
        if (p1.health <= 0 || p2.health <= 0) { this.endRound("K.O."); sfx("vo_ko"); }
        else if (this.timer <= 0) { this.endRound("TIME"); sfx("time_up"); sfx("vo_time"); }
        break;
      case "roundEnd":
        if (this.phaseT === 90) {
          const w = this.roundWinner;
          if (w) {
            w.setState("victory");
            const taunts = w.char.taunts;
            if (taunts?.length && !w.isPlayer) w.shout = { text: taunts[Math.floor(Math.random() * taunts.length)], t: 120 };
          }
          this.banner = w ? (w.isPlayer ? "YOU WIN" : `${w.char.name.toUpperCase()} WINS`) : "DRAW";
          sfx(w?.isPlayer ? "win" : "lose");
          const call = !w ? "vo_draw" : w.isPlayer ? "vo_you_win" : `vo_win_${w.char.slug}`;
          sfx(sound.has(call) ? call : "vo_you_lose");
          if (w && w.health === w.stats.health) this.banner = "PERFECT";
        }
        if (this.phaseT === 150 && this.banner === "PERFECT") sfx("vo_perfect");
        if (this.phaseT >= 210) {
          const done = this.p1.rounds >= ROUNDS_TO_WIN || this.p2.rounds >= ROUNDS_TO_WIN || this.round >= MAX_ROUNDS;
          if (done) this.finish(false); else this.nextRound();
        }
        break;
    }
  }

  endRound(reason) {
    const { p1, p2 } = this;
    this.phase = "roundEnd"; this.phaseT = 0; this.banner = reason;
    this.projectiles = []; this.drops = [];
    let winner = null;
    const r1 = p1.health / p1.stats.health, r2 = p2.health / p2.stats.health;
    if (r1 > r2) winner = p1; else if (r2 > r1) winner = p2;
    this.roundWinner = winner;
    if (winner) winner.rounds++;
    for (const f of [p1, p2]) if (f !== winner && f.state !== "ko") f.setState("idle");
  }

  finish(quit) {
    this.stop();
    const won = !quit && this.p1.rounds > this.p2.rounds;
    this.onEnd({
      quit,
      won,
      health_left: Math.max(won ? 1 : 0, Math.round(this.p1.health)),
      duration: Math.max(3, Math.round(this.totalTicks / 60)),
      rounds: [this.p1.rounds, this.p2.rounds],
    });
  }

  resolveHits(a, d) {
    const atk = ATTACKS[a.state];
    if (!atk || a.hasHit) return;
    if (a.t < atk.startup || a.t >= atk.startup + atk.active) return;
    if (overlap(a.hitBox(), d.hurtBox())) {
      a.hasHit = true;
      d.receive(a, atk.damage(a.stats), this, { hitstun: atk.hitstun, push: atk.push });
    }
  }

  separate() {
    const { p1, p2 } = this;
    if (Math.abs(p1.y - p2.y) > 60) return;
    const dx = p2.x - p1.x;
    if (Math.abs(dx) >= PUSH_DISTANCE) return;
    const push = (PUSH_DISTANCE - Math.abs(dx)) / 2 * (dx >= 0 ? 1 : -1);
    p1.x = clamp(p1.x - push, 18, this.stageWidth - 18);
    p2.x = clamp(p2.x + push, 18, this.stageWidth - 18);
  }

  spawnProjectile(owner, sp) {
    const img = owner.char.props[sp.id];
    const h = img ? img.height : 24, w = img ? img.width : 24;
    this.projectiles.push({
      owner, sp, img, w, h, angle: 0,
      x: owner.x + owner.facing * 30, y: GROUND - owner.y - 70, vx: 4 * owner.facing,
    });
    sfx("throw", { x: owner.x });
  }

  updateProjectiles() {
    for (const p of this.projectiles) {
      p.x += p.vx; p.angle += 0.15;
      const target = p.owner === this.p1 ? this.p2 : this.p1;
      const box = { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h };
      if (!p.done && overlap(box, target.hurtBox())) {
        p.done = true;
        target.receive(p.owner, p.owner.stats.special_damage, this, { hitstun: 24, push: 4 });
      }
    }
    this.projectiles = this.projectiles.filter(p => !p.done && p.x > -60 && p.x < this.stageWidth + 60);
  }

  // Stun specials: the prop drops onto the opponent (or a flash when there's no prop image).
  spawnDrop(owner, target, sp) {
    const inRange = Math.abs(target.x - owner.x) < 170;
    const x = inRange ? target.x : owner.x + owner.facing * 80;
    const img = owner.char.props[sp.id];
    this.drops.push({ owner, target, sp, img, x, y: img ? -img.height : GROUND - 140, vy: 3, t: 0, landed: false });
  }

  updateDrops() {
    for (const d of this.drops) {
      d.t++;
      if (!d.landed) {
        d.y += d.vy; d.vy += 0.6;
        const bottom = d.img ? d.y + d.img.height : d.y + 20;
        const head = d.target.hurtBox().y;
        if (bottom >= head || bottom >= GROUND) {
          d.landed = true; d.t = 0;
          sfx("slam", { x: d.x });
          const w = d.img ? d.img.width : 40;
          if (overlap({ x: d.x - w / 2, y: head - 10, w, h: 40 }, d.target.hurtBox())) {
            d.target.receive(d.owner, d.owner.stats.special_damage, this, { stun: STUN_TICKS, unblockable: true });
          }
          this.shake = 8;
        }
      }
    }
    this.drops = this.drops.filter(d => !d.landed || d.t < 24);
  }

  spark(x, y, blocked) {
    this.sparks.push({ x, y, t: 0, blocked });
  }

  // ------------------------------------------------------------ drawing

  draw() {
    const ctx = this.ctx, { p1, p2 } = this;
    const mid = (p1.x + p2.x) / 2;
    const camX = clamp(Math.round(mid - W / 2), 0, this.stageWidth - W);
    const shakeY = this.shake ? (this.shake % 2 ? 2 : -2) : 0;

    ctx.save();
    ctx.translate(0, shakeY);
    ctx.drawImage(this.arenaImg, -camX, 0, this.arenaImg.width, H);
    for (const f of [p2, p1]) f.draw(ctx, camX);

    for (const p of this.projectiles) {
      ctx.save();
      ctx.translate(Math.round(p.x - camX), Math.round(p.y));
      ctx.rotate(p.angle * Math.sign(p.vx));
      if (p.img) ctx.drawImage(p.img, -p.w / 2, -p.h / 2);
      else { ctx.fillStyle = "#b07a3a"; ctx.fillRect(-12, -12, 24, 24); ctx.strokeStyle = "#000"; ctx.strokeRect(-12, -12, 24, 24); }
      ctx.restore();
    }
    for (const d of this.drops) {
      const x = Math.round(d.x - camX);
      if (d.img) ctx.drawImage(d.img, Math.round(x - d.img.width / 2), Math.round(d.y));
      else if (d.landed) {
        ctx.fillStyle = `rgba(255,255,255,${1 - d.t / 24})`;
        ctx.beginPath(); ctx.arc(x, d.target.hurtBox().y + 10, 10 + d.t * 2, 0, Math.PI * 2); ctx.fill();
      }
      if (d.landed && d.t < 20) {
        ctx.font = `12px ${FONT}`; ctx.textAlign = "center";
        outlinedText(ctx, d.sp.shout || d.sp.name, x, d.target.hurtBox().y - 6, "#ff4040");
      }
    }
    for (const s of this.sparks) {
      ctx.strokeStyle = s.blocked ? "#9cf" : (s.t % 4 < 2 ? "#fff" : "#ffd23f");
      ctx.lineWidth = 2;
      const r = 3 + s.t * 1.4;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        ctx.moveTo(s.x - camX + Math.cos(a) * r * 0.4, s.y + Math.sin(a) * r * 0.4);
        ctx.lineTo(s.x - camX + Math.cos(a) * r, s.y + Math.sin(a) * r);
      }
      ctx.stroke();
    }
    if (this.debug) this.drawDebug(ctx, camX);
    ctx.restore();

    this.drawHUD(ctx);
    if (this.banner) {
      ctx.font = `24px ${FONT}`; ctx.textAlign = "center";
      outlinedText(ctx, this.banner, W / 2, H / 2 - 10, this.banner === "K.O." ? "#ff4040" : "#ffd23f", 3);
    }
    if (this.paused) {
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0, 0, W, H);
      ctx.font = `16px ${FONT}`; ctx.textAlign = "center";
      outlinedText(ctx, "PAUSED", W / 2, H / 2 - 8, "#fff", 2);
      ctx.font = `8px ${FONT}`;
      outlinedText(ctx, "ESC RESUME  ·  Q QUIT", W / 2, H / 2 + 14, "#ccc");
      outlinedText(ctx, `M MUSIC ${music.muted ? "OFF" : "ON"}  ·  N SOUND ${sound.muted ? "OFF" : "ON"}`,
                   W / 2, H / 2 + 28, "#ccc");
    }
  }

  drawHUD(ctx) {
    const barW = 150, barH = 10, top = 14;
    const bars = [[this.p1, 18, -1], [this.p2, W - 18 - barW, 1]];
    for (const [f, x, side] of bars) {
      ctx.fillStyle = "#000"; ctx.fillRect(x - 2, top - 2, barW + 4, barH + 4);
      ctx.fillStyle = "#c01818"; ctx.fillRect(x, top, barW, barH);
      const hp = f.health / f.stats.health, tr = f.trail / f.stats.health;
      // Bars drain toward the outer edge, like SF2.
      const fill = (ratio, color) => {
        const w = Math.round(barW * ratio);
        ctx.fillStyle = color;
        ctx.fillRect(side < 0 ? x : x + barW - w, top, w, barH);
      };
      fill(tr, "#fff");
      fill(hp, hp < 0.25 && this.phaseT % 20 < 10 ? "#ff8c1a" : "#ffd23f");
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(x - 0.5, top - 0.5, barW + 1, barH + 1);
      ctx.font = `8px ${FONT}`;
      ctx.textAlign = side < 0 ? "left" : "right";
      const tx = side < 0 ? x : x + barW;
      outlinedText(ctx, f.char.name.toUpperCase(), tx, top + barH + 12, "#fff");
      for (let i = 0; i < f.rounds; i++) {
        ctx.fillStyle = "#ffd23f";
        const sx = side < 0 ? x + barW - 8 - i * 10 : x + i * 10;
        ctx.fillRect(sx, top + barH + 5, 7, 7);
        ctx.strokeStyle = "#000"; ctx.strokeRect(sx + 0.5, top + barH + 5.5, 6, 6);
      }
    }
    // KO badge and timer
    ctx.font = `8px ${FONT}`; ctx.textAlign = "center";
    outlinedText(ctx, "KO", W / 2, top + 8, "#ff4040");
    ctx.font = `16px ${FONT}`;
    outlinedText(ctx, String(Math.max(0, this.timer)).padStart(2, "0"), W / 2, top + 30, "#fff", 2);
    // Special cooldown pip for the player
    if (this.p1.cooldown === 0 && this.phase === "fight") {
      ctx.font = `8px ${FONT}`; ctx.textAlign = "left";
      outlinedText(ctx, "SPECIAL READY", 18, H - 6, "#7fffb2");
    }
  }

  drawDebug(ctx, camX) {
    ctx.lineWidth = 1;
    for (const f of [this.p1, this.p2]) {
      const hb = f.hurtBox();
      ctx.strokeStyle = "#0f0"; ctx.strokeRect(hb.x - camX + 0.5, hb.y + 0.5, hb.w, hb.h);
      const atk = ATTACKS[f.state];
      if (atk && f.t >= atk.startup && f.t < atk.startup + atk.active) {
        const b = f.hitBox(); ctx.strokeStyle = "#f00"; ctx.strokeRect(b.x - camX + 0.5, b.y + 0.5, b.w, b.h);
      }
    }
  }
}

function outlinedText(ctx, text, x, y, color, width = 2) {
  ctx.lineWidth = width * 2; ctx.strokeStyle = "#000"; ctx.lineJoin = "round";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

// ---------------------------------------------------------------- menus

const app = { characters: [], arenas: [], me: null, choice: { player: null, opponent: "random" }, loaded: {} };

// The character select screen, with SelectionScreen.mp3 looping (M toggles it there too).
const SELECTION_MUSIC = "/assets/selection-music";

function showMenu() {
  show("select");
  music.play(SELECTION_MUSIC);
}

window.addEventListener("keydown", e => {
  if (e.repeat || e.target.matches?.("input, textarea") || !$("select").classList.contains("active")) return;
  if (e.key.toLowerCase() === "m") music.toggleMute();
  if (e.key.toLowerCase() === "n") { sound.toggleMute(); sfx("menu_move"); }
});

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("active", s.id === id);
}

function statBar(label, value, max) {
  return `<div class="stat"><span>${label}</span><i style="width:${Math.round(100 * Math.min(1, value / max))}%"></i></div>`;
}

function characterCard(c, group) {
  const btn = document.createElement("button");
  btn.className = "card";
  btn.dataset.value = c.slug;
  const maxHp = Math.max(...app.characters.map(x => x.stats.health));
  const maxDmg = Math.max(...app.characters.map(x => x.stats.kick_damage));
  btn.innerHTML = `
    ${c.portrait ? `<img class="portrait" src="${esc(c.portrait)}" alt="">` : `<div class="portrait"></div>`}
    <span class="name">${esc(c.name.toUpperCase())}</span>
    <span class="meta">
      ${statBar("HP", c.stats.health, maxHp)}
      ${statBar("ATK", c.stats.kick_damage, maxDmg)}
      ${statBar("DEF", c.stats.block, 0.9)}
    </span>`;
  const home = homeArena(c.slug);
  if (group === "opponent" && home) btn.querySelector(".meta").insertAdjacentHTML("beforeend",
    `<span>HOME: ${esc(home.name.toUpperCase())}</span>`);
  btn.title = c.summary;
  btn.onclick = () => { select(group, c.slug); sfx("menu_move"); };
  return btn;
}

function select(group, value) {
  app.choice[group] = value;
  const grid = { player: "player-grid", opponent: "opponent-grid" }[group];
  for (const el of $(grid).children) el.classList.toggle("selected", el.dataset.value === value);
  if (group === "player") showSpecialHelp();
  if (group === "opponent") showArenaPreview(value);
  $("fight-btn").disabled = !(app.choice.player && app.arenas.length && app.characters.length > 1);
}

// The opponent's home arena (an Arena_* image in their Characters/ folder), else a random
// arena from Arenas/, else any arena.
function homeArena(slug) {
  return app.arenas.find(a => a.home === slug);
}

function arenaFor(slug) {
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const generic = app.arenas.filter(a => !a.home);
  return homeArena(slug) || pick(generic.length ? generic : app.arenas);
}

// Small card beside FIGHT! showing where the match will be fought.
function showArenaPreview(opponent) {
  const box = $("arena-preview"), img = box.querySelector("img");
  const home = opponent === "random" ? null : homeArena(opponent);
  const opp = app.characters.find(c => c.slug === opponent);
  box.hidden = !app.arenas.length;
  box.classList.toggle("random", !home);
  if (home) img.src = home.image;
  box.querySelector("figcaption").innerHTML = opponent === "random" ? "ARENA: <b>OPPONENT'S HOME</b>"
    : home ? `ARENA: <b>${esc(home.name.toUpperCase())}</b>`
    : `ARENA: <b>RANDOM</b>${opp ? ` · ${esc(opp.name.toUpperCase())} HAS NO HOME` : ""}`;
  box.classList.remove("pop"); void box.offsetWidth; box.classList.add("pop");  // restart the animation
}

function showSpecialHelp() {
  const c = app.characters.find(x => x.slug === app.choice.player);
  // Directions are relative to facing, shown as arrows for a fighter facing right (→ = toward).
  // The pixel font has no arrows, so they're drawn in the system font.
  const arrow = { W: "↑", A: "←", S: "↓", D: "→" };
  const name = t => arrow[t] ? `<span class="arrow">${arrow[t]}</span>` : esc({ LMB: "Punch", RMB: "Kick" }[t] || t);
  $("special-help").innerHTML = c ? c.specials.map(s =>
    `<b>${s.input.map(name).join(" ")}</b> ${esc(s.name)}`).join("<br>") : "";
}

function renderScores(table, rows) {
  table.innerHTML = rows.length ? rows.map((r, i) => `
    <tr class="${r.username === app.me?.username ? "me" : ""}">
      <td>${i + 1}.</td><td>${esc(r.username)}</td><td>${esc(r.character)}</td><td>${r.score}</td>
    </tr>`).join("") : `<tr><td class="empty">No scores yet</td></tr>`;
}

async function refreshScores() {
  const rows = await getJSON("/api/scores");
  renderScores($("scores-side"), rows);
  renderScores($("scores-results"), rows);
}

async function initMenu() {
  [app.me, app.characters, app.arenas] = await Promise.all(
    ["/api/me", "/api/characters", "/api/arenas"].map(getJSON));
  $("user").textContent = `${app.me.username.toUpperCase()} · BEST ${app.me.best}`;

  // The player's fighter is fixed per account (last column of users.csv); only the opponent is chosen.
  const pg = $("player-grid"), og = $("opponent-grid");
  const mine = app.characters.find(c => c.slug === app.me.character);
  if (!app.characters.length) {
    pg.innerHTML = `<p class="empty">No characters built yet. Run add_character.py.</p>`;
  } else if (mine) {
    const card = characterCard(mine, "player");
    card.onclick = null; card.style.cursor = "default";
    pg.append(card);
  } else {
    pg.innerHTML = `<p class="empty">${app.me.character_name
      ? `Your fighter "${esc(app.me.character_name)}" isn't built yet.`
      : "No fighter is assigned to your account."} Ask the admin to set one in users.csv.</p>`;
  }
  const rivals = app.characters.filter(c => c.slug !== app.me.character);  // no fighting yourself
  for (const c of rivals) og.append(characterCard(c, "opponent"));
  const randomCard = document.createElement("button");
  randomCard.className = "card"; randomCard.dataset.value = "random";
  randomCard.innerHTML = `<div class="portrait" style="display:grid;place-items:center;font-size:40px">?</div><span class="name">RANDOM</span>`;
  randomCard.onclick = () => { select("opponent", "random"); sfx("menu_move"); };
  if (rivals.length) og.append(randomCard);
  else og.innerHTML = `<p class="empty">No one to fight yet. Build another character with add_character.py.</p>`;

  if (mine) select("player", mine.slug);
  select("opponent", "random");
  refreshScores();
}

async function getCharacter(slug) {
  if (!app.loaded[slug]) app.loaded[slug] = loadCharacter(app.characters.find(c => c.slug === slug));
  return app.loaded[slug];
}

async function startMatch(arena) {
  const { player } = app.choice;
  let opponent = app.choice.opponent;
  if (opponent === "random") {
    const others = app.characters.filter(c => c.slug !== player);
    opponent = others[Math.floor(Math.random() * others.length)].slug;
  }
  $("fight-btn").disabled = true;
  $("fight-btn").textContent = "LOADING...";
  try {
    const a = app.arenas.find(x => x.slug === arena) || arenaFor(opponent);
    const [pc, oc, img] = await Promise.all([getCharacter(player), getCharacter(opponent), loadImage(a.image), document.fonts.ready]);
    show("fight");
    app.lastMatch = { player, opponent, arena: a.slug };
    app.match = new Match({ player: pc, opponent: oc, arena: a, arenaImg: img, onEnd: r => endMatch(r, pc, oc) });
    app.match.start();
  } catch (e) {
    alert(`Could not load the match: ${e.message}`);
  } finally {
    $("fight-btn").disabled = false;
    $("fight-btn").textContent = "FIGHT!";
  }
}

async function endMatch(result, pc, oc) {
  app.match = null;
  if (result.quit) { showMenu(); return; }
  show("results");
  $("result-title").textContent = result.won ? "YOU WIN!" : "YOU LOSE";
  $("result-title").style.color = result.won ? "var(--gold)" : "var(--red)";
  $("result-score").textContent = "...";
  $("result-detail").textContent = `${pc.name} vs ${oc.name} · rounds ${result.rounds.join("-")} · ${result.duration}s`;
  try {
    const r = await fetch("/api/scores", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...app.lastMatch, character: app.lastMatch.player, won: result.won,
                             health_left: result.health_left, duration: result.duration }),
    }).then(r => r.json());
    $("result-score").textContent = r.score !== undefined ? `${r.score} PTS` : "NO SCORE";
    if (r.personal_best !== undefined) {
      $("result-detail").textContent += ` · best ${r.personal_best} · rank #${r.rank}`;
      app.me.best = r.personal_best;
      $("user").textContent = `${app.me.username.toUpperCase()} · BEST ${app.me.best}`;
    }
  } catch {
    $("result-score").textContent = "SCORE NOT SAVED";
  }
  refreshScores();
}

$("fight-btn").onclick = () => { sfx("menu_select"); startMatch(); };
$("rematch-btn").onclick = () => {
  sfx("menu_select");
  Object.assign(app.choice, { player: app.lastMatch.player, opponent: app.lastMatch.opponent });
  startMatch(app.lastMatch.arena);
};
$("menu-btn").onclick = () => {
  sfx("menu_move");
  select("opponent", app.choice.opponent);
  showMenu();
};
// ---------------------------------------------------------------- splash

// SplashScreen.mp4 plays once per page load, then the character select screen; a key or click
// skips it. Browsers may block autoplay with sound;
// then it plays muted and the first click turns the sound on instead of skipping.
function runSplash() {
  const video = $("splash-video"), hint = $("splash-hint");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    video.pause();
    window.removeEventListener("keydown", onKey);
    showMenu();
  };
  const onKey = e => { if (!e.repeat) finish(); };
  video.onerror = finish;  // no SplashScreen.mp4: straight to the menu
  video.onended = finish;
  $("splash").onclick = () => {
    if (video.muted) { video.muted = false; hint.textContent = ""; }
    else finish();
  };
  window.addEventListener("keydown", onKey);
  video.play().catch(() => {
    video.muted = true;
    hint.textContent = "CLICK FOR SOUND";
    video.play().catch(finish);
  });
}

runSplash();
initMenu().catch(e => { $("player-grid").innerHTML = `<p class="empty">Failed to load: ${esc(e.message)}</p>`; });
