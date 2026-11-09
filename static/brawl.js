"use strict";
// Campaign mode: a Double Dragon style street built by add_campaign.py (build/campaigns/<boss>/),
// walked left to right through waves of enemies, then a regular Match against the boss in their
// home arena. Uses game.js's helpers (sfx, music, outlinedText, keyName, FALLBACK_ANIMS, ...).

// walk: x speed as a multiple of the fighter's walk_speed; depth: up/down speed relative to that;
// reach: how close in depth two must be for a hit to connect; chain: ticks after a punch in which
// the next continues the chain (the third punch is a knockdown finisher); invuln: ticks after
// getting up. Points as in server.py.
const STREET = {
  walk: 0.8, depth: 0.6, reach: 12, chain: 24, invuln: 70, down: 46, getup: 16,
  propHits: 3, propReach: 20,  // hits to smash a prop; how near its row (depth) the hero must stand
  heartChance: 0.5, heartHeal: 0.1,  // a smashed prop may leave a heart: heals this share of full health
  enemyPoints: 300, clearPoints: 3000, par: 300, speedPoints: 5,
};
// Crouching (Left Shift): low enough to duck thrown things; punch, kick and block all work low.
const CROUCHING = new Set(["crouch", "crouch_block", "crouch_punch", "crouch_kick"]);
// The fighter's moves on the street. knock: knocks the enemy down; anim: which animation shows it.
const HERO_MOVES = {
  punch:     { startup: 4, active: 4, recovery: 7, damage: s => s.punch_damage, push: 1.2, stun: 16 },
  finisher:  { startup: 6, active: 6, recovery: 14, damage: s => s.punch_damage * 1.6, push: 3, knock: true, anim: "uppercut" },
  kick:      { startup: 7, active: 5, recovery: 12, damage: s => s.kick_damage, push: 2.6, stun: 22 },
  // Left Shift + punch / kick, as in a match: a quick low jab, and a sweep that knocks down.
  crouch_punch: { startup: 4, active: 4, recovery: 7, damage: s => s.punch_damage * 0.8, push: 1, stun: 14 },
  crouch_kick:  { startup: 7, active: 6, recovery: 16, damage: s => s.kick_damage * 0.9, push: 1.5, knock: true },
  // In the air (air: lasts until landing). Punch or kick after a jump; with Left Shift held, a dive kick.
  jump_punch: { startup: 4, active: 40, recovery: 0, damage: s => s.punch_damage * 1.1, push: 2.2, stun: 16, air: true },
  jump_kick:  { startup: 4, active: 40, recovery: 0, damage: s => s.kick_damage * 1.2, push: 3, knock: true, air: true },
  dive_kick:  { startup: 3, active: 60, recovery: 0, damage: s => s.kick_damage, push: 2.5, knock: true, air: true },
  // Up + punch, as in a match: a rising uppercut that knocks down.
  uppercut:   { startup: 3, active: 14, recovery: 0, damage: s => s.punch_damage * 1.6, push: 2, knock: true, air: true,
                box: [-6, -128, 46, 118] },
  // Combo breaker (down, down, up, then up + punch while being hit): a leaping uppercut that clears
  // everyone around.
  breaker:    { startup: 2, active: 20, recovery: 0, damage: s => s.punch_damage * 2.2, push: 4, knock: true, air: true,
                box: [-40, -140, 100, 140] },
  // Rising uppercut, everyone's: punch just as you get up off the ground (STREET_WAKEUP). Unblockable; each
  // enemy it hits is flung away from the hero (around: by which side they're on) about half the screen.
  wakeup:     { startup: 2, active: 22, recovery: 0, damage: s => s.punch_damage * 2, knock: true, air: true,
                anim: "uppercut", box: [-36, -140, 96, 140], launch: 6, fling: 4.3, unblockable: true, around: true },
};
// When the rising uppercut works: from early ticks before the end of lying down, through getting up,
// to late ticks after standing. A punch pressed while lying down before that spends the chance for
// this knockdown, so mashing doesn't work. jump: its upward speed; invuln: ticks safe from hits.
const STREET_WAKEUP = { early: 14, late: 8, jump: 6, invuln: 40 };
// Special moves on the street: each fighter's specials, same inputs, animation and shout, with an
// effect reworked for a crowd of enemies along a street instead of one opponent:
//   shot     something flies down the lane (the move's prop): projectile, bind (tapes them up), cat (runs
//            through everyone in the lane)
//   beam     a beam along the lane, hitting everyone in it
//   audit    a fan of red figures, then money bursts out of everyone it reaches
//   orbital  a reticle locks onto the nearest enemy, then a strike from the sky hits everyone under it
//   rain     a downpour over the stretch of street ahead
//   daze     everyone on screen (slideshow: bored stiff) or ahead (stun) is left dizzy
//   dash     the fighter charges along the lane (dash), or spins along it (tornado), hitting all in the way
//   van      the move's vehicle drives through the lane from behind (charge)
//   strike   a big hit in front: melee, uppercut, flip, stretch (long reach), flurry (many hits),
//            teleport (behind the nearest enemy first)
//   area     a spin that hits everyone around
//   float    rise out of reach, drift, and come down with a slam (Left Shift drops early)
//   abduct   the nearest enemy is magicked into the air
const STREET_SPECIALS = {
  projectile: "shot", bind: "shot", cat: "shot", beam: "beam", audit: "audit", orbital: "orbital", rain: "rain",
  slideshow: "daze", stun: "daze", dash: "dash", tornado: "dash", charge: "van", melee: "strike", uppercut: "strike",
  flip: "strike", hurricane: "dash", stretch: "strike", flurry: "strike", teleport: "strike", area: "area", float: "float", abduct: "abduct",
};
const AIR_STATES = new Set(["jump", ...Object.keys(HERO_MOVES).filter(k => HERO_MOVES[k].air)]);
// Per difficulty: how many enemies attack at once, ticks they wait between attacks, how long
// their windups are, how hard they hit, and how often a blocker blocks.
const STREET_LEVELS = {
  easy:   { attackers: 2, think: 70, windup: 1.25, damage: 0.8,  block: 0.25 },
  medium: { attackers: 2, think: 48, windup: 1.0,  damage: 1.0,  block: 0.4 },
  hard:   { attackers: 3, think: 30, windup: 0.8,  damage: 1.25, block: 0.55 },
};
const RANGED_MOVE = /throw|toss|fling|spray|fire|shoot|spit|hurl|launch|laser|zap|beam|blast/i;
const LASER_MOVE = /laser|zap|beam|\bray\b|bolt|blast/i;  // a ranged move that shoots a red beam, not a thrown thing
const FLYING = /hover|\bfl(y|ies|ying)\b|float|airborne|drone|propeller|rotor|levitat/i;  // kept off the ground
const HOVER = 22;  // how high a flying enemy hovers (px), bobbing a little
const CHARGE_MOVE = /charge|rush|\bram|run over|dash|tackle/i;

// An enemy kind's numbers come from its size: bigger is tougher, slower and hits harder.
function enemyKind(info, sheet, img) {
  const t = Math.max(0.8, sheet.height / 112);
  const moves = Object.entries(sheet.moves || {}).filter(([a]) => a.startsWith("attack")).map(([anim, name]) => {
    const text = info.moves.find(m => m.startsWith(name)) || name;
    const kind = RANGED_MOVE.test(text) ? "ranged" : CHARGE_MOVE.test(text) ? "charge" : "melee";
    return { anim, name, kind, laser: kind === "ranged" && LASER_MOVE.test(text) };
  });
  const flies = FLYING.test([info.name, info.look, info.fighting_style].join(" "));
  return { name: info.name, sheet, img, t, moves, hp: Math.round(14 + 22 * t * t), damage: 3 + 4 * t,
           speed: 1.25 / Math.sqrt(t), heavy: t > 1.2, canBlock: Boolean(sheet.animations.block), flies };
}

function frameOf(anim, t, hold) {
  if (hold !== undefined) return anim.frames[Math.min(hold, anim.frames.length - 1)];
  return anim.frames[Math.floor(t / (60 / anim.fps)) % anim.frames.length];
}

function drawFrame(ctx, img, f, x, y, facing, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(Math.round(x), Math.round(y));
  if (facing < 0) ctx.scale(-1, 1);
  ctx.drawImage(img, f.x, f.y, f.w, f.h, -f.ax, -f.ay, f.w, f.h);
  ctx.restore();
}

// A pixel heart (health pickup), centred on x with its point at y; it glints now and then.
const HEART = ["..oo.oo..", ".orrorrw.", "orwrrrrro", "orrrrrrro", ".orrrrro.", "..orrro..", "...oro...", "....o...."];
function drawHeart(ctx, x, y, t) {
  const glint = t % 90 < 6, colors = { o: "#2a0008", r: glint ? "#ff8a9a" : "#e8203a", w: "#ffffff" };
  HEART.forEach((row, j) => [...row].forEach((c, i) => {
    if (c === ".") return;
    ctx.fillStyle = colors[c] || colors.r;
    ctx.fillRect(x - 9 + i * 2, y - 16 + j * 2, 2, 2);
  }));
}

// Someone on the street: x along it, z the screen row their feet are on (depth), h height off the ground.
class Brawler {
  setState(s) { this.state = s; this.t = 0; this.struck = new Set(); }
  get down() { return ["fall", "down", "getup", "dead"].includes(this.state); }
  box(b) {
    const [l, t, w, h] = b;
    return { x: this.facing > 0 ? this.x + l : this.x - l - w, y: this.z - this.h - (this.lift || 0) + t, w, h };
  }
  hurtBox() { return this.box(this.frame().hurt); }
  fallFrom(dir, vx = 2.4) {  // a hovering enemy falls from its hover height
    this.setState("fall"); this.vx = dir * vx; this.vh = 3.2; this.h = Math.max(this.h + (this.lift || 0), 1); this.lift = 0;
  }
  // knocked-down physics; returns true when it has landed and stayed down long enough
  updateDown(street) {
    if (this.state === "fall") {
      this.x += this.vx; this.h += this.vh; this.vh -= GRAVITY;
      if (this.h <= 0 && this.t > 4) { this.h = 0; this.vx = 0; this.setState("down"); sfx("land", { x: this.x }); street.shake = 4; }
    } else if (this.state === "down" && this.t >= STREET.down) {
      if (this.hp <= 0) this.setState("dead"); else this.setState("getup");
    } else if (this.state === "getup" && this.t >= STREET.getup) {
      this.setState("idle"); this.invuln = STREET.invuln;
    }
  }
}

class Hero extends Brawler {
  constructor(char, x, z) {
    super();
    this.char = char; this.sheet = char.sheetData; this.stats = char.stats;
    Object.assign(this, { x, z, h: 0, vh: 0, vx: 0, facing: 1, hp: char.stats.health, trail: char.stats.health,
                          chain: 0, lastPunch: -99, invuln: 0, stagger: 0, lastHurt: -99, combo: 0, comboLast: -99,
                          combos: [], comboShow: null, cooldowns: {}, breakerCooldown: 0, shout: null, sp: null });
    this.setState("idle");
  }
  anim(name) {
    const a = this.sheet.animations;
    while (!a[name] && FALLBACK_ANIMS[name]) name = FALLBACK_ANIMS[name];
    return a[name] || a.idle;
  }
  frame() {
    const s = this.state, mv = HERO_MOVES[s];
    if (mv) return frameOf(this.anim(mv.anim || s), 0, this.t < mv.startup ? 0 : 1);
    if (s === "special") return frameOf(this.anim(this.sp.id), 0, this.t < SPECIAL.startup ? 0 : 1);
    if (["fall", "down", "dead"].includes(s)) return frameOf(this.anim("ko"), 0, 0);
    if (s === "getup") return frameOf(this.anim("crouch"), 0, 0);
    if (s === "jump") return frameOf(this.anim("jump"), 0, 0);
    const a = this.anim(s);
    return a.loop ? frameOf(a, this.t) : frameOf(a, 0, 0);
  }
  endCombo() {
    if (this.combo >= 2) { this.combos.push(this.combo); this.comboShow = { n: this.combo, t: 0, done: true }; }
    this.combo = 0;
  }
}

