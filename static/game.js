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

// level: "mid" can be blocked standing or crouching, "low" only crouching, "high" (from the air)
// only standing. air: the attack lasts until landing.
const ATTACKS = {
  punch:        { startup: 5, active: 5, recovery: 8, damage: s => s.punch_damage, hitstun: 14, push: 2.2, level: "mid" },
  kick:         { startup: 8, active: 6, recovery: 12, damage: s => s.kick_damage, hitstun: 18, push: 3.0, level: "mid" },
  crouch_punch: { startup: 4, active: 4, recovery: 7, damage: s => s.punch_damage * 0.8, hitstun: 12, push: 1.8, level: "mid" },
  crouch_kick:  { startup: 7, active: 6, recovery: 16, damage: s => s.kick_damage * 0.9, hitstun: 20, push: 1.5, level: "low", launch: 2.6 },
  jump_punch:   { startup: 4, active: 40, recovery: 0, damage: s => s.punch_damage * 1.1, hitstun: 16, push: 2.2, level: "high", air: true },
  jump_kick:    { startup: 6, active: 40, recovery: 0, damage: s => s.kick_damage * 1.1, hitstun: 20, push: 3.0, level: "high", air: true },
  dive_kick:    { startup: 3, active: 60, recovery: 0, damage: s => s.kick_damage, hitstun: 18, push: 2.5, level: "high", air: true },
  // Combo breaker (S, S, W, then W + punch while being comboed): a huge leaping uppercut.
  breaker:      { startup: 2, active: 20, recovery: 0, damage: s => s.punch_damage * 2.2, hitstun: 40, push: 4, level: "mid", launch: 8, air: true, box: [-14, -140, 60, 140] },
  // Up + punch: a rising uppercut that launches. box: its own reach, straight up in front.
  uppercut:     { startup: 3, active: 14, recovery: 0, damage: s => s.punch_damage * 1.6, hitstun: 26, push: 2, level: "mid", launch: 6.5, air: true, box: [-6, -128, 46, 118] },
  // Rising uppercut, everyone's: punch just as you land after being launched (WAKEUP). Unblockable,
  // and it flings the opponent about half the screen away.
  wakeup:       { startup: 2, active: 22, recovery: 0, damage: s => s.punch_damage * 2, hitstun: 40, push: 4.8, level: "mid", launch: 6, air: true, unblockable: true, box: [-36, -140, 96, 140] },
};
// When the rising uppercut works after a launch: falling and within `height` of the ground, or up to
// `late` ticks after landing. Punching while still high in the air spends the chance for that launch.
// jump: its upward speed; invuln: ticks safe from hits as it comes out.
const WAKEUP = { height: 30, late: 8, jump: 6, invuln: 24 };
// Animation to show when a character's sheet predates an extended move.
const FALLBACK_ANIMS = {
  crouch_block: "block", crouch_punch: "punch", crouch_kick: "kick",
  jump_punch: "punch", jump_kick: "kick", dive_kick: "jump_kick", uppercut: "jump_punch", breaker: "uppercut", wakeup: "uppercut",
};
const LANDING_TICKS = 6;   // recovery after landing from an air attack
const SPECIAL = { startup: 14, active: 16, recovery: 18, cooldown: 240 };
const STUN_TICKS = 110;
// Combos: landed (unblocked) hits each within `window` ticks of the last. Every hit deeper in a
// combo staggers the victim longer (slower to react), and they're scored 50 x hits^2 (server.py).
const COMBO = { window: 50, stunPerHit: 0.1, maxStun: 0.8, base: 50, maxScored: 60 };
const comboPoints = n => COMBO.base * Math.min(n, COMBO.maxScored) ** 2;
// invuln/cooldown/slowmo in game ticks; slowSpeed: game speed during the slow-motion leap;
// points: per breaker, before the difficulty multiplier (as in server.py)
const BREAKER = { invuln: 26, cooldown: 300, jump: 8.5, slowmo: 50, slowSpeed: 0.4, points: 1000 };
const BEAM = { startup: 14, active: 34, recovery: 14, every: 8, hits: 3 };
// A beam with beam_style "blast" (a cannon blast rather than a laser): its thickness, and how many
// scraps of paperwork tumble out of it.
const BLAST = { thickness: 16, papers: 14 };
// Flurry: a burst of rapid kicks, one hit every `every` ticks, edging forward to stay in range.
// damage: the whole flurry's damage as a multiple of special_damage, if every kick lands.
const FLURRY = { startup: 10, active: 54, recovery: 14, every: 6, hits: 8, damage: 1.3, creep: 0.7 };
// Flip: crouch, then a rising backflip kick that launches; the sprite turns a full circle in the air.
const FLIP = { startup: 12, vy: 7.6, vx: 0.5, hitFor: 0.6 };
// Hurricane: a hop, then spinning like a top with a leg out, travelling forward through the air and
// kicking whoever it passes several times; lands where it ends up.
const HURRICANE = { startup: 10, air: 46, height: 26, speed: 2.6, every: 8, hits: 4, damage: 1.4 };
// Audit: tap away at a calculator, then a fan of red figures sprays across the screen (block it).
// If it reaches the opponent their money bursts out of their pockets and whirls around them for
// `whirl` ticks, hitting them `whirlHits` times (unblockable), before it blows away.
// sprayDamage / whirlDamage: per hit, as a fraction of special_damage.
// Orbital: call down a strike from the sky. A target reticle follows the opponent (slower than they
// can run, so it can be outrun) for `track` ticks, locks for `lock`, then a giant beam hits that spot.
// damage: x special_damage; unblockable, but dodgeable by getting out from under it.
const ORBITAL = { startup: 18, track: 44, follow: 1.9, lock: 24, strike: 40, hitFor: 14, width: 54, damage: 2.2, recovery: 16,
                  fall: 9, propScale: 0.7 };  // a dropped prop: ticks to fall from the sky, and its size
const AUDIT = { startup: 20, speed: 7, hold: 30, recovery: 16, cash: 46, sprayDamage: 0.5,
                whirl: 150, whirlHits: 5, whirlDamage: 0.25 };

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

// A sprite frame's main color (its most common opaque, not-too-light color, roughly), for effects
// drawn in a fighter's own colors.
function dominantColor(img, f) {
  const c = document.createElement("canvas"); c.width = f.w; c.height = f.h;
  const g = c.getContext("2d"); g.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  const px = g.getImageData(0, 0, f.w, f.h).data, bins = new Map();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue;
    const r = px[i], gg = px[i + 1], b = px[i + 2];
    if (r + gg + b > 600) continue;  // whites: the crescent's core is white already
    const key = (r >> 5) << 6 | (gg >> 5) << 3 | (b >> 5);
    const e = bins.get(key) || [0, 0, 0, 0];
    e[0] += r; e[1] += gg; e[2] += b; e[3]++; bins.set(key, e);
  }
  const best = [...bins.values()].sort((p, q) => q[3] - p[3])[0];
  if (!best) return [120, 200, 255];
  const [r, gg, b, n] = best;
  // lift very dark colors a little so a black outfit still reads as a colored edge
  const lift = v => Math.round(Math.min(255, v / n * 0.8 + 40));
  return [lift(r), lift(gg), lift(b)];
}

class Fighter {
  constructor(char, isPlayer) {
    this.char = char;
    this.stats = char.stats;
    this.isPlayer = isPlayer;
    this.rounds = 0;
    // For the score: health left at the end of each round won, and how many special moves
    // landed (each use counts once, however many times it hits).
    this.roundHealth = [];
    this.specialsLanded = 0; this.specialRun = 0; this.countedRun = 0;
    this.combos = [];  // lengths of the combos (2+ hits) this fighter landed this match
    this.breakers = 0;  // combo breakers this fighter pulled off this match
  }

  // The combo breaker works only while the opponent's combo on this fighter is still alive.
  canBreak() {
    return this.breakerCooldown === 0 && this.lastAttacker?.combo >= 2 &&
      !["ko", "victory", "defeat"].includes(this.state) && !this.hidden && !this.held;
  }

  // The rising uppercut: when falling close to the ground after a launch, or just after landing.
  wakeWindow() {
    if (this.wakeSpent || ["ko", "victory", "defeat"].includes(this.state) || this.hidden || this.held) return false;
    if (this.knocked) return this.vy < 0 && this.y < WAKEUP.height;
    return this.now - this.landedAt <= WAKEUP.late && ["hit", "landing", "idle", "walk", "crouch", "jump"].includes(this.state);
  }

  // A punch while launched: too early (still high) spends the chance; else whether it's on.
  tryWake() {
    if (this.wakeWindow()) return true;
    if (this.knocked) this.wakeSpent = true;
    return false;
  }

  wakeUp(opp, match) {
    this.special = null; this.bound = 0; this.floating = false; this.knocked = false; this.wakeSpent = true;
    this.setState("wakeup");
    this.facing = opp.x >= this.x ? 1 : -1;
    this.vy = WAKEUP.jump; this.y = Math.max(this.y, 0.01); this.vx = this.facing * 0.8;
    this.airAttacked = true;
    this.invuln = Math.max(this.invuln, WAKEUP.invuln);
    this.shout = { text: "RISING UPPERCUT!", t: 50 };
    sfx("special"); sfx("punch_whoosh", { x: this.x }); match.shake = 5;
  }

  comboBreaker(opp, match) {
    opp.endCombo();
    this.special = null; this.bound = 0; this.floating = false;
    this.setState("breaker");
    this.facing = opp.x >= this.x ? 1 : -1;
    this.vy = BREAKER.jump; this.y = Math.max(this.y, 0.01); this.vx = this.facing * 1.5;
    this.airAttacked = true;
    this.invuln = BREAKER.invuln;  // can't be hit while it comes out
    this.breakerCooldown = BREAKER.cooldown;
    this.breakers++;
    match.comboBreakerFx(this);
  }

  // A hit landed on the opponent at match tick `now`: extend the combo or start a new one.
  comboHit(now) {
    if (this.combo > 0 && now - this.comboLast <= COMBO.window) this.combo++;
    else { this.endCombo(); this.combo = 1; }
    this.comboLast = now;
    if (this.combo >= 2) this.comboShow = { n: this.combo, t: 0, done: false };
    return this.combo;
  }

  endCombo() {
    if (this.combo >= 2) {
      this.combos.push(this.combo);
      this.comboShow = { n: this.combo, t: 0, done: true };
      if (this.combo >= 4) sfx("menu_select");
    }
    this.combo = 0;
  }

  reset(x, facing) {
    Object.assign(this, {
      x, y: 0, vx: 0, vy: 0, facing, health: this.stats.health, trail: this.stats.health,
      state: "idle", t: 0, hasHit: false, hitCount: 0, stunFor: 0, cooldown: 0, cooldowns: {},
      special: null, shout: null, combo: 0, comboLast: -999, comboShow: null, lastAttacker: null, invuln: 0, breakerCooldown: 0, holdingBack: false, holdingDown: false, airAttacked: false, hidden: false, held: false, stretch: 0, bound: 0, auditDone: 0, ghosts: [], passThrough: false, floating: false,
      knocked: false, wakeSpent: false, landedAt: -999, now: 0,
    });
  }

  setState(state) {
    if (this.state === state) return;
    if (this.state === "dizzy") this.sleepy = false;
    if (this.special && this.state === this.special.id) { this.floating = false; this.passThrough = false; this.ghosts = []; this.cat = null; this.stopT = 0; this.auditDone = 0; }
    this.state = state; this.t = 0; this.hasHit = false; this.hitCount = 0;
  }

  get airborne() { return this.y > 0 || this.vy > 0; }
  get attacking() { return this.state in ATTACKS || this.state.startsWith("special"); }
  get canAct() { return ["idle", "walk", "crouch", "jump"].includes(this.state); }
  get blocking() { return this.state === "block" || this.state === "crouch_block"; }

  anim(name) {
    const anims = this.char.sheetData.animations;
    while (!anims[name] && FALLBACK_ANIMS[name]) name = FALLBACK_ANIMS[name];
    return anims[name] || anims.idle;
  }

  currentFrame() {
    const s = this.state;
    let anim, i = 0;
    if (s in ATTACKS) {
      anim = this.anim(s); i = this.t < ATTACKS[s].startup ? 0 : 1;
    } else if (s.startsWith("special") && this.special?.effect === "beam") {
      // beam_frame (character.json): which frame fires it. 0 (eyes): stand normally while charging;
      // 1 (hands): the other frame is the wind-up.
      const fire = this.special.beam_frame || 0;
      if (this.t < BEAM.startup && !fire) anim = this.anim("idle");
      else { anim = this.anim(s); i = this.t < BEAM.startup ? 0 : fire; }
    } else if (s.startsWith("special") && this.special?.effect === "cat") {
      // waiting for the cat (normal stance), the cat at her feet (frame 0, which has it), petting it (1)
      const k = this.cat?.arrived ? this.t - this.cat.arrived : -1;
      anim = k < 0 ? this.anim("idle") : this.anim(s); i = k < 15 ? 0 : 1;
    } else if (s.startsWith("special") && this.special?.effect === "charge") {
      anim = this.anim("jump");
    } else if (s.startsWith("special") && this.special?.effect === "orbital") {
      anim = this.anim(s); i = this.t < ORBITAL.startup ? 0 : 1;  // keying it in, then calling it down
    } else if (s.startsWith("special") && this.special?.effect === "audit") {
      anim = this.anim(s); i = this.t < AUDIT.startup ? 0 : 1;  // typing, then holding the calculator out
    } else if (s.startsWith("special") && this.special?.effect === "flip") {
      anim = this.anim(s); i = this.t < FLIP.startup ? 0 : 1;  // crouch, then the flip frame from take-off
    } else if (s.startsWith("special") && this.special?.effect === "flurry") {
      // wind up (frame 0), then flicker between the chambered leg and the blur of kicks
      const k = this.t - FLURRY.startup;
      anim = this.anim(s); i = k < 0 || k >= FLURRY.active ? 0 : (Math.floor(k / 3) % 3 === 2 ? 0 : 1);
    } else if (s.startsWith("special")) {
      anim = this.anim(s); i = this.t < SPECIAL.startup ? 0 : 1;
    } else if (s === "dizzy") {
      anim = this.anim("hit");
    } else {
      anim = this.anim(s);
      if (anim.loop) i = Math.floor(this.t / (60 / anim.fps));
      // Backing away: the walk cycle runs backwards, so the feet step back instead of moonwalking.
      if (s === "walk" && this.holdingBack) i = anim.frames.length - 1 - (i % anim.frames.length);
    }
    return anim.frames[i % anim.frames.length];
  }

  // Box relative to the feet anchor -> world box, mirrored when facing left.
  worldBox(box) {
    const [l, t, w, h] = box;
    return { x: this.facing > 0 ? this.x + l : this.x - l - w, y: GROUND - this.y + t, w, h };
  }

  hurtBox() { return this.worldBox(this.currentFrame().hurt); }

  // Float: hover cross-legged high enough that ground attacks pass underneath, for a few
  // seconds. Drift with left/right; down drops out early; getting hit ends it.
  updateFloat(opp, input) {
    const t = this.t, s = SPECIAL, HEIGHT = 70, TICKS = 180;
    if (t === 1 && !this.airborne) { this.vy = 6.2; this.y = 0.01; }  // hop up from the ground
    if (t < s.startup) return;
    if (!this.floating) { this.floating = true; this.floatY = this.y; this.vy = 0; }
    const k = t - s.startup;
    this.floatY += clamp(HEIGHT - this.floatY, -1.5, 1.5);  // ease to the hover height
    this.y = this.floatY + Math.sin(k * 0.08) * 3;
    this.vx = (input.move || 0) * 1.1;
    if (k > TICKS || input.crouch) {
      this.floating = false; this.vy = -0.5;
      this.facing = opp.x >= this.x ? 1 : -1;
      this.setState("jump");  // and fall
    }
  }

  // Dash: sprint across the whole screen through the opponent. Tornado: storm to the far side of
  // the screen and back as a whirlwind. Both pass through the opponent (see Match.separate).
  updateRun(sp, opp, match) {
    const t = this.t, s = SPECIAL, tornado = sp.effect === "tornado";
    const speed = tornado ? 7.5 : 9.5;
    if (t === s.startup) {
      const camX = match.camX();
      this.runFrom = this.x;
      this.runTo = clamp(this.facing > 0 ? camX + W - 26 : camX + 26, 18, match.stageWidth - 18);
      this.runDir = this.facing; this.leg = 0; this.lastHit = -99; this.passThrough = true;
      sfx(tornado ? "special" : "punch_whoosh", { x: this.x });
    }
    if (t < s.startup) return;
    if (this.leg < (tornado ? 2 : 1)) {
      const goal = this.leg === 0 ? this.runTo : this.runFrom, dir = Math.sign(goal - this.x) || this.runDir;
      this.vx = dir * speed;
      this.facing = this.runDir;  // she keeps facing the same way, tornado or not
      if (Math.abs(goal - this.x) <= speed || (dir < 0 ? this.x <= 18 : this.x >= match.stageWidth - 18)) {
        this.x = goal; this.vx = 0; this.leg++;
      }
      this.ghosts.unshift(this.x); this.ghosts.length = Math.min(this.ghosts.length, 4);
      const box = tornado ? [-40, -130, 80, 130] : [-22, -100, 52, 95];
      const maxHits = tornado ? 3 : 1;
      if (this.hitCount < maxHits && t - this.lastHit > 14 && overlap(this.worldBox(box), opp.hurtBox())) {
        this.hitCount++; this.lastHit = t;
        const dmg = this.stats.special_damage * (tornado ? 0.55 : 1);
        opp.receive(this, dmg, match, { hitstun: tornado ? 40 : 30, push: 4, launch: tornado ? 7 : 5 });
      }
      return;
    }
    // arrived: skid to a stop, then turn back to the opponent
    this.vx = 0; this.passThrough = false;
    if (this.ghosts.length) this.ghosts.pop();
    if ((this.stopT = (this.stopT || 0) + 1) > s.recovery) {
      this.stopT = 0; this.ghosts = [];
      this.facing = opp.x >= this.x ? 1 : -1;
      this.setState("idle");
    }
  }

