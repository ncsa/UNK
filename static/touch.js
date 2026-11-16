// Touch screen controls for phones and tablets. Like the controller (static/gamepad.js), every button
// turns into the key presses the keyboard makes, so matches, the street and the pause menu need no
// changes of their own. Only shown on a touch screen, and only during a fight.
//
//   left thumb   a floating pad: put a thumb down anywhere on the left half and slide it
//                (up = jump in a match, up/down = up and down the road on the street)
//   right thumb  PUNCH, KICK, JUMP (and BLOCK on the street)
//   above them   one button per special move: a tap does the whole move (no sequence to enter);
//                dimmed while it recharges
//   top          pause; while paused: resume, quit, music, and the practice partner switch
//
// In portrait a "turn your phone sideways" card covers the fight and pauses it. Starting a fight from
// a touch screen asks for full screen and landscape where the browser allows it (Android; an iPhone
// gets full screen by adding the game to the home screen instead: see manifest.json).

const touch = { on: false, held: new Map(), stick: null, buttons: new Map(), built: false };
const TOUCH_RADIUS = 44;   // CSS px the thumb travels for a full push
const TOUCH_DEAD = 0.4;    // fraction of the radius before a direction counts

const isStreet = () => typeof Street !== "undefined" && app.match instanceof Street;
const touchDevice = () => matchMedia("(pointer: coarse)").matches;

function touchKey(name, down, key) {
  const was = touch.held.get(name);
  if (down && !was && key) { touch.held.set(name, key); sendKey("keydown", key); }
  else if (!down && was) { touch.held.delete(name); sendKey("keyup", was); }
}

function touchReleaseAll() {
  for (const [, key] of touch.held) sendKey("keyup", key);
  touch.held.clear();
  touch.stick = null;
  touch.buttons.clear();
  drawStick();
  for (const b of document.querySelectorAll("#touch .held")) b.classList.remove("held");
}

// ------------------------------------------------------------------ building the overlay

function buildTouch() {
  if (touch.built) return;
  touch.built = true;
  document.documentElement.classList.add("touch");
  const el = document.createElement("div");
  el.id = "touch";
  el.innerHTML = `
    <div class="t-stickzone"></div><div class="t-stick"><i></i></div>
    <div class="t-specials"></div>
    <div class="t-buttons">
      <button data-act="punch">PUNCH</button><button data-act="kick">KICK</button>
      <button data-act="jump">JUMP</button><button data-act="block">BLOCK</button>
    </div>
    <button class="t-pause" data-act="pause" aria-label="Pause">II</button>
    <div class="t-paused">
      <button data-act="resume">RESUME</button><button data-act="dummy">OPPONENT</button>
      <button data-act="music">MUSIC</button><button data-act="quit">QUIT</button>
    </div>`;
  $("fight").append(el);
  const rotate = document.createElement("div");
  rotate.id = "rotate";
  rotate.innerHTML = `<div><b>⟳</b>TURN YOUR PHONE SIDEWAYS</div>`;
  $("fight").append(rotate);

  // Touch events (not pointer events) so preventDefault stops the browser's pretend mouse clicks,
  // which a match would read as punches, and its scrolling and zooming.
  const opts = { passive: false };
  el.addEventListener("touchstart", onTouchStart, opts);
  el.addEventListener("touchmove", onTouchMove, opts);
  el.addEventListener("touchend", onTouchEnd, opts);
  el.addEventListener("touchcancel", onTouchEnd, opts);
  // A tap on the game itself (outside the controls) does nothing, rather than a mouse-click punch.
  $("canvas").addEventListener("touchstart", e => e.preventDefault(), opts);
  requestAnimationFrame(touchFrame);
  buildInitialsInput();
}