class Grunt extends Brawler {
  constructor(kind, x, z, side) {
    super();
    this.kind = kind;
    Object.assign(this, { x, z, h: 0, vh: 0, vx: 0, facing: -side, hp: kind.hp, invuln: 0, stagger: 0,
                          cooldown: 30 + Math.random() * 40, move: null, homeZ: z, wander: Math.random() * 600 });
    this.setState("enter");
  }
  anim(name) { const a = this.kind.sheet.animations; return a[name] || a.idle; }
  frame() {
    const s = this.state;
    if (["fall", "down", "dead"].includes(s)) return frameOf(this.anim("ko"), 0, 0);
    if (s === "windup") return frameOf(this.anim(this.move.anim), 0, 0);
    if (s === "strike") return frameOf(this.anim(this.move.anim), 0, 1);
    if (s === "hit" || s === "getup" || s === "dizzy") return frameOf(this.anim("hit"), 0, 0);
    if (s === "block") return frameOf(this.anim("block"), 0, 0);
    return frameOf(this.anim(this.moving ? "walk" : "idle"), this.t + this.wander);
  }
  get hittable() { return !this.down && this.state !== "enter" && !this.invuln; }
}

class Street {
  // mini: the mini boss's character (level.mini_boss names them), and onMini(), called when the
  // hero reaches them: it runs their one-round match and calls resume() if the hero wins.
  // arena: the boss's arena picture, approached at the end of the street (level.boss.view).
  constructor({ level, base, imgs, kinds, hero, boss, arena = null, mini = null, onMini = null, music, difficulty = "easy", onEnd }) {
    this.canvas = $("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    Object.assign(this, { level, base, imgs, kinds, boss, music, onEnd, onMini });
    // The street's last screen shows the boss's arena small, in its backdrop. Walking up to the boss,
    // the arena picture grows from there to fill the screen (approach: 0 to 1), and the fight is on it.
    this.arena = arena && level.boss?.view ? { img: arena, view: level.boss.view } : null;
    this.approach = 0;
    this.lv = STREET_LEVELS[difficulty] || STREET_LEVELS.easy;
    this.top = level.floor_y + 10; this.bottom = H - 3;  // the rows feet can stand on
    this.hero = new Hero(hero, 70, (this.top + this.bottom) / 2);
    Object.assign(this, { camX: 0, lock: null, wave: 0, spawns: [], enemies: [], shots: [], sparks: [],
                          beaten: 0, ticks: 0, clock: 0, phase: "intro", phaseT: 0, shake: 0, go: 0,
                          paused: false, lastEnemy: null, total: level.waves.reduce((n, w) => n + w.enemies.length, 0) });
    this.keys = new Set(); this.pending = null; this.engagedSet = new Set();
    this.buffer = [];  // recent inputs as tokens (W A S D LMB RMB), for special moves and the breaker
    this.fx = [];      // special move effects in play
    // Props along the street. The small ones (boxes, a cabinet, a bench) can be smashed; tall
    // fixtures like lamp posts can't. Older levels have no "breakable" flag: go by height.
    this.props = level.props.map(p => ({ ...p, hits: 0, shake: 0,
      breakable: p.breakable ?? imgs[p.image].height < 125 }));
    this.debris = [];  // pieces of smashed props, flying
    this.pickups = []; // hearts dropped by smashed props, and the "+HP" each leaves when taken
    // The boss waits in front of their arena at the end of the street.
    this.bossAt = { x: level.width - 64, z: (this.top + this.bottom) / 2 };
    // The mini boss waits halfway along, once the waves before them are beaten.
    this.mini = level.mini_boss && mini ? { ...level.mini_boss, char: mini, z: (this.top + this.bottom) / 2, done: false } : null;
    // Left Shift crouches; it's kept apart from the right one.
    const name = e => e.code === "ShiftLeft" ? "lshift" : keyName(e);
    this.onKeyDown = e => {
      if (e.target.matches?.("input, textarea")) return;
      const k = name(e);
      if (ARROW_KEYS[e.key] || e.key === " ") e.preventDefault();
      if (e.key === "Escape") { this.paused = !this.paused; music.duck(this.paused); sfx("pause"); return; }
      if (this.paused) {
        if (k === "m") music.toggleMute();
        if (k === "n") sound.toggleMute();
        if (k === "q") this.finish(true);
        return;
      }
      if (e.repeat) { this.keys.add(k); return; }
      if (k === "a" || k === "d") this.lastH = k;
      if (k === "w" || k === "s") this.lastV = k;
      const token = { w: "W", a: "A", s: "S", d: "D", lshift: "S" }[k];
      if (token) this.pushToken(token);
      if (k === "j") this.attack("LMB");
      else if (k === "k") this.attack("RMB");
      else if (e.key === " ") this.press("jump");
      else if (e.key === "Enter") this.press("start");
      this.keys.add(k);
    };
    this.onKeyUp = e => this.keys.delete(name(e));
    this.onMouse = e => {
      if (e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      this.attack(e.button === 0 ? "LMB" : "RMB");
    };
    this.onContext = e => e.preventDefault();
    this.onBlur = () => this.keys.clear();
  }

  press(what, more = {}) { this.pending = { what, until: this.clock + 9, ...more }; }

  // Special inputs are written for facing right (D = forward); facing left, A and D swap, as in a match.
  pushToken(token) {
    if (this.hero.facing < 0) token = { A: "D", D: "A" }[token] || token;
    const now = performance.now();
    this.buffer.push({ token, time: now });
    this.buffer = this.buffer.filter(b => now - b.time < 2000).slice(-10);
  }

  // A punch or kick press: a special move if it ends one's input, the combo breaker, up + punch for
  // the uppercut, else a plain punch or kick.
  attack(token) {
    this.pushToken(token);
    const b = this.buffer, n = b.length, now = performance.now(), tokens = (i, j) => b.slice(i, j).map(x => x.token).join("");
    if (token === "LMB" && n >= 4 && (tokens(n - 4, n - 1) === "SSW" || (tokens(n - 4, n - 1) === "SWW" && n >= 5 && tokens(n - 5, n - 1) === "SSWW"))
        && now - b[n - 4].time < SEQ_GAP * 3) {
      this.buffer = [];
      return this.press("breaker");
    }
    const sp = [...this.hero.char.specials].sort((x, y) => y.input.length - x.input.length).find(sp => {
      const recent = b.slice(-sp.input.length);
      return recent.length === sp.input.length && recent.every((r, i) => r.token === sp.input[i]) &&
        recent.every((r, i) => i === 0 || r.time - recent[i - 1].time <= SEQ_GAP);
    });
    if (sp) { this.buffer = []; return this.press("special", { sp, token }); }
    const lastUp = [...b].reverse().find(x => x.token === "W");
    if (token === "LMB" && (this.keys.has("w") || (lastUp && now - lastUp.time < 200))) return this.press("uppercut");
    this.press(token === "LMB" ? "punch" : "kick");
  }

  specialReady(sp) { return (this.hero.cooldowns[sp.id] || 0) <= this.clock; }

  start() {
    for (const [ev, fn] of [["keydown", this.onKeyDown], ["keyup", this.onKeyUp], ["mousedown", this.onMouse],
                            ["contextmenu", this.onContext], ["blur", this.onBlur]]) window.addEventListener(ev, fn);
    music.play(this.music);
    this.last = performance.now(); this.acc = 0; this.running = true;
    requestAnimationFrame(this.frame.bind(this));
  }

  stop() {
    this.running = false;
    for (const [ev, fn] of [["keydown", this.onKeyDown], ["keyup", this.onKeyUp], ["mousedown", this.onMouse],
                            ["contextmenu", this.onContext], ["blur", this.onBlur]]) window.removeEventListener(ev, fn);
  }

  frame(now) {
    if (!this.running) return;
    this.acc = Math.min(this.acc + (now - this.last), 250);
    this.last = now;
    while (this.acc >= TICK) { if (!this.paused) this.update(); this.acc -= TICK; }
    if (this.running) this.draw();
    requestAnimationFrame(this.frame.bind(this));
  }

  finish(quit) {
    if (this.finished) return;  // the frame loop may run another tick after the end
    this.finished = true;
    this.stop();
    const hero = this.hero;
    hero.endCombo();
    this.onEnd({ quit, cleared: this.phase === "boss", fight: this.phase === "boss" ? this.fightSetup() : null,
                 enemies: this.beaten, combos: hero.combos, mini_boss: !!this.mini?.done,
                 street_seconds: Math.max(3, Math.round(this.ticks / 60)), health_left: Math.max(0, Math.round(hero.hp)) });
  }

  // Before a fight, the hero and their opponent walk to where the fight starts: the row of the street
  // a match's floor is on (GROUND), 140 apart in the middle of the view the fight will open on (camX).
  // The fight then starts from exactly there, on a picture of the same street (fightSetup), so
  // nothing jumps. foe: an object with x and z (the mini boss, or bossAt), char its fighter.
  startWalkIn(foe, camX, char) {
    const mid = camX + W / 2;
    foe.char = char;
    this.walkIn = { camX, foe, hero: { x: mid - 70, z: GROUND }, to: { x: mid + 70, z: GROUND } };
  }

  // One tick of walking in; true once both are in place (and the hero is back on their feet).
  updateWalkIn() {
    const w = this.walkIn, h = this.hero;
    if (!w) return true;
    this.updateDebris(); this.sparks = this.sparks.filter(s => ++s.t < 12);
    if (!["idle", "walk"].includes(h.state) || h.h > 0) { this.updateHero(); return false; }  // land, get up
    const step = (a, to, speed) => {
      const dx = to.x - a.x, dz = to.z - a.z, dist = Math.hypot(dx, dz);
      if (dist <= speed) { a.x = to.x; a.z = to.z; return true; }
      a.x += dx / dist * speed; a.z += dz / dist * speed;
      return false;
    };
    h.t++;
    const heroThere = step(h, w.hero, h.stats.walk_speed * STREET.walk);
    if (heroThere) { h.facing = 1; if (h.state !== "idle") h.setState("idle"); }
    else { h.facing = w.hero.x >= h.x ? 1 : -1; if (h.state !== "walk") h.setState("walk"); }
    const foeThere = step(w.foe, w.to, (w.foe.char.stats.walk_speed || 2) * STREET.walk);
    w.foe.moving = !foeThere;
    return heroThere && foeThere;
  }

  // What the fight starts from: a picture of the street around the view, where the two stand on
  // it, and the hero's health (no healing on the way in).
  fightSetup() {
    const w = this.walkIn;
    if (this.phase === "boss" && this.arena) {  // the arena picture itself, right edge on the screen's
      const img = this.arena.img, off = Math.max(W, img.width) - W - this.camX;
      return { img, starts: [this.hero.x + off, w.foe.x + off], health: this.hero.hp };
    }
    const img = this.snapshot(w.camX + W / 2);
    // the fight draws the street itself (scrolling as the street does, front props in front), so the
    // backdrop doesn't move when it starts or ends; img only sets how far the fight can roam
    const stage = { back: (ctx, camX) => this.drawStage(ctx, this.snapX + camX, "back"),
                    front: (ctx, camX) => this.drawStage(ctx, this.snapX + camX, "front") };
    return { img, stage, starts: [this.hero.x - this.snapX, w.foe.x - this.snapX], health: this.hero.hp };
  }

  // The backdrop (scrolling slower than the ground) and the pavement, for a camera at cx.
  drawGround(ctx, cx) {
    const L = this.level;
    ctx.drawImage(this.imgs[L.back.image], -Math.round(cx * L.back.parallax), 0);
    const fl = this.imgs[L.floor.image];
    for (let x = -(cx % fl.width); x < W; x += fl.width) ctx.drawImage(fl, Math.round(x), L.floor_y);
  }

  // The street as the mini boss's match sees it: "back" is the ground, the props behind the
  // fighters and any hearts lying there; "front" the props in front of them.
  drawStage(ctx, cx, layer) {
    if (layer === "back") this.drawGround(ctx, cx);
    for (const p of this.props) if (p.layer === layer && !p.broken) {
      const im = this.imgs[p.image];
      ctx.drawImage(im, Math.round(p.x - cx - im.width / 2), p.y - im.height);
    }
    if (layer === "back") this.drawPickups(ctx, cx);
  }

  // The arena on its way in: from where the backdrop shows it (view) to filling the screen with its
  // right edge on the screen's (where a match's camera opens on it), fading in with soft edges.
  drawApproach(ctx) {
    const a = this.arena, v = a.view, t = this.approach;
    const e = t * t * (3 - 2 * t), lerp = (p, q) => p + (q - p) * e;
    const aw = Math.max(W, a.img.width), k = lerp(v.scale, 1);
    const x = lerp(v.x, W - aw), y = lerp(v.y, 0);
    const c = a.canvas ??= Object.assign(document.createElement("canvas"), { width: aw, height: H });
    const g = c.getContext("2d"), fade = 60 * (1 - e);  // soft left and top edges, gone by the end
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, aw, H); g.drawImage(a.img, 0, 0, aw, H);
    if (fade > 0.5) {
      g.globalCompositeOperation = "destination-in";
      let grad = g.createLinearGradient(0, 0, fade, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,1)");
      g.fillStyle = grad; g.fillRect(0, 0, aw, H);
      grad = g.createLinearGradient(0, 0, 0, fade);
      grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,1)");
      g.fillStyle = grad; g.fillRect(0, 0, aw, H);
    }
    // It starts exactly over the backdrop's copy of it, so it can turn opaque early: a short fade
    // (the backdrop's own trees and the ground below it), then a clean zoom with no double image.
    ctx.save(); ctx.globalAlpha = Math.min(1, t * 4); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, Math.round(x), Math.round(y), Math.round(aw * k), Math.round(H * k));
    ctx.restore();
  }

  // The street around x as one picture (backdrop, pavement, props; no one on it), for the
  // mini boss's match to be fought on: it stays on the street instead of cutting to an arena.
  snapshot(x, width = W * 2) {
    const L = this.level, c = document.createElement("canvas");
    const cx = clamp(Math.round(x - width / 2), 0, Math.max(0, L.width - width));
    this.snapX = cx;  // where the picture starts on the street, to map the fight back onto it
    c.width = width; c.height = H;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.imgs[L.back.image], -Math.round(cx * L.back.parallax), 0);
    const fl = this.imgs[L.floor.image];
    for (let fx = -(cx % fl.width); fx < width; fx += fl.width) ctx.drawImage(fl, Math.round(fx), L.floor_y);
    for (const p of this.props) {
      if (p.broken) continue;
      const im = this.imgs[p.image];
      ctx.drawImage(im, Math.round(p.x - cx - im.width / 2), p.y - im.height);
    }
    return c;
  }

  // Back on the street after beating the mini boss, with the health the hero had before. The street
  // takes over the fight's last view (its camera and where the hero stood), so nothing jumps.
  resume(match) {
    if (match) {
      this.camX = clamp(this.snapX + match.camX(), 0, this.level.width - W);
      this.hero.x = this.snapX + match.p1.x; this.hero.facing = match.p1.facing;
      this.hero.hp = this.hero.trail = Math.max(1, match.p1.health);  // what the fight left, no healing
      // the beaten mini boss stays down where they fell for a moment, then fades
      this.mini.beaten = { x: this.snapX + match.p2.x, z: GROUND, facing: match.p2.facing, t: 0,
                           img: match.p2.char.img };  // (a mirror match's recolored sprite)
    }
    this.walkIn = null;
    this.heroWas = this.hero.x;  // the fight moved the hero; that isn't walking for the camera to chase
    this.mini.done = true;
    this.lock = null; this.phase = "play"; this.phaseT = 0; this.go = 200;
    this.keys.clear(); this.buffer = [];
    this.hero.setState("idle");
    this.start();
    sfx("ready");
  }

  // ------------------------------------------------------------ update

  update() {
    this.clock++; this.phaseT++;
    if (this.pending && this.clock > this.pending.until) this.pending = null;
    const hero = this.hero;
    if (this.phase === "intro") {
      if (this.pending || this.phaseT > 60 * 20) { this.pending = null; this.phase = "play"; this.phaseT = 0; sfx("fight"); sfx("vo_fight"); }
      return;
    }
    if (this.phase === "mini") {  // the mini boss has their say while the two walk into place
      if (this.phaseT === 1) sfx("round");
      // ease the camera so the two of them face off mid-screen
      const d = this.walkIn.camX - this.camX;
      this.camX += Math.sign(d) * Math.min(Math.abs(d), 3);
      const ready = this.updateWalkIn();
      // "away" until resume(): the frame loop may still run a tick or two after stop()
      if (ready && this.phaseT >= 110 && this.camX === this.walkIn.camX) {
        this.phase = "away"; this.stop(); this.onMini(this.fightSetup());
      }
      return;
    }
    if (this.phase === "boss") {  // the boss's taunt while the two walk into place, up to the arena
      if (this.arena) this.approach = Math.min(1, this.phaseT / 150);
      const ready = this.updateWalkIn() && (!this.arena || this.approach >= 1);
      if (ready && (this.phaseT > 60 * 6 || (this.phaseT > 40 && this.pending))) this.finish(false);
      return;
    }
    if (this.phase === "away") return;
    if (this.phase === "play") this.ticks++;
    if (hero.combo && this.clock - hero.comboLast > COMBO.window) hero.endCombo();
    if (hero.comboShow && ++hero.comboShow.t > 80) hero.comboShow = null;
    this.updateHero();
    this.updateWaves();
    this.engagedSet = this.engaged();
    for (const e of this.enemies) this.updateEnemy(e);
    this.separate();
    this.updateShots();
    this.updateFx();
    this.updateDebris();
    this.updatePickups();
    for (const e of this.enemies) if (e.state === "dead" && e.t === 1) { this.beaten++; sfx("ko", { x: e.x }); }
    this.enemies = this.enemies.filter(e => !(e.state === "dead" && e.t > 70));
    this.sparks = this.sparks.filter(s => ++s.t < 12);
    hero.trail = Math.max(hero.hp, hero.trail - 0.35);
    if (this.shake > 0) this.shake--;
    if (this.go > 0) this.go--;

    if (this.phase === "play" && hero.state === "dead") { this.phase = "over"; this.phaseT = 0; sfx("lose"); sfx("vo_you_lose"); }
    if (this.phase === "over" && this.phaseT > 200) this.finish(false);
    if (this.phase === "play" && this.wave >= this.level.waves.length && !this.enemies.length && (!this.mini || this.mini.done) &&
        this.camX >= this.level.width - W - 1 && hero.x > this.level.width - W * 0.55) {
      this.phase = "boss"; this.phaseT = 0; sfx("round");
      this.bossAt.facing = -1;
      this.startWalkIn(this.bossAt, this.camX, this.boss);
    }
  }

  input() {
    const k = this.keys;
    return { move: axis(k, "d", "a", this.lastH), depth: axis(k, "s", "w", this.lastV),
             block: k.has("l"), crouch: k.has("lshift") };
  }

  take() { const p = this.pending; this.pending = null; this.lastTaken = p; return p?.what; }

  updateHero() {
    const h = this.hero, s = h.stats, inp = this.phase === "play" ? this.input() : { move: 0, depth: 0 };
    const speed = s.walk_speed * STREET.walk;
    h.t++;
    if (h.invuln) h.invuln--;
    if (this.clock - h.lastHurt > 60) h.stagger = 0;
    if (h.breakerCooldown) h.breakerCooldown--;
    if (h.shout && --h.shout.t <= 0) h.shout = null;
    // Combo breaker: only while being beaten on (hit within the combo window), not too often.
    if (this.pending?.what === "breaker" && this.phase === "play" && !h.down && !h.breakerCooldown &&
        this.clock - h.lastHurt < COMBO.window && h.state !== "special") {
      this.take();
      h.setState("breaker"); h.vh = BREAKER.jump; h.vx = h.facing * 1.5; h.h = Math.max(h.h, 0.01);
      h.invuln = BREAKER.invuln; h.breakerCooldown = BREAKER.cooldown; h.stagger = 0;
      sfx("vo_combo_breaker"); sfx("special"); this.shake = 8;
      h.shout = { text: "COMBO BREAKER!", t: 70 };
    }
    // Rising uppercut: punch just as you get up (STREET_WAKEUP). Too early while lying there spends the chance.
    if (h.state === "fall") h.wakeSpent = false;
    if (h.down && h.hp > 0 && this.phase === "play" && ["punch", "uppercut"].includes(this.pending?.what)) {
      this.take();
      if (h.state === "down" && h.t < STREET.down - STREET_WAKEUP.early) h.wakeSpent = true;
      else if (h.state !== "fall" && !h.wakeSpent) this.wakeUp();
    }
    const mv = HERO_MOVES[h.state], wasDown = h.down;
    if (h.down) {
      h.updateDown(this); if (h.state === "dead") h.hp = 0;
      if (wasDown && h.state === "idle") h.upAt = this.clock;
    }
    else if (h.state === "hit") { if (h.t >= 18) h.setState("idle"); }
    else if (h.state === "special") this.updateSpecial(inp);
    else if (AIR_STATES.has(h.state)) {
      h.x += h.vx; h.h += h.vh; h.vh -= GRAVITY;
      const act = h.state === "jump" && this.phase === "play" && ["punch", "kick", "uppercut"].includes(this.pending?.what) ? this.take() : null;
      if (act) {
        const name = inp.crouch ? "dive_kick" : act === "kick" ? "jump_kick" : "jump_punch";
        h.setState(name); sfx(act === "kick" || inp.crouch ? "kick_whoosh" : "punch_whoosh", { x: h.x });
        if (name === "dive_kick") { h.vh = -4.5; h.vx = h.facing * 3.2; }
      }
      if (h.h <= 0 && h.t > 1) { h.h = 0; h.vh = 0; h.vx = 0; h.setState("idle"); sfx("land", { x: h.x }); }
    } else if (mv) {
      if (h.t >= mv.startup + mv.active + mv.recovery) {
        if (h.state === "punch") h.lastPunch = this.clock;
        h.setState("idle");
      }
    } else if ((h.state === "block" && (!inp.block || inp.crouch)) || (h.state === "crouch_block" && (!inp.block || !inp.crouch)) ||
               (h.state === "crouch" && (!inp.crouch || inp.block))) {
      h.setState("idle");
    } else if (h.state !== "block" && h.state !== "crouch_block") {  // idle, walking or crouching: free to act
      let act = this.phase === "play" ? this.take() : null;
      const p = this.lastTaken;
      if (act === "special") {
        if (this.specialReady(p.sp)) { this.startSpecial(p.sp); act = "started"; }
        else act = p.token === "LMB" ? "punch" : "kick";  // still cooling down: a plain attack instead
      }
      if (act === "breaker") act = "uppercut";  // not being comboed: up + punch
      if ((act === "punch" || act === "uppercut") && !h.wakeSpent && this.clock - (h.upAt ?? -99) <= STREET_WAKEUP.late) {
        this.wakeUp(); act = "started";  // a moment late, just after standing up: still counts
      }
      if (act === "started") {
        // the special move began above
      } else if (act === "uppercut" && !inp.crouch) {
        h.chain = 0; this.heroAttack("uppercut"); h.vh = 5.5; h.vx = h.facing * 0.8; h.h = 0.01;
      } else if (inp.crouch && act !== "jump") {  // crouching: no walking, attacks and blocks go low
        if (act === "punch" || act === "uppercut") { h.chain = 0; this.heroAttack("crouch_punch"); }
        else if (act === "kick") { h.chain = 0; this.heroAttack("crouch_kick"); }
        else if (inp.block) h.setState("crouch_block");
        else if (h.state !== "crouch") h.setState("crouch");
      } else if (act === "punch" || act === "uppercut") {
        h.chain = this.clock - h.lastPunch <= STREET.chain ? h.chain + 1 : 1;
        if (h.chain >= 3) { h.chain = 0; this.heroAttack("finisher"); } else this.heroAttack("punch");
      } else if (act === "kick") {
        h.chain = 0; this.heroAttack("kick");
      } else if (act === "jump") {
        h.setState("jump"); h.vh = s.jump_power; h.vx = inp.move * speed; h.h = 0.01;
      } else if (inp.block) {
        h.setState("block");
      } else {
        h.x += inp.move * speed; h.z += inp.depth * speed * STREET.depth;
        if (inp.move) h.facing = inp.move;
        const moving = Boolean(inp.move || inp.depth);
        if (moving !== (h.state === "walk")) h.setState(moving ? "walk" : "idle");
      }
    }
    // Never left standing in the air: anything that ends an air state early drops to the ground.
    if (h.h > 0 && !h.down && !AIR_STATES.has(h.state) && h.state !== "special") {
      h.h += h.vh; h.vh -= GRAVITY;
      if (h.h <= 0) { h.h = 0; h.vh = 0; h.vx = 0; }
    }
    // hits land during the active ticks of the move
    const m = HERO_MOVES[h.state];
    if (m && h.t >= m.startup && h.t < m.startup + m.active) {
      const f = h.frame(), box = h.box(m.box || f.hit || [12, -86, 30, 40]);
      for (const e of this.enemies) {
        if (!e.hittable || h.struck.has(e) || Math.abs(e.z - h.z) > STREET.reach || !overlap(box, e.hurtBox())) continue;
        h.struck.add(e);
        this.hitEnemy(e, m, box);
      }
      for (const p of this.props) {
        if (!p.breakable || p.broken || h.struck.has(p) || !this.nearProp(p)) continue;
        const half = this.imgs[p.image].width / 2;
        if (box.x + box.w < p.x - half + 4 || box.x > p.x + half - 4) continue;
        h.struck.add(p);
        this.hitProp(p, m, box);
      }
    }
    h.z = clamp(h.z, this.top, this.bottom);
    h.x = clamp(h.x, this.camX + 14, Math.min(this.camX + W - 14, this.bossAt.x - 70,
                                              this.mini && !this.mini.done ? this.mini.x - 50 : Infinity));
  }

  // Back-row props stand just behind the walkable area, front-row ones just in front of it.
  nearProp(p) {
    const h = this.hero;
    return p.layer === "front" ? p.y - h.z <= STREET.propReach + 14 : h.z - p.y <= STREET.propReach;
  }

  hitProp(p, m, box) {
    const h = this.hero;
    this.sparks.push({ x: h.facing > 0 ? box.x + box.w : box.x, y: box.y + box.h / 2, t: 0 });
    p.hits += m.knock ? 2 : 1; p.shake = 10;
    if (p.hits < STREET.propHits) { sfx("hit_light", { x: p.x }); return; }
    // Smashed: cut the picture into chunks that fly apart, away from the hero.
    p.broken = true; this.shake = 6;
    sfx("slam", { x: p.x }); sfx("hit_heavy", { x: p.x });
    const im = this.imgs[p.image], cols = 4, rows = 4, cw = Math.ceil(im.width / cols), ch = Math.ceil(im.height / rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const sx = c * cw, sy = r * ch;
      this.debris.push({ img: im, sx, sy, sw: cw, sh: ch, layer: p.layer,
        x: p.x - im.width / 2 + sx + cw / 2, y: p.y - im.height + sy + ch / 2, ground: p.y,
        vx: h.facing * (0.6 + Math.random() * 2.2) + (c - (cols - 1) / 2) * 0.7,
        vy: -2 - Math.random() * 3 - (rows - r) * 0.4, spin: (Math.random() - 0.5) * 0.4, a: 0, t: 0 });
    }
    if (Math.random() < STREET.heartChance) {
      // pops out with a little hop and lands on the nearest row the hero can walk on
      this.pickups.push({ x: p.x, z: p.layer === "front" ? this.bottom - 3 : this.top + 3, h: 1, vh: 3.5, t: 0 });
    }
  }

  updatePickups() {
    const hero = this.hero, full = hero.stats.health;
    for (const k of this.pickups) {
      k.t++;
      if (k.taken) continue;
      if (k.h > 0) { k.h += k.vh; k.vh -= 0.3; if (k.h <= 0) { k.h = 0; k.vh = 0; } continue; }
      if (hero.down || hero.h > 10 || Math.abs(hero.x - k.x) > 16 || Math.abs(hero.z - k.z) > 10) continue;
      k.taken = true; k.t = 0;
      hero.hp = Math.min(full, hero.hp + full * STREET.heartHeal);
      sfx("menu_select", { x: k.x });
    }
    this.pickups = this.pickups.filter(k => !k.taken || k.t < 40);
  }

  drawPickups(ctx, cx) {
    ctx.save(); ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
    for (const k of this.pickups) {
      const x = Math.round(k.x - cx);
      if (k.taken) {  // "+HP" floats up and fades
        ctx.globalAlpha = 1 - k.t / 40;
        outlinedText(ctx, "+HP", x, Math.round(k.z - 24 - k.t * 0.6), "#7dff8a", 2);
        ctx.globalAlpha = 1;
        continue;
      }
      const bob = k.h > 0 ? 0 : Math.round(Math.sin(k.t / 9) * 1.5);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath(); ctx.ellipse(x, Math.round(k.z) + 1, 7, 2, 0, 0, Math.PI * 2); ctx.fill();
      drawHeart(ctx, x, Math.round(k.z - k.h - 6 + bob), k.t);
    }
    ctx.restore();
  }

  updateDebris() {
    for (const p of this.props) if (p.shake) p.shake--;
    for (const d of this.debris) {
      d.t++; d.x += d.vx; d.y += d.vy; d.a += d.spin;
      if (d.y >= d.ground - 2) { d.y = d.ground - 2; d.vy *= -0.3; d.vx *= 0.7; d.spin *= 0.6; }
      else d.vy += 0.35;
    }
    this.debris = this.debris.filter(d => d.t < 70);
  }

  drawDebris(ctx, cx, layer) {
    for (const d of this.debris) {
      if (d.layer !== layer) continue;
      ctx.save();
      ctx.globalAlpha = d.t < 45 ? 1 : 1 - (d.t - 45) / 25;
      ctx.translate(Math.round(d.x - cx), Math.round(d.y)); ctx.rotate(d.a);
      ctx.drawImage(d.img, d.sx, d.sy, d.sw, d.sh, -d.sw / 2, -d.sh / 2, d.sw, d.sh);
      ctx.restore();
    }
  }

  wakeUp() {
    const h = this.hero;
    h.setState("wakeup"); h.vh = STREET_WAKEUP.jump; h.vx = h.facing * 0.8; h.h = 0.01; h.chain = 0; h.stagger = 0;
    h.invuln = Math.max(h.invuln, STREET_WAKEUP.invuln); h.wakeSpent = true; h.upAt = -99;
    sfx("special"); sfx("punch_whoosh", { x: h.x }); this.shake = 5;
    h.shout = { text: "RISING UPPERCUT!", t: 50 };
  }

  heroAttack(name) {
    const h = this.hero;
    h.setState(name);
    sfx(name.endsWith("kick") ? "kick_whoosh" : "punch_whoosh", { x: h.x });
    // A blocker sees it coming
    for (const e of this.enemies) {
      if (e.kind.canBlock && ["idle", "approach"].includes(e.state) && Math.abs(e.x - h.x) < 70 &&
          Math.abs(e.z - h.z) < 14 && Math.random() < this.lv.block) {
        e.facing = h.x >= e.x ? 1 : -1; e.setState("block");
      }
    }
  }

  hitEnemy(e, m, box) {
    const h = this.hero, dir = m.around ? (e.x >= h.x ? 1 : -1) : h.facing;
    const sx = dir > 0 ? box.x + box.w : box.x, sy = box.y + box.h / 2;
    if (e.state === "block" && e.facing === -dir && !m.unblockable) {
      sfx("block", { x: e.x }); this.sparks.push({ x: sx, y: sy, t: 0, blocked: true });
      e.x += dir * 2;
      return;
    }
    this.sparks.push({ x: sx, y: sy, t: 0 });
    this.damage(e, m.damage(h.stats), dir, { knock: m.knock, stun: m.stun, push: m.push, launch: m.launch, fling: m.fling });
  }

  // Damage an enemy: knocked down by a knockdown move, a fourth hit in a row or running out of health;
  // otherwise it flinches (stun: ticks), or is left dizzy (daze: ticks) or launched (launch: speed up).
  // fling: how fast a launched enemy flies sideways.
  damage(e, amount, dir, { knock = false, stun = 16, push = 1.5, daze = 0, launch = 0, fling = 1.2, taped = false } = {}) {
    const h = this.hero;
    if (!e.hittable && e.state !== "dizzy") return false;
    e.hp -= amount;
    this.lastEnemy = e;
    sfx(knock || launch ? "hit_heavy" : "hit_light", { x: e.x });
    h.combo++; h.comboLast = this.clock;
    if (h.combo >= 2) h.comboShow = { n: h.combo, t: 0 };
    e.stagger++; e.lastHitT = this.clock;
    e.facing = -dir;
    if (launch) {
      e.stagger = 0; e.fallFrom(dir, fling); e.vh = launch; this.shake = 6;
    } else if (knock || e.hp <= 0 || e.stagger >= 4) {
      e.stagger = 0; e.fallFrom(dir, e.kind.heavy ? 1.4 : 2.6); this.shake = 6;
    } else if (daze) {
      e.setState("dizzy"); e.stunFor = daze; e.taped = taped;
    } else {
      e.setState("hit"); e.stun = stun; e.x += dir * push;
    }
    return true;
  }

  hurtHero(e, move) {
    const h = this.hero;
    if (h.invuln || h.down || this.phase !== "play") return false;
    const dmg = e.kind.damage * this.lv.damage * (move.kind === "charge" ? 1.2 : 1);
    // Blocking: L, or holding away from the attacker (as in a match) while on the ground and free.
    const away = e.x >= h.x ? -1 : 1, inp = this.input();
    const holdBack = inp.move === away && ["idle", "walk", "crouch"].includes(h.state) && !h.h;
    if (((h.state === "block" || h.state === "crouch_block") && h.facing === -away) || holdBack) {
      if (holdBack) { h.facing = -away; h.setState(inp.crouch ? "crouch_block" : "block"); }
      sfx("block", { x: h.x }); h.x -= h.facing * 3;
      this.sparks.push({ x: h.x + h.facing * 16, y: h.z - 60, t: 0, blocked: true });
      return true;
    }
    h.hp = Math.max(0, h.hp - dmg);
    h.endCombo(); h.chain = 0;
    h.stagger++; h.lastHurt = this.clock;
    const dir = e.x >= h.x ? -1 : 1;
    h.facing = -dir;
    this.sparks.push({ x: h.x, y: h.z - 60, t: 0 });
    sfx(e.kind.heavy ? "hit_heavy" : "hit_light", { x: h.x });
    // Hit in mid-air (a jump kick met by a punch): knocked out of the air. A plain stagger has no
    // gravity, and left the hero standing on nothing until they jumped again.
    if (h.hp <= 0 || e.kind.heavy || move.kind === "charge" || h.stagger >= 3 || h.h > 0) {
      h.stagger = 0; h.fallFrom(dir, 2.2); this.shake = 6;
    } else {
      h.setState("hit"); h.x += dir * 3;
    }
    return true;
  }

  // ------------------------------------------------------------ special moves

  startSpecial(sp) {
    const h = this.hero;
    h.setState("special"); h.sp = sp; h.vx = 0; h.chain = 0;
    h.cooldowns[sp.id] = this.clock + (sp.cooldown ? Math.round(sp.cooldown * 60) : SPECIAL.cooldown);
    h.shout = { text: sp.shout || sp.name, t: 90 };
    sfx("special", { x: h.x });
  }

  canHit(e) { return e.hittable || e.state === "dizzy"; }
  // Enemies ahead of the fighter in their lane (depth within `lane`), up to `range` away.
  ahead(range, lane = STREET.reach + 4) {
    const h = this.hero;
    return this.enemies.filter(e => this.canHit(e) && Math.abs(e.z - h.z) <= lane &&
      (e.x - h.x) * h.facing > -12 && Math.abs(e.x - h.x) <= range);
  }
  around(x, z, rx, rz) {
    return this.enemies.filter(e => this.canHit(e) && Math.abs(e.x - x) <= rx && Math.abs(e.z - z) <= rz);
  }
  nearest(range) {
    const h = this.hero, dist = e => Math.hypot(e.x - h.x, (e.z - h.z) * 2);
    return this.enemies.filter(e => this.canHit(e) && dist(e) <= range).sort((a, b) => dist(a) - dist(b))[0] || null;
  }

  updateSpecial(inp) {
    const h = this.hero, sp = h.sp, kind = STREET_SPECIALS[sp.effect] || "strike", S = SPECIAL.startup;
    const t = h.t, dmg = h.stats.special_damage, dir = h.facing, prop = h.char.props?.[sp.id] || null;
    let end = S + 24;
    switch (kind) {
      case "shot":
        if (t === S) {
          this.fx.push({ type: "shot", effect: sp.effect, x: h.x + dir * 26, z: h.z, h: 50, vx: dir * (sp.effect === "cat" ? 4 : 5.5),
                         img: prop, dmg, hit: new Set(), t: 0 });
          sfx("throw", { x: h.x });
        }
        end = S + 18; break;
      case "beam":
        if (t >= S && t < S + BEAM.active && (t - S) % BEAM.every === 0) {
          for (const e of this.ahead(W)) this.damage(e, dmg / 4, dir, { knock: t - S >= BEAM.active - BEAM.every });
          this.shake = 2;
        }
        end = S + BEAM.active + BEAM.recovery; break;
      case "audit":
        if (t === S) this.fx.push({ type: "digits", x: h.x + dir * 24, z: h.z, dir, t: 0,
          parts: Array.from({ length: 36 }, () => ({ a: rand(-0.5, 0.35), v: rand(4, 7), d: String(Math.floor(rand(0, 10))), y0: rand(-64, -40) })) });
        if (t === S + 12) for (const e of this.ahead(230, 30)) {
          this.damage(e, dmg * 1.2, dir, { knock: true });
          this.fx.push({ type: "cash", x: e.x, z: e.z, t: 0, bills: Array.from({ length: 10 }, (_, i) => ({ a: i / 10 * Math.PI * 2, r: rand(14, 26), up: rand(20, 60) })) });
        }
        end = S + 34; break;
      case "orbital": {
        if (t === S) {
          const target = this.nearest(W);
          this.fx.push({ type: "orbital", target, x: target ? target.x : h.x + dir * 120, z: target ? target.z : h.z, t: 0, dmg, dir,
                         img: prop });  // a prop (MJ's hippo) drops out of the sky instead of a beam
        }
        end = S + 16; break;
      }
      case "rain":
        if (t === S) this.fx.push({ type: "rain", x0: Math.min(h.x + dir * 20, h.x + dir * 230), x1: Math.max(h.x + dir * 20, h.x + dir * 230),
                                     z: h.z, t: 0, dmg, dir, drops: [] });
        end = S + 20; break;
      case "daze":
        if (t === S) {
          const bored = sp.effect === "slideshow";
          const targets = bored ? this.enemies.filter(e => this.canHit(e) && e.x > this.camX && e.x < this.camX + W) : this.ahead(160, 26);
          for (const e of targets) this.damage(e, dmg * (bored ? 0.5 : 0.8), dir, { daze: bored ? 170 : 130 });
          this.fx.push({ type: bored ? "screen" : "drop", img: prop, t: 0, targets, x: h.x, z: h.z });
          sfx("slam", { x: h.x });
        }
        end = S + 30; break;
      case "dash":
        if (sp.effect === "tornado") {
          if (t >= S && t < S + 70) {
            h.x += dir * 2.4;
            if ((t - S) % 10 === 0) for (const e of this.around(h.x, h.z, 40, STREET.reach + 4))
              this.damage(e, dmg / 5, dir, { knock: t - S >= 60 });
          }
          end = S + 80;
        } else {
          if (t >= S && t < S + 26) {
            h.x += dir * 6;
            for (const e of this.around(h.x + dir * 12, h.z, 26, STREET.reach + 2))
              if (!h.struck.has(e)) { h.struck.add(e); this.damage(e, dmg, dir, { knock: true }); }
          }
          end = S + 34;
        }
        break;
      case "van":
        if (t === S) this.fx.push({ type: "van", img: prop, x: dir > 0 ? this.camX - 80 : this.camX + W + 80, z: h.z, vx: dir * 7,
                                     dmg, hit: new Set(), t: 0 });
        end = S + 20; break;
      case "area":
        if (t >= S && t < S + 40) {
          if (t % 6 === 0) h.facing = -h.facing;  // spinning
          if ((t - S) % 8 === 0) for (const e of this.around(h.x, h.z, 64, 22))
            this.damage(e, dmg / 5, e.x >= h.x ? 1 : -1, { knock: t - S >= 32 });
        }
        end = S + 50; break;
      case "float": {
        const speed = h.stats.walk_speed * STREET.walk;
        if (t >= S) {
          h.invuln = Math.max(h.invuln, 2);
          if (h.h < 52) h.h += 2.6;
          h.x += inp.move * speed; h.z = clamp(h.z + (inp.depth || 0) * speed * STREET.depth, this.top, this.bottom);
          if (inp.move) h.facing = inp.move;
        }
        if (t >= S + 180 || (t > S + 30 && inp.crouch)) {  // come down with a dive
          h.setState("dive_kick"); h.vh = -4.5; h.vx = h.facing * 2;
        }
        return;
      }
      case "abduct":
        if (t === S) {
          const target = this.nearest(260);
          if (target) {
            this.damage(target, dmg * 1.4, dir, { launch: 8 });
            this.fx.push({ type: "glitter", target, t: 0 });
          }
        }
        end = S + 24; break;
      case "strike": {
        const e = sp.effect;
        if (e === "teleport" && t === S) {
          const target = this.nearest(220);
          this.fx.push({ type: "puff", x: h.x, z: h.z, t: 0 });
          if (target) {
            const side = target.x >= h.x ? 1 : -1;
            h.x = target.x + side * 30; h.z = target.z; h.facing = -side;
            this.fx.push({ type: "puff", x: h.x, z: h.z, t: 0 });
          }
        }
        if (e === "flurry") {
          if (t >= S && t < S + FLURRY.active) {
            h.x += dir * FLURRY.creep;
            if ((t - S) % FLURRY.every === 0) for (const en of this.ahead(58))
              this.damage(en, dmg * FLURRY.damage / FLURRY.hits, dir, { knock: t - S >= FLURRY.active - FLURRY.every, stun: 10, push: 0.6 });
          }
          end = S + FLURRY.active + FLURRY.recovery;
        } else if (e === "flip" || e === "uppercut") {  // rise into the air, hitting on the way up
          if (t === S) { h.vh = e === "flip" ? FLIP.vy : 6.5; h.vx = dir * FLIP.vx; h.h = 0.01; }
          if (t >= S) {
            h.x += h.vx; h.h += h.vh; h.vh -= GRAVITY;
            if (h.vh > 0) for (const en of this.ahead(56, STREET.reach + 2))
              if (!h.struck.has(en)) { h.struck.add(en); this.damage(en, dmg, dir, { launch: 6 }); }
            if (h.h <= 0) { h.h = 0; h.vh = 0; h.vx = 0; h.setState("idle"); sfx("land", { x: h.x }); }
          }
          return;
        } else {
          const at = e === "teleport" ? S + 6 : S, reach = e === "stretch" ? 150 : 66;
          if (t === at) for (const en of this.ahead(reach)) this.damage(en, dmg * (e === "melee" ? 1.2 : 1), h.facing, { knock: true });
          end = S + 24;
        }
        break;
      }
    }
    if (t >= end) h.setState("idle");
  }

  updateFx() {
    const reach = STREET.reach + 2;
    for (const f of this.fx) {
      f.t++;
      switch (f.type) {
        case "shot":
          f.x += f.vx;
          for (const e of this.enemies) {
            if (!this.canHit(e) || f.hit.has(e) || Math.abs(e.z - f.z) > reach || Math.abs(e.x - f.x) > 18) continue;
            f.hit.add(e);
            const dir = Math.sign(f.vx);
            if (f.effect === "bind") { this.damage(e, f.dmg * 0.5, dir, { daze: 180, taped: true }); f.done = true; }
            else if (f.effect === "cat") this.damage(e, f.dmg * 0.6, dir, { knock: true });
            else { this.damage(e, f.dmg, dir, { knock: true }); f.done = true; }
            if (f.done) break;
          }
          if (f.x < this.camX - 60 || f.x > this.camX + W + 60) f.done = true;
          break;
        case "van":
          f.x += f.vx;
          for (const e of this.enemies)
            if (this.canHit(e) && !f.hit.has(e) && Math.abs(e.z - f.z) <= reach + 6 && Math.abs(e.x - f.x) < 34) {
              f.hit.add(e); this.damage(e, f.dmg * 1.3, Math.sign(f.vx), { knock: true });
            }
          if ((f.vx > 0 && f.x > this.camX + W + 120) || (f.vx < 0 && f.x < this.camX - 120)) f.done = true;
          break;
        case "orbital":  // track (slower than a running enemy), lock, strike
          if (f.t < ORBITAL.track && f.target && this.enemies.includes(f.target)) {
            f.x += clamp(f.target.x - f.x, -ORBITAL.follow, ORBITAL.follow);
            f.z += clamp(f.target.z - f.z, -ORBITAL.follow, ORBITAL.follow);
          }
          if (f.img && f.t === ORBITAL.track + ORBITAL.lock) sfx("throw", { x: f.x });
          if (f.t === ORBITAL.track + ORBITAL.lock + (f.img ? ORBITAL.fall : 0)) {
            for (const e of this.around(f.x, f.z, ORBITAL.width * 0.6, 18)) this.damage(e, f.dmg * ORBITAL.damage, e.x >= f.x ? 1 : -1, { knock: true });
            this.shake = 10; sfx("slam", { x: f.x }); if (f.img) sfx("hit_heavy", { x: f.x });
          }
          f.done = f.t > ORBITAL.track + ORBITAL.lock + 30 + (f.img ? ORBITAL.fall : 0);
          break;
        case "rain":
          if (f.t < 64 && f.t % 2 === 0) f.drops.push({ x: rand(f.x0, f.x1), z: f.z + rand(-26, 26), y: -10, v: rand(4, 6) });
          for (const d of f.drops) d.y += d.v;
          f.drops = f.drops.filter(d => d.y < d.z);
          if (f.t % 16 === 0 && f.t <= 64) for (const e of this.enemies)
            if (this.canHit(e) && e.x >= f.x0 && e.x <= f.x1 && Math.abs(e.z - f.z) <= 30) this.damage(e, f.dmg / 4, f.dir, { knock: f.t === 64 });
          f.done = f.t > 90;
          break;
        default:
          f.done = f.t > (f.type === "screen" ? 80 : f.type === "glitter" ? 60 : 40);
      }
    }
    this.fx = this.fx.filter(f => !f.done);
  }

  // Effects on the street, drawn with the fighters (cx: the camera).
  drawFx(ctx, cx) {
    const h = this.hero;
    if (h.state === "special") {
      const sp = h.sp, kind = STREET_SPECIALS[sp.effect], t = h.t - SPECIAL.startup;
      if (kind === "beam" && t >= 0 && t < BEAM.active) {  // on from where the drawing's own beam leaves the frame
        const f = h.frame(), y0 = f.edge ? (f.edge[0] + f.edge[1]) / 2 : -f.ay * 0.62, x0 = f.edge ? f.w - f.ax - 1 : (f.front ? f.front[0] : 20);
        const sx = Math.round(h.x - cx + h.facing * x0), sy = Math.round(h.z - h.h + y0), ex = h.facing > 0 ? W : 0;
        const blast = sp.beam_style === "blast", th = blast ? BLAST.thickness : 6, flick = t % 4 < 2 ? 1 : 0;
        ctx.fillStyle = blast ? "#c98a1a" : "#a01010"; ctx.fillRect(Math.min(sx, ex), sy - th / 2 - flick, Math.abs(ex - sx), th + flick * 2);
        ctx.fillStyle = blast ? "#ffd23f" : "#ff4040"; ctx.fillRect(Math.min(sx, ex), sy - th / 3, Math.abs(ex - sx), th * 2 / 3);
        ctx.fillStyle = "#fff"; ctx.fillRect(Math.min(sx, ex), sy - 1, Math.abs(ex - sx), 2);
      }
      if (sp.effect === "tornado" && t >= 0 && t < 70) {
        for (let i = 0; i < 14; i++) {
          const a = h.t * 0.5 + i, y = h.z - 6 - i * 7, r = 10 + i * 2.2;
          ctx.fillStyle = i % 3 ? "rgba(220,230,255,0.75)" : "rgba(160,170,200,0.75)";
          ctx.fillRect(Math.round(h.x - cx + Math.cos(a) * r) - 3, Math.round(y), 6, 2);
        }
      }
      if (sp.effect === "dash" && t >= 0 && t < 26) {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        for (let i = 0; i < 6; i++) ctx.fillRect(Math.round(h.x - cx - h.facing * (24 + i * 9)), Math.round(h.z - 20 - i * 13), 18, 2);
      }
    }
    for (const f of this.fx) {
      const x = Math.round(f.x - cx);
      switch (f.type) {
        case "shot": {
          const y = Math.round(f.z - f.h);
          ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fillRect(x - 10, Math.round(f.z), 20, 3);
          if (f.img) {
            const sc = Math.min(1, 44 / f.img.height), w = f.img.width * sc, hh = f.img.height * sc;
            ctx.save(); ctx.translate(x, f.effect === "cat" ? Math.round(f.z - hh / 2) : y);
            if (f.vx < 0) ctx.scale(-1, 1);
            if (f.effect === "projectile") ctx.rotate(f.t * 0.2);
            ctx.drawImage(f.img, -w / 2, -hh / 2, w, hh); ctx.restore();
          } else if (f.effect === "bind") {
            ctx.fillStyle = "#222"; ctx.fillRect(x - 12, y - 4, 24, 8); ctx.fillStyle = "#b8bcc2"; ctx.fillRect(x - 11, y - 3, 22, 6);
          } else {
            ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#7fd0ff"; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case "van": {
          if (!f.img) { ctx.fillStyle = "#eee"; ctx.fillRect(x - 40, Math.round(f.z) - 50, 80, 50); break; }
          const sc = 70 / f.img.height, w = f.img.width * sc;
          ctx.save(); ctx.translate(x, Math.round(f.z)); if (f.vx < 0) ctx.scale(-1, 1);
          ctx.drawImage(f.img, -w / 2, -70, w, 70); ctx.restore();
          break;
        }
        case "digits":  // red figures fanning out
          ctx.font = `8px ${FONT}`; ctx.textAlign = "center";
          for (const p of f.parts) {
            const d = p.v * f.t, px = Math.round(f.x - cx + f.dir * Math.cos(p.a) * d), py = Math.round(f.z + p.y0 + Math.sin(p.a) * d * 0.6);
            if (f.t < 36) outlinedText(ctx, p.d, px, py, "#ff3030", 1);
          }
          break;
        case "cash":
          for (const b of f.bills) {
            const a = b.a + f.t * 0.25;
            drawCash(ctx, Math.round(x + Math.cos(a) * b.r), Math.round(f.z - b.up + Math.sin(a) * 4 - f.t * 0.3), true, a * 2);
          }
          break;
        case "orbital": {
          const y = Math.round(f.z), locked = f.t >= ORBITAL.track, strike = f.t >= ORBITAL.track + ORBITAL.lock;
          if (!strike) {
            ctx.strokeStyle = locked && f.t % 6 < 3 ? "#fff" : "#ff3030"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.ellipse(x, y, 22, 6, 0, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(x - 28, y - 1, 10, 2); ctx.fillRect(x + 18, y - 1, 10, 2);
          } else if (f.img) {  // the prop drops onto the spot, lands with a thud, then fades
            const k = f.t - ORBITAL.track - ORBITAL.lock, sc = ORBITAL.propScale;
            const fall = Math.min(1, k / ORBITAL.fall), squash = k >= ORBITAL.fall ? Math.max(0, 1 - (k - ORBITAL.fall) / 8) * 0.18 : 0;
            const ww = Math.round(f.img.width * sc * (1 + squash)), hh = Math.round(f.img.height * sc * (1 - squash));
            const bottom = Math.round(-20 + (y + 4 + 20) * fall * fall);
            ctx.globalAlpha = Math.min(1, (30 + ORBITAL.fall - k) / 10);
            if (k >= ORBITAL.fall) {
              ctx.fillStyle = "rgba(230,220,200,0.7)";
              ctx.beginPath(); ctx.ellipse(x, y + 2, ww * 0.6 + (k - ORBITAL.fall) * 2, 7, 0, 0, Math.PI * 2); ctx.fill();
            }
            ctx.drawImage(f.img, x - Math.round(ww / 2), bottom - hh, ww, hh);
            ctx.globalAlpha = 1;
          } else {
            const k = 1 - (f.t - ORBITAL.track - ORBITAL.lock) / 30, w = ORBITAL.width * Math.max(0.2, k);
            ctx.fillStyle = `rgba(255,80,80,${0.5 * k})`; ctx.fillRect(Math.round(x - w / 2 - 4), 0, Math.round(w + 8), y);
            ctx.fillStyle = `rgba(255,240,240,${0.85 * k})`; ctx.fillRect(Math.round(x - w / 4), 0, Math.round(w / 2), y);
          }
          break;
        }
        case "rain":
          ctx.fillStyle = "#5a3418";
          for (const d of f.drops) ctx.fillRect(Math.round(d.x - cx), Math.round(d.y), 2, 5);
          break;
        case "screen":  // the presentation, projected over the street
          if (f.img) {
            const sc = Math.min(110 / f.img.height, 1), w = f.img.width * sc;
            ctx.globalAlpha = Math.min(1, (80 - f.t) / 20);
            ctx.drawImage(f.img, Math.round(W / 2 - w / 2), 30, w, f.img.height * sc);
            ctx.globalAlpha = 1;
          }
          break;
        case "drop":  // the stamp or laptop comes down on each target
          if (f.img && f.t < 30) for (const e of f.targets) {
            const sc = 34 / f.img.height, w = f.img.width * sc, y = Math.min(e.z - 90, -40 + f.t * 8);
            ctx.drawImage(f.img, Math.round(e.x - cx - w / 2), Math.round(y), w, 34);
          }
          break;
        case "puff":
          ctx.fillStyle = `rgba(230,230,255,${1 - f.t / 40})`;
          for (let i = 0; i < 8; i++) {
            const a = i / 8 * Math.PI * 2, r = 6 + f.t * 0.8;
            ctx.beginPath(); ctx.arc(x + Math.cos(a) * r, f.z - 50 + Math.sin(a) * r, 6, 0, Math.PI * 2); ctx.fill();
          }
          break;
        case "glitter":
          if (f.target) for (let i = 0; i < 8; i++) {
            const a = f.t * 0.2 + i;
            drawStar(ctx, f.target.x - cx + Math.cos(a) * 22, f.target.z - f.target.h - 50 + Math.sin(a * 1.3) * 30, 4, a, i % 2 ? "#ffd23f" : "#ff9df0", 1 - f.t / 60);
          }
          break;
      }
    }
  }

  // ------------------------------------------------------------ waves and camera

  updateWaves() {
    const h = this.hero, L = this.level;
    if (this.lock === null) {
      // Only forward. After a wave or a mini boss fight the hero may stand well ahead of where the
      // camera follows from; it catches up gently rather than jumping or hurrying there: a pixel a
      // frame on its own, a pixel a frame faster than the hero while they walk forward. Walking only
      // ever opens a gap of a couple of pixels, so normal following is unchanged.
      const target = clamp(Math.round(h.x - W * 0.45), this.camX, L.width - W), gap = target - this.camX;
      const ahead = Math.max(0, Math.ceil(h.x - (this.heroWas ?? h.x)));
      this.camX += gap <= 3 ? gap : Math.min(gap, ahead + 1);
    }
    this.heroWas = h.x;
    if (this.lock === null) {
    }
    const m = this.mini;
    if (m && !m.done && this.lock === null && this.wave >= m.after_wave && !this.enemies.length && h.x >= m.x - 110 &&
        this.phase === "play" && !h.down && !h.h) {
      this.lock = this.camX; this.phase = "mini"; this.phaseT = 0;
      h.setState("idle"); h.facing = 1;
      this.startWalkIn(m, clamp(Math.round(m.x - W * 0.68), 0, L.width - W), m.char);
      const taunts = m.char.taunts;
      m.shout = taunts?.length ? taunts[Math.floor(Math.random() * taunts.length)] : "You'll have to get past me first!";
      return;
    }
    const w = L.waves[this.wave];
    if (w && this.lock === null && h.x >= w.x - 40) {
      this.lock = this.camX;
      // most walk in from ahead, every third from behind, a beat apart
      this.spawns = w.enemies.map((name, i) => ({ name, at: this.clock + 20 + i * 50, side: i % 3 === 2 ? -1 : 1 }));
    }
    for (const s of this.spawns) {
      if (s.at > this.clock) continue;
      s.done = true;
      const kind = this.kinds[s.name];
      if (!kind) { this.beaten++; continue; }  // no sprites for it: counts as beaten
      const z = this.top + Math.random() * (this.bottom - this.top);
      this.enemies.push(new Grunt(kind, s.side > 0 ? this.camX + W + 30 : this.camX - 30, z, s.side));
    }
    this.spawns = this.spawns.filter(s => !s.done);
    if (this.lock !== null && !this.spawns.length && !this.enemies.length) {
      this.lock = null; this.wave++; this.go = 200; sfx("ready");
    }
  }

  engaged() {
    const h = this.hero;
    return new Set(this.enemies.filter(e => !e.down && e.state !== "enter")
      .sort((a, b) => Math.abs(a.x - h.x) - Math.abs(b.x - h.x)).slice(0, this.lv.attackers));
  }

  updateEnemy(e) {
    const h = this.hero, k = e.kind;
    e.t++;
    if (e.invuln) e.invuln--;
    if (k.flies) {  // rise to hover height (again after getting up), bobbing; sink a little while dazed
      const want = e.down ? 0 : (e.state === "dizzy" ? HOVER * 0.4 : HOVER) + Math.sin((this.clock + e.wander) / 14) * 2;
      e.lift = e.down ? 0 : (e.lift || 0) + (want - (e.lift || 0)) * 0.12;
    }
    if (e.down) { e.updateDown(this); if (e.state === "idle") e.setState("approach"); return; }
    if (e.state === "dizzy") { if (e.t >= e.stunFor) { e.taped = false; e.setState("approach"); } return; }
    const toward = h.x >= e.x ? 1 : -1;
    e.moving = false;
    const walk = (tx, tz) => {
      const dx = tx - e.x, dz = tz - e.z;
      if (Math.abs(dx) > 3) { e.x += Math.sign(dx) * Math.min(Math.abs(dx), k.speed); e.moving = true; }
      if (Math.abs(dz) > 2) { e.z += Math.sign(dz) * Math.min(Math.abs(dz), k.speed * 0.6); e.moving = true; }
      return Math.abs(dx) <= 6 && Math.abs(dz) <= 4;
    };
    switch (e.state) {
      case "enter":  // walk onto the screen
        e.facing = toward;
        walk(clamp(e.x, this.camX + 30, this.camX + W - 30), e.z);
        if (e.x > this.camX + 20 && e.x < this.camX + W - 20) e.setState("approach");
        break;
      case "idle": case "approach": {
        e.facing = toward;
        e.move ||= k.moves[Math.floor(Math.random() * k.moves.length)] || { anim: "idle", kind: "melee" };
        const side = e.x <= h.x ? -1 : 1;  // stay on the side it's on
        if (this.engagedSet.has(e) && !h.down) {
          const range = e.move.kind === "ranged" ? 130 : e.move.kind === "charge" ? 100 : 26 + 14 * k.t;
          const ready = walk(clamp(h.x + side * range, this.camX + 16, this.camX + W - 16), h.z);
          if (ready && --e.cooldown <= 0) {
            e.facing = toward; e.setState("windup");
            e.windup = Math.round((k.heavy ? 30 : 18) * this.lv.windup);
          }
        } else {  // waiting its turn: hang back and drift
          const zz = clamp(e.homeZ + Math.sin((this.clock + e.wander) / 70) * 14, this.top, this.bottom);
          walk(clamp(h.x + side * (100 + (e.wander % 40)), this.camX + 16, this.camX + W - 16), zz);
          e.cooldown = Math.max(e.cooldown, 20);
        }
        break;
      }
      case "windup":
        if (e.t >= e.windup) {
          e.setState("strike");
          sfx(e.move.laser ? "laser" : e.move.kind === "ranged" ? "throw" : "punch_whoosh", { x: e.x });
          if (e.move.kind === "ranged") {
            const f = e.frame(), lift = e.lift || 0;
            this.shots.push(e.move.laser  // a laser leaves from the eye, fast and straight
              ? { laser: true, x: e.x + e.facing * f.w * 0.4, z: e.z, h: lift + f.ay * 0.55, vx: e.facing * 7,
                  owner: e, t: 0, x0: e.x + e.facing * f.w * 0.4 }
              : { x: e.x + e.facing * 20, z: e.z, h: Math.min(70, lift + f.ay * 0.6), vx: e.facing * 3.4,
                  owner: e, t: 0, spin: Math.random() * 6 });
          }
        }
        break;
      case "strike": {
        const charge = e.move.kind === "charge";
        if (charge && e.t < 26) { e.x += e.facing * 3.6; e.x = clamp(e.x, this.camX - 20, this.camX + W + 20); }
        const active = e.move.kind === "ranged" ? 0 : charge ? 26 : 8;
        if (e.t < active && !e.struck.has(h)) {
          const f = e.frame(), hb = f.hit || [10, -f.ay * 0.8, 26, f.ay * 0.4];
          const box = e.box([hb[0], hb[1], Math.max(hb[2], 22), Math.max(hb[3], 20)]);
          if (Math.abs(e.z - h.z) <= STREET.reach && overlap(box, h.hurtBox()) && this.hurtHero(e, e.move)) e.struck.add(h);
        }
        if (e.t >= (charge ? 34 : 16)) e.setState("recover");
        break;
      }
      case "recover":
        if (e.t >= 18) {
          e.setState("approach"); e.move = null;
          e.cooldown = this.lv.think * (0.6 + Math.random() * 0.8);
        }
        break;
      case "block": if (e.t >= 34) e.setState("approach"); break;
      case "dizzy": e.moving = false; if (e.t >= e.stunFor) { e.taped = false; e.setState("approach"); } break;
      case "hit": if (e.t >= (e.stun || 16)) { e.setState("approach"); e.cooldown = Math.max(e.cooldown, 20); } break;
    }
    if (this.clock - (e.lastHitT || 0) > 90) e.stagger = 0;
    e.z = clamp(e.z, this.top, this.bottom);
  }

  // Keep enemies from standing inside each other (and the hero), so they spread around.
  separate() {
    const live = this.enemies.filter(e => !e.down);
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j], dx = b.x - a.x;
      if (Math.abs(dx) < 22 && Math.abs(b.z - a.z) < 8) {
        const p = (22 - Math.abs(dx)) / 2 * (dx >= 0 ? 1 : -1);
        a.x -= p * 0.5; b.x += p * 0.5;
      }
    }
  }

  updateShots() {
    const h = this.hero;
    for (const s of this.shots) {
      s.t++; s.x += s.vx; s.spin += 0.3;
      if (!s.hit && !CROUCHING.has(h.state) && Math.abs(s.x - h.x) < 14 && Math.abs(s.z - h.z) <= STREET.reach && h.h < s.h + 20 &&
          this.hurtHero(s.owner, { kind: "ranged" })) s.hit = true;
    }
    this.shots = this.shots.filter(s => !s.hit && s.t < 140 && s.x > this.camX - 40 && s.x < this.camX + W + 40);
  }

  // ------------------------------------------------------------ draw

  draw() {
    const ctx = this.ctx, L = this.level, cx = this.camX, h = this.hero;
    const shakeY = this.shake ? (this.shake % 2 ? 2 : -2) : 0;
    ctx.save();
    ctx.translate(0, shakeY);
    this.drawGround(ctx, cx);
    const prop = p => {
      if (p.broken) return;
      const im = this.imgs[p.image], jig = p.shake ? (p.shake % 4 < 2 ? 2 : -2) : 0;
      ctx.drawImage(im, Math.round(p.x - cx - im.width / 2) + jig, p.y - im.height);
      if (p.shake > 6) {  // a white flash as it's struck
        ctx.save(); ctx.globalAlpha = 0.5; ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(im, Math.round(p.x - cx - im.width / 2) + jig, p.y - im.height); ctx.restore();
      }
    };
    for (const p of this.props) if (p.layer === "back") prop(p);
    this.drawDebris(ctx, cx, "back");
    if (this.arena && this.approach > 0) this.drawApproach(ctx);

    // shadows, then everyone nearest-the-back first
    const boss = this.bossAt.x - cx < W + 80 ? [{ boss: true, char: this.boss, x: this.bossAt.x, z: this.bossAt.z, h: 0, moving: this.bossAt.moving }] : [];
    const m = this.mini;
    if (m && !m.done && Math.abs(m.x - cx - W / 2) < W) boss.push({ boss: true, char: m.char, x: m.x, z: m.z, h: 0, moving: m.moving });
    const beaten = m?.done && m.beaten && m.beaten.t < 120 ? m.beaten : null;
    if (beaten) {
      beaten.t++;
      drawFrame(ctx, beaten.img, frameOf(m.char.sheetData.animations.ko, 0, 0), beaten.x - cx, beaten.z, beaten.facing,
                Math.min(1, (120 - beaten.t) / 50));
    }
    const actors = [...this.enemies, ...boss, h];
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    for (const a of actors) {
      const rx = a.down ? 28 : a.lift > 4 ? 13 : 18;  // smaller under something hovering
      ctx.globalAlpha = a.state === "dead" ? Math.max(0, Math.min(1, (70 - a.t) / 25)) : 1;  // fades with the body
      ctx.beginPath(); ctx.ellipse(Math.round(a.x - cx), Math.round(a.z) + 1, rx, a.lift > 4 ? 3 : 4, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.drawPickups(ctx, cx);
    for (const a of actors.sort((p, q) => p.z - q.z)) {
      // No blinking, not even while briefly unhittable after getting up; a beaten enemy lies still,
      // then fades away over its last 25 ticks (it's removed at 70).
      const fade = a.state === "dead" ? Math.max(0, Math.min(1, (70 - a.t) / 25)) : 1;
      if (a.boss) {
        const anims = a.char.sheetData.animations, anim = a.moving && anims.walk ? anims.walk : anims.idle;
        drawFrame(ctx, a.char.img, frameOf(anim, this.clock), a.x - cx, a.z, -1);
        continue;
      }
      const img = a === h ? h.char.img : a.kind.img;
      drawFrame(ctx, img, a.frame(), a.x - cx, a.z - a.h - (a.lift || 0), a.facing, fade);
    }
    for (const s of this.shots) this.drawShot(ctx, s, cx);
    this.drawFx(ctx, cx);
    for (const e of this.enemies) if (e.state === "dizzy") {
      const f = e.frame();
      if (e.taped) drawTape(ctx, Math.round(e.x - cx), Math.round(e.z), f.w, e.stunFor - e.t);
      drawDizzy(ctx, Math.round(e.x - cx), Math.round(e.z - f.ay - 4), this.clock);
    }
    // kept below the health bars when the hero is high in the air
    if (h.shout) drawBubble(ctx, h.shout.text, Math.round(h.x - cx), Math.max(60, Math.round(h.z - h.h - h.frame().ay - 6)));
    for (const s of this.sparks) {
      ctx.fillStyle = s.blocked ? "#9fd8ff" : "#fff";
      const r = 3 + s.t;
      ctx.globalAlpha = 1 - s.t / 12;
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        ctx.fillRect(Math.round(s.x - cx + Math.cos(a) * r) - 1, Math.round(s.y + Math.sin(a) * r) - 1, 3, 3);
      }
      ctx.globalAlpha = 1;
    }
    for (const p of this.props) if (p.layer === "front") prop(p);
    this.drawDebris(ctx, cx, "front");
    ctx.restore();
    this.drawHUD(ctx);
  }

  // A thrown sheaf of papers, tumbling; or a laser: a red beam with a hot core and a flash where it left.
  drawShot(ctx, s, cx) {
    const x = Math.round(s.x - cx), y = Math.round(s.z - s.h);
    if (s.laser) {
      const dir = Math.sign(s.vx), len = Math.min(34, Math.abs(s.x - s.x0) + 6), tail = x - dir * len;
      const l = Math.min(x, tail), w = Math.abs(x - tail);
      ctx.save();
      ctx.fillStyle = "rgba(255,0,20,0.4)"; ctx.fillRect(l, y - 3, w, 7);    // glow
      ctx.fillStyle = "#e0001a"; ctx.fillRect(l, y - 1, w, 3);               // beam
      ctx.fillStyle = "#ff5a5a"; ctx.fillRect(l + (dir > 0 ? 4 : 0), y, w - 4, 1);  // hot core
      ctx.fillStyle = "#ffe0e0"; ctx.fillRect(x - 1, y - 1, 2, 3);           // bright tip
      if (s.t < 5) {  // muzzle flash
        const fx = Math.round(s.x0 - cx), r = 5 - s.t;
        ctx.fillStyle = "rgba(255,0,20,0.6)"; ctx.fillRect(fx - r, y - r, r * 2, r * 2);
        ctx.fillStyle = "#fff"; ctx.fillRect(fx - 1, y - 1, 3, 3);
      }
      ctx.restore();
      return;
    }
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(x - 6, Math.round(s.z), 12, 2);
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.translate(x - Math.sign(s.vx) * i * 7, y + Math.sin(s.spin + i * 2) * 3);
      ctx.rotate(s.spin + i);
      ctx.fillStyle = "#000"; ctx.fillRect(-5, -4, 10, 8);
      ctx.fillStyle = i ? "#e8e8e0" : "#fff"; ctx.fillRect(-4, -3, 8, 6);
      ctx.fillStyle = "#7a8aa8"; ctx.fillRect(-3, -1, 6, 1); ctx.fillRect(-3, 1, 4, 1);
      ctx.restore();
    }
  }

  drawHUD(ctx) {
    const h = this.hero, barW = 130, barH = 8, top = 12;
    const bar = (x, ratio, trail, side) => {
      ctx.fillStyle = "#000"; ctx.fillRect(x - 2, top - 2, barW + 4, barH + 4);
      ctx.fillStyle = "#c01818"; ctx.fillRect(x, top, barW, barH);
      const fill = (r, color) => { const w = Math.round(barW * clamp(r, 0, 1)); ctx.fillStyle = color; ctx.fillRect(side < 0 ? x : x + barW - w, top, w, barH); };
      if (trail !== null) fill(trail, "#fff");
      fill(ratio, ratio < 0.25 && this.clock % 20 < 10 ? "#ff8c1a" : "#ffd23f");
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(x - 0.5, top - 0.5, barW + 1, barH + 1);
    };
    ctx.font = `8px ${FONT}`;
    bar(14, h.hp / h.stats.health, h.trail / h.stats.health, -1);
    ctx.textAlign = "left";
    outlinedText(ctx, h.char.name.toUpperCase(), 14, top + barH + 12, "#fff");
    outlinedText(ctx, `SCORE ${this.score()}`, 14, top + barH + 24, "#7fffb2");
    const e = this.lastEnemy;
    if (e && this.enemies.includes(e) && e.state !== "dead") {
      bar(W - 14 - barW, e.hp / e.kind.hp, null, 1);
      ctx.textAlign = "right";
      outlinedText(ctx, e.kind.name.toUpperCase(), W - 14, top + barH + 12, "#fff");
    }
    ctx.textAlign = "center";
    const sec = Math.floor(this.ticks / 60);
    outlinedText(ctx, `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`, W / 2, top + 8, "#fff");
    if (h.comboShow) {
      ctx.textAlign = "left";
      ctx.font = `${Math.min(22, 12 + h.comboShow.n)}px ${FONT}`;
      outlinedText(ctx, `${h.comboShow.n}`, 14, top + 62, "#ffd23f", 3);
      const nw = ctx.measureText(`${h.comboShow.n}`).width;
      ctx.font = `8px ${FONT}`;
      outlinedText(ctx, h.comboShow.done ? "HIT COMBO!" : "HITS", 14 + nw + 6, top + 62, "#fff");
    }
    if (this.phase === "play" && h.char.specials.some(sp => this.specialReady(sp))) {
      ctx.font = `8px ${FONT}`; ctx.textAlign = "left";
      outlinedText(ctx, "SPECIAL READY", 14, H - 6, "#7fffb2");
    }
    if (this.go && this.go % 30 < 18 && this.phase === "play") {
      ctx.font = `16px ${FONT}`; ctx.textAlign = "right";
      outlinedText(ctx, "GO →", W - 16, 92, "#ffd23f", 3);
    }
    const S = this.level.story || {};
    ctx.font = `8px ${FONT}`; ctx.textAlign = "left";
    if (this.phase === "intro") {
      this.panel(ctx, [...(S.title ? [S.title.toUpperCase(), ""] : []), S.intro || "", "",
                       "MOVE ARROWS/WASD  JUMP SPACE  BLOCK L", "PUNCH J  KICK K  CROUCH SHIFT",
                       "UP+J UPPERCUT  SPECIALS AS IN A MATCH", "", "PRESS J TO START"], 44);
    }
    if (this.phase === "boss") {
      this.panel(ctx, [`${this.boss.name.toUpperCase()}:`, `"${S.boss_taunt || "You made it this far?"}"`], 40, "#ffd0d0");
    }
    if (this.phase === "mini") {
      const m = this.mini, f = frameOf(m.char.sheetData.animations.idle, this.clock);
      if (m.shout) drawBubble(ctx, m.shout, Math.round(m.x - this.camX), Math.round(m.z - f.ay - 6));
      ctx.font = `16px ${FONT}`; ctx.textAlign = "center";  // along the bottom, clear of the taunt
      outlinedText(ctx, "MINI BOSS!", W / 2, H - 20, "#ffd23f", 3);
      ctx.font = `8px ${FONT}`;
      outlinedText(ctx, this.mini.char.name.toUpperCase(), W / 2, H - 7, "#fff", 2);
      ctx.textAlign = "left";
    }
    if (this.phase === "over") {
      ctx.font = `20px ${FONT}`; ctx.textAlign = "center";
      outlinedText(ctx, "GAME OVER", W / 2, H / 2, "#ff4040", 3);
    }
    if (this.paused) {
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0, 0, W, H);
      ctx.font = `16px ${FONT}`; ctx.textAlign = "center";
      outlinedText(ctx, "PAUSED", W / 2, H / 2 - 10, "#fff", 2);
      ctx.font = `8px ${FONT}`;
      outlinedText(ctx, "ESC RESUME  ·  Q QUIT  ·  F FULL SCREEN", W / 2, H / 2 + 12, "#ccc");
      outlinedText(ctx, `M MUSIC ${music.muted ? "OFF" : "ON"}  ·  N SOUND ${sound.muted ? "OFF" : "ON"}`, W / 2, H / 2 + 28, "#ccc");
    }
  }

  // A box of text across the screen, top at y (raised if it would run off the bottom). Every line is
  // wrapped to fit inside it; the first (a heading) is yellow.
  panel(ctx, lines, y, color = "#fff") {
    ctx.font = `8px ${FONT}`; ctx.textAlign = "left";
    const rows = lines.flatMap((l, i) => (ctx.measureText(l).width <= W - 54 ? [l] : wrapText(ctx, l, W - 54)).map(r => [r, i === 0]));
    const hgt = rows.length * 11 + 12;
    y = Math.max(2, Math.min(y, H - hgt - 2));
    ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.fillRect(16, y, W - 32, hgt);
    ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 1; ctx.strokeRect(16.5, y + 0.5, W - 33, hgt - 1);
    rows.forEach(([l, head], i) => outlinedText(ctx, l, 26, y + 16 + i * 11, head ? "#ffd23f" : color, 1));
  }

  // Points so far, as server.py will count them (before the multipliers). Combos on the street are
  // just for show: punch chains string them together far too easily to score them as in a match.
  score() { return this.beaten * STREET.enemyPoints; }
}