  // Cat: a cat (the prop) scampers in from the far side, tripping the opponent on the way, and
  // runs to her; she sits and pets it, slowly healing, wide open to attack.
  updateCat(sp, opp, match) {
    const t = this.t, img = this.char.props[sp.id];
    if (t === 1) {
      const camX = match.camX(), w = img ? img.width : 24;
      this.cat = { x: this.facing > 0 ? camX + W + w : camX - w, dir: -this.facing, img, tripped: false, arrived: 0 };
      this.healed = 0;
    }
    const c = this.cat;
    if (!c) { this.setState("idle"); return; }
    if (!c.arrived) {
      c.x += c.dir * 5;
      const w = c.img ? c.img.width : 24, h = c.img ? c.img.height : 24;
      if (!c.tripped && !opp.airborne && overlap({ x: c.x - w / 2, y: GROUND - h, w, h }, opp.hurtBox())) {
        c.tripped = true;
        opp.receive(this, 4, match, { hitstun: 22, push: 1, launch: 2.5, level: "low" });
      }
      if ((this.x - c.x) * c.dir <= 10) { c.arrived = t; sfx("ready", { x: this.x }); }
    } else {
      const heal = Math.min(this.stats.health * 0.12 / 60, this.stats.health - this.health);
      if (t - c.arrived < 60 && heal > 0) { this.health += heal; this.healed += heal; }
      if (t - c.arrived > 75) { this.cat = null; this.facing = opp.x >= this.x ? 1 : -1; this.setState("idle"); }
    }
    if (t > 400) { this.cat = null; this.setState("idle"); }
  }

