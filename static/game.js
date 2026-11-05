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
};
// Animation to show when a character's sheet predates an extended move.
const FALLBACK_ANIMS = {
  crouch_block: "block", crouch_punch: "punch", crouch_kick: "kick",
  jump_punch: "punch", jump_kick: "kick", dive_kick: "jump_kick",
};
const LANDING_TICKS = 6;   // recovery after landing from an air attack
const SPECIAL = { startup: 14, active: 16, recovery: 18, cooldown: 240 };
const STUN_TICKS = 110;
const BEAM = { startup: 14, active: 34, recovery: 14, every: 8, hits: 3 };

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
      special: null, shout: null, holdingBack: false, holdingDown: false, airAttacked: false, hidden: false, held: false, stretch: 0, bound: 0, ghosts: [], passThrough: false, floating: false,
    });
  }

  setState(state) {
    if (this.state === state) return;
    if (this.state === "dizzy") this.sleepy = false;
    if (this.special && this.state === this.special.id) { this.floating = false; this.passThrough = false; this.ghosts = []; this.cat = null; this.stopT = 0; }
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
      anim = this.t < BEAM.startup ? this.anim("idle") : this.anim(s);
    } else if (s.startsWith("special") && this.special?.effect === "cat") {
      // waiting for the cat (normal stance), the cat at her feet (frame 0, which has it), petting it (1)
      const k = this.cat?.arrived ? this.t - this.cat.arrived : -1;
      anim = k < 0 ? this.anim("idle") : this.anim(s); i = k < 15 ? 0 : 1;
    } else if (s.startsWith("special") && this.special?.effect === "charge") {
      anim = this.anim("jump");
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
    const t = this.t;
    if (t < BEAM.startup) {  // eyes charging up
      const r = 1 + t / 4, ey = py - f.ay + Math.round(f.h * 0.14);
      ctx.fillStyle = `rgba(255,60,60,${0.4 + t / 40})`;
      ctx.beginPath(); ctx.arc(px + this.facing * 6, ey, r, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (t >= BEAM.startup + BEAM.active) return;
    const fade = Math.min(1, (BEAM.startup + BEAM.active - t) / 6);
    const b = this.beamBox(camX), x = b.x - camX, mid = b.y + b.h / 2;
    const wobble = (t % 4 < 2) ? 1 : 0;
    ctx.globalAlpha = fade;
    ctx.fillStyle = "rgba(255,40,40,0.35)"; ctx.fillRect(x, mid - b.h / 2 - 2 - wobble, b.w, b.h + 4 + wobble * 2);
    ctx.fillStyle = "#ff2a2a"; ctx.fillRect(x, mid - b.h / 2 + 1, b.w, Math.max(2, b.h - 2));
    ctx.fillStyle = "#ffd0d0"; ctx.fillRect(x, mid - 1, b.w, 1 + wobble);
    ctx.globalAlpha = 1;
  }

  // The beam from the front edge of the sprite to the edge of the screen (world coordinates).
  beamBox(camX) {
    const f = this.currentFrame();
    // edge: rows and starting column of the beam drawn in the sprite (see add_character.py);
    // the beam is drawn from there, over the sprite's own (palette-muted) one.
    const [top, bottom, from] = f.edge || [-Math.round(f.h * 0.86), -Math.round(f.h * 0.82)];
    const start = this.x + this.facing * (from ?? f.w - f.ax - 1);
    const end = this.facing > 0 ? camX + W : camX;
    return { x: Math.min(start, end), y: GROUND - this.y + top - 1, w: Math.abs(end - start), h: bottom - top + 2 };
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
    if (this.bound > 0) this.bound--;  // legs taped by a bind special
    if (this.cooldown > 0 && --this.cooldown === 0 && this.isPlayer) sfx("ready");
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
    if (input.special && this.cooldown === 0) return this.startSpecial(input.special);
    if (input.attack) {
      // punch / kick become the crouching, jumping or diving version by stance.
      let move = input.attack;
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

  startSpecial(sp) {
    this.special = sp;
    this.setState(sp.id);
    this.cooldown = SPECIAL.cooldown;
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
      if (t === BEAM.startup) sfx("throw", { x: this.x });
      if (on && (t - BEAM.startup) % BEAM.every === 0 && this.hitCount < BEAM.hits &&
          overlap(this.beamBox(match.camX()), opp.hurtBox())) {
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

  receive(attacker, damage, match, { hitstun = 16, push = 2.5, stun = 0, unblockable = false, launch = 0, level = "mid" } = {}) {
    if (["ko", "victory", "defeat"].includes(this.state) || this.hidden || this.held) return;
    // Hold back to block; hold back and down to block low. Lows must be blocked crouching,
    // attacks from the air standing.
    const low = this.holdingDown;
    const blocking = !unblockable && this.holdingBack && ["idle", "walk", "crouch", "block", "crouch_block"].includes(this.state)
      && !(level === "low" && !low) && !(level === "high" && low);
    const box = this.hurtBox();
    const sparkX = attacker.x < this.x ? box.x + 4 : box.x + box.w - 4;
    if (blocking) {
      this.health -= damage * (1 - this.stats.block);
      this.setState(low ? "crouch_block" : "block"); this.stunFor = 10;
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

    if (this.floating) {  // soft glow and rising motes under a hovering fighter
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
    const top = py - f.ay;
    if (this.state === "dizzy") (this.sleepy ? drawZzz : drawDizzy)(ctx, px, top - 6, this.t);
    if (this.shout) drawBubble(ctx, this.shout.text, px, top - 8, camX);
  }
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

    // React to an attack in progress: block with probability from the block trait, low against
    // sweeps and standing against attacks from the air (usually; reads are sometimes wrong).
    const threatened = (opp.attacking && dist < 95 && opp.t < 4) || this.incoming;
    if (threatened && !this.blockRolled) {
      this.blockRolled = true;
      if (Math.random() < tr.block * 0.75) {
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

    const specials = f.char.specials.filter(() => f.cooldown === 0);
    const ranged = specials.filter(s => ["projectile", "bind", "slideshow", "rain", "dash", "tornado", "cat", "stun", "charge", "abduct", "stretch", "teleport"].includes(s.effect));
    const close = specials.filter(s => ["melee", "bind", "float", "slideshow", "rain", "dash", "tornado", "area", "stun", "charge", "abduct", "teleport"].includes(s.effect));
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
        { v: "punch", w: tr.punch * 1.1 },
        { v: "kick", w: tr.kick * 1.1 },
        { v: "lowpunch", w: tr.punch * 0.5 },
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
      lowpunch: [{ in: { crouch: true }, ticks: 2 }, { in: { crouch: true, attack: "punch" }, ticks: 1 },
                 { in: { crouch: true }, ticks: think }],
      sweep: [{ in: { crouch: true }, ticks: 2 }, { in: { crouch: true, attack: "kick" }, ticks: 1 },
              { in: {}, ticks: think }],
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
    this.projectiles = []; this.drops = []; this.sparks = []; this.charges = []; this.abducts = []; this.puffs = []; this.glitter = []; this.tapes = []; this.slideshows = []; this.rains = [];
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
    this.updateCharges();
    this.updateAbducts();
    this.updateTapes();
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
    for (const c of this.charges) if (!c.dropped) this.dropOff(c);  // the vehicle keeps driving off
    this.tapes = []; this.slideshows = []; this.rains = [];
    for (const f of [p1, p2]) f.bound = 0;
    for (const a of this.abducts) if (a.target.held) { a.target.held = false; a.target.y = 0; a.target.setState("idle"); }
    this.abducts = [];
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
    if (d.floating && !atk.air) return;  // ground attacks pass under a floating fighter
    if (a.t < atk.startup || a.t >= atk.startup + atk.active) return;
    if (overlap(a.hitBox(), d.hurtBox())) {
      a.hasHit = true;
      d.receive(a, atk.damage(a.stats), this, { hitstun: atk.hitstun, push: atk.push, level: atk.level, launch: atk.launch || 0 });
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
    for (const a of this.abducts) if (a.phase === "plane") this.drawVehicle(ctx, a, a.plane, 34, camX);  // behind the faller
    this.drawSlideshows(ctx);
    for (const f of [p2, p1]) f.draw(ctx, camX);
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
  if (group === "player") {
    showSpecialHelp();
    // No fighting yourself: hide your fighter among the opponents.
    for (const el of $("opponent-grid").children) el.hidden = el.dataset.value === value;
    if (app.choice.opponent === value) select("opponent", "random");
  }
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
  } else if (app.me.choose_any) {
    // The first account in users.csv may play anyone.
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
  randomCard.innerHTML = `<div class="portrait" style="display:grid;place-items:center;font-size:40px">?</div><span class="name">RANDOM</span>`;
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
