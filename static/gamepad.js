// Xbox (or any "standard" layout) controller support. The controller is read every frame and turned
// into the same key presses the keyboard makes, so matches, the street and the pause menu need no
// changes of their own. Outside a fight the D-pad moves a highlight between the menu's buttons and
// A presses the highlighted one.
//
//   in a match                         on the street                    menus
//   D-pad / left stick  move, jump, crouch   move (up/down = depth)      move the highlight
//   X  punch            X  punch                                         A    choose
//   Y  kick             Y  kick                                          B    back (Esc)
//   A  jump             A  jump                                          any  skip splash / scores
//   B  kick             B  block
//   RB block (hold back is still the usual way)   LB  crouch
//   Start  pause        View (in pause)  quit to menu

const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const STICK_DEAD = 0.5;

const KEY = {  // what a synthetic key press carries: key (for e.key) and code (for e.code)
  up: ["ArrowUp", "ArrowUp"], down: ["ArrowDown", "ArrowDown"], left: ["ArrowLeft", "ArrowLeft"],
  right: ["ArrowRight", "ArrowRight"], punch: ["j", "KeyJ"], kick: ["k", "KeyK"], jumpKey: ["w", "KeyW"],
  space: [" ", "Space"], block: ["l", "KeyL"], crouch: ["Shift", "ShiftLeft"], escape: ["Escape", "Escape"],
  enter: ["Enter", "Enter"], quit: ["q", "KeyQ"],
};

const pad = { held: new Map(), prev: [], navPrev: {}, rest: {} };  // held: our name -> the key we pressed for it

function sendKey(type, [key, code]) {
  window.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
}

function inFight() {
  return !!app.match && $("fight").classList.contains("active");
}

// What each control means right now (a match and the street want different keys for some).
function padBindings() {
  const street = typeof Street !== "undefined" && app.match instanceof Street;
  return {
    up: KEY.up, down: KEY.down, left: KEY.left, right: KEY.right,
    [PAD.X]: KEY.punch, [PAD.Y]: KEY.kick,
    [PAD.A]: street ? KEY.space : KEY.jumpKey,
    [PAD.B]: street ? KEY.block : KEY.kick,
    [PAD.LB]: street ? KEY.crouch : null, [PAD.LT]: street ? KEY.crouch : null,
    [PAD.RB]: street ? KEY.block : null, [PAD.RT]: street ? KEY.block : null,
    [PAD.START]: KEY.escape, [PAD.VIEW]: KEY.quit,
  };
}

function readPad() {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  if (!pads.length) return null;
  const p = pads.find(g => g.mapping === "standard") || pads[0];
  const btn = i => !!p.buttons[i]?.pressed;
  // The stick counts only once pushed away from where it rests. A controller without the standard
  // layout may report a trigger (resting at -1) or another control as axes 0 and 1, and a worn
  // stick can rest off centre; either one read as a direction held for good, so the player couldn't
  // walk the other way. Rest is learned from the first reading of each controller.
  const rest = pad.rest[p.index] ??= [p.axes[0] || 0, p.axes[1] || 0];
  const usable = p.mapping === "standard";
  const ax = usable && Math.abs(rest[0]) < 0.3 ? (p.axes[0] || 0) - rest[0] : 0;
  const ay = usable && Math.abs(rest[1]) < 0.3 ? (p.axes[1] || 0) - rest[1] : 0;
  return {
    buttons: p.buttons.map((_, i) => btn(i)),
    up: btn(PAD.UP) || ay < -STICK_DEAD, down: btn(PAD.DOWN) || ay > STICK_DEAD,
    left: btn(PAD.LEFT) || ax < -STICK_DEAD, right: btn(PAD.RIGHT) || ax > STICK_DEAD,
  };
}

// Press or release one control's key as its state changes.
function setControl(name, down, key) {
  const was = pad.held.get(name);
  if (down && !was && key) { pad.held.set(name, key); sendKey("keydown", key); }
  else if (!down && was) { pad.held.delete(name); sendKey("keyup", was); }
}

function releaseAll() {
  for (const [name, key] of pad.held) sendKey("keyup", key);
  pad.held.clear();
}