  // Claws coming out of the knuckles: three steel blades drawn at the fist's own scale (a
  // picture of claws shrunk to fist size smears). Drawn behind the sprite so the fist covers
  // their roots. character.json, extra_props.claws: attach = [[x, y, angle], ...] per frame
  // (relative to the feet, facing right), fist (root spread), length, blade width.
  drawClaws(ctx, f, px, py) {
    const rising = this.t >= SPECIAL.startup;
    const cfg = this.special.extra_props.claws;
    const [cx, cy, ang] = cfg.attach?.[rising ? 1 : 0] ||
      [...((rising ? f.top : f.front) || [f.w - f.ax, -f.ay]), rising ? 0.15 : 0.45];
    const fist = cfg.fist || 9, len = (cfg.length || 26) * (rising ? 1 : Math.min(1, this.t / 5));  // spring out
    const hw = (cfg.blade || 3) / 2;
    ctx.save();
    ctx.translate(px + this.facing * cx, py + cy);
    ctx.scale(this.facing, 1);
    ctx.rotate(ang);
    const tri = (pts, color) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(...pts[0]);
      for (const q of pts.slice(1)) ctx.lineTo(...q);
      ctx.closePath(); ctx.fill();
    };
    for (const k of [-1, 0, 1]) {
      const bx = k * fist / 3, tx = k * (fist / 3 + 1.5), ty = -len + Math.abs(k) * 2;
      tri([[bx - hw - 1, 0], [bx + hw + 1, 0], [tx, ty - 1]], "#181820");  // outline
      tri([[bx - hw, 0], [bx + hw, 0], [tx, ty]], "#b0b8c4");              // steel
      ctx.strokeStyle = "#fafcff"; ctx.lineWidth = 1;                     // shine
      ctx.beginPath(); ctx.moveTo(bx - hw + 0.5, 0); ctx.lineTo(tx, ty + 1); ctx.stroke();
    }
    ctx.restore();
  }

  // The whirlwind (the prop) behind her, and papers swirling in front.
  drawTornado(ctx, px, behind) {
    const img = this.char.props[this.special.id], t = this.t;
    if (behind) {
      if (!img) return;
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.translate(px + Math.sin(t * 0.5) * 3, GROUND + 2);
      if (Math.floor(t / 3) % 2) ctx.scale(-1, 1);  // flicker-spin
      ctx.drawImage(img, -img.width / 2, -img.height);
      ctx.restore();
      return;
    }
    for (let i = 0; i < 12; i++) {
      const a = t * 0.35 + i * 1.7, r = 18 + (i % 4) * 9;
      const x = px + Math.cos(a) * r, y = GROUND - 12 - i * 11 + Math.sin(a) * 4;
      if (Math.sin(a) < -0.2) continue;  // behind her
      ctx.fillStyle = "#222"; ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 6, 5);
      ctx.fillStyle = i % 3 ? "#f4f4f0" : "#dfe6ff"; ctx.fillRect(Math.round(x), Math.round(y), 4, 3);
    }
  }

  drawCat(ctx, camX, py) {
    const c = this.cat;
    if (c.arrived) {  // hearts while petting
      const k = this.t - c.arrived;
      if (k > 70) return;
      ctx.font = `8px ${FONT}`; ctx.textAlign = "center"; ctx.fillStyle = "#ff6fae";
      for (let i = 0; i < 3; i++) {
        const h = (k * 0.6 + i * 14) % 40;
        ctx.globalAlpha = 1 - h / 40;
        ctx.fillText("\u2665", Math.round(this.x - camX - 10 + i * 10), Math.round(py - 70 - h));
      }
      ctx.globalAlpha = 1;
      return;
    }
    const img = c.img, x = Math.round(c.x - camX), bob = Math.abs(Math.sin(this.t * 0.6)) * 3;
    ctx.save();
    ctx.translate(x, GROUND + 1 - bob);
    if (c.dir > 0) ctx.scale(-1, 1);
    if (img) ctx.drawImage(img, -img.width / 2, -img.height);
    else { ctx.fillStyle = "#e89a3c"; ctx.fillRect(-10, -16, 20, 16); }
    ctx.restore();
  }

  drawBeam(ctx, camX, f, px, py) {
    const t = this.t, blast = this.special.beam_style === "blast";
    if (t < BEAM.startup) {  // charging up: at the eyes, or between the hands drawn back
      const r = 1 + t / (blast ? 2.5 : 4);
      const ey = py - f.ay + Math.round(f.h * (blast ? 0.6 : 0.14)), ex = px + this.facing * (blast ? 4 : 6);
      ctx.fillStyle = blast ? `rgba(255,214,80,${0.4 + t / 30})` : `rgba(255,60,60,${0.4 + t / 40})`;
      ctx.beginPath(); ctx.arc(ex, ey, r, 0, Math.PI * 2); ctx.fill();
      if (blast) { ctx.fillStyle = "#fff8d0"; ctx.beginPath(); ctx.arc(ex, ey, r * 0.45, 0, Math.PI * 2); ctx.fill(); }
      return;
    }
    if (blast) return this.drawBlast(ctx, camX);
    if (t >= BEAM.startup + BEAM.active) return;
    const fade = Math.min(1, (BEAM.startup + BEAM.active - t) / 6);
    const b = this.beamLine(camX), wobble = (t % 4 < 2) ? 1 : 0;
    const len = Math.abs(b.x1 - b.x0) * Math.hypot(1, b.slope);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(Math.round(b.x0 - camX), b.y0);
    ctx.scale(this.facing, 1);
    ctx.rotate(Math.atan(b.slope));  // angled down at a shorter opponent
    ctx.fillStyle = "rgba(255,40,40,0.35)"; ctx.fillRect(0, -b.h / 2 - 2 - wobble, len, b.h + 4 + wobble * 2);
    ctx.fillStyle = "#ff2a2a"; ctx.fillRect(0, -b.h / 2 + 1, len, Math.max(2, b.h - 2));
    ctx.fillStyle = "#ffd0d0"; ctx.fillRect(0, -1, len, 1 + wobble);
    ctx.restore();
  }

  // beam_style "blast": a thick golden cannon blast from the palms, shredding paperwork as it goes.
  drawBlast(ctx, camX) {
    const t = this.t, k = t - BEAM.startup;
    const fade = Math.min(1, (BEAM.startup + BEAM.active - t) / 6), grow = Math.min(1, (k + 1) / 4);
    const b = this.beamLine(camX), len = Math.abs(b.x1 - b.x0) * Math.hypot(1, b.slope);
    const h = Math.round(BLAST.thickness * grow) + (t % 4 < 2 ? 2 : 0);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(Math.round(b.x0 - camX), b.y0);
    ctx.scale(this.facing, 1);
    ctx.rotate(Math.atan(b.slope));
    ctx.fillStyle = "rgba(255,190,60,0.35)"; ctx.fillRect(0, -h / 2 - 4, len, h + 8);
    ctx.fillStyle = "#ffcf3a"; ctx.fillRect(0, -h / 2, len, h);
    ctx.fillStyle = "#fff1b0"; ctx.fillRect(0, -h / 4, len, Math.ceil(h / 2));
    ctx.fillStyle = "#fffdf2"; ctx.fillRect(0, -1, len, 2);
    ctx.fillStyle = "#fff8d0";  // the muzzle flare at the palms
    ctx.beginPath(); ctx.ellipse(2, 0, 7 + (t % 3), h / 2 + 4, 0, 0, Math.PI * 2); ctx.fill();
    // Shredded paperwork tumbling out of the blast: forms, memos, red tape.
    for (let i = 0; i < BLAST.papers; i++) {
      const along = (k * 7 + i * 47) % Math.max(60, len);
      const out = (along / 60) * (i % 2 ? 1 : -1) * (4 + (i * 13) % 9);  // drifting off the beam
      const y = Math.sin(k * 0.3 + i) * h * 0.35 + out, spin = k * 0.35 + i * 1.3;
      ctx.save();
      ctx.translate(Math.round(along), Math.round(y));
      ctx.rotate(spin);
      if (i % 5 === 4) {  // a strand of red tape
        ctx.fillStyle = "#d22a2a"; ctx.fillRect(-6, -1, 12, 2);
      } else {
        const torn = i % 3 === 0;
        ctx.fillStyle = "#4a4a4a"; ctx.fillRect(-4, -5, torn ? 6 : 8, 10);
        ctx.fillStyle = "#f6f3e8"; ctx.fillRect(-3, -4, torn ? 4 : 6, 8);
        ctx.fillStyle = "#8a8a94"; ctx.fillRect(-2, -2, 4, 1); ctx.fillRect(-2, 0, 3, 1);
        if (i % 4 === 1) { ctx.fillStyle = "#d22a2a"; ctx.fillRect(-2, 2, 4, 1); }  // a red stamp
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // The beam from the front edge of the sprite to the edge of the screen (world coordinates):
  // from (x0, y0) to x1, thickness h, dropping `slope` px per px (see aimBeam).
  beamLine(camX) {
    const f = this.currentFrame();
    // edge: rows and starting column of the beam drawn in the sprite (see add_character.py);
    // the beam is drawn from there, over the sprite's own (palette-muted) one.
    const [top, bottom, from] = f.edge || [-Math.round(f.h * 0.86), -Math.round(f.h * 0.82)];
    const x0 = this.x + this.facing * (from ?? f.w - f.ax - 1);
    return { x0, y0: GROUND - this.y + (top + bottom) / 2, x1: this.facing > 0 ? camX + W : camX,
             h: this.special?.beam_style === "blast" ? BLAST.thickness : bottom - top + 2, slope: this.beamSlope || 0 };
  }

  // A beam fired over the opponent's head (a giant's eyes) tilts down to their upper chest; aimed
  // once as it fires, so ducking afterwards still dodges it.
  aimBeam(opp, camX) {
    this.beamSlope = 0;
    const b = this.beamLine(camX), hb = opp.hurtBox(), dx = Math.abs(opp.x - b.x0);
    if (b.y0 + b.h / 2 < hb.y + 4 && dx > 20) this.beamSlope = clamp((hb.y + hb.h * 0.25 - b.y0) / dx, 0, 0.5);
  }

  beamHits(opp, camX) {
    const b = this.beamLine(camX), hb = opp.hurtBox();
    if ((opp.x - b.x0) * this.facing < 0 || (opp.x - b.x1) * this.facing > 0) return false;
    const y = b.y0 + b.slope * Math.abs(opp.x - b.x0);
    return y + b.h / 2 > hb.y && y - b.h / 2 < hb.y + hb.h;
  }

  // Roughly where a raised wand's tip is: the sprite's top front corner.
  wandTip() {
    const f = this.currentFrame();
    return { x: this.x + this.facing * (f.w - f.ax - 14), y: GROUND - this.y - f.ay + 9 };
  }

  hitBox() {
    const f = this.currentFrame();
    // Sprite-derived boxes can be thin; guarantee a fair reach.
    const box = f.hit ? [...f.hit] : [8, -Math.round(f.h * 0.75), 30, 24];
    if (box[2] < 26) box[2] = 26;
    return this.worldBox(box);
  }

  update(input, opp, match) {
    this.t++;
    if (this.held) return;  // inside an abduct special's vehicle
    if (this.invuln > 0) this.invuln--;
    if (this.breakerCooldown > 0) this.breakerCooldown--;
    this.now = match.clock;
    if (input.breaker && this.canBreak()) return this.comboBreaker(opp, match);
    if (input.wakeup && this.wakeWindow()) return this.wakeUp(opp, match);
    if (this.bound > 0) this.bound--;  // legs taped by a bind special
    if (this.cooldown > 0 && --this.cooldown === 0 && this.isPlayer) sfx("ready");
    for (const id in this.cooldowns) {
      // only the long ones announce themselves; a quick move would chime constantly
      if (this.cooldowns[id] > 0 && --this.cooldowns[id] === 0 && this.isPlayer &&
          this.char.specials.find(s => s.id === id)?.cooldown >= 5) sfx("ready");
    }
    if (this.shout && --this.shout.t <= 0) this.shout = null;
    this.holdingBack = input.move === -this.facing && !this.airborne;
    this.holdingDown = !!input.crouch && !this.airborne;

    switch (this.state) {
      case "ko": case "victory": case "defeat":
        break;
      case "hit":
        if (this.t >= this.stunFor) this.setState(this.airborne ? "jump" : "idle");
        break;
      case "dizzy":
        if (this.t >= this.stunFor) this.setState("idle");
        break;
      case "block": case "crouch_block":
        if (this.t >= this.stunFor) this.setState(this.state === "crouch_block" ? "crouch" : "idle");
        break;
      case "landing":
        if (this.t >= LANDING_TICKS) this.setState("idle");
        break;
      default:
        if (this.state in ATTACKS) {
          const a = ATTACKS[this.state];
          if (this.t >= a.startup + a.active + a.recovery) this.setState(this.airborne ? "jump" : "idle");
        } else if (this.state.startsWith("special")) {
          this.updateSpecial(opp, match, input);
        }
    }

    if (this.canAct) this.handleInput(input, opp);

    // physics
    this.x += this.vx;
    if (this.floating) {
      // hovering (float specials): height is set in updateFloat, no gravity
    } else if (this.airborne) {
      this.y += this.vy; this.vy -= GRAVITY;
      if (this.y <= 0) {
        this.y = 0; this.vy = 0;
        this.airAttacked = false;
        if (this.knocked) { this.knocked = false; this.landedAt = match.clock; }
        if (this.state === "jump") { this.setState("idle"); this.vx = 0; sfx("land", { x: this.x }); }
        else if (ATTACKS[this.state]?.air) { this.setState("landing"); this.vx = 0; sfx("land", { x: this.x }); }
        if (this.state === "ko") this.vx *= 0.5;
      }
    } else if (["hit", "block", "crouch_block", "ko", "dizzy"].includes(this.state) || this.state.startsWith("special")) {
      // (grounded only: airborne specials such as an uppercut keep their drift)
      this.vx *= 0.82;
    }
    if (!this.airborne && this.canAct && this.state !== "walk") this.vx = 0;
    this.x = clamp(this.x, 18, match.stageWidth - 18);
  }

  handleInput(input, opp) {
    if (!this.airborne) this.facing = opp.x >= this.x ? 1 : -1;
    if (input.special && this.specialReady(input.special)) return this.startSpecial(input.special);
    if (input.attack) {
      // punch / kick become the crouching, jumping or diving version by stance.
      let move = input.attack;
      // Up + punch together: an uppercut. Up held on the ground, or punch in the first few frames
      // of a jump (up pressed a hair earlier), both count.
      const uppercut = move === "punch" && !input.crouch && !this.airAttacked &&
        ((!this.airborne && input.jump && !this.bound) || (this.state === "jump" && this.t <= 6));
      if (uppercut) {
        this.setState("uppercut");
        this.airAttacked = true;
        this.vy = Math.max(this.vy, 6.4); this.y = Math.max(this.y, 0.01); this.vx = this.facing * 1.2;
        sfx("punch_whoosh", { x: this.x });
        return;
      }
      if (this.airborne) {
        if (this.airAttacked) return;    // one attack per jump
        this.airAttacked = true;
        move = input.crouch ? "dive_kick" : `jump_${move}`;
      } else if (input.crouch) {
        move = `crouch_${move}`;
      }
      this.setState(move);
      sfx(`${input.attack}_whoosh`, { x: this.x });
      if (move === "dive_kick") { this.vy = -4.2; this.vx = this.facing * 3.2; }
      else if (!this.airborne) this.vx = 0;
      return;
    }
    if (this.airborne) return;
    if (input.jump && !this.bound) {
      this.vy = this.stats.jump_power; this.y = 0.01;
      this.vx = input.move * this.stats.walk_speed * 1.1;
      this.setState("jump");
    } else if (input.crouch) {
      this.setState("crouch"); this.vx = 0;
    } else if (input.move) {
      this.setState("walk");
      this.vx = input.move * this.stats.walk_speed * (input.move === this.facing ? 1 : 0.75);
      if (this.bound) this.vx *= 0.35 * (Math.sin(this.t * 0.3) > 0 ? 2 : 0);  // taped legs: slow little hops
    } else {
      this.setState("idle");
    }
  }

  // A special with its own "cooldown" (seconds, character.json) runs on its own timer; the rest
  // share one, so using any of them blocks the others for SPECIAL.cooldown.
  specialReady(sp) {
    return sp.cooldown ? !(this.cooldowns[sp.id] > 0) : this.cooldown === 0;
  }

  startSpecial(sp) {
    this.special = sp;
    this.specialRun++;
    this.setState(sp.id);
    if (sp.cooldown) this.cooldowns[sp.id] = Math.round(sp.cooldown * 60);
    else this.cooldown = SPECIAL.cooldown;
    if (!this.airborne) this.vx = 0;
    if (sp.shout) this.shout = { text: sp.shout, t: 100 };
    sfx("special", { x: this.x });
  }

  updateSpecial(opp, match, input = {}) {
    const sp = this.special, t = this.t, s = SPECIAL;
    const dmg = this.stats.special_damage;
    if (sp.effect === "float") return this.updateFloat(opp, input);
    if (sp.effect === "charge") {
      // The vehicle (see Match.updateCharges) picks the fighter up and drops them off; this is a backstop.
      if (t === 1) match.spawnCharge(this, opp, sp);
      else if (t > 300) { this.hidden = false; this.setState("idle"); }
      return;
    }
    if (sp.effect === "stretch") {
      // The kicking leg stretches to reach the opponent, holds, then snaps back.
      const f = this.currentFrame();
      const reach = (f.hit ? f.hit[0] + f.hit[2] : f.w - f.ax);
      const want = t < s.startup + s.active ? clamp(Math.abs(opp.x - this.x) - reach + 10, 0, 280) : 0;
      this.stretch += clamp(want - this.stretch, -24, 36);
      if (t >= s.startup && t < s.startup + s.active && !this.hasHit && this.stretch > 0) {
        const box = f.hit ? [...f.hit] : [8, -Math.round(f.h * 0.75), 30, 24];
        box[2] += this.stretch;
        if (overlap(this.worldBox(box), opp.hurtBox())) {
          this.hasHit = true;
          opp.receive(this, dmg, match, { hitstun: 26, push: 5 });
        }
      }
    }
    if (sp.effect === "beam") {
      const on = t >= BEAM.startup && t < BEAM.startup + BEAM.active;
      if (t === BEAM.startup) { sfx("throw", { x: this.x }); this.aimBeam(opp, match.camX()); }
      if (on && (t - BEAM.startup) % BEAM.every === 0 && this.hitCount < BEAM.hits && this.beamHits(opp, match.camX())) {
        this.hitCount++;
        opp.receive(this, Math.ceil(dmg / BEAM.hits), match, { hitstun: 14, push: 1.5 });
      }
      if (t >= BEAM.startup + BEAM.active + BEAM.recovery) {
        this.facing = opp.x >= this.x ? 1 : -1;
        this.setState(this.airborne ? "jump" : "idle");
      }
      return;
    }
    if (sp.effect === "dash" || sp.effect === "tornado") return this.updateRun(sp, opp, match);
    if (sp.effect === "cat") return this.updateCat(sp, opp, match);
    if (sp.effect === "orbital") {
      if (t < ORBITAL.startup && t % 4 === 0) sfx("tick", { x: this.x });  // keying in the command
      if (t === ORBITAL.startup) match.spawnOrbital(this, opp);
      // keep the fist raised until the strike is over
      if (t > ORBITAL.startup && t < 400 && match.orbitals.some(o => o.owner === this)) return;
      if (t >= ORBITAL.startup && !this.auditDone) this.auditDone = t;
      if (this.auditDone && t >= this.auditDone + ORBITAL.recovery) {
        this.auditDone = 0;
        this.facing = opp.x >= this.x ? 1 : -1;
        this.setState("idle");
      }
      return;
    }
    if (sp.effect === "audit") {
      if (t < AUDIT.startup && t % 4 === 0) sfx("tick", { x: this.x });  // keys beeping
      if (t === AUDIT.startup) match.spawnAudit(this, opp);
      // hold the calculator out while the tape is running
      if (t > AUDIT.startup && t < 400 && match.audits.some(a => a.owner === this && a.state !== "fall")) return;
      if (t >= AUDIT.startup && !this.auditDone) this.auditDone = t;
      if (this.auditDone && t >= this.auditDone + AUDIT.recovery) {
        this.auditDone = 0;
        this.facing = opp.x >= this.x ? 1 : -1;
        this.setState("idle");
      }
      return;
    }
    if (sp.effect === "hurricane") {
      const k = t - HURRICANE.startup;
      if (k < 0) { this.vx = 0; return; }
      if (k < HURRICANE.air) {
        // held aloft on a smooth arc (no gravity), moving forward
        this.floating = true; this.vy = 0;
        this.y = Math.max(0.01, HURRICANE.height * Math.sin(Math.PI * Math.min(1, (k + 4) / (HURRICANE.air + 4))));
        this.vx = this.facing * HURRICANE.speed;
        if (k % HURRICANE.every === 0) {
          sfx("kick_whoosh", { x: this.x });
          if (this.hitCount < HURRICANE.hits && overlap(this.worldBox([-34, -120, 92, 90]), opp.hurtBox())) {
            this.hitCount++;
            const last = this.hitCount === HURRICANE.hits;
            opp.receive(this, Math.max(1, Math.round(dmg * HURRICANE.damage / HURRICANE.hits)), match,
                        last ? { hitstun: 26, push: 5, launch: 4 } : { hitstun: 14, push: 1.5 });
          }
        }
        return;
      }
      this.floating = false; this.y = 0; this.vy = 0; this.vx = 0;
      this.facing = opp.x >= this.x ? 1 : -1;
      sfx("land", { x: this.x });
      this.setState("idle");
      return;
    }
    if (sp.effect === "flurry") {
      const k = t - FLURRY.startup;
      if (k >= 0 && k < FLURRY.active) {
        this.vx = this.facing * FLURRY.creep;
        if (k % FLURRY.every === 0) {
          if (k % (FLURRY.every * 2) === 0) sfx("kick_whoosh", { x: this.x });
          if (this.hitCount < FLURRY.hits && overlap(this.worldBox([0, -100, 72, 84]), opp.hurtBox())) {
            this.hitCount++;
            const last = this.hitCount === FLURRY.hits;
            opp.receive(this, Math.max(1, Math.round(dmg * FLURRY.damage / FLURRY.hits)), match,
                        last ? { hitstun: 24, push: 4.5 } : { hitstun: 13, push: 0.6 });
          }
        }
      } else this.vx = 0;
      if (k >= FLURRY.active + FLURRY.recovery) {
        this.facing = opp.x >= this.x ? 1 : -1;
        this.setState("idle");
      }
      return;
    }
    if (sp.effect === "flip") {
      // Crouch, spring straight up in a backflip with the legs sweeping up in front, launching the opponent.
      if (t === FLIP.startup && !this.airborne) { this.vy = FLIP.vy; this.y = 0.01; this.vx = this.facing * FLIP.vx; }
      const air = t - FLIP.startup, airtime = 2 * FLIP.vy / GRAVITY;
      if (air >= 0 && air < airtime * FLIP.hitFor && !this.hasHit &&
          overlap(this.worldBox([-8, -135, 62, 135]), opp.hurtBox())) {
        this.hasHit = true;
        opp.receive(this, dmg, match, { hitstun: 36, push: 3, launch: 7 });
      }
      if (air > 2 && !this.airborne) {
        this.facing = opp.x >= this.x ? 1 : -1;
        this.setState("crouch");  // land in a crouch, then the usual controls take over
      }
      return;
    }
    if (sp.effect === "uppercut") {
      // Leap up and forward, fist (and claws) first, launching the opponent.
      if (t === s.startup && !this.airborne) { this.vy = 6.8; this.y = 0.01; this.vx = this.facing * 1.6; }
      if (t >= s.startup && t < s.startup + s.active + 6 && !this.hasHit &&
          overlap(this.worldBox([-6, -125, 52, 115]), opp.hurtBox())) {
        this.hasHit = true;
        opp.receive(this, dmg, match, { hitstun: 34, push: 3, launch: 6.5 });
      }
      if (t >= s.startup + s.active + s.recovery && !this.airborne) {
        this.facing = opp.x >= this.x ? 1 : -1;
        this.setState("idle");
      }
      return;
    }
    if (sp.effect === "teleport") {
      if (t === s.startup) match.teleport(this, opp);
      if (t >= s.startup && t < s.startup + s.active && !this.hasHit &&
          overlap(this.worldBox([0, -100, 56, 90]), opp.hurtBox())) {
        this.hasHit = true;  // from behind: no chance to block
        opp.receive(this, dmg, match, { hitstun: 28, push: 4, unblockable: true });
      }
    }
    if (t === s.startup) {
      if (sp.effect === "slideshow") match.spawnSlideshow(this, opp, sp);
      if (sp.effect === "rain") match.spawnRain(this, opp, sp);
      if (sp.effect === "bind") match.spawnTape(this, sp);
      if (sp.effect === "abduct") match.spawnAbduct(this, opp, sp);
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
    // Slideshow: keep presenting while the slides are up.
    if (sp.effect === "slideshow" && t > s.startup && t < 400 && match.slideshows.some(a => a.owner === this)) return;
    // Abduct: hold the wand up until the car and plane are done; the wand drives the whole move.
    if (sp.effect === "abduct" && t > s.startup && t < 600 && match.abducts.some(a => a.owner === this)) return;
    if (t >= s.startup + s.active + s.recovery) {
      this.stretch = 0;
      this.facing = opp.x >= this.x ? 1 : -1;
      this.setState(this.airborne ? "jump" : "idle");
    }
  }

  // basic: an ordinary punch or kick; anything else is a special move (for the score).
  receive(attacker, damage, match, { hitstun = 16, push = 2.5, stun = 0, unblockable = false, launch = 0, level = "mid", basic = false } = {}) {
    if (["ko", "victory", "defeat"].includes(this.state) || this.hidden || this.held || this.invuln > 0) return;
    this.lastAttacker = attacker;
    // Hold back to block; hold back and down to block low. Lows must be blocked crouching,
    // attacks from the air standing.
    const low = this.holdingDown;
    const blocking = !unblockable && this.holdingBack && ["idle", "walk", "crouch", "block", "crouch_block"].includes(this.state)
      && !(level === "low" && !low) && !(level === "high" && low);
    const box = this.hurtBox();
    const sparkX = attacker.x < this.x ? box.x + 4 : box.x + box.w - 4;
    if (blocking) {
      attacker.endCombo();  // a blocked hit ends the attacker's combo
      this.health -= damage * (1 - this.stats.block);
      this.setState(low ? "crouch_block" : "block"); this.stunFor = 10;
      this.vx = push * 0.6 * Math.sign(this.x - attacker.x || attacker.facing);
      match.spark(sparkX, box.y + 30, true);
      sfx("block", { x: this.x });
    } else {
      if (!basic && attacker.countedRun !== attacker.specialRun) {  // a special move landed
        attacker.specialsLanded++; attacker.countedRun = attacker.specialRun;
      }
      this.endCombo();  // getting hit ends your own combo
      const chain = attacker.comboHit(match.clock);
      // Deeper in a combo, the victim reels longer before they can act again.
      hitstun = Math.round(hitstun * (1 + Math.min(COMBO.maxStun, COMBO.stunPerHit * (chain - 1))));
      this.health -= damage;
      if (stun) { this.setState("dizzy"); this.stunFor = stun; sfx("dizzy", { x: this.x }); }
      else { this.setState("hit"); this.stunFor = hitstun; }
      this.vx = push * Math.sign(this.x - attacker.x || attacker.facing);
      if (launch || this.airborne) { this.vy = launch || 2.5; this.y = Math.max(this.y, 0.01); }
      if (launch) { this.knocked = true; this.wakeSpent = false; this.knockCount = (this.knockCount || 0) + 1; }  // a chance at the rising uppercut
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

  // Spinning like a top: the airborne frame turns side to side (mirrored every few ticks, as old
  // sprites did it), squeezed narrow as it passes edge-on, with swirling arcs round the kicking leg.
  drawHurricane(ctx, f, img, px, py) {
    const k = this.t - HURRICANE.startup, turn = (k / 10) * Math.PI * 2;  // a full turn every 10 ticks
    const sx = Math.cos(turn), cy = py - Math.round(f.h * 0.55);
    ctx.save();
    // swirl: flattened ellipses round the body at leg height, the near half drawn over the sprite after
    const swirl = front => {
      for (const [r, a] of [[46, 0.5], [38, 0.8]]) {
        ctx.strokeStyle = `rgba(235,248,255,${a})`; ctx.lineWidth = 2;
        ctx.beginPath();
        const start = turn % (Math.PI * 2);
        ctx.ellipse(px, cy + 4, r, 9, 0, front ? start : start + Math.PI, (front ? start : start + Math.PI) + Math.PI * 0.8);
        ctx.stroke();
      }
    };
    swirl(false);
    ctx.translate(px, py);
    ctx.scale((Math.abs(sx) < 0.25 ? 0.25 : Math.abs(sx)) * (sx >= 0 ? 1 : -1) * this.facing, 1);
    ctx.drawImage(img, f.x, f.y, f.w, f.h, -f.ax, -f.ay, f.w, f.h);
    ctx.restore();
    ctx.save(); swirl(true); ctx.restore();
    if (this.shout) drawBubble(ctx, this.shout.text, px, py - f.h - 8);
  }

  // How far through a flip special's backflip this fighter is (0..1), or null when not flipping.
  flipProgress() {
    if (!(this.special?.effect === "flip" && this.state === this.special.id)) return null;
    const air = this.t - FLIP.startup;
    return air < 0 ? null : clamp(air / (2 * FLIP.vy / GRAVITY), 0, 1);
  }

  // The flip frame (drawn upside down) turns a full backward circle about the body's middle:
  // upright at take-off, upside down at the top, upright again on landing; the kicking feet
  // leave a crescent trail.
  drawFlip(ctx, f, img, px, py, p) {
    const R = 52, cy = py - 52;
    const rot = p => Math.PI - 2 * Math.PI * p;  // decreasing: the head goes back, away from the opponent
    const feet = p => rot(p) - Math.PI / 2;      // the feet point "up" in the drawn frame
    ctx.save();
    ctx.translate(px, cy);
    if (this.facing < 0) ctx.scale(-1, 1);
    // The crescent the feet sweep in front of the body, from below through the front to overhead:
    // widest in the middle, a white core, an edge in the fighter's own colors frayed into streaks.
    // It stays drawn after the feet pass the top, then fades.
    const swept = Math.min(p, 0.55), fade = p < 0.55 ? 1 : Math.max(0, 1 - (p - 0.55) / 0.3);
    if (swept > 0.02 && fade > 0) this.drawCrescent(ctx, R + 6, feet(swept), feet(Math.max(0, swept - 0.5)), fade, f, img);
    ctx.rotate(rot(p));
    ctx.drawImage(img, f.x, f.y, f.w, f.h, -Math.round(f.w / 2), -Math.round(f.h / 2), f.w, f.h);
    ctx.restore();
    if (this.shout) drawBubble(ctx, this.shout.text, px, cy - R - 8);
  }

  // A crescent along a circle of radius R from angle a0 back to a1 (a0 < a1: drawn going backwards),
  // thickest in the middle. Its rim takes the fighter's main color from the flip frame (f).
  drawCrescent(ctx, R, a0, a1, alpha, f, img) {
    const rim = this.char.flipColor ??= dominantColor(img, f);
    const N = 28, pts = (width, bias) => {
      const outer = [], inner = [];
      for (let i = 0; i <= N; i++) {
        const u = i / N, a = a0 + (a1 - a0) * u, w = width * Math.sin(Math.PI * Math.min(1, u * 1.15));
        outer.push([Math.cos(a) * (R + w * (0.5 + bias)), Math.sin(a) * (R + w * (0.5 + bias))]);
        inner.push([Math.cos(a) * (R - w * (0.5 - bias)), Math.sin(a) * (R - w * (0.5 - bias))]);
      }
      return [...outer, ...inner.reverse()];
    };
    const fill = (poly, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath(); ctx.fill();
    };
    ctx.save();
    ctx.globalAlpha = alpha;
    const mid = rim.map(v => Math.round(v + (255 - v) * 0.55));
    fill(pts(30, 0.15), `rgba(${rim[0]},${rim[1]},${rim[2]},0.95)`);  // the colored rim
    fill(pts(23, 0.1), `rgba(${mid[0]},${mid[1]},${mid[2]},0.95)`);   // a lighter band
    fill(pts(15, 0.05), "rgba(255,255,255,0.97)");                    // the white core
    // frayed streaks off the outer edge, fixed per angle so they don't flicker
    ctx.strokeStyle = `rgba(${rim[0]},${rim[1]},${rim[2]},0.9)`; ctx.lineWidth = 1.5;
    for (let i = 1; i < N; i += 1) {
      const u = i / N, a = a0 + (a1 - a0) * u, w = 30 * Math.sin(Math.PI * Math.min(1, u * 1.15));
      const r0 = R + w * 0.6, len = 3 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 10 * (w / 30);
      const da = 0.06 * (a1 > a0 ? 1 : -1);  // swept back along the arc, like a brushstroke's tail
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a + da) * (r0 + len), Math.sin(a + da) * (r0 + len));
      ctx.stroke();
    }
    ctx.restore();
  }

  // Speed lines across the kicking zone while the flurry is on.
  drawFlurry(ctx, f, px, py) {
    const k = this.t - FLURRY.startup;
    if (k < 0 || k >= FLURRY.active) return;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    for (let i = 0; i < 4; i++) {
      const r = Math.sin((k + i * 7) * 12.9898) * 43758.5453, u = r - Math.floor(r);  // cheap per-tick jitter
      const y = py - Math.round(f.h * (0.35 + 0.45 * u)), x = 18 + Math.round(u * 20), len = 14 + Math.round(u * 18);
      ctx.fillRect(this.facing > 0 ? px + x : px - x - len, y, len, 1);
    }
  }

  draw(ctx, camX) {
    if (this.hidden || this.held) return;  // riding in a special's vehicle
    const f = this.currentFrame();
    const img = this.char.img;
    const hop = this.bound && this.state === "walk" ? Math.round(Math.max(0, Math.sin(this.t * 0.3)) * 7) : 0;
    const px = Math.round(this.x - camX), py = Math.round(GROUND - this.y) - hop;
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(px, GROUND + 1, Math.max(10, 22 - this.y / 6), 4, 0, 0, Math.PI * 2);
    ctx.fill();

    if (this.floating && this.special?.effect !== "hurricane") {  // soft glow and rising motes under a hovering fighter
      ctx.fillStyle = `rgba(190,230,255,${0.18 + Math.sin(this.t * 0.15) * 0.06})`;
      ctx.beginPath(); ctx.ellipse(px, py + 4, 26, 7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(220,245,255,0.8)";
      for (let i = 0; i < 5; i++) {
        const k = (this.t * 0.7 + i * 9) % 30;
        ctx.fillRect(Math.round(px - 18 + i * 9), Math.round(py + 6 - k), 1, 2);
      }
    }
    if (this.special?.extra_props?.claws && this.state === this.special.id) this.drawClaws(ctx, f, px, py);
    const inSpecial = this.special && this.state === this.special.id;
    if (inSpecial && this.special.effect === "tornado" && this.t >= SPECIAL.startup) this.drawTornado(ctx, px, true);
    for (const [k, gx] of this.ghosts.entries()) {  // afterimages behind a dash
      ctx.save();
      ctx.globalAlpha = 0.35 - k * 0.08;
      ctx.translate(Math.round(gx - camX - this.runDir * (k + 1) * 4), py);
      if (this.facing < 0) ctx.scale(-1, 1);
      ctx.drawImage(img, f.x, f.y, f.w, f.h, -f.ax, -f.ay, f.w, f.h);
      ctx.restore();
    }

    const flipP = this.flipProgress();
    if (flipP !== null) return this.drawFlip(ctx, f, img, px, py, flipP);
    if (this.special?.effect === "hurricane" && this.state === this.special.id && this.t >= HURRICANE.startup) {
      return this.drawHurricane(ctx, f, img, px, py);
    }

    ctx.save();
    ctx.translate(px, py);
    if (this.state === "ko" && !this.airborne && this.char.sheetData.animations.ko === undefined) ctx.rotate(Math.PI / 2);
    if (this.facing < 0) ctx.scale(-1, 1);
    const flash = this.state === "hit" && this.t < 4;
    if (flash) ctx.filter = "brightness(2.2)";
    if (this.state === "dizzy") ctx.translate(Math.sin(this.t / 3) * 2, 0);
    const ext = Math.round(this.stretch);
    if (ext > 0) {
      const cut = f.ax + Math.round((f.w - f.ax) * 0.6);
      ctx.drawImage(img, f.x, f.y, cut, f.h, -f.ax, -f.ay, cut, f.h);
      ctx.drawImage(img, f.x + cut, f.y, 1, f.h, -f.ax + cut, -f.ay, ext, f.h);
      ctx.drawImage(img, f.x + cut, f.y, f.w - cut, f.h, -f.ax + cut + ext, -f.ay, f.w - cut, f.h);
    } else {
      ctx.drawImage(img, f.x, f.y, f.w, f.h, -f.ax, -f.ay, f.w, f.h);
    }
    ctx.restore();

    if (this.bound) drawTape(ctx, px, py, this.hurtBox().w, this.bound);
    if (this.special?.effect === "beam" && this.state === this.special.id) this.drawBeam(ctx, camX, f, px, py);
    if (inSpecial && this.special.effect === "tornado" && this.t >= SPECIAL.startup) this.drawTornado(ctx, px, false);
    if (inSpecial && this.cat) this.drawCat(ctx, camX, py);
    if (inSpecial && this.special.effect === "flurry") this.drawFlurry(ctx, f, px, py);
    const top = py - f.ay;
    if (this.state === "dizzy") (this.sleepy ? drawZzz : drawDizzy)(ctx, px, top - 6, this.t);
    if (this.shout) drawBubble(ctx, this.shout.text, px, top - 8, camX);
  }
}

function drawStar(ctx, x, y, r, rot, color, alpha) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.translate(Math.round(x), Math.round(y)); ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r, a = i * Math.PI / 5 - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function drawZzz(ctx, x, y, t) {
  ctx.font = `8px ${FONT}`; ctx.textAlign = "center";
  for (let i = 0; i < 3; i++) {
    const k = (t * 0.5 + i * 12) % 36;
    ctx.globalAlpha = 1 - k / 36;
    outlinedText(ctx, "Z", Math.round(x + 6 + k * 0.5 + i * 2), Math.round(y - k), "#cfe3ff");
  }
  ctx.globalAlpha = 1;
}

// A tumbling dollar bill (flat when edge-on) or a glinting coin.
function drawCash(ctx, x, y, bill, spin) {
  if (bill) {
    const flat = Math.sin(spin) > 0;
    ctx.fillStyle = "#14401d"; ctx.fillRect(x - 6, y - (flat ? 3 : 1), 12, flat ? 6 : 2);
    if (flat) {
      ctx.fillStyle = "#7fcf7a"; ctx.fillRect(x - 5, y - 2, 10, 4);
      ctx.fillStyle = "#2f7a3a"; ctx.fillRect(x - 1, y - 1, 2, 2);  // the portrait oval
    } else { ctx.fillStyle = "#7fcf7a"; ctx.fillRect(x - 5, y - 1, 10, 1); }
  } else {
    ctx.fillStyle = "#6a4e08"; ctx.fillRect(x - 2, y - 2, 4, 4);
    ctx.fillStyle = Math.sin(spin * 1.6) > 0 ? "#ffe066" : "#d9a520"; ctx.fillRect(x - 2, y - 2, 3, 3);
  }
}

function drawTape(ctx, x, feetY, bodyW, left) {
  const w = Math.max(16, Math.round(bodyW * 0.55));
  if (left < 40 && left % 8 < 4) return;  // flicker as it comes loose
  for (const [dy, tilt] of [[-7, 1], [-15, -1], [-23, 1]]) {
    ctx.save();
    ctx.translate(x, feetY + dy);
    ctx.rotate(tilt * 0.12);
    ctx.fillStyle = "#222"; ctx.fillRect(-w / 2 - 1, -3, w + 2, 7);
    ctx.fillStyle = "#b8bcc2"; ctx.fillRect(-w / 2, -2, w, 5);
    ctx.fillStyle = "#e6e8ea"; ctx.fillRect(-w / 2, -2, w, 1);
    ctx.restore();
  }
  ctx.fillStyle = "#b8bcc2"; ctx.fillRect(x + w / 2 - 2, feetY - 9, 6, 3);  // loose end
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
  // kept below the health bars and names at the top of the screen
  const bx = clamp(Math.round(x - w / 2), 2, W - w - 2), by = Math.max(38, Math.round(bottom - h - 6));
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
  ctx.fillRect(bx, by, w, h); ctx.strokeRect(bx, by, w, h);
  ctx.beginPath(); ctx.moveTo(x - 4, by + h); ctx.lineTo(x, by + h + 6); ctx.lineTo(x + 4, by + h); ctx.fill();
  ctx.fillStyle = "#000"; ctx.textAlign = "left";
  lines.forEach((l, i) => ctx.fillText(l, bx + 5, by + 12 + i * 10));
}

// ---------------------------------------------------------------- input

// The arrow keys work the same as W A S D.
const ARROW_KEYS = { ArrowUp: "w", ArrowLeft: "a", ArrowDown: "s", ArrowRight: "d" };
const keyName = e => ARROW_KEYS[e.key] || e.key.toLowerCase();

// Two opposite directions held at once: the one pressed last wins, rather than cancelling out. With
// cancelling, a key whose release the browser never delivered (or a controller stick reading as
// pushed) left the player stuck: the opposite direction just added up to standing still.
function axis(keys, pos, neg, last) {
  const p = keys.has(pos), n = keys.has(neg);
  return p && n ? (last === neg ? -1 : 1) : (p ? 1 : 0) - (n ? 1 : 0);
}

class PlayerInput {
  constructor() {
    this.keys = new Set();
    this.buffer = [];        // recent {token, time} for special-move sequences
    this.pending = null;     // {attack|special, expires}
    this.onKeyDown = e => {
      const k = keyName(e);
      if (ARROW_KEYS[e.key]) e.preventDefault();  // don't scroll the page mid-fight
      if (k.length !== 1) return;
      if (ATTACK_KEYS[k]) {               // J punch, K kick (same tokens as the mouse buttons)
        if (!e.repeat) this.attack(ATTACK_KEYS[k]);
        return;
      }
      if (!"wasd".includes(k)) return;
      if (!e.repeat) this.push(this.relative(k.toUpperCase()));
      if (!e.repeat && (k === "a" || k === "d")) this.lastH = k;
      this.keys.add(k);
    };
    this.onKeyUp = e => this.keys.delete(keyName(e));
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
    if (token === "LMB" && this.isBreaker()) {
      this.pending = { breaker: true, expires: performance.now() + 250 };
      this.buffer = [];
      return;
    }
    const sp = this.matchSpecial();
    this.pending = sp ? { special: sp, expires: performance.now() + 150 }
                      : { attack: token === "LMB" ? "punch" : "kick", expires: performance.now() + 150 };
  }

  push(token) {
    const now = performance.now();
    this.buffer.push({ token, time: now });
    this.buffer = this.buffer.filter(b => now - b.time < 2000).slice(-10);
  }

  // Combo breaker: S, S, W, then W and punch together (W pressed just before the punch, or held).
  isBreaker() {
    const b = this.buffer, n = b.length, now = performance.now();
    if (n < 4 || b[n - 1].token !== "LMB") return false;
    const i = n - 2;
    if (b[i].token !== "W" || !(now - b[i].time < 200 || this.keys.has("w"))) return false;
    const tokens = (from, to) => b.slice(from, to).map(x => x.token).join("");
    // S, S, W, W+punch
    if (i >= 3 && tokens(i - 3, i) === "SSW" && b[i].time - b[i - 3].time < SEQ_GAP * 3) return true;
    // or S, S, W held down through the punch
    return i >= 2 && tokens(i - 2, i + 1) === "SSW" && this.keys.has("w") && b[i].time - b[i - 2].time < SEQ_GAP * 2;
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
    const input = { move: axis(k, "d", "a", this.lastH), jump: k.has("w"), crouch: k.has("s") };
    if (this.pending && performance.now() > this.pending.expires) this.pending = null;
    return input;
  }

  // Called after the fighter has seen the input, so a buffered press survives until it can act.
  consume(fighter) {
    if (!this.pending) return {};
    // Punch just as you land after a launch: the rising uppercut (too early wastes it).
    if (this.pending.attack === "punch" && (fighter.knocked || fighter.wakeWindow())) {
      this.pending = null;
      return fighter.tryWake() ? { wakeup: true } : {};
    }
    if (this.pending.breaker) {  // usable mid-combo, when nothing else is
      if (fighter.canBreak()) { this.pending = null; return { breaker: true }; }
      if (fighter.canAct) { this.pending = null; return { attack: "punch" }; }  // not being comboed: W + punch, an uppercut
      return {};
    }
    if (!fighter.canAct || (this.pending.special && !fighter.specialReady(this.pending.special))) return {};
    const p = this.pending; this.pending = null;
    return p.special ? { special: p.special } : { attack: p.attack };
  }
}

// ---------------------------------------------------------------- AI

// Opponent difficulty. easy is the original AI. block, special, breaker: multipliers on how often it
// blocks, uses specials and combo-breaks; think: on its pauses between moves; aggression: added to
// the trait; chain: chance an attack is followed straight into another (2-3 hit strings);
// damage: on its punch, kick and special damage. The score bonus for each is in server.py.
const DIFFICULTY = {
  easy:   { label: "EASY",   block: 1,   think: 1,    aggression: 0,    special: 1,   breaker: 1, chain: 0,    damage: 1 },
  medium: { label: "MEDIUM", block: 1.3, think: 0.6,  aggression: 0.15, special: 1.3, breaker: 2, chain: 0.35, damage: 1.15 },
  hard:   { label: "HARD",   block: 1.6, think: 0.35, aggression: 0.3,  special: 1.6, breaker: 4, chain: 0.65, damage: 1.3 },
};

class AI {
  // Uses the character's trait weights (0..1): punch, kick, jump, block, special, aggression, mobility,
  // adjusted for the difficulty level.
  constructor(fighter, level = "easy") {
    this.f = fighter;
    this.lv = DIFFICULTY[level] || DIFFICULTY.easy;
    const tr = fighter.char.ai;
    this.tr = { ...tr, aggression: Math.min(1, tr.aggression + this.lv.aggression),
                special: Math.min(1, tr.special * this.lv.special) };
    this.queue = [];
  }

  input(opp) {
    const f = this.f, tr = this.tr;
    // Combo breaker: short combos rarely, longer ones more and more likely (and more so for
    // fighters with a high block trait).
    if (f.canBreak() && opp.combo >= 3 &&
        Math.random() < (0.002 + 0.006 * tr.block) * (opp.combo - 2) * this.lv.breaker) return { breaker: true };
    // Rising uppercut: one try per launch, as it nears the ground, more often on harder levels.
    if (f.knocked && f.vy < 0 && f.y < WAKEUP.height && this.wakeRoll !== f.landedAt + ":" + f.knockCount) {
      this.wakeRoll = f.landedAt + ":" + f.knockCount;
      if (Math.random() < 0.12 * this.lv.breaker ** 0.7) return { wakeup: true };
    }
    const toward = opp.x >= f.x ? 1 : -1;
    const dist = Math.abs(opp.x - f.x);

    // React to an attack in progress: block with probability from the block trait, low against
    // sweeps and standing against attacks from the air (usually; reads are sometimes wrong).
    const threatened = (opp.attacking && dist < 95 && opp.t < 4) || this.incoming;
    if (threatened && !this.blockRolled) {
      this.blockRolled = true;
      if (Math.random() < Math.min(0.95, tr.block * 0.75 * this.lv.block)) {
        const level = ATTACKS[opp.state]?.level || "mid";
        const low = level === "low" ? Math.random() < 0.85 : level === "high" ? Math.random() < 0.15 : Math.random() < 0.4;
        this.queue = [{ in: { move: -toward, crouch: low }, ticks: 22 }];
      }
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

    const specials = f.char.specials.filter(s => f.specialReady(s));
    const ranged = specials.filter(s => ["projectile", "beam", "audit", "orbital", "bind", "slideshow", "rain", "dash", "tornado", "cat", "stun", "charge", "abduct", "stretch", "teleport"].includes(s.effect));
    const close = specials.filter(s => ["melee", "flurry", "flip", "hurricane", "uppercut", "orbital", "bind", "float", "slideshow", "rain", "dash", "tornado", "area", "stun", "charge", "abduct", "teleport"].includes(s.effect));
    const think = Math.round(rand(6, 22) * (1.3 - tr.aggression) * this.lv.think);
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
        { v: "punch", w: tr.punch * 1.1 },
        { v: "kick", w: tr.kick * 1.1 },
        { v: "lowpunch", w: tr.punch * 0.5 },
        { v: "uppercut", w: tr.punch * 0.35 },
        { v: "sweep", w: tr.kick * 0.5 },
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
               Math.random() < 0.3 ? { in: { crouch: true, attack: "kick" }, ticks: 1 }   // dive kick
                                   : { in: { attack: Math.random() < tr.kick ? "kick" : "punch" }, ticks: 1 }],
      jumpback: [{ in: { move: "away", jump: true }, ticks: 1 }],
      punch: [{ in: { attack: "punch" }, ticks: 1 }, { in: {}, ticks: think }],
      kick: [{ in: { attack: "kick" }, ticks: 1 }, { in: {}, ticks: think }],
      uppercut: [{ in: { jump: true, attack: "punch" }, ticks: 1 }, { in: {}, ticks: think }],
      lowpunch: [{ in: { crouch: true }, ticks: 2 }, { in: { crouch: true, attack: "punch" }, ticks: 1 },
                 { in: { crouch: true }, ticks: think }],
      sweep: [{ in: { crouch: true }, ticks: 2 }, { in: { crouch: true, attack: "kick" }, ticks: 1 },
              { in: {}, ticks: think }],
      ranged: [{ in: { special: pick(ranged) }, ticks: 1 }, { in: {}, ticks: 20 }],
      close: [{ in: { special: pick(close) }, ticks: 1 }, { in: {}, ticks: 20 }],
    };
    // Harder levels follow a landed-range attack straight into another, as a string (each waits for
    // the previous one to finish, then goes inside the combo window).
    if (["punch", "kick", "lowpunch"].includes(action)) {
      for (let n = 0; n < 2 && Math.random() < this.lv.chain; n++) {
        const last = plans[action].pop(), prev = action === "kick" ? ATTACKS.kick : ATTACKS.punch;
        const next = Math.random() < tr.kick ? "kick" : "punch";
        plans[action].push({ in: { crouch: action === "lowpunch" }, ticks: prev.startup + prev.active + prev.recovery + 1 },
                           { in: { attack: next, crouch: action === "lowpunch" }, ticks: 1 }, last);
      }
    }
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
    if (src && this.audio && this.src === src) return;  // already playing it: keep going
    this.stop();
    if (!src) return;
    this.src = src;
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
    this.src = null;
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

// A fighter's sprite sheet recolored for a mirror match, the way old fighting games gave the second
// player another palette: clothes and everything else swing round the color wheel, while skin and
// hair tones (reds through yellow-browns) stay as they are. Cached on the character.
function mirrorColors(char) {
  if (char.mirrorImg) return char.mirrorImg;
  const src = char.img, c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height), px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d < 0.04) {  // greys, black and white: a little darker and warmer, so a grey suit still changes
      px[i] = Math.min(255, px[i] * 0.95 + 14); px[i + 1] *= 0.82; px[i + 2] *= 0.82;
      continue;
    }
    const sat = d / (1 - Math.abs(2 * l - 1));
    let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
    if (hue < 50 && r > b) continue;  // skin, hair, wood: keep
    hue = (hue + 150) % 360;
    const k = n => { const a = (n + hue / 30) % 12; return l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(a - 3, 9 - a, 1)); };
    px[i] = k(0) * 255; px[i + 1] = k(8) * 255; px[i + 2] = k(4) * 255;
  }
  ctx.putImageData(data, 0, 0);
  return (char.mirrorImg = c);
}

class Match {
  // rounds: rounds to win the match; 1 for a campaign's mini boss (a draw is fought again).
  // From a campaign street (static/brawl.js), the first round can also start where the two walked
  // to (starts: [player x, opponent x] on the stage) and with the player's health from the street.
  // stage: draws the ground instead of arenaImg, {back(ctx, camX), front(ctx, camX)} (front: in
  // front of the fighters); a campaign's mini boss is fought on the street itself this way.
  constructor({ player, opponent, arena, arenaImg, onEnd, difficulty = "easy", rounds = ROUNDS_TO_WIN,
                starts = null, health = null, stage = null }) {
    this.canvas = $("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.arena = arena; this.arenaImg = arenaImg; this.stage = stage;
    // The arena image's edges are the stage's hard edges. The server builds arenas at least
    // screen-wide; an older, narrower one is stretched to fill the screen rather than leaving
    // black space fighters could walk into.
    this.arenaW = Math.max(W, arenaImg.width);
    this.stageWidth = this.arenaW;
    // A mirror match (a campaign mini boss who is the player's own fighter): the opponent wears
    // other colors, so you can tell them apart.
    if (opponent.slug === player.slug) opponent = { ...opponent, img: mirrorColors(opponent) };
    this.p1 = new Fighter(player, true);
    this.p2 = new Fighter(opponent, false);
    const lv = DIFFICULTY[difficulty] || DIFFICULTY.easy;
    if (lv.damage !== 1) {  // its own copy: the character's stats are shared
      const st = this.p2.stats;
      this.p2.stats = { ...st, punch_damage: st.punch_damage * lv.damage, kick_damage: st.kick_damage * lv.damage,
                        special_damage: st.special_damage * lv.damage };
    }
    this.input = new PlayerInput();
    this.ai = new AI(this.p2, difficulty);
    this.onEnd = onEnd;
    this.roundsToWin = rounds;
    this.starts = starts; this.startHealth = health;
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
    const mid = this.stageWidth / 2, [x1, x2] = this.round === 1 && this.starts || [mid - 70, mid + 70];
    this.p1.reset(x1, 1);
    this.p2.reset(x2, -1);
    if (this.round === 1 && this.startHealth != null) {  // no healing on the way in
      this.p1.health = this.p1.trail = clamp(this.startHealth, 1, this.p1.stats.health);
    }
    this.projectiles = []; this.drops = []; this.sparks = []; this.charges = []; this.abducts = []; this.puffs = []; this.glitter = []; this.tapes = []; this.slideshows = []; this.rains = []; this.audits = []; this.orbitals = [];
    this.stars = []; this.breakerBanner = null; this.flash = 0;
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
    // During a combo breaker's slow-motion leap each game tick takes longer in real time.
    let step;
    while (this.acc >= (step = this.slowmo > 0 ? TICK / BREAKER.slowSpeed : TICK)) {
      if (!this.paused) { this.update(); if (this.slowmo > 0) this.slowmo--; }
      this.acc -= step;
    }
    this.draw();
    requestAnimationFrame(this.frame.bind(this));
  }

  update() {
    this.phaseT++;
    this.clock = (this.clock || 0) + 1;
    for (const f of [this.p1, this.p2]) {
      if (f.combo && this.clock - f.comboLast > COMBO.window) f.endCombo();
      if (f.comboShow && ++f.comboShow.t > (f.comboShow.done ? 80 : 999)) f.comboShow = null;
    }
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
    this.updateCharges();
    this.updateAbducts();
    this.updateTapes();
    this.updateAudits();
    this.updateOrbitals();
    for (const s of this.stars) { s.t++; s.x += s.vx; s.y += s.vy; s.vy += 0.12; s.spin += 0.2; }
    this.stars = this.stars.filter(s => s.t < 60 && s.y < GROUND + 10);
    if (this.flash > 0) this.flash--;
    if (this.breakerBanner && ++this.breakerBanner.t > 110) this.breakerBanner = null;
    this.updateSlideshows();
    this.updateRains();
    this.puffs = this.puffs.filter(p => ++p.t < 30);
    for (const g of this.glitter) { g.x += g.vx; g.y += g.vy; g.vy += 0.03; }
    this.glitter = this.glitter.filter(g => ++g.t < 26);
    this.separate();
    for (const f of [p1, p2]) f.trail = Math.max(f.health, f.trail - 0.35);
    this.sparks = this.sparks.filter(s => ++s.t < 12);
    if (this.shake > 0) this.shake--;
    this.ai.incoming = this.projectiles.some(p => p.owner === p1 && Math.abs(p.x - p2.x) < 90);

    switch (this.phase) {
      case "intro":
        // A one-round fight (a campaign's mini boss) is just a fight: no round number, no round call.
        const single = this.roundsToWin === 1;
        this.banner = this.phaseT < 80 ? (single ? "GET READY" : `ROUND ${this.round}`) : "FIGHT!";
        if (this.phaseT === 1) sfx("round");
        if (this.phaseT === 20 && !single) sfx(this.round === MAX_ROUNDS || (this.p1.rounds === this.roundsToWin - 1 &&
          this.p2.rounds === this.roundsToWin - 1) ? "vo_final_round" : `vo_round_${this.round}`);
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
          const done = this.p1.rounds >= this.roundsToWin || this.p2.rounds >= this.roundsToWin || this.round >= MAX_ROUNDS;
          if (done) this.finish(false); else this.nextRound();
        }
        break;
    }
  }

  endRound(reason) {
    const { p1, p2 } = this;
    p1.endCombo(); p2.endCombo();
    this.phase = "roundEnd"; this.phaseT = 0; this.banner = reason;
    this.projectiles = []; this.drops = [];
    for (const c of this.charges) if (!c.dropped) this.dropOff(c);  // the vehicle keeps driving off
    this.tapes = []; this.slideshows = []; this.rains = []; this.audits = []; this.orbitals = [];
    for (const f of [p1, p2]) f.bound = 0;
    for (const a of this.abducts) if (a.target.held) { a.target.held = false; a.target.y = 0; a.target.setState("idle"); }
    this.abducts = [];
    let winner = null;
    const r1 = p1.health / p1.stats.health, r2 = p2.health / p2.stats.health;
    if (r1 > r2) winner = p1; else if (r2 > r1) winner = p2;
    this.roundWinner = winner;
    if (winner) winner.roundHealth.push(Math.max(1, Math.round(winner.health)));
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
      round_health: this.p1.roundHealth,         // health left after each round the player won
      specials_landed: this.p1.specialsLanded,
      combos: (this.p1.endCombo(), this.p1.combos),  // lengths of the player's 2+ hit combos
      breakers: this.p1.breakers,
      duration: Math.max(3, Math.round(this.totalTicks / 60)),
      rounds: [this.p1.rounds, this.p2.rounds],
    });
  }

  resolveHits(a, d) {
    const atk = ATTACKS[a.state];
    if (!atk || a.hasHit) return;
    if (d.floating && !atk.air) return;  // ground attacks pass under a floating fighter
    if (a.t < atk.startup || a.t >= atk.startup + atk.active) return;
    if (overlap(atk.box ? a.worldBox(atk.box) : a.hitBox(), d.hurtBox())) {
      a.hasHit = true;
      d.receive(a, atk.damage(a.stats), this, { hitstun: atk.hitstun, push: atk.push, level: atk.level, launch: atk.launch || 0,
                                                unblockable: !!atk.unblockable, basic: !atk.unblockable });
      if (a.state === "dive_kick") { a.vy = 3.6; a.vx = -a.facing * 1.8; }  // bounce off
    }
  }

  separate() {
    const { p1, p2 } = this;
    if (p1.passThrough || p2.passThrough) return;  // dashing through the opponent
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
      // origin: [forward, up] from the feet where the shot leaves (character.json), e.g. a shoulder cannon
      x: owner.x + owner.facing * (sp.origin ? sp.origin[0] : 30), y: GROUND - owner.y + (sp.origin ? sp.origin[1] : -70),
      vx: 4 * owner.facing, vy: 0,
    });
    // A shot fired from above the opponent's head (a giant's shoulder cannon) angles down to their
    // chest, aimed as it's fired: crouching afterwards still ducks it.
    const p = this.projectiles[this.projectiles.length - 1], target = owner === this.p1 ? this.p2 : this.p1;
    const hb = target.hurtBox(), dx = Math.abs(target.x - p.x);
    if (p.y < hb.y + 10 && dx > 20) p.vy = clamp((hb.y + hb.h * 0.3 - p.y) / (dx / Math.abs(p.vx)), 0, 1.5);
    sfx("throw", { x: owner.x });
  }

  updateProjectiles() {
    for (const p of this.projectiles) {
      p.x += p.vx; p.y += p.vy || 0; p.angle += 0.15;
      const target = p.owner === this.p1 ? this.p2 : this.p1;
      const box = { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h };
      if (!p.done && overlap(box, target.hurtBox())) {
        p.done = true;
        target.receive(p.owner, p.owner.stats.special_damage, this, { hitstun: 24, push: 4 });
      }
    }
    this.projectiles = this.projectiles.filter(p => !p.done && p.x > -60 && p.x < this.stageWidth + 60);
  }

  camX() {
    return clamp(Math.round((this.p1.x + this.p2.x) / 2 - W / 2), 0, this.stageWidth - W);
  }

  // Charge specials: the prop (a van, a stampede...) drives in from off screen behind the owner,
  // picks them up, runs across the whole screen over the opponent, and drops the owner off past them.
  spawnCharge(owner, target, sp) {
    const img = owner.char.props[sp.id];
    const h = img ? img.height : 90, w = img ? img.width : 160;
    const dir = owner.facing, camX = this.camX();
    this.charges.push({
      owner, target, sp, img, w, h, dir, v: 5, picked: false, dropped: false, hit: false,
      x: dir > 0 ? Math.min(camX - w / 2, owner.x - w) : Math.max(camX + W + w / 2, owner.x + w),  // off screen
      dropX: clamp(target.x + dir * 70, 18, this.stageWidth - 18),
    });
    sfx("throw", { x: owner.x });
  }

  dropOff(c) {
    const o = c.owner;
    c.dropped = true;
    o.hidden = false;
    if (o.state.startsWith("special")) {
      o.x = c.dropX; o.y = 0; o.vx = 0; o.vy = 0;
      o.facing = c.target.x >= o.x ? 1 : -1;
      o.setState("idle");
    }
  }

  updateCharges() {
    for (const c of this.charges) {
      c.v = Math.min(c.v + 0.7, 13);
      c.x += c.v * c.dir;
      const o = c.owner, past = x => (c.x - x) * c.dir >= 0;
      if (!c.picked && past(o.x)) { c.picked = true; o.hidden = true; o.vx = 0; }
      if (!c.hit && this.phase === "fight") {
        const box = { x: c.x - c.w / 2, y: GROUND - c.h, w: c.w, h: c.h };
        if (overlap(box, c.target.hurtBox())) {
          c.hit = true;
          c.target.receive(o, o.stats.special_damage, this, { hitstun: 34, push: 6, launch: 5 });
          sfx("slam", { x: c.target.x });
          this.shake = 10;
        }
      }
      if (c.picked && !c.dropped && past(c.dropX)) this.dropOff(c);
    }
    const camX = this.camX();
    this.charges = this.charges.filter(c => !c.dropped ||
      (c.dir > 0 ? c.x - c.w / 2 < camX + W + 20 : c.x + c.w / 2 > camX - 20));
  }

  // Teleport specials: vanish in a burst of particles and reappear on the far side of the opponent.
  teleport(f, opp) {
    const side = Math.sign(opp.x - f.x) || f.facing;
    this.puffs.push({ x: f.x, y: GROUND - f.y - 50, t: 0 });
    f.x = clamp(opp.x + side * 44, 18, this.stageWidth - 18);
    f.y = 0; f.vx = 0; f.vy = 0;
    f.facing = opp.x >= f.x ? 1 : -1;
    this.puffs.push({ x: f.x, y: GROUND - 50, t: 0 });
    sfx("special", { x: f.x });
  }

  // Abduct specials: a car (prop "<id>_car") drives in and grabs the opponent off the ground, then
  // a plane (prop "<id>_plane") flies over and drops them from the sky for heavy damage.
  spawnAbduct(owner, target, sp) {
    const car = owner.char.props[`${sp.id}_car`], plane = owner.char.props[`${sp.id}_plane`];
    const dir = owner.facing, camX = this.camX();
    const cw = car ? car.width : 150;
    this.abducts.push({
      owner, target, sp, car, plane, dir, phase: "car", v: 4, t: 0,
      x: dir > 0 ? Math.min(camX - cw / 2, owner.x - cw) : Math.max(camX + W + cw / 2, owner.x + cw),
    });
    sfx("throw", { x: owner.x });
  }

  // Magic glitter streaming from the wand to the vehicle it's steering, and trailing behind it.
  sprinkle(a) {
    const img = a.phase === "car" ? a.car : a.plane;
    const w = img ? img.width : 150, h = img ? img.height : 60;
    const vy = a.phase === "car" ? GROUND - h / 2 : 34 + h / 2;
    const tip = a.owner.state.startsWith("special") ? a.owner.wandTip() : null;
    for (let i = 0; i < 8; i++) {
      if (tip) {
        const u = Math.random();
        this.glitter.push({ x: tip.x + (a.x - tip.x) * u + rand(-4, 4), y: tip.y + (vy - tip.y) * u + rand(-4, 4),
                            vx: rand(-0.3, 0.3), vy: rand(-0.4, 0.2), t: 0 });
      }
      this.glitter.push({ x: a.x - a.dir * (w / 2 + rand(0, 20)), y: vy + rand(-h / 2, h / 2),
                          vx: -a.dir * rand(0.2, 1), vy: rand(-0.3, 0.3), t: 0 });
    }
  }

  updateAbducts() {
    const camX = this.camX();
    for (const a of this.abducts) {
      a.t++;
      const tg = a.target;
      if (a.phase !== "wait") this.sprinkle(a);
      if (a.phase === "car") {
        const w = a.car ? a.car.width : 150, h = a.car ? a.car.height : 70;
        a.v = Math.min(a.v + 0.6, 11);
        a.x += a.v * a.dir;
        if (!a.grabbed && this.phase === "fight" && tg.y < 30 &&
            overlap({ x: a.x - w / 2, y: GROUND - h, w, h }, tg.hurtBox())) {
          a.grabbed = true; tg.held = true; tg.vx = 0; tg.vy = 0;
          sfx("hit_heavy", { x: tg.x });
        }
        const gone = a.dir > 0 ? a.x - w / 2 > camX + W : a.x + w / 2 < camX;
        if (gone) {
          if (!a.grabbed) { a.done = true; continue; }  // missed (they jumped): no plane
          a.phase = "wait"; a.t = 0;
        }
      } else if (a.phase === "wait" && a.t > 40) {
        const pw = a.plane ? a.plane.width : 180;
        a.phase = "plane"; a.t = 0;
        a.x = a.dir > 0 ? camX - pw / 2 : camX + W + pw / 2;
        a.dropX = tg.x;
        sfx("special", { x: tg.x });
      } else if (a.phase === "plane") {
        const pw = a.plane ? a.plane.width : 180;
        a.x += 6 * a.dir;
        if (tg.held && (a.x - a.dropX) * a.dir >= 0) {
          tg.held = false; tg.x = clamp(a.x, 18, this.stageWidth - 18);
          tg.y = 85; tg.vy = 0; tg.vx = 0;  // just under the plane
          tg.setState("hit"); tg.stunFor = 999;  // tumble until landing
          a.falling = true;
        }
        if (a.falling && tg.y <= 0) {
          a.falling = false;
          tg.setState("idle");  // so receive() starts a fresh hit
          tg.receive(a.owner, a.owner.stats.special_damage * 1.6, this, { hitstun: 40, push: 1, unblockable: true });
          sfx("slam", { x: tg.x });
          this.shake = 14;
        }
        if (!tg.held && !a.falling && (a.dir > 0 ? a.x - pw / 2 > camX + W : a.x + pw / 2 < camX)) a.done = true;
      }
    }
    this.abducts = this.abducts.filter(a => !a.done);
  }

  drawVehicle(ctx, a, img, top, camX) {
    const w = img ? img.width : 150, h = img ? img.height : 60;
    ctx.save();
    ctx.translate(Math.round(a.x - camX), top ?? GROUND - h + 2);
    if (a.dir < 0) ctx.scale(-1, 1);  // props are drawn facing right
    if (img) ctx.drawImage(img, -w / 2, 0);
    else { ctx.fillStyle = "#ddd"; ctx.fillRect(-w / 2, 0, w, h); }
    ctx.restore();
  }

  // Slideshow specials: a giant projected presentation fills the screen; the opponent, unless
  // blocking, is bored stiff (a sleepy stun).
  spawnSlideshow(owner, target, sp) {
    this.slideshows.push({ owner, target, sp, t: 0, slide: 3 + Math.floor(Math.random() * 9), total: 180 + Math.floor(Math.random() * 300) });
    sfx("special", { x: owner.x });
  }

  updateSlideshows() {
    for (const s of this.slideshows) {
      s.t++;
      if (s.t % 22 === 0) s.slide++;
      if (s.t === 30 && this.phase === "fight") {
        s.target.receive(s.owner, s.owner.stats.special_damage * 0.5, this, { stun: STUN_TICKS, push: 0 });
        if (s.target.state === "dizzy") { s.target.sleepy = true; s.target.shout = { text: "zzz...", t: 70 }; }
      }
      if (s.t > 100 || s.owner.state !== s.sp.id) s.done = true;
    }
    this.slideshows = this.slideshows.filter(s => !s.done);
  }

  drawSlideshows(ctx) {
    for (const s of this.slideshows) {
      const a = Math.min(1, s.t / 8, (100 - s.t) / 8);
      const x = 46, y = 34, w = W - 92, h = 112, seed = s.slide * 7;
      ctx.globalAlpha = a * 0.92;
      ctx.fillStyle = "#1a1a24"; ctx.fillRect(x - 3, y - 3, w + 6, h + 6);   // screen frame
      ctx.fillStyle = "#f6f7fb"; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#2b4c9a"; ctx.fillRect(x, y, w, 14);                   // title bar
      ctx.font = `6px ${FONT}`; ctx.textAlign = "left"; ctx.fillStyle = "#fff";
      const titles = ["Q3 SYNERGY METRICS", "APPENDIX F (CONT.)", "KPI DEEP DIVE", "LESSONS LEARNED", "BUDGET VARIANCE"];
      ctx.fillText(titles[s.slide % titles.length], x + 5, y + 10);
      // a bar chart and some bullet points, different every slide
      for (let i = 0; i < 7; i++) {
        const bh = 12 + ((seed * (i + 3) * 37) % 50);
        ctx.fillStyle = ["#4a7bd8", "#e0763a", "#46a86a"][i % 3];
        ctx.fillRect(x + 10 + i * 13, y + h - 12 - bh, 9, bh);
      }
      ctx.fillStyle = "#555"; ctx.fillRect(x + 8, y + h - 11, 96, 1);
      ctx.fillStyle = "#333";
      for (let i = 0; i < 6; i++) {
        ctx.fillRect(x + 118, y + 24 + i * 13, 3, 3);
        ctx.fillRect(x + 125, y + 25 + i * 13, 60 + ((seed + i * 29) % 90), 1);
      }
      ctx.fillStyle = "#777"; ctx.textAlign = "right";
      ctx.fillText(`${s.slide} / ${s.total}`, x + w - 4, y + h - 4);
      // the laser pointer wandering over it
      const lx = x + w / 2 + Math.sin(s.t * 0.13) * w * 0.4, ly = y + h / 2 + Math.sin(s.t * 0.21) * h * 0.35;
      ctx.fillStyle = "rgba(255,0,0,0.35)"; ctx.fillRect(Math.round(lx) - 2, Math.round(ly) - 2, 5, 5);
      ctx.fillStyle = "#ff2020"; ctx.fillRect(Math.round(lx) - 1, Math.round(ly) - 1, 3, 3);
      ctx.globalAlpha = 1;
    }
  }

  // Rain specials: the prop (a cup) is tossed off the top of the screen, bursts, and its contents
  // rain down over the whole screen, hurting the opponent (block standing; it comes from above).
  spawnRain(owner, target, sp) {
    this.rains.push({ owner, target, sp, img: owner.char.props[sp.id], t: 0, drops: [], hits: 0, lastHit: -99,
                      cupX: owner.x + owner.facing * 10, cupY: GROUND - 120 });
    sfx("throw", { x: owner.x });
  }

  updateRains() {
    const camX = this.camX();
    for (const r of this.rains) {
      r.t++;
      if (r.t < 24) r.cupY -= 7;  // the cup flies up out of view
      const raining = r.t >= 34 && r.t < 120;
      if (raining) for (let i = 0; i < 9; i++) {
        r.drops.push({ x: camX + Math.random() * W, y: -Math.random() * 20, vy: 4.5 + Math.random() * 3, len: 5 + Math.floor(Math.random() * 6) });
      }
      for (const d of r.drops) d.y += d.vy;
      r.drops = r.drops.filter(d => d.y < GROUND);
      const box = r.target.hurtBox();
      if (raining && this.phase === "fight" && r.hits < 4 && r.t - r.lastHit > 16 &&
          r.drops.some(d => d.x >= box.x && d.x <= box.x + box.w && d.y >= box.y && d.y <= box.y + 12)) {
        r.hits++; r.lastHit = r.t;
        r.target.receive(r.owner, r.owner.stats.special_damage * 0.4, this, { hitstun: 12, push: 0.5, level: "high" });
      }
      if (r.t >= 120 && !r.drops.length) r.done = true;
    }
    this.rains = this.rains.filter(r => !r.done);
  }

  drawRains(ctx, camX) {
    for (const r of this.rains) {
      if (r.t < 24 && r.img) {  // tossed cup going up
        ctx.save(); ctx.translate(Math.round(r.cupX - camX), Math.round(r.cupY)); ctx.rotate(r.t * 0.4);
        ctx.drawImage(r.img, -r.img.width / 2, -r.img.height / 2); ctx.restore();
      }
      if (r.t >= 30 && r.t < 50 && r.img) {  // it bursts at the top of the screen
        const k = (r.t - 30) / 20, sz = 1 + k * 1.5;
        ctx.globalAlpha = 1 - k;
        ctx.drawImage(r.img, W / 2 - r.img.width * sz / 2, 6, r.img.width * sz, r.img.height * sz);
        ctx.globalAlpha = 1;
      }
      for (const d of r.drops) {
        const x = Math.round(d.x - camX), y = Math.round(d.y);
        ctx.fillStyle = "#2a1408"; ctx.fillRect(x - 1, y, 3, d.len + 1);
        ctx.fillStyle = "#8a5228"; ctx.fillRect(x, y, 1, d.len);
        if (d.y + d.vy >= GROUND) { ctx.fillStyle = "#6b4226"; ctx.fillRect(x - 2, GROUND - 1, 6, 1); }  // splash
      }
    }
  }

  // Combo breaker: white flash, stars bursting out of the breaker, the banner and the announcer.
  comboBreakerFx(f) {
    this.flash = 14;
    this.shake = 14;
    this.breakerBanner = { t: 0, points: f === this.p1 };
    this.slowmo = BREAKER.slowmo;
    const cx = f.x, cy = GROUND - f.y - 60;
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2 + Math.random() * 0.2, v = 2.5 + Math.random() * 4;
      this.stars.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, t: 0,
                        r: 3 + Math.random() * 3, spin: Math.random() * 6, gold: Math.random() < 0.7 });
    }
    sfx("hit_heavy", { x: f.x });
    sfx("vo_combo_breaker");
  }

  // Bind specials: the prop (a strip of tape) shoots along the ground; if it catches the
  // opponent's feet their legs are bound: slow hops, no jumping. Jump it, or block it crouching.
  spawnTape(owner, sp) {
    const img = owner.char.props[sp.id];
    const w = img ? img.width : 60, h = img ? Math.min(img.height, 26) : 14;
    this.tapes.push({ owner, img, w, h, dir: owner.facing, x: owner.x + owner.facing * 30, start: owner.x, t: 0 });
    sfx("throw", { x: owner.x });
  }

  updateTapes() {
    for (const tp of this.tapes) {
      tp.t++;
      tp.x += 6.5 * tp.dir;
      const target = tp.owner === this.p1 ? this.p2 : this.p1;
      const box = { x: tp.x - tp.w / 2, y: GROUND - tp.h, w: tp.w, h: tp.h };
      if (this.phase === "fight" && overlap(box, target.hurtBox())) {
        tp.done = true;
        target.receive(tp.owner, tp.owner.stats.special_damage * 0.4, this, { hitstun: 10, push: 0.5, level: "low" });
        if (target.state !== "crouch_block" && target.state !== "ko") {
          target.bound = 180;  // three seconds
          target.shout = { text: "TAPED!", t: 70 };
        }
      }
      if (Math.abs(tp.x - tp.start) > 230) tp.done = true;
    }
    this.tapes = this.tapes.filter(tp => !tp.done);
  }

  // Orbital specials: see ORBITAL.
  spawnOrbital(owner, target) {
    // With a prop (MJ's hippo), the prop drops out of the sky onto the target instead of a beam.
    const img = owner.special && owner.char.props?.[owner.special.id] || null;
    this.orbitals.push({ owner, target, x: target.x, phase: "track", t: 0, hit: false, img });
  }

  updateOrbitals() {
    for (const o of this.orbitals) {
      o.t++;
      if (o.phase === "track") {
        o.x += clamp(o.target.x - o.x, -ORBITAL.follow, ORBITAL.follow);
        if (o.t % 8 === 0) sfx("tick", { x: o.x });
        if (o.t >= ORBITAL.track) { o.phase = "lock"; o.t = 0; }
      } else if (o.phase === "lock") {
        if (o.t % 4 === 0) sfx("tick", { x: o.x });
        if (o.t >= ORBITAL.lock) {
          o.phase = "strike"; o.t = 0;
          if (o.img) sfx("throw", { x: o.x });  // the prop whistles down; it lands at ORBITAL.fall
          else { sfx("special", { x: o.x }); sfx("slam", { x: o.x }); this.shake = 16; this.flash = 10; }
        }
      } else if (o.phase === "strike") {
        const target = o.target, landed = !o.img || o.t >= ORBITAL.fall;
        if (o.img && o.t === ORBITAL.fall) { sfx("slam", { x: o.x }); sfx("hit_heavy", { x: o.x }); this.shake = 16; }
        if (landed && !o.hit && o.t <= ORBITAL.hitFor + (o.img ? ORBITAL.fall : 0) && this.phase === "fight" && target.state !== "ko") {
          const hb = target.hurtBox(), half = ORBITAL.width / 2;
          if (hb.x < o.x + half && hb.x + hb.w > o.x - half) {
            o.hit = true;
            target.receive(o.owner, Math.round(o.owner.stats.special_damage * ORBITAL.damage), this,
                           { hitstun: 40, push: 3, launch: 6, unblockable: true });
          }
        }
        if (landed && o.t % 3 === 0 && o.t < ORBITAL.strike - 8) this.spark(o.x + rand(-20, 20), GROUND - rand(0, 24), false);
        if (o.t >= ORBITAL.strike) o.done = true;
      }
    }
    this.orbitals = this.orbitals.filter(o => !o.done);
  }

  // "ground": the target reticle under the fighters; "beam": the strike, over them.
  drawOrbitals(ctx, camX, layer) {
    for (const o of this.orbitals) {
      const x = Math.round(o.x - camX);
      if (layer === "ground" && o.phase !== "strike") {
        const locked = o.phase === "lock", blink = locked && o.t % 6 < 3;
        const r = locked ? 18 : 24 - Math.sin(o.t * 0.25) * 3;
        ctx.strokeStyle = blink ? "#fff" : "#ff3030"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(x, GROUND - 1, r, r * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(x, GROUND - 1, r * 0.45, r * 0.13, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        for (let k = 0; k < 4; k++) {  // turning tick marks
          const a = o.t * 0.08 + k * Math.PI / 2;
          ctx.fillRect(Math.round(x + Math.cos(a) * (r + 4)) - 1, Math.round(GROUND - 1 + Math.sin(a) * (r + 4) * 0.28) - 1, 3, 2);
        }
        // a thin targeting laser from the sky
        ctx.fillStyle = `rgba(255,60,60,${locked ? 0.55 : 0.25 + (o.t % 10 < 5 ? 0.1 : 0)})`;
        ctx.fillRect(x, 0, 1, GROUND - 2);
      }
      if (layer === "beam" && o.phase === "strike" && o.img) {  // the prop drops, lands, settles
        const k = o.t, s = ORBITAL.propScale, w = Math.round(o.img.width * s), h = Math.round(o.img.height * s);
        const fall = Math.min(1, k / ORBITAL.fall);
        const squash = k >= ORBITAL.fall ? Math.max(0, 1 - (k - ORBITAL.fall) / 8) * 0.18 : 0;  // a thud
        const hh = Math.round(h * (1 - squash)), ww = Math.round(w * (1 + squash));
        const bottom = Math.round(-20 + (GROUND + 4 + 20) * fall * fall);
        ctx.globalAlpha = Math.min(1, (ORBITAL.strike - k) / 10);
        if (k >= ORBITAL.fall) {  // dust where it hit
          ctx.fillStyle = "rgba(230,220,200,0.7)";
          ctx.beginPath(); ctx.ellipse(x, GROUND + 2, ww * 0.6 + (k - ORBITAL.fall) * 2, 7, 0, 0, Math.PI * 2); ctx.fill();
        }
        ctx.drawImage(o.img, x - Math.round(ww / 2), bottom - hh, ww, hh);
        ctx.globalAlpha = 1;
        continue;
      }
      if (layer === "beam" && o.phase === "strike") {
        const k = o.t;
        const grow = Math.min(1, k / 4), fade = Math.min(1, (ORBITAL.strike - k) / 12);
        const w = Math.round(ORBITAL.width * grow * (0.7 + 0.3 * fade) + (k % 4 < 2 ? 2 : 0));
        ctx.globalAlpha = fade;
        for (const [ww, color] of [[w + 18, "rgba(255,40,40,0.3)"], [w, "rgba(255,42,42,0.7)"], [w * 0.5, "rgba(255,170,170,0.6)"], [w * 0.22, "rgba(255,255,255,0.85)"]]) {
          ctx.fillStyle = color; ctx.fillRect(Math.round(x - ww / 2), 0, Math.round(ww), GROUND + 2);
        }
        ctx.fillStyle = "rgba(255,230,230,0.8)";  // the impact splash on the ground
        ctx.beginPath(); ctx.ellipse(x, GROUND, w * 0.9 + k, 6 + k * 0.2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  // Audit specials: see AUDIT. The numbers spray from the calculator, held out at the sprite's top front.
  spawnAudit(owner, target) {
    const f = owner.currentFrame();
    const x0 = owner.x + owner.facing * (f.w - f.ax - 6), y = GROUND - owner.y - f.ay + Math.round(f.h * 0.2);
    this.audits.push({ owner, target, dir: owner.facing, x0, y, len: 0, state: "out", t: 0,
                       digits: [], swirl: [], cash: [], whirl: 0, whirlHits: 0, stamp: 0 });
    sfx("throw", { x: owner.x });
  }

  // The fan's leading edge: as tall as the figures have spread by then.
  auditFront(a) {
    const tip = a.x0 + a.dir * a.len, h = Math.min(80, 10 + a.len * 0.42);
    return { x: Math.min(tip, tip - a.dir * AUDIT.speed), y: a.y - h / 2, w: AUDIT.speed + 2, h };
  }

  updateAudits() {
    const camX = this.camX();
    for (const a of this.audits) {
      a.t++;
      const target = a.target, owner = a.owner, dmg = owner.stats.special_damage;
      if (a.state === "out") {
        a.len += AUDIT.speed;
        // keep spraying figures from the calculator, fanning out wide as they go
        const spread = Math.random() - 0.5;
        a.digits.push({ x: a.x0, y: a.y + spread * 3, vx: a.dir * (AUDIT.speed - 0.6 + Math.random() * 1.4),
                        vy: spread * 3.2, ch: "0123456789$%"[Math.floor(Math.random() * 12)], life: 999 });
        if (this.phase === "fight" && target.state !== "ko" && overlap(this.auditFront(a), target.hurtBox())) {
          const blocked = target.state === "block" || target.state === "crouch_block";
          target.receive(owner, Math.max(1, Math.round(dmg * AUDIT.sprayDamage)), this, { hitstun: 24, push: 1 });
          a.state = "hit"; a.t = 0;
          if (!blocked && target.state !== "ko") {
            target.shout = { text: "MY MONEY!", t: 80 };
            a.stamp = 1; a.whirl = 1;
            sfx("slam", { x: target.x });
            for (let i = 0; i < AUDIT.cash; i++) {  // their pockets empty into a whirlwind around them
              a.swirl.push({ ang: Math.random() * Math.PI * 2, r: 20 + Math.random() * 16, hf: Math.random(),
                             speed: 0.13 + Math.random() * 0.09, rise: 0.004 + Math.random() * 0.006,
                             bill: i % 3 !== 2, spin: Math.random() * 6 });
            }
          }
        }
        if (a.state === "out" && (a.x0 + a.dir * a.len < camX - 10 || a.x0 + a.dir * a.len > camX + W + 10)) {
          a.state = "fall"; a.t = 0;
        }
      } else if (a.state === "hit" && a.t > AUDIT.hold) {
        a.state = "fall"; a.t = 0;  // ChuckT is free again; the whirlwind carries on
      }
      if (a.stamp) a.stamp++;

      if (a.whirl) {
        a.whirl++;
        for (const c of a.swirl) { c.ang += c.speed; c.hf = (c.hf + c.rise) % 1; c.spin += 0.2; }
        const every = Math.floor(AUDIT.whirl / AUDIT.whirlHits);
        if (a.whirl % every === 0 && a.whirlHits < AUDIT.whirlHits && this.phase === "fight" && target.state !== "ko") {
          a.whirlHits++;
          target.receive(owner, Math.max(1, Math.round(dmg * AUDIT.whirlDamage)), this,
                         { hitstun: 16, push: 0.3, unblockable: true });
        }
        if (a.whirl > AUDIT.whirl || target.state === "ko") {  // the whirlwind blows itself out
          const h = target.hurtBox();
          for (const c of a.swirl) {
            a.cash.push({ x: target.x + Math.cos(c.ang) * c.r, y: h.y + h.h * (1 - c.hf),
                          vx: Math.cos(c.ang) * (1.5 + Math.random() * 2), vy: -1.5 - Math.random() * 2.5,
                          bill: c.bill, spin: c.spin, life: 60 + Math.random() * 30 });
          }
          a.swirl = []; a.whirl = 0;
        }
      }

      for (const d of a.digits) {
        d.x += d.vx; d.y += d.vy;
        if (a.state !== "out" && d.life > 20) d.life = 20;  // stream cut off: the rest fizzle out
        d.life--;
        if (a.state === "hit" && Math.abs(d.x - target.x) < 14) { d.vx *= -0.3; d.vy = (Math.random() - 0.5) * 3; }
      }
      a.digits = a.digits.filter(d => d.life > 0 && d.x > camX - 20 && d.x < camX + W + 20 && d.y < GROUND);
      for (const c of a.cash) {
        c.x += c.vx; c.y += c.vy; c.life--;
        c.vy += c.bill ? 0.08 : 0.25;
        if (c.bill) { c.vx *= 0.97; c.vy = Math.min(c.vy, 0.9); }  // bills flutter down
        if (c.y > GROUND - 1) { c.y = GROUND - 1; c.vy *= -0.35; c.vx *= 0.6; }
      }
      a.cash = a.cash.filter(c => c.life > 0);
      if (a.state === "fall" && a.t > 30 && !a.whirl && !a.cash.length && !a.digits.length) a.done = true;
    }
    this.audits = this.audits.filter(a => !a.done);
  }

  // layer "back": the far half of the whirlwind, behind the fighters; "front": everything else.
  drawAudits(ctx, camX, layer) {
    for (const a of this.audits) {
      const h = a.target.hurtBox();
      if (a.whirl) {  // wind streaks circling the opponent, the far side faint
        const fade = Math.min(1, a.whirl / 10, (AUDIT.whirl - a.whirl) / 15);
        for (let k = 0; k < 4; k++) {
          const y = h.y + h.h * (0.15 + 0.23 * k), r = 30 + (k % 2) * 5, spin = a.whirl * 0.22 + k * 1.7;
          ctx.strokeStyle = `rgba(235,245,230,${(layer === "back" ? 0.25 : 0.6) * fade})`; ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.ellipse(Math.round(a.target.x - camX), Math.round(y), r, 6, 0,
                      layer === "back" ? Math.PI + spin % 1 : spin % 1, (layer === "back" ? Math.PI : 0) + spin % 1 + 2.2);
          ctx.stroke();
        }
      }
      for (const c of a.swirl) {
        if ((Math.sin(c.ang) < 0) !== (layer === "back")) continue;
        const x = a.target.x + Math.cos(c.ang) * c.r, y = h.y + h.h * (1 - c.hf);
        drawCash(ctx, Math.round(x - camX), Math.round(y), c.bill, c.spin);
      }
      if (layer === "back") continue;
      ctx.font = `8px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (a.state === "out") {  // the calculator's display glowing
        ctx.fillStyle = `rgba(255,60,60,${0.35 + (a.t % 4 < 2 ? 0.2 : 0)})`;
        ctx.beginPath(); ctx.arc(Math.round(a.x0 - camX), a.y, 5, 0, Math.PI * 2); ctx.fill();
      }
      for (const d of a.digits) {
        const x = Math.round(d.x - camX), y = Math.round(d.y);
        ctx.globalAlpha = Math.min(1, d.life / 20);
        ctx.fillStyle = "#5a0000"; ctx.fillText(d.ch, x + 1, y + 1);  // dark edge so each figure reads
        ctx.fillStyle = d.ch === "$" || d.ch === "%" ? "#ffb0b0" : "#ff2e2e";
        ctx.fillText(d.ch, x, y);
      }
      ctx.globalAlpha = 1;
      for (const c of a.cash) drawCash(ctx, Math.round(c.x - camX), Math.round(c.y), c.bill, c.spin + c.life * 0.3);
      if (a.stamp && a.stamp < 60) {  // a red AUDITED stamp slams onto the opponent
        const k = Math.min(1, a.stamp / 6), sc = 2.2 - 1.2 * k;
        ctx.save();
        ctx.translate(Math.round(a.target.x - camX), Math.round(h.y + 26));
        ctx.rotate(-0.2); ctx.scale(sc, sc);
        ctx.globalAlpha = a.stamp > 45 ? (60 - a.stamp) / 15 : 0.95;
        ctx.strokeStyle = "#d42020"; ctx.lineWidth = 1.5; ctx.strokeRect(-34, -8, 68, 16);
        ctx.fillStyle = "#d42020"; ctx.fillText("AUDITED", 0, 1);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
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
    if (this.stage) this.stage.back(ctx, camX);
    else ctx.drawImage(this.arenaImg, -camX, 0, this.arenaW, H);
    for (const a of this.abducts) if (a.phase === "plane") this.drawVehicle(ctx, a, a.plane, 34, camX);  // behind the faller
    this.drawSlideshows(ctx);
    this.drawAudits(ctx, camX, "back");
    this.drawOrbitals(ctx, camX, "ground");
    for (const f of [p2, p1]) f.draw(ctx, camX);
    this.stage?.front(ctx, camX);
    this.drawAudits(ctx, camX, "front");
    this.drawOrbitals(ctx, camX, "beam");
    this.drawRains(ctx, camX);

    for (const p of this.projectiles) {
      ctx.save();
      ctx.translate(Math.round(p.x - camX), Math.round(p.y));
      ctx.rotate(p.angle * Math.sign(p.vx));
      if (p.img) ctx.drawImage(p.img, -p.w / 2, -p.h / 2);
      else { ctx.fillStyle = "#b07a3a"; ctx.fillRect(-12, -12, 24, 24); ctx.strokeStyle = "#000"; ctx.strokeRect(-12, -12, 24, 24); }
      ctx.restore();
    }
    for (const tp of this.tapes) {
      ctx.save();
      ctx.translate(Math.round(tp.x - this.camX()), GROUND - tp.h + 1);
      if (tp.dir < 0) ctx.scale(-1, 1);
      if (tp.img) ctx.drawImage(tp.img, -tp.w / 2, 0, tp.w, tp.h);
      else { ctx.fillStyle = "#b8bcc2"; ctx.fillRect(-tp.w / 2, 0, tp.w, tp.h); }
      ctx.restore();
    }
    for (const a of this.abducts) if (a.phase === "car") {
      this.drawVehicle(ctx, a, a.car, null, camX);
      const w = a.car ? a.car.width : 150, h = a.car ? a.car.height : 70;
      const sx = Math.round(a.x - camX + a.dir * w * 0.07), sy = Math.round(GROUND - h + 2 + h * 0.28);
      ctx.fillStyle = "rgba(120,220,255,0.35)"; ctx.fillRect(sx - 17, sy - 7, 34, 14);  // glow
      ctx.fillStyle = "#000"; ctx.fillRect(sx - 15, sy - 5, 30, 10);
      ctx.strokeStyle = "#7df"; ctx.lineWidth = 1; ctx.strokeRect(sx - 14.5, sy - 4.5, 29, 9);
      ctx.font = `6px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff"; ctx.fillText("UBER", sx, sy + 1);
      ctx.textBaseline = "alphabetic";
    }
    for (const g of this.glitter) {
      const x = Math.round(g.x - camX), y = Math.round(g.y);
      ctx.globalAlpha = 1 - g.t / 26;
      ctx.fillStyle = ["#fff", "#ffe066", "#ff8cf0", "#8cf4ff"][(g.t + Math.round(g.x)) % 4];
      if (g.t % 6 < 3) { ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3); }  // twinkle
      else ctx.fillRect(x, y, 2, 2);
    }
    ctx.globalAlpha = 1;
    for (const p of this.puffs) {  // teleport particles
      for (let i = 0; i < 18; i++) {
        const ang = i * 2.4 + p.x, r = p.t * (1.2 + (i % 5) * 0.5);
        ctx.fillStyle = ["#5ff", "#f6f", "#ff6", "#fff"][i % 4];
        ctx.globalAlpha = 1 - p.t / 30;
        ctx.fillRect(Math.round(p.x - camX + Math.cos(ang) * r), Math.round(p.y + Math.sin(ang) * r * 1.6), 2, 2);
      }
      ctx.globalAlpha = 1;
    }
    for (const c of this.charges) {
      const x = Math.round(c.x - camX), top = GROUND - c.h + 2;
      ctx.fillStyle = "rgba(255,255,255,0.55)";  // speed lines trailing behind
      for (let i = 0; i < 5; i++) {
        const len = 20 + ((i * 37 + this.phaseT * 3) % 40);
        ctx.fillRect(x - c.dir * (c.w / 2 + 6) - (c.dir > 0 ? len : 0), top + c.h * (0.2 + i * 0.15), len, 2);
      }
      ctx.save();
      ctx.translate(x, top);
      if (c.dir < 0) ctx.scale(-1, 1);  // props are drawn facing right
      if (c.img) ctx.drawImage(c.img, -c.w / 2, 0);
      else { ctx.fillStyle = "#ddd"; ctx.fillRect(-c.w / 2, 0, c.w, c.h); }
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
    for (const s of this.stars) drawStar(ctx, s.x - camX, s.y, s.r, s.spin, s.gold ? "#ffd23f" : "#fff", 1 - s.t / 60);
    if (this.debug) this.drawDebug(ctx, camX);
    ctx.restore();

    this.drawHUD(ctx);
    if (this.flash) { ctx.fillStyle = `rgba(255,255,255,${this.flash / 14 * 0.85})`; ctx.fillRect(0, 0, W, H); }
    if (this.breakerBanner) {
      const t = this.breakerBanner.t, jitter = t < 30 ? (t % 4 < 2 ? 2 : -2) : 0;
      const zoom = t < 8 ? 1.6 - t * 0.075 : 1;
      if (!(t > 95 && t % 6 < 3)) {
        ctx.save();
        ctx.translate(W / 2 + jitter, 112);  // mid-screen, clear of the combo counters
        ctx.scale(zoom, zoom);
        ctx.textAlign = "center";
        ctx.font = `20px ${FONT}`; outlinedText(ctx, "COMBO BREAKER!!!", 0, 8, t % 8 < 4 ? "#ff4040" : "#ffd23f", 3);
        if (this.breakerBanner.points && t > 12) { ctx.font = `10px ${FONT}`; outlinedText(ctx, `+${BREAKER.points}`, 0, 26, "#7fffb2", 2); }
        ctx.restore();
      }
    }
    if (this.banner) {
      ctx.font = `24px ${FONT}`; ctx.textAlign = "center";
      outlinedText(ctx, this.banner, W / 2, H / 2 - 10, this.banner === "K.O." ? "#ff4040" : "#ffd23f", 3);
    }
    if (this.paused) {
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0, 0, W, H);
      ctx.font = `16px ${FONT}`; ctx.textAlign = "center";
      outlinedText(ctx, "PAUSED", W / 2, H / 2 - 8, "#fff", 2);
      ctx.font = `8px ${FONT}`;
      outlinedText(ctx, "ESC RESUME  ·  Q QUIT  ·  F FULL SCREEN", W / 2, H / 2 + 14, "#ccc");
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
    // Combo counters, under each fighter's health bar
    for (const [f, x, side] of bars) {
      const c = f.comboShow;
      if (!c) continue;
      const tx = side < 0 ? x : x + barW, y = top + barH + 52;  // below the name
      ctx.textAlign = side < 0 ? "left" : "right";
      const pop = c.t < 6 ? 1 + (6 - c.t) * 0.06 : 1;  // each new hit pops the number
      const big = Math.min(26, 14 + c.n * 1.2) * pop;
      const color = c.n >= 8 ? "#ff5a3c" : c.n >= 5 ? "#ff9d2e" : "#ffd23f";
      if (c.done && c.t > 60 && c.t % 6 < 3) continue;  // blink out
      ctx.font = `${Math.round(big)}px ${FONT}`;
      outlinedText(ctx, `${c.n}`, tx, y, color, 3);
      const nx = tx + (side < 0 ? 1 : -1) * (ctx.measureText(`${c.n}`).width + 5);
      ctx.font = `8px ${FONT}`;
      outlinedText(ctx, c.done ? "HIT COMBO!" : "HITS", nx, y, "#fff");
      if (c.done && f === this.p1) outlinedText(ctx, `+${comboPoints(c.n)}`, tx, y + 12, "#7fffb2");
    }
    // KO badge and timer
    ctx.font = `8px ${FONT}`; ctx.textAlign = "center";
    outlinedText(ctx, "KO", W / 2, top + 8, "#ff4040");
    ctx.font = `16px ${FONT}`;
    outlinedText(ctx, String(Math.max(0, this.timer)).padStart(2, "0"), W / 2, top + 30, "#fff", 2);
    // Special cooldown pip for the player
    if (this.p1.char.specials.some(s => this.p1.specialReady(s)) && this.phase === "fight") {
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

const app = { characters: [], arenas: [], campaigns: [], me: null, choice: { player: null, opponent: "random" }, loaded: {} };

// The character select screen, with SelectionScreen.mp3 looping (M toggles it there too).
const SELECTION_MUSIC = "/assets/selection-music";

function showMenu() {
  show("select");
  music.play(SELECTION_MUSIC);
  armIdle();
}

// Attract loop: a minute on the menu with no mouse, key or touch shows the high scores again.
const IDLE_SECONDS = 60;
let idleTimer = null;
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if ($("select").classList.contains("active") && !app.match && !document.querySelector("dialog[open]")) showHighScores();
  }, IDLE_SECONDS * 1000);
}
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) {
  window.addEventListener(ev, () => { if ($("select").classList.contains("active")) armIdle(); }, { passive: true });
}

// ------------------------------------------------------------------ screen size
// The game draws at 384x224 and is scaled up with blocky pixels. The scale is always a whole number
// of screen pixels per game pixel (counting a Retina display's real pixels), since at an in-between
// scale some rows come out a pixel thicker than others and edges wobble as fighters move.
//   800x600 (the default): the largest whole scale that fits inside 800x600, smaller if the window
//     is: 768x448 (2x on a standard screen, 4 screen pixels per game pixel on a Retina one).
//   full screen (button or F): the largest whole scale that fits the screen, black around it.
const WINDOW_BOX = [800, 600];

function isFullscreen() { return !!document.fullscreenElement; }

function fitCanvas() {
  const c = $("canvas"), dpr = window.devicePixelRatio || 1;
  const fits = Math.floor(Math.min(innerWidth * dpr / W, innerHeight * dpr / H));
  const box = Math.floor(Math.min(WINDOW_BOX[0] * dpr / W, WINDOW_BOX[1] * dpr / H));
  const k = isFullscreen() ? fits : Math.min(fits, box);
  if (k < 1) { c.style.width = c.style.height = ""; return; }  // tiny window: just fit it
  c.style.width = `${k * W / dpr}px`;
  c.style.height = `${k * H / dpr}px`;
  for (const b of document.querySelectorAll("#display button"))
    b.classList.toggle("selected", (b.dataset.mode === "full") === isFullscreen());
}

function setFullscreen(on) {
  if (on === isFullscreen()) return;
  const req = on ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.();
  req?.catch?.(() => {});  // refused (e.g. not from a click or key press): stay as we are
}

for (const b of document.querySelectorAll("#display button"))
  b.onclick = () => { sfx("menu_move"); setFullscreen(b.dataset.mode === "full"); };
window.addEventListener("resize", fitCanvas);
document.addEventListener("fullscreenchange", fitCanvas);
// F toggles full screen on any screen (it isn't a fighting key); not while typing initials.
window.addEventListener("keydown", e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.("input, textarea")) return;
  if (e.key.toLowerCase() === "f" && !($("results").classList.contains("active") && !$("initials").hidden))
    setFullscreen(!isFullscreen());
});
fitCanvas();

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
  if (group === "player") {
    showSpecialHelp();
    // No fighting yourself: hide your fighter among the opponents.
    for (const el of $("opponent-grid").children) el.hidden = el.dataset.value === value;
    if (app.choice.opponent === value) select("opponent", "random");
  }
  if (group === "opponent") showArenaPreview(value);
  $("fight-btn").disabled = !(app.choice.player && app.arenas.length && app.characters.length > 1);
  showCampaignButton();
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

// The opponent's campaign (static/brawl.js), if they have one: a street of enemies, then them as
// the boss. Offered as a second button under FIGHT!; never your own (you'd be its boss).
function currentCampaign() {
  const { player, opponent } = app.choice;
  return opponent !== player && app.campaigns.find(c => c.boss === opponent) || null;
}

function showCampaignButton() {
  const c = currentCampaign(), btn = $("campaign-btn");
  btn.hidden = !c;
  if (!c) return;
  btn.innerHTML = `CAMPAIGN<small>${esc(c.title.toUpperCase())}</small>`;
  btn.title = `Fight through ${c.enemies} enemies, then ${c.boss_name}`;
  btn.disabled = $("fight-btn").disabled;
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
  // A guest's own line is the one they just signed; everyone else's is their username's.
  const mine = r => app.me?.choose_any ? r.id === app.signedScore : r.username === app.me?.username;
  table.innerHTML = rows.length ? rows.map((r, i) => `
    <tr class="${mine(r) ? "me" : ""}">
      <td>${i + 1}.</td><td>${esc(r.name || r.username)}</td><td>${esc(r.character)}</td><td>${r.score}</td>
    </tr>`).join("") : `<tr><td class="empty">No scores yet</td></tr>`;
}

async function refreshScores() {
  const rows = await getJSON("/api/scores");
  renderScores($("scores-side"), rows);
  renderScores($("scores-results"), rows);
}

async function initMenu() {
  [app.me, app.characters, app.arenas, app.campaigns] = await Promise.all(
    ["/api/me", "/api/characters", "/api/arenas", "/api/campaigns"].map(u => getJSON(u).catch(e => {
      if (u === "/api/campaigns") return [];  // campaigns are optional
      throw e;
    })));
  $("user").textContent = `${app.me.username.toUpperCase()} · BEST ${app.me.best}`;
  $("pw-btn").hidden = !app.me.can_change_password;
  $("acct-btn").hidden = !app.me.can_request_account;
  $("logout-btn").hidden = !app.me.can_logout;

  // The player's fighter is fixed per account (last column of users.csv); only the opponent is chosen.
  const pg = $("player-grid"), og = $("opponent-grid");
  const mine = app.characters.find(c => c.slug === app.me.character);
  if (!app.characters.length) {
    pg.innerHTML = `<p class="empty">No characters built yet. Run add_character.py.</p>`;
  } else if (app.me.choose_any) {
    // The guest account may play anyone.
    for (const c of app.characters) pg.append(characterCard(c, "player"));
  } else if (mine) {
    const card = characterCard(mine, "player");
    card.onclick = null; card.style.cursor = "default";
    pg.append(card);
  } else {
    pg.innerHTML = `<p class="empty">${app.me.character_name
      ? `Your fighter "${esc(app.me.character_name)}" isn't built yet.`
      : "No fighter is assigned to your account."} Ask the admin to set one in users.csv.</p>`;
  }
  const rivals = app.me.choose_any ? app.characters  // select() hides whoever is playing
    : app.characters.filter(c => c.slug !== app.me.character);  // no fighting yourself
  for (const c of rivals) og.append(characterCard(c, "opponent"));
  const randomCard = document.createElement("button");
  randomCard.className = "card"; randomCard.dataset.value = "random";
  // Same rows as a fighter's card (portrait, name, three stat bars), so it's the same size.
  const unknownBar = label => `<div class="stat"><span>${label}</span><i class="unknown" style="width:100%"></i></div>`;
  randomCard.innerHTML = `<div class="portrait unknown">?</div><span class="name">RANDOM</span>
    <span class="meta">${unknownBar("HP")}${unknownBar("ATK")}${unknownBar("DEF")}</span>`;
  randomCard.onclick = () => { select("opponent", "random"); sfx("menu_move"); };
  if (rivals.length) og.append(randomCard);
  else og.innerHTML = `<p class="empty">No one to fight yet. Build another character with add_character.py.</p>`;

  select("opponent", "random");
  if (mine || app.me.choose_any) select("player", (mine || app.characters[0])?.slug);
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
    app.lastMatch = { player, opponent, arena: a.slug, difficulty: app.difficulty };
    app.match = new Match({ player: pc, opponent: oc, arena: a, arenaImg: img, onEnd: r => endMatch(r, pc, oc),
                           difficulty: app.difficulty });
    app.match.start();
  } catch (e) {
    alert(`Could not load the match: ${e.message}`);
  } finally {
    $("fight-btn").disabled = false;
    $("fight-btn").textContent = "FIGHT!";
  }
}

// ---------------------------------------------------------------- guest initials

// After a guest's match, arcade-style initials entry: type letters, or up/down to change the
// letter and left/right to move; Enter (or the button) saves them on that score.
const INITIAL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const initials = { scoreId: null, letters: ["A", "A", "A"], pos: 0 };

function drawInitials() {
  [...document.querySelectorAll("#initials .slot")].forEach((el, i) => {
    el.textContent = initials.letters[i];
    el.classList.toggle("on", i === initials.pos);
  });
}

function openInitials(scoreId) {
  // AAA every time: on a shared machine the last guest's initials belong to someone else.
  Object.assign(initials, { scoreId, pos: 0, letters: ["A", "A", "A"] });
  $("initials").hidden = false;
  drawInitials();
}

function closeInitials() { $("initials").hidden = true; initials.scoreId = null; }

async function saveInitials() {
  if (initials.scoreId == null) return;
  const text = initials.letters.join(""), id = initials.scoreId;
  closeInitials();
  try {
    const r = await fetch(`/api/scores/${id}/initials`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initials: text }),
    });
    if (!r.ok) throw new Error((await r.json()).detail);
    const { rank } = await r.json();
    app.signedScore = id;
    $("result-detail").textContent += ` · ${text} is #${rank}`;
    sfx("menu_select");
  } catch (e) {
    $("result-detail").textContent += ` · initials not saved (${e.message})`;
  }
  refreshScores();
}

window.addEventListener("keydown", e => {
  if ($("initials").hidden || !$("results").classList.contains("active")) return;
  const k = e.key, cycle = d => {
    const i = INITIAL_CHARS.indexOf(initials.letters[initials.pos]);
    initials.letters[initials.pos] = INITIAL_CHARS[(i + d + INITIAL_CHARS.length) % INITIAL_CHARS.length];
  };
  if (/^[a-z0-9]$/i.test(k)) { initials.letters[initials.pos] = k.toUpperCase(); initials.pos = Math.min(2, initials.pos + 1); }
  else if (k === "ArrowUp") cycle(1);
  else if (k === "ArrowDown") cycle(-1);
  else if (k === "ArrowLeft" || k === "Backspace") initials.pos = Math.max(0, initials.pos - 1);
  else if (k === "ArrowRight") initials.pos = Math.min(2, initials.pos + 1);
  else if (k === "Enter") { e.preventDefault(); saveInitials(); return; }
  else return;
  e.preventDefault();
  sfx("menu_move");
  drawInitials();
});
document.querySelectorAll("#initials .slot").forEach((el, i) => {
  el.onclick = () => { initials.pos = i; drawInitials(); };
});
$("initials-ok").onclick = saveInitials;

// run: set for a campaign (static/brawl.js): how the street went; result is the boss match, or a
// stand-in for it when the player was knocked out on the street.
async function endMatch(result, pc, oc, run = null) {
  app.match = null;
  if (result.quit) { showMenu(); return; }
  closeInitials();
  show("results");
  const combos = result.combos;  // the boss match's; street combos aren't scored (static/brawl.js)
  $("result-title").textContent = !run ? (result.won ? "YOU WIN!" : "YOU LOSE")
    : result.won ? "CAMPAIGN CLEAR!" : "GAME OVER";
  $("result-title").style.color = result.won ? "var(--gold)" : "var(--red)";
  $("result-score").textContent = "...";
  const best = Math.max(0, ...combos);
  $("result-detail").textContent = (run
    ? `${run.story.title || "Campaign"} (${DIFFICULTY[app.lastMatch.difficulty].label}) · ${run.enemies} enemies beaten` +
      ` · street ${run.street_seconds}s` + (run.mini_boss ? ` · beat ${run.mini_name}` : "") +
      (run.cleared ? ` · vs ${oc.name}: rounds ${result.rounds.join("-")}` : "")
    : `${pc.name} vs ${oc.name} (${DIFFICULTY[app.lastMatch.difficulty].label})` +
      ` · rounds ${result.rounds.join("-")} · ${result.duration}s`) +
    (best ? ` · best combo ${best} hits` : "") +
    (result.breakers ? ` · ${result.breakers} combo breaker${result.breakers > 1 ? "s" : ""}` : "");
  try {
    const r = await fetch("/api/scores", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...app.lastMatch, character: app.lastMatch.player, won: result.won,
                             health_left: result.health_left, duration: result.duration,
                             round_health: result.round_health, specials_landed: result.specials_landed,
                             combos, breakers: result.breakers,
                             campaign: run ? { enemies: run.enemies, street_seconds: run.street_seconds,
                                               cleared: run.cleared, mini_boss: !!run.mini_boss } : null }),
    }).then(r => r.json());
    $("result-score").textContent = r.score !== undefined ? `${r.score} PTS` : "NO SCORE";
    if (r.id !== undefined && app.me.choose_any) openInitials(r.id);
    if (r.personal_best !== undefined && !app.me.choose_any) {  // a guest's "best" spans every guest
      $("result-detail").textContent += ` · best ${r.personal_best} · rank #${r.rank}`;
      app.me.best = r.personal_best;
      $("user").textContent = `${app.me.username.toUpperCase()} · BEST ${app.me.best}`;
    }
  } catch {
    $("result-score").textContent = "SCORE NOT SAVED";
  }
  if (run && result.won && run.story.outro) $("result-detail").textContent += `\n\n${run.story.outro}`;
  refreshScores();
}