// A guest's initials: there's no keyboard on a phone until a text box has focus, so tapping a letter
// slot focuses a hidden one; what's typed there goes in as if typed on a keyboard.
function buildInitialsInput() {
  const input = document.createElement("input");
  Object.assign(input, { id: "initials-type", autocapitalize: "characters", autocomplete: "off", spellcheck: false });
  input.setAttribute("aria-label", "Initials");
  $("initials").append(input);
  for (const slot of document.querySelectorAll("#initials .slot"))
    slot.addEventListener("click", () => { if (touch.on) input.focus(); });
  // It always holds one space, so a backspace has something to delete (and so fires an input event).
  input.value = " ";
  input.addEventListener("input", e => {
    const ch = input.value.trim().slice(-1);
    input.value = " ";
    if (e.inputType?.startsWith("delete")) sendKey("keydown", ["Backspace", "Backspace"]);
    else if (/^[a-z0-9]$/i.test(ch)) sendKey("keydown", [ch, `Key${ch.toUpperCase()}`]);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); sendKey("keydown", KEY.enter); }
    e.stopPropagation();  // the box's own keys reach the initials only through the lines above
  });
}

// What a button presses right now.
function touchBinding(act) {
  const street = isStreet();
  return {
    punch: KEY.punch, kick: KEY.kick,
    jump: street ? KEY.space : KEY.jumpKey,
    block: street ? KEY.block : null,
  }[act];
}

function onTouchStart(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const target = document.elementFromPoint(t.clientX, t.clientY);
    const btn = target?.closest("#touch button");
    if (btn) { pressButton(t.identifier, btn); continue; }
    // Anywhere else on the left half: the pad, centred where the thumb landed.
    if (!touch.stick && t.clientX < innerWidth / 2 && !app.match?.paused) {
      touch.stick = { id: t.identifier, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0 };
      updateStick();
    }
  }
}

function onTouchMove(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (touch.stick?.id !== t.identifier) continue;
    let dx = t.clientX - touch.stick.x0, dy = t.clientY - touch.stick.y0;
    const len = Math.hypot(dx, dy);
    // Dragged past the rim: the centre follows the thumb, so reversing direction is a short move.
    if (len > TOUCH_RADIUS) {
      const over = (len - TOUCH_RADIUS) / len;
      touch.stick.x0 += dx * over; touch.stick.y0 += dy * over;
      dx -= dx * over; dy -= dy * over;
    }
    touch.stick.dx = dx; touch.stick.dy = dy;
    updateStick();
  }
}

function onTouchEnd(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (touch.stick?.id === t.identifier) { touch.stick = null; updateStick(); continue; }
    const btn = touch.buttons.get(t.identifier);
    if (btn) releaseButton(t.identifier, btn);
  }
}

function updateStick() {
  const s = touch.stick, b = KEY;
  const dx = s ? s.dx / TOUCH_RADIUS : 0, dy = s ? s.dy / TOUCH_RADIUS : 0;
  touchKey("left", dx < -TOUCH_DEAD, b.left);
  touchKey("right", dx > TOUCH_DEAD, b.right);
  // Up is the jump in a match, so it takes a firmer push than the other directions (resting a
  // thumb slightly high shouldn't hop); down to crouch is easy.
  touchKey("up", dy < -(isStreet() ? TOUCH_DEAD : 0.6), b.up);
  touchKey("down", dy > TOUCH_DEAD, b.down);
  drawStick();
}

function drawStick() {
  const zone = document.querySelector("#touch .t-stick");
  if (!zone) return;
  const s = touch.stick;
  zone.classList.toggle("active", !!s);
  if (s) {
    zone.style.left = `${s.x0}px`; zone.style.top = `${s.y0}px`;
    zone.firstElementChild.style.transform = `translate(${s.dx}px, ${s.dy}px)`;
  } else {
    zone.style.left = zone.style.top = "";
    zone.firstElementChild.style.transform = "";
  }
}