function pollPad() {
  const s = readPad();
  if (!s) { releaseAll(); requestAnimationFrame(pollPad); return; }
  if (inFight()) {
    const b = padBindings();
    for (const dir of ["up", "down", "left", "right"]) setControl(dir, s[dir], b[dir]);
    s.buttons.forEach((down, i) => { if (i in b) setControl(`b${i}`, down, b[i]); });
  } else {
    releaseAll();
    menuPad(s);
  }
  pad.prev = s.buttons;
  requestAnimationFrame(pollPad);
}

// ------------------------------------------------------------------ menus

const pressed = (s, i) => s.buttons[i] && !pad.prev[i];

function menuPad(s) {
  // Screens that wait for any key (the splash, the high scores) take any button.
  const anyKey = ["splash", "hiscores"].some(id => $(id)?.classList.contains("active"));
  if (anyKey) { if (s.buttons.some((d, i) => d && !pad.prev[i])) sendKey("keydown", KEY.enter); return; }
  // The initials entry has its own arrow-key controls; A saves.
  if ($("results").classList.contains("active") && !$("initials").hidden) {
    for (const dir of ["up", "down", "left", "right"]) if (s[dir] && !pad.navPrev[dir]) sendKey("keydown", KEY[dir]);
    if (pressed(s, PAD.A)) sendKey("keydown", KEY.enter);
    for (const dir of ["up", "down", "left", "right"]) pad.navPrev[dir] = s[dir];
    return;
  }
  // The D-pad moves; held, it repeats. On the select screen the highlight IS the selection: landing
  // on a fighter's card picks them, and A (or Start) on a card starts the fight.
  const now = performance.now(), select = $("select").classList.contains("active");
  for (const dir of ["up", "down", "left", "right"]) {
    const fresh = s[dir] && !pad.navPrev[dir];
    if (fresh) pad.repeatAt = now + 350;
    if (fresh || (s[dir] && now >= pad.repeatAt)) {
      if (!fresh) pad.repeatAt = now + 140;
      moveFocus(dir);
      const el = focused();
      if (select && el?.classList.contains("card") && !el.classList.contains("selected")) el.click();
    }
    pad.navPrev[dir] = s[dir];
  }
  if (pressed(s, PAD.A) || (select && pressed(s, PAD.START))) {
    const el = focused();
    const fight = $("fight-btn");
    if (select && (!el || el.classList.contains("card") || pressed(s, PAD.START)) && !fight.disabled) fight.click();
    else if (el) el.click();
    else moveFocus("down");
  }
  if (pressed(s, PAD.B)) sendKey("keydown", KEY.escape);
}

function focusables() {
  const screen = document.querySelector("dialog[open]") || document.querySelector(".screen.active");
  if (!screen) return [];
  return [...screen.querySelectorAll("button, a[href], select, [tabindex]:not([tabindex='-1'])")]
    .filter(el => !el.disabled && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
}

function focused() {
  const el = document.querySelector(".pad-focus");
  return el && focusables().includes(el) ? el : null;
}

function setFocus(el) {
  document.querySelector(".pad-focus")?.classList.remove("pad-focus");
  el.classList.add("pad-focus");
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  sfx("menu_move");
}

// Spatial navigation: the nearest button in that direction, preferring ones roughly in line.
function moveFocus(dir) {
  const all = focusables();
  if (!all.length) return;
  const cur = focused();
  if (!cur) { setFocus(all.find(el => el.classList.contains("selected")) || all[0]); return; }
  const c = cur.getBoundingClientRect(), cx = c.x + c.width / 2, cy = c.y + c.height / 2;
  const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  let best = null, bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect(), ex = r.x + r.width / 2, ey = r.y + r.height / 2;
    const along = (ex - cx) * dx + (ey - cy) * dy, across = Math.abs((ex - cx) * dy + (ey - cy) * dx);
    if (along <= 4) continue;
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) setFocus(best);
}

// Mouse users don't need the highlight.
window.addEventListener("pointerdown", () => document.querySelector(".pad-focus")?.classList.remove("pad-focus"));
window.addEventListener("gamepadconnected", e => { delete pad.rest[e.gamepad.index]; });
requestAnimationFrame(pollPad);