$("fight-btn").onclick = () => { sfx("menu_select"); startMatch(); };
$("campaign-btn").onclick = () => { sfx("menu_select"); if (currentCampaign()) startCampaign(currentCampaign()); };

// Difficulty picker on the selection screen; remembered per browser.
function setDifficulty(level) {
  app.difficulty = DIFFICULTY[level] ? level : "easy";
  for (const b of document.querySelectorAll("#difficulty button")) b.classList.toggle("selected", b.dataset.level === app.difficulty);
  try { localStorage.setItem("unk.difficulty", app.difficulty); } catch {}
}
for (const b of document.querySelectorAll("#difficulty button")) b.onclick = () => { sfx("menu_move"); setDifficulty(b.dataset.level); };
setDifficulty((() => { try { return localStorage.getItem("unk.difficulty"); } catch { return null; } })());
$("rematch-btn").onclick = () => {
  sfx("menu_select");
  closeInitials();
  if (app.lastMatch.campaign) { startCampaign(app.lastMatch.campaign); return; }
  Object.assign(app.choice, { player: app.lastMatch.player, opponent: app.lastMatch.opponent });
  startMatch(app.lastMatch.arena);
};
$("menu-btn").onclick = () => {
  sfx("menu_move");
  closeInitials();
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
    showHighScores();
  };
  const onKey = e => { if (!e.repeat) finish(); };
  video.onerror = finish;  // no SplashScreen.mp4: straight to the high scores
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