function pressButton(id, btn) {
  const act = btn.dataset.act, m = app.match;
  if (btn.disabled) return;
  if (btn.dataset.special != null) { touchSpecial(Number(btn.dataset.special)); flash(btn); return; }
  if (act === "pause" || act === "resume") { touchReleaseAll(); sendKey("keydown", KEY.escape); return; }
  if (act === "quit") { sendKey("keydown", KEY.quit); return; }
  if (act === "dummy") { sendKey("keydown", KEY.switchDummy); return; }
  if (act === "music") { sendKey("keydown", ["m", "KeyM"]); return; }
  if (m?.paused) return;
  touch.buttons.set(id, btn);
  btn.classList.add("held");
  touchKey(`b-${act}`, true, touchBinding(act));
}

function releaseButton(id, btn) {
  touch.buttons.delete(id);
  btn.classList.remove("held");
  touchKey(`b-${btn.dataset.act}`, false);
}

function flash(btn) {
  btn.classList.add("held");
  setTimeout(() => btn.classList.remove("held"), 150);
}

// ------------------------------------------------------------------ one-tap specials

function playerChar() {
  const m = app.match;
  return isStreet() ? m.hero?.char : m?.p1?.char;
}

function specialReady(sp) {
  const m = app.match;
  return isStreet() ? m.specialReady(sp) : m.p1.specialReady(sp);
}

// Queue the special exactly as if its last key had just completed its input sequence; the match
// (or the street) still decides whether it can go now, as with a typed one.
function touchSpecial(i) {
  const m = app.match, sp = playerChar()?.specials?.[i];
  if (!sp || m.paused) return;
  if (isStreet()) m.press("special", { sp, token: sp.input[sp.input.length - 1] });
  else if (m.input) m.input.pending = { special: sp, expires: performance.now() + 250 };
}

function buildSpecials() {
  const box = document.querySelector("#touch .t-specials");
  const specials = playerChar()?.specials || [];
  box.innerHTML = "";
  specials.forEach((sp, i) => {
    const b = document.createElement("button");
    b.dataset.special = i;
    b.textContent = (sp.name || sp.id).toUpperCase();
    box.append(b);
  });
  touch.specialsFor = app.match;
}

// ------------------------------------------------------------------ every frame

function touchFrame() {
  requestAnimationFrame(touchFrame);
  const m = app.match, fighting = touch.on && inFight();
  document.documentElement.classList.toggle("touch-fight", fighting);
  if (!fighting) {
    if (touch.held.size) touchReleaseAll();
    return;
  }
  if (touch.specialsFor !== m) buildSpecials();
  const root = $("touch");
  root.classList.toggle("paused", !!m.paused);
  root.classList.toggle("street", isStreet());
  root.classList.toggle("practice", !!m.practice);
  if (m.paused && touch.held.size) touchReleaseAll();
  const specials = playerChar()?.specials || [];
  for (const b of root.querySelectorAll(".t-specials button"))
    b.classList.toggle("cooling", !specialReady(specials[b.dataset.special]));
  // Turned upright mid-fight: pause until it's turned back.
  if (portrait() && !m.paused) { touchReleaseAll(); sendKey("keydown", KEY.escape); }
}

const portrait = () => matchMedia("(orientation: portrait)").matches;

// ------------------------------------------------------------------ turning it on

function enableTouch() {
  if (touch.on) return;
  touch.on = true;
  buildTouch();
  if (typeof fitCanvas === "function") fitCanvas();
}

if (touchDevice()) enableTouch();
// A touch screen that reports a mouse as its main pointer (some laptops): on its first touch.
window.addEventListener("touchstart", enableTouch, { once: true, passive: true });

// Starting a fight from a touch screen: full screen and landscape, where the browser allows it.
document.addEventListener("click", e => {
  if (!touch.on || !e.target.closest?.("#fight-btn, #practice-btn, #campaign-btn, #rematch-btn")) return;
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen({ navigationUI: "hide" })
    .then(() => screen.orientation?.lock?.("landscape"))
    .catch(() => {});
}, true);