// ---------------------------------------------------------------- campaign flow

async function loadStreet(campaign) {
  const level = await getJSON(campaign.level);
  const base = campaign.level.replace(/level\.json$/, "");
  const names = new Set([level.back.image, level.floor.image, ...level.props.map(p => p.image)]);
  const imgs = {};
  await Promise.all([...names].map(async n => { imgs[n] = await loadImage(base + n); }));
  const kinds = {};
  await Promise.all(level.enemies.filter(e => e.sheet).map(async e => {
    const sheet = await getJSON(base + e.sheet);
    kinds[e.name] = enemyKind(e, sheet, await loadImage(base + e.sheet.replace(/[^/]+$/, "") + sheet.image));
  }));
  return { level, base, imgs, kinds };
}

// The street (to the character's campaign music), then the boss in their home arena (to its own
// music); the score covers both (server.py).
async function startCampaign(campaign) {
  const { player } = app.choice, btn = $("campaign-btn"), label = btn.innerHTML;
  btn.disabled = $("fight-btn").disabled = true;
  btn.textContent = "LOADING...";
  try {
    const arena = app.arenas.find(a => a.slug === campaign.arena) || arenaFor(campaign.boss);
    const [street, pc, oc, arenaImg] = await Promise.all([loadStreet(campaign), getCharacter(player),
      getCharacter(campaign.boss), loadImage(arena.image), document.fonts.ready]);
    // The mini boss (level.mini_boss), fought for one round on the street, to their own music.
    // If that's the player's own fighter, it's a mirror match against them in other colors.
    const mb = street.level.mini_boss || null;
    const miniArena = mb && (app.arenas.find(a => a.slug === mb.arena) || arenaFor(mb.character));  // for its music
    const mc = mb ? await getCharacter(mb.character) : null;
    show("fight");
    app.lastMatch = { player, opponent: campaign.boss, arena: arena.slug, difficulty: app.difficulty, campaign };
    const runOf = r => ({ enemies: r.enemies, street_seconds: r.street_seconds, cleared: r.cleared, combos: r.combos,
                          mini_boss: r.mini_boss, mini_name: mc?.name, story: street.level.story });
    const gameOver = r => endMatch({ quit: false, won: false, health_left: 0, round_health: [], specials_landed: 0,
                                     combos: [], breakers: 0, duration: r.street_seconds, rounds: [0, 0] }, pc, oc, runOf(r));
    const st = new Street({ ...street, hero: pc, boss: oc, arena: arenaImg, mini: mc, music: campaign.music || arena.music, difficulty: app.difficulty,
      onMini: fight => {
        // Fought right there on the street (the same backdrop), from where the two walked to and with
        // the hero's health, to the mini boss's own music.
        app.match = new Match({ player: pc, opponent: mc, arena: miniArena, arenaImg: fight.img, stage: fight.stage, starts: fight.starts,
                                health: fight.health, difficulty: app.difficulty, rounds: 1, onEnd: m => {
          if (m.quit) { app.match = null; showMenu(); return; }
          if (m.won) { const fight = app.match; app.match = st; st.resume(fight); return; }
          st.finish(false);  // beaten by the mini boss: the run ends here
        } });
        app.match.start();
      },
      onEnd: r => {
        app.match = null;
        if (r.quit) { showMenu(); return; }
        if (!r.cleared) { gameOver(r); return; }  // knocked out on the street, or by the mini boss
        // The boss fight is in their arena, which the walk up to them zoomed in on (or, for a level
        // built before that, on the street's last stretch), to the arena's music.
        app.match = new Match({ player: pc, opponent: oc, arena, arenaImg: r.fight.img, starts: r.fight.starts,
                                health: r.fight.health, difficulty: app.difficulty,
                                onEnd: m => endMatch(m, pc, oc, runOf(r)) });
        app.match.start();
      } });
    app.match = st;
    app.match.start();
  } catch (e) {
    alert(`Could not load the campaign: ${e.message}`);
  } finally {
    btn.disabled = $("fight-btn").disabled = false;
    btn.innerHTML = label;
  }
}