// ---------------------------------------------------------------- log out

// Basic auth has no logout: replace the browser's saved login with a dummy the server accepts only
// at /api/logout (see server.py), then reload, which the server refuses, so the login prompt returns.
$("logout-btn").onclick = () => {
  sfx("menu_move");
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/api/logout", true, "_logout_", "x");
  xhr.onloadend = () => location.reload();
  xhr.send();
};

// ---------------------------------------------------------------- change password

// Logins are HTTP basic auth, so after a change the browser must be told the new password:
// reloading gets a 401 and the browser asks for it.
function openPasswordDialog() {
  const d = $("pw-dialog");
  $("pw-form").reset(); $("pw-msg").textContent = ""; $("pw-msg").className = "";
  $("pw-save").textContent = "SAVE"; $("pw-save").disabled = false; delete $("pw-save").dataset.done;
  $("pw-cancel").hidden = false;
  for (const id of ["pw-current", "pw-new", "pw-again"]) $(id).disabled = false;
  d.showModal();
  $("pw-current").focus();
}

$("pw-btn").onclick = () => { sfx("menu_move"); openPasswordDialog(); };
$("pw-cancel").onclick = () => $("pw-dialog").close();
$("pw-form").onsubmit = async e => {
  e.preventDefault();
  const msg = $("pw-msg");
  if ($("pw-save").dataset.done) { location.reload(); return; }  // "LOG IN AGAIN"
  if ($("pw-new").value !== $("pw-again").value) { msg.textContent = "The new passwords don't match."; return; }
  $("pw-save").disabled = true; msg.className = ""; msg.textContent = "Saving...";
  try {
    const r = await fetch("/api/password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: $("pw-current").value, new: $("pw-new").value }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const d = body.detail;
      throw new Error(Array.isArray(d) ? "New password must be 6 to 200 characters." : d || `error ${r.status}`);
    }
    msg.className = "ok";
    msg.textContent = "Password changed. Log in again with your new password.";
    for (const id of ["pw-current", "pw-new", "pw-again"]) $(id).disabled = true;
    $("pw-save").textContent = "LOG IN AGAIN"; $("pw-save").dataset.done = "1"; $("pw-save").disabled = false;
    $("pw-cancel").hidden = true;
    sfx("menu_select");
  } catch (err) {
    msg.textContent = err.message.charAt(0).toUpperCase() + err.message.slice(1) + ".";
    $("pw-save").disabled = false;
  }
};

// ---------------------------------------------------------------- account requests (guest)

// The guest can ask for an account and a fighter; the server files it for an admin to review.
const MAX_PHOTO_MB = 8;
let acctPhoto = null;  // data: URL of the chosen photo

$("acct-btn").onclick = () => {
  sfx("menu_move");
  $("acct-form").reset(); acctPhoto = null;
  $("acct-preview").style.display = "none";
  $("acct-msg").textContent = ""; $("acct-msg").className = "msg";
  for (const el of $("acct-form").elements) el.disabled = false;
  $("acct-send").textContent = "SEND REQUEST"; $("acct-send").hidden = false; $("acct-cancel").textContent = "CANCEL";
  $("acct-dialog").showModal();
  $("acct-user").focus();
};
$("acct-cancel").onclick = () => $("acct-dialog").close();
$("acct-photo").onchange = () => {
  const file = $("acct-photo").files[0];
  acctPhoto = null; $("acct-preview").style.display = "none"; $("acct-msg").textContent = "";
  if (!file) return;
  if (file.size > MAX_PHOTO_MB * 1024 * 1024) { $("acct-msg").textContent = `That photo is over ${MAX_PHOTO_MB} MB.`; $("acct-photo").value = ""; return; }
  const reader = new FileReader();
  reader.onload = () => { acctPhoto = reader.result; $("acct-preview").src = acctPhoto; $("acct-preview").style.display = "block"; };
  reader.readAsDataURL(file);
};
$("acct-form").onsubmit = async e => {
  e.preventDefault();
  const msg = $("acct-msg");
  if ($("acct-pass").value !== $("acct-pass2").value) { msg.textContent = "The passwords don't match."; return; }
  if (!acctPhoto) { msg.textContent = "Choose a photo for your fighter."; return; }
  $("acct-send").disabled = true; msg.className = "msg"; msg.textContent = "Sending...";
  try {
    const r = await fetch("/api/account-request", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("acct-user").value.trim(), password: $("acct-pass").value,
                             character: $("acct-char").value.trim(), description: $("acct-desc").value.trim(),
                             photo: acctPhoto }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const d = body.detail;
      throw new Error(Array.isArray(d) ? fieldProblem(d[0]) : d || `error ${r.status}`);
    }
    msg.className = "msg ok";
    msg.textContent = `Request sent for ${body.character}! Once an admin approves it, log in as ${$("acct-user").value.trim()}.`;
    for (const el of $("acct-form").elements) el.disabled = true;
    $("acct-cancel").disabled = false; $("acct-cancel").textContent = "CLOSE";
    $("acct-send").hidden = true;
    sfx("menu_select");
  } catch (err) {
    msg.textContent = err.message.charAt(0).toUpperCase() + err.message.slice(1) + ".";
    $("acct-send").disabled = false;
  }
};

// The server's field checks, in words.
function fieldProblem(d) {
  const field = d?.loc?.[1];
  return {
    username: "Username: 3 to 30 letters, numbers, . _ or -",
    password: "Password: at least 6 characters",
    character: "Character name: 2 to 40 characters",
    description: "Description: at least 20 characters (4000 at most)",
  }[field] || "Please check the form";
}

// ---------------------------------------------------------------- high scores attract screen

// Between the splash and the menu, arcade style: the top 10 slide in, then the menu after a few
// seconds (sooner on a key or click).
const HISCORE_SECONDS = 8;
const ORDINALS = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH", "9TH", "10TH"];

async function showHighScores() {
  clearTimeout(idleTimer);
  show("hiscores");
  music.play(SELECTION_MUSIC);
  let done = false, timer = null;
  const finish = () => {
    if (done) return;
    done = true; clearTimeout(timer);
    window.removeEventListener("keydown", onKey);
    showMenu();
  };
  const onKey = e => { if (!e.repeat) finish(); };
  window.addEventListener("keydown", onKey);
  $("hiscores").onclick = finish;
  let rows = [];
  try {
    await app.ready;  // characters, for portraits
    rows = await getJSON("/api/scores?limit=10");
  } catch {}
  if (done) return;
  const portrait = slug => app.characters?.find(c => c.slug === slug);
  $("hiscore-list").innerHTML = rows.length ? rows.map((r, i) => {
    const c = portrait(r.character);
    return `<li class="${["gold", "silver", "bronze"][i] || ""}" style="animation-delay:${0.15 + i * 0.12}s">
      <span class="rank">${ORDINALS[i]}</span>
      ${c ? `<img class="face" src="${c.portrait}" alt="">` : `<span class="face"></span>`}
      <span class="who">${esc(r.name || r.username)}</span>
      <span class="char">${esc(c?.name || r.character)}${r.best_combo >= 2 ? ` <b class="combo">${r.best_combo} HIT</b>` : ""}</span>
      <span class="pts">${String(r.score).padStart(7, "0")}</span>
    </li>`;
  }).join("") : `<li class="none">NO SCORES YET &middot; BE THE FIRST!</li>`;
  timer = setTimeout(finish, (rows.length ? HISCORE_SECONDS : 3) * 1000);
}

runSplash();
app.ready = initMenu();
app.ready.catch(e => { $("player-grid").innerHTML = `<p class="empty">Failed to load: ${esc(e.message)}</p>`; });
