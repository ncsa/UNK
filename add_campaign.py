#!/usr/bin/env python3
"""Build a side-scrolling campaign level for a character, seeded from their home arena.

    python add_campaign.py Characters/ChuckT
    python add_campaign.py Characters/ChuckT --stage parse      # read campaign.txt only (no images)
    python add_campaign.py Characters/ChuckT --stage build      # re-layout only, no API calls
    python add_campaign.py Characters/ChuckT --only floor,prop_bench --force

The level is a Double Dragon style street that ends at the character's arena, where they wait as
the boss: the player walks right toward it, fighting waves of enemies on the way.

Stages
  parse     Characters/<Name>/campaign.txt (the story, setting and enemies, in your words; a
            template is written the first time) -> Characters/<Name>/campaign.json, via Gemini:
            the boss's motive, intro and outro lines, what the backdrop shows, the props, and the
            enemy roster. Re-parsed whenever campaign.txt changes; unchanged parts stay word for
            word, so their images aren't redrawn.
  generate  the level's images, cached in Characters/<Name>/campaign/ and redrawn only when their
            description in campaign.json changes (or with --only ... --force):
              back   sky and buildings: the arena's backdrop extended to the LEFT by Gemini
                     outpainting, one stretch at a time; scrolls slower than the floor (parallax)
              floor  the band of ground you walk on, up and down as well as along: one seamless tile
              props  sprites standing on the floor, along the back edge (behind the fighters) or
                     the front edge (in front of them)
  build     -> build/campaigns/<slug>/ (level.json and PNGs): layers, prop layout, the story, the
            enemy roster and where each wave of enemies stops the player. No API calls.

campaign.json also holds the layout (where the arena's ground starts, the floor band, level length,
scroll speeds); those you can edit by hand and they're kept when campaign.txt is re-parsed.
Preview a built level at /static/campaign.html?c=<slug> on the game server.

Enemies: each kind gets a reference design drawn in the boss's sprite style (there's no photo), then
its frames (idle, walk, its two moves, hit, knocked out) from that design, with the same anatomy check
add_character.py uses for fighters; built into a sprite sheet in the fighters' format. About $0.75 a
kind. --only enemies (or enemy_<slug>) redraws just those.

Mini boss: a line "Mini boss: <character>" in the boss's own profile (Characters/<Name>/<Name>.txt,
e.g. "Mini boss: TheKoop") puts that fighter halfway along the street. Reaching them is one round of
a regular match, fought there on the street to their music (their home arena's); then the street goes on. Picked up by the
build stage, so --stage build is enough after adding or changing it.

Needs GEMINI_API_KEY (from the environment or gemini_key.txt) for the parse and generate stages.
"""

import argparse
import difflib
import hashlib
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

import add_character as ac  # Gemini client, cost log, background keying, slugify

W, H = 384, 224                 # the game's screen (game.js)
SPRITE_HEIGHT = ac.SPRITE_HEIGHT  # a standing fighter, for sizing props
CAMPAIGN_BUILD = ac.ROOT / "build" / "campaigns"
WORK_H = 768                    # height of the backdrop while it's being extended (source pixels)
ASPECT = "21:9"                 # outpainting canvas: the last third is the existing backdrop
SEAM = 0.1                      # fraction of the canvas crossfaded where new meets old
SEAM_LIMIT = 2.5                # a new stretch whose join is this many times sharper than usual is redrawn
SEAM_TRIES = 3

# Layout: not in campaign.txt; edit campaign.json by hand.
LAYOUT = {
    # Fraction of the arena image's height where the ground starts (everything above is backdrop).
    "horizon": 0.85,
    # Screen y where the walkable floor band starts (the band runs to the bottom of the screen).
    "floor_y": 150,
    "back_parallax": 0.6,
}

# What a campaign has before campaign.txt is filled in (and what the parser starts from).
STORY_DEFAULTS = {
    "title": "",
    "boss_motive": "",
    "intro": "",
    "boss_taunt": "",
    "outro": "",
    "screens": 6,
    "scenery": "the rest of the same university campus: more historic campus buildings, trees, hedges and lawns",
    # size: height as a fraction of a standing fighter; where: back (along the back edge, behind
    # fighters) or front (along the bottom edge, in front of them).
    "props": [
        {"name": "lamp", "description": "a black iron campus street lamp post with a round white globe light",
         "size": 1.45, "where": "back"},
        {"name": "bench", "description": "a wooden park bench with black iron legs, seen from the front",
         "size": 0.42, "where": "back"},
        {"name": "trashcan", "description": "a dark green metal campus trash can", "size": 0.38, "where": "back"},
        {"name": "planter", "description": "a large square stone planter with a round green shrub",
         "size": 0.42, "where": "front"},
    ],
    # Planted over each join between outpainted stretches of backdrop, which rarely line up.
    "join_cover": "one tall full-grown leafy oak tree, trunk and roots at the bottom, a broad round crown "
                  "of green leaves at the top, seen from the side",
    "enemies": [],
}

TEMPLATE = """# Campaign for {name}: a side-scrolling street level that ends at {name}'s arena, where {name}
# waits as the boss. Fill this in, then run add_campaign.py again: only what changed is redrawn.
# Lines starting with # are ignored. Write as much or as little as you like; anything left out is
# made up to fit {name}.

Story:
# Why is {name} the boss? What are they up to, and why does the player have to stop them?
# e.g. "{name} has locked down the building and won't let anyone out until ..."

Setting:
# What the player walks past on the way to the arena, and anything lying around that fits the
# story, e.g. "the main quad, then a row of old labs; shredders and stacks of file boxes".

Enemies:
# Who gets in the player's way, one per line starting with "- ": what they look like and how they
# fight. Add "(x3)" for how many show up. e.g.
# - Clipboard Intern: a nervous intern in a lanyard who swats with a clipboard and blocks a lot (x4)
"""

PARSE_PROMPT = """Turn this description of a campaign level for a 2D fighting game into JSON.

The level: a 1990s SNES-style side-scrolling beat 'em up stage (like Double Dragon), set at a university
campus. The player walks right along a street, fights waves of enemies, and reaches the boss's home arena
at the end, where the boss is fought. The boss is {boss}: {summary} Their special moves: {specials}.
The boss's arena (the level's last screen) is the {arena} building, shown in the attached image; the
level's backdrop is painted outward from it, so describe scenery that matches its style and era.

Rules:
- Keep to what the text says; fill anything missing with ideas that fit the boss and setting. Funny is good.
- title: a short level name. boss_motive: one or two sentences on why the boss is the villain here.
- intro: 2-3 short sentences shown as the level starts, setting up the story for the player.
- boss_taunt: one short line the boss says when the player arrives. outro: 1-2 sentences after the boss falls.
- screens: level length in screens, 5-8 (longer only if the text asks for a long level).
- scenery: a purely visual description of what the backdrop shows walking AWAY from the arena (buildings,
  trees, landmarks; no people, vehicles or readable text), starting near the arena and leading away.
- props: 4-6 objects standing along the street. Mostly ordinary things for the setting (lamp posts,
  benches, bins), plus one or two that fit the story. name: one lowercase word. description: purely visual,
  one object, no people, no text except a short stamped word if the story needs it. size: height relative to
  a standing adult (a bench 0.42, a lamp post 1.45). where: "back" (along the back edge of the street) for
  most, "front" for one low object.
- enemies: 2-5 kinds of regular enemy (not the boss). name: a short title. look: purely visual, for drawing
  a sprite: build, clothes, colors, what they carry. personality: a few words. fighting_style: one sentence.
  moves: 2-3 short move names with what they do. count: how many appear in the level in all (1-8).
  first_screen: the screen they first appear on (1 = the start; tougher ones later, never the last screen).
  body: "humanoid" if it has two arms and two legs (people, and monsters or golems shaped like people),
  else "other" (machines, blobs, animals). height: standing height relative to an average adult (a child 0.7,
  a rolling robot 0.5, a hulking brute 1.3; at most 1.4).

Text:
"""

PREVIOUS_NOTE = """

This is a RE-PARSE of an edited description. The edit, as a diff from the earlier version:
{diff}
Previous result, parsed from the earlier version. Update every value the edit affects. Copy every other
value EXACTLY, word for word, especially scenery and the props' and enemies' descriptions, which
drawn images are based on:
{previous}"""

_str = {"type": "string"}
PARSE_SCHEMA = {"type": "object", "properties": {
    "title": _str, "boss_motive": _str, "intro": _str, "boss_taunt": _str, "outro": _str,
    "screens": {"type": "integer"}, "scenery": _str,
    "props": {"type": "array", "items": {"type": "object", "properties": {
        "name": _str, "description": _str, "size": {"type": "number"},
        "where": {"type": "string", "enum": ["back", "front"]}},
        "required": ["name", "description", "size", "where"]}},
    "enemies": {"type": "array", "items": {"type": "object", "properties": {
        "name": _str, "look": _str, "personality": _str, "fighting_style": _str,
        "moves": {"type": "array", "items": _str}, "count": {"type": "integer"},
        "first_screen": {"type": "integer"}, "body": {"type": "string", "enum": ["humanoid", "other"]},
        "height": {"type": "number"}},
        "required": ["name", "look", "personality", "fighting_style", "moves", "count", "first_screen",
                     "body", "height"]}},
}, "required": ["title", "boss_motive", "intro", "boss_taunt", "outro", "screens", "scenery",
                "props", "enemies"]}

BACK_PROMPT = """This image is part of a wide, side-on background for a 1990s SNES 16-bit pixel-art side-scrolling beat 'em up
(like Double Dragon). The right third is existing artwork; the left two thirds are blank magenta.
Paint the blank part so the scene continues seamlessly to the LEFT of the existing artwork: {scenery}.
Keep the existing right third exactly as it is. Match its pixel-art style, palette, lighting, sky and the
height of the horizon, buildings and trees. The bottom edge is the back edge of the street the player
walks along: continue the hedges and grass along the bottom at exactly the same height.
No people, no vehicles, no text or signs, nothing cut off at the left edge."""

FLOOR_PROMPT = """Using the reference image's ground (the paving at the bottom) as the style, draw a strip of that same
ground for a 1990s SNES 16-bit pixel-art side-scrolling beat 'em up (like Double Dragon): the street surface
the fighters walk on, seen from the same slight angle, filling the whole image edge to edge.
It must tile seamlessly left to right. Just the paving: no objects, people, shadows, grass, curbs or text."""

PROP_PROMPT = """Draw a single object as a sprite for a 1990s SNES 16-bit pixel-art side-scrolling beat 'em up, in the style
and palette of the reference background: {description}.
Only the object, standing upright, seen from the front at eye level, no people,
crisp pixels and dark outlines, centered, filling about 80% of the image,
background: perfectly flat solid magenta (#FF00FF) with no gradient or texture."""

def log(msg):
    ac.log(msg)


def find_arena(folder):
    arenas = sorted(p for p in folder.glob("Arena_*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
    if not arenas:
        sys.exit(f"{folder.name} has no Arena_* image to build a campaign from")
    return arenas[0]


def generate(prompt, refs, aspect="1:1"):
    return ac.generate_image(prompt, refs, aspect=aspect)


def key(*parts):
    """What an image is a picture of, to tell when its description changed."""
    return hashlib.sha1(json.dumps(parts).encode()).hexdigest()[:12]


# --------------------------------------------------------------------------- parse

def text_of(path):
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("#")).strip()


def stage_parse(folder, cfg_path, reparse=False):
    txt = folder / "campaign.txt"
    if not txt.exists():
        txt.write_text(TEMPLATE.format(name=folder.name))
        log(f"  parse: wrote a template {ac.rel(txt)} to fill in")
    text = text_of(txt)
    blank = text == text_of_str(TEMPLATE.format(name=folder.name))
    cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
    layout = {k: cfg.get(k, v) for k, v in LAYOUT.items()}
    src = cfg.get("source", {})
    if blank:
        if not cfg:
            log("  parse: campaign.txt not filled in yet, using a plain campus level with no story")
        cfg = {**layout, **STORY_DEFAULTS, **{k: v for k, v in cfg.items() if k in STORY_DEFAULTS}}
    elif src.get("text_hash") == key(text) and not reparse:
        log(f"  parse: keeping {ac.rel(cfg_path)} (campaign.txt unchanged)")
        return {**layout, **STORY_DEFAULTS, **cfg}
    else:
        if not ac.gemini():
            sys.exit("parse: set GEMINI_API_KEY (or add gemini_key.txt) to read campaign.txt")
        log("  parse: reading campaign.txt" + (" (changed)" if src else ""))
        # an edit keeps the rest word for word (so its images stay); --reparse starts fresh
        previous = {k: cfg[k] for k in STORY_DEFAULTS if k in cfg} if src.get("parsed_text") and not reparse else None
        p = parse_with_gemini(folder, text, previous, src.get("parsed_text"))
        p["screens"] = max(4, min(10, p["screens"]))
        for e in p["enemies"]:
            e["count"] = max(1, min(8, e["count"]))
            e["first_screen"] = max(1, min(p["screens"] - 1, e["first_screen"]))
            e["height"] = max(0.3, min(1.4, e.get("height") or 1))
        for pr in p["props"]:
            pr["name"] = "".join(c for c in pr["name"].lower() if c.isalnum()) or "prop"
            pr["size"] = max(0.15, min(1.8, pr["size"]))
        cfg = {**layout, **{k: p.get(k, STORY_DEFAULTS[k]) for k in STORY_DEFAULTS},
               "source": {"text_hash": key(text), "parsed_text": text}}
    cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    log(f"  parse: wrote {ac.rel(cfg_path)}" + (f": \"{cfg['title']}\", {len(cfg['enemies'])} kinds of enemy"
                                                 if cfg.get("title") else ""))
    return cfg


def text_of_str(s):
    return "\n".join(l for l in s.splitlines() if not l.lstrip().startswith("#")).strip()


def parse_with_gemini(folder, text, previous=None, old_text=None, attempts=3):
    from google.genai import types
    char = {}
    built = ac.BUILD_DIR / ac.slugify(folder.name) / "character.json"
    if built.exists():
        char = json.loads(built.read_text())
    arena = find_arena(folder).stem.removeprefix("Arena_")
    prompt = PARSE_PROMPT.format(
        boss=char.get("name", folder.name), summary=char.get("summary", ""),
        specials=", ".join(f"{s['name']} ({s['description']})" for s in char.get("specials", [])) or "none",
        arena=arena) + text
    if previous and old_text is not None:  # unchanged parts must match, or their images are redrawn
        diff = "\n".join(difflib.unified_diff(old_text.splitlines(), text.splitlines(), "before", "after",
                                              lineterm="", n=0))
        prompt += PREVIOUS_NOTE.format(diff=diff or "(no change)", previous=json.dumps(previous, indent=1))
    config = types.GenerateContentConfig(
        response_mime_type="application/json", response_json_schema=PARSE_SCHEMA,
        thinking_config=types.ThinkingConfig(thinking_level="low"),
        http_options=types.HttpOptions(timeout=120_000))
    img = Image.open(find_arena(folder)).convert("RGB")
    img.thumbnail((768, 768))
    for attempt in range(1, attempts + 1):
        try:
            resp = ac.gemini().models.generate_content(model=ac.TEXT_MODEL, contents=[prompt, img], config=config)
            ac.usage.record(ac.TEXT_MODEL, resp)
            return json.loads(resp.text)
        except Exception as e:  # 503s, timeouts, malformed JSON
            if attempt == attempts:
                raise
            log(f"    parse error (attempt {attempt}): {str(e)[:200]}")
            time.sleep(10 * attempt)


# --------------------------------------------------------------------------- generate

def read_made(work):
    f = work / ".made.json"
    return json.loads(f.read_text()) if f.exists() else {}


def write_made(work, made):
    (work / ".made.json").write_text(json.dumps(made, indent=1, sort_keys=True) + "\n")


def back_needed(cfg):
    """Width of backdrop needed at game scale: what the camera sees over the whole level."""
    level_w = W * cfg["screens"]
    return cfg["back_parallax"] * (level_w - W) + W


def extend_left(pano, scenery, raw_path=None):
    """One outpainting step: a 21:9 canvas whose right third is the backdrop's left end. The model
    redraws that third a little differently (shifted, recolored), so its colors are matched to the
    original and the two are joined along the path where they agree best, not blended."""
    cw = round(WORK_H * 21 / 9)
    keep = cw // 3
    canvas = Image.new("RGB", (cw, WORK_H), (255, 0, 255))
    canvas.paste(pano.crop((0, 0, keep, WORK_H)), (cw - keep, 0))
    if raw_path and raw_path.exists():
        out = Image.open(raw_path).convert("RGB").resize((cw, WORK_H), Image.LANCZOS)
    else:
        # Sometimes the model paints the new part without connecting it to the artwork it was
        # given: a hard line where the two meet. Check for that and draw it again (up to 3 tries).
        best = None
        for attempt in range(1, SEAM_TRIES + 1):
            raw = generate(BACK_PROMPT.format(scenery=scenery), [canvas], aspect=ASPECT)
            out = raw.resize((cw, WORK_H), Image.LANCZOS)
            score = seam_step(out, cw - keep)
            if best is None or score < best[0]:
                best = (score, raw, out)
            if score < SEAM_LIMIT:
                break
            log(f"    the new part doesn't join up (step {score:.1f}x normal)"
                + ("; drawing it again" if attempt < SEAM_TRIES else "; keeping the best try"))
        _, raw, out = best
        if raw_path:
            raw.save(raw_path)
    return stitch_left(out, pano, keep)  # (backdrop, x of the new join)


def seam_step(img, x):
    """How sharply the image changes at column x, relative to its usual column-to-column change."""
    a = np.asarray(img).astype(np.float32)
    step = lambda c: np.abs(a[:, c - 3:c].mean(1) - a[:, c:c + 3].mean(1)).mean()
    typical = np.median([step(c) for c in range(100, x - 100, 61)])
    return step(x) / max(typical, 1e-3)


def hard_edge(pano, join, reach, before=450, after=150):
    """The model's drawing often has a hard vertical edge a little left of a join (where its copy
    of the old part starts), up to a few hundred pixels off, beyond the crown of the tree that
    covers the crossfade. Returns its x if there is one the crown misses, else None. A seam runs
    straight down through sky and treetops alike; a building's edge stops at its roof."""
    a = np.asarray(pano.crop((0, 0, pano.width, round(WORK_H * 0.55)))).astype(np.float32)
    def straight(c):  # share of rows where the picture jumps at column c
        return float((np.abs(a[:, c - 3:c].mean(1) - a[:, c:c + 3].mean(1)).sum(1) > 40).mean())
    runs = {c: straight(c) for c in range(max(3, join - before), min(pano.width - 3, join + after), 2)}
    edge = max(runs, key=runs.get)
    return edge if runs[edge] >= 0.6 and abs(edge - join) > reach else None


def crown_reach(tree):
    """Half the width of a tree's crown near its top (an eighth of the way down), where it's narrow."""
    a = np.asarray(tree)[:, :, 3] > 0
    row = np.nonzero(a[round(a.shape[0] * 0.125)])[0]
    return (row[-1] - row[0]) / 2 * 0.85 if len(row) else tree.width / 4


def stitch_left(out, pano, keep):
    """Join a new stretch (out, whose right third redraws pano's left end) onto pano with a short
    crossfade where the new part meets the old. Returns (backdrop, x of the join). The model's copy
    of the old part is never exact, so the join is covered with a tree at build time; correcting
    colors or position from that copy made things worse (errors compound stretch after stretch)."""
    cw = out.width
    new_w = cw - keep
    seam = round(cw * SEAM)
    a = np.asarray(out.crop((new_w, 0, new_w + seam, WORK_H))).astype(np.float32)
    b = np.asarray(pano.crop((0, 0, seam, WORK_H))).astype(np.float32)
    t = np.linspace(0, 1, seam)[None, :, None]
    result = Image.new("RGB", (new_w + pano.width, WORK_H))
    result.paste(out.crop((0, 0, new_w, WORK_H)), (0, 0))
    result.paste(pano, (new_w, 0))
    result.paste(Image.fromarray((a * (1 - t) + b * t).astype(np.uint8)), (new_w, 0))
    return result, new_w + seam // 2  # the middle of the fade, where a tree covers it best


def stage_back(folder, cfg, work, made, redo):
    k = key(cfg["scenery"], cfg["horizon"])
    if made.get("back", k) != k or redo:  # a new scenery description: start the backdrop over
        log("  back: the scenery changed, redrawing the backdrop")
        for p in work.glob("back_*.png"):  # the stitched stretches and the drawings behind them
            p.unlink()
    arena = Image.open(find_arena(folder)).convert("RGB")
    cut = round(arena.height * cfg["horizon"])
    backdrop = arena.crop((0, 0, arena.width, cut))
    pano = backdrop.resize((round(backdrop.width * WORK_H / cut), WORK_H), Image.LANCZOS)
    need = back_needed(cfg) * WORK_H / cfg["floor_y"]  # in source pixels
    i, joins = 0, []  # x of every join between stretches, to cover with trees at build time
    while pano.width < need:
        i += 1
        path = work / f"back_{i}.png"
        if path.exists() and path.with_suffix(".json").exists():
            pano = Image.open(path).convert("RGB")
            joins = json.loads(path.with_suffix(".json").read_text())["joins"]
            continue
        raw = work / f"back_raw_{i}.png"  # the model's own image, kept so stitching can be redone free
        log(f"  back: extending the backdrop left, stretch {i} ({pano.width} of {round(need)} px)"
            + (" from the saved drawing" if raw.exists() else ""))
        before = pano.width
        pano, join = extend_left(pano, cfg["scenery"], raw)
        joins = [join] + [j + pano.width - before for j in joins]
        pano.save(path)
        path.with_suffix(".json").write_text(json.dumps({"joins": joins}) + "\n")
    made["back"] = k


def make_seamless(img, overlap=1 / 6):
    """Wrap the right edge onto the left with a crossfade so the tile repeats without a seam."""
    w, h = img.size
    o = round(w * overlap)
    arr = np.asarray(img).astype(np.float32)
    t = np.linspace(0, 1, o)[None, :, None]
    left = arr[:, w - o:] * (1 - t) + arr[:, :o] * t
    tile = arr[:, :w - o].copy()
    tile[:, :o] = left
    return Image.fromarray(tile.astype(np.uint8))


def piece(work, made, name, k, redo, draw):
    """Draw one cached image unless it's there and still matches its description."""
    path = work / f"{name}.png"
    if path.exists() and name not in made:
        made[name] = k  # made before keys were recorded: treat as current
    if path.exists() and made.get(name) == k and not redo:
        return
    log(f"  {name}: " + ("redrawing (description changed)" if path.exists() and not redo else "drawing"))
    draw().save(path)
    made[name] = k


def stage_generate(folder, cfg, work, only, force):
    made = read_made(work)
    wants = lambda name: not only or name in only
    redo = lambda name: force and (not only or name in only)
    arena = Image.open(find_arena(folder)).convert("RGB")
    ref = arena.copy()
    ref.thumbnail((1024, 1024))
    try:
        if wants("back"):
            stage_back(folder, cfg, work, made, redo("back"))
        if wants("floor"):
            piece(work, made, "floor", key(FLOOR_PROMPT), redo("floor"),
                  lambda: generate(FLOOR_PROMPT, [ref], aspect=ASPECT))
        for p in cfg["props"]:
            name = f"prop_{p['name']}"
            if wants(name):
                piece(work, made, name, key(p["description"]), redo(name),
                      lambda p=p: generate(PROP_PROMPT.format(description=p["description"]), [ref]))
        if wants("jointree"):
            piece(work, made, "jointree", key(cfg["join_cover"]), redo("jointree"),
                  lambda: generate(PROP_PROMPT.format(description=cfg["join_cover"]), [ref]))
    finally:
        write_made(work, made)
    if not only or any(o == "enemies" or o.startswith("enemy_") for o in only):
        stage_enemies(folder, cfg, work, only, force)


# --------------------------------------------------------------------------- enemies
# Each enemy kind gets a small sprite sheet, like a fighter's but with only what a beat 'em up
# grunt needs. First a reference design drawn in the boss's style (there's no photo), then every
# frame from that reference, the same way add_character.py draws fighters from a photo.
# Cached in Characters/<Name>/campaign/enemies/<slug>/, built to build/campaigns/<slug>/enemies/.

ENEMY_REF_PROMPT = """Design a regular enemy for a 1990s SNES 16-bit pixel-art side-scrolling beat 'em up (like Double Dragon)
set on a university campus. The attached sprite is the level's boss: draw the enemy in exactly the same
pixel-art style, pixel size, outline weight, shading and level of detail, but as a completely different {kind}.
The enemy: {name}. {look}
Personality: {personality}. Fighting style: {fighting_style}
Exactly one full-body sprite in a ready stance, side view facing RIGHT (a 3/4 view toward the right is fine),
the whole body visible from top to bottom, centered, about 80% of the image height.{anatomy}
No text, no UI, no shadow, no ground, no other characters.
Background: perfectly flat solid magenta (#FF00FF) with no gradient or texture."""

ENEMY_FRAME_PROMPT = """You are producing animation frames for a 1990s SNES 16-bit pixel-art side-scrolling beat 'em up (like Double Dragon).
The first image is the reference for this enemy.{anchor_note}
Draw the SAME enemy: same design, face, clothing, colors, proportions and anything it carries.
The enemy: {name}. {look} Personality: {personality}.

Pose: {pose}

Requirements:
- exactly one full-body sprite, side view facing RIGHT (a 3/4 view toward the right is fine)
- the whole body visible from top to bottom, centered, about 80% of the image height{anatomy}
- 16-bit pixel-art style with crisp pixels, limited palette, dark outlines
- no text, no UI, no shadow, no ground, no other characters, no motion lines or effects, nothing
  flying or floating loose around the body (unless the pose throws it)
- background: perfectly flat solid magenta (#FF00FF) with no gradient or texture"""

ENEMY_ANCHOR = (" The second image is an approved frame of the same enemy: match its art style, pixel size, colors "
                "and build exactly, but NOT its pose; the pose comes only from the description below.")
HUMANOID_NOTE = "\n- normal anatomy: exactly two legs and two arms, every limb attached"

# Walks are drawn all at once as one strip, like the fighters' (add_character.WALK_STRIP_PROMPT):
# separate drawings of each step never lined up into a smooth cycle. A humanoid gets the fighters'
# 8-step leg cycle with its own upper body; a machine gets 4 frames of however it gets around.
_FIGHTER_UPPER = "Upper body, the same in all 8, as in the second image: fists up guarding the face, torso upright."
assert _FIGHTER_UPPER in ac.WALK_STRIP_PROMPT
ENEMY_WALK_PROMPT = (ac.WALK_STRIP_PROMPT
                     .replace("1990s SNES 16-bit fighting game", "1990s SNES 16-bit side-scrolling beat 'em up")
                     .replace(_FIGHTER_UPPER, "Upper body, the same in all 8, as in the second image: the same arm "
                              "pose, anything carried held the same way in the same hands, torso upright. Nothing "
                              "floating loose.")
                     + "\nThe enemy: {name}. {look}")
MACHINE_WALK_PROMPT = """Using the reference images, draw a MOVEMENT CYCLE sprite sheet for a 1990s SNES 16-bit side-scrolling beat 'em up.
The first image is the enemy; the second is an approved sprite of it: match its art style, pixel size, colors,
build and viewing angle exactly. Show the SAME enemy 4 times in ONE ROW, evenly spaced with wide magenta gaps,
each whole and facing RIGHT, all the same size and on the same ground line; no two touch or overlap.
The enemy: {name}. {look}
The 4 frames are one smooth loop of it moving forward the way it gets around (wheels turning a quarter turn
per frame, legs or treads stepping, a slight bob up and down), changing only a little from each frame to the
next, like a hand-animated arcade sprite. Its shape and size stay the same in all 4.
No text, no numbers, no ground, no shadows, no motion lines, nothing floating loose.
Background: perfectly flat solid magenta (#FF00FF) with no gradient or texture."""
MACHINE_WALK_FRAMES = 4
BLOCK_MOVE = ("block", "guard", "shield", "parry", "defend")

# (frames, fit) per animation; fit as in add_character.ANIMATIONS. Attacks get room to grow (an
# overhead slam is taller than standing); a wrecked machine stays its size, a body lies down.
ENEMY_POSES = {
    "humanoid": {
        "idle": [f"standing in a ready-to-fight stance that suits them ({{style}})",
                 "the same ready stance at the low point of a breathing bounce, shoulders slightly lowered"],
        "walk": ["walking forward to the right, front leg stepping forward, one arm swinging forward and the "
                 "other back; anything carried stays in those two hands",
                 "walking forward to the right, back leg passing the front leg, arms swinging; anything carried "
                 "stays in those two hands"],
        "hit": ["recoiling from a hit, head snapped back, body leaning away to the left, pained"],
        "ko": [ac.ANIMATIONS["ko"]["frames"][0][0]],
    },
    "other": {
        "idle": ["at rest but switched on and ready to attack, as described",
                 "the same, bobbing slightly (the second frame of an idle animation)"],
        "walk": ["moving forward to the right the way it gets around, first of two animation frames",
                 "moving forward to the right the way it gets around, second of two animation frames"],
        "hit": ["jolted by a hit, tipping back to the left, a dent showing"],
        "ko": ["WRECKED and KNOCKED OVER: the whole machine tipped over and lying on its side on the ground, "
               "its bottom and wheels facing the viewer's left, broken and smoking, seen from the side; it is "
               "much wider than it is tall"],
    },
}
ENEMY_FITS = {"idle": ("h", 1.0), "walk": ("h", 1.0), "hit": ("h", 0.95), "block": ("h", 0.98),
              "attack": ("idle", 0.6, 1.35), "ko": {"humanoid": ("idle", 0.25, 0.6), "other": ("idle", 0.4, 1.0)}}


def enemy_slug(e):
    return ac.slugify(e["name"])


def walk_poses(body):
    """One description per walk frame (they're drawn together as one strip, see ENEMY_WALK_PROMPT)."""
    if body == "humanoid":
        return [pose for pose, _ in ac.ANIMATIONS["walk"]["frames"]]
    return [f"moving forward, step {i + 1} of {MACHINE_WALK_FRAMES}" for i in range(MACHINE_WALK_FRAMES)]


def enemy_plan(e):
    """[(animation, stem, pose)] for every frame, and {animation: move name} for the attacks."""
    body = e.get("body", "humanoid")
    poses = ENEMY_POSES[body]
    plan = [("idle", f"idle_{i}", pose.format(style=e["fighting_style"])) for i, pose in enumerate(poses["idle"])]
    plan += [("walk", f"walk_{i}", pose) for i, pose in enumerate(walk_poses(body))]
    moves = {}
    for n, move in enumerate(e["moves"][:2], 1):
        name, _, what = move.partition(":")
        what = what.strip().rstrip(".")
        if any(w in move.lower() for w in BLOCK_MOVE):
            anim = "block"
            plan.append((anim, "block_0", f"defending with \"{name.strip()}\": {what}, braced"))
        else:
            anim = f"attack{n}"
            plan.append((anim, f"{anim}_0", f"move \"{name.strip()}\" ({what.strip()}): the WINDUP, a split "
                                            "second before it lands"))
            plan.append((anim, f"{anim}_1", f"move \"{name.strip()}\" ({what.strip()}): the moment it LANDS, "
                                            "the attack reaching forward to the RIGHT at full extension"))
        moves[anim] = name.strip()
    plan += [(a, f"{a}_0", poses[a][0]) for a in ("hit", "ko")]
    return plan, moves


def stage_enemies(folder, cfg, work, only, force):
    """Draw every enemy kind's reference design and frames (cached, redrawn when its look changes)."""
    boss = folder / "frames" / "idle_0.png"
    style = Image.open(boss if boss.exists() else find_arena(folder)).convert("RGB")
    style.thumbnail((768, 768))
    for e in cfg.get("enemies", []):
        slug = enemy_slug(e)
        if only and not {"enemies", f"enemy_{slug}"} & only:
            continue
        d = work / "enemies" / slug
        d.mkdir(parents=True, exist_ok=True)
        made = read_made(d)
        body = e.get("body", "humanoid")
        anatomy = HUMANOID_NOTE if body == "humanoid" else ""
        log(f"  enemy {e['name']}:")
        try:
            look = key(e["look"], body)
            piece(d, made, "ref", look, force, lambda: generate(ENEMY_REF_PROMPT.format(
                kind="character" if body == "humanoid" else "kind of enemy", name=e["name"], look=e["look"],
                personality=e["personality"], fighting_style=e["fighting_style"],
                anatomy="\nNormal anatomy: exactly two legs and two arms." if anatomy else ""), [style]))
            ref = Image.open(d / "ref.png").convert("RGB")
            plan, _ = enemy_plan(e)
            for anim, stem, pose in plan:
                if anim == "walk":
                    continue  # drawn below, all at once
                anchor = d / "idle_0.png"
                # not for knockouts: shown a standing frame, they came back standing
                use_anchor = anim not in ("idle", "ko") or stem == "idle_1"
                refs = [ref] + ([Image.open(anchor).convert("RGB")] if use_anchor and anchor.exists() else [])
                prompt = ENEMY_FRAME_PROMPT.format(
                    anchor_note=ENEMY_ANCHOR if len(refs) > 1 else "", name=e["name"], look=e["look"],
                    personality=e["personality"], pose=pose, anatomy=anatomy)

                def draw(prompt=prompt, refs=refs, pose=pose, anim=anim):
                    for attempt in range(1, ac.ANATOMY_TRIES + 1):
                        img = generate(prompt, refs)
                        problems = []
                        if body == "humanoid":
                            problems = ac.anatomy_problems(img, pose, anim != "ko")
                        if anim == "ko" and body == "humanoid":
                            problems += ac.shape_problems("ko", img, None)
                        if not problems:
                            return img
                        log(f"    {', '.join(problems)}; " + ("trying again" if attempt < ac.ANATOMY_TRIES
                                                              else "keeping it anyway, check it by hand"))
                    return img
                # keyed on the look too: a new design redraws every frame
                piece(d, made, stem, key(look, pose), force, draw)
            humanoid = body == "humanoid"
            walk_prompt = (ENEMY_WALK_PROMPT if humanoid else MACHINE_WALK_PROMPT).format(name=e["name"],
                                                                                         look=e["look"])
            ac.stage_walk_strip(d, ref, made, force, e, prompt=walk_prompt, poses=walk_poses(body),
                                rows=2 if humanoid else 1, check=humanoid)
        finally:
            write_made(d, made)


def build_enemy(e, src, out):
    """One enemy's sprite sheet, in the same format as a fighter's sheet.json (static/game.js)."""
    body = e.get("body", "humanoid")
    base = round(SPRITE_HEIGHT * e.get("height", 1))
    plan, moves = enemy_plan(e)
    if not all((src / f"{stem}.png").exists() for _, stem, _ in plan):
        return None
    raw = lambda stem: cutout(ac.load_frame(src / f"{stem}.png"))  # cutout also clears the pink fringe
    idle_raw = raw("idle_0")
    idle_height = idle_raw.crop(idle_raw.getbbox()).height
    frames = {}
    walk_stems = [stem for anim, stem, _ in plan if anim == "walk"]
    walk_rows = 2 if body == "humanoid" else 1
    for anim, stem, _ in plan:
        fit = ENEMY_FITS["attack" if anim.startswith("attack") else anim]
        fit = fit[body] if isinstance(fit, dict) else fit
        if anim == "walk":
            # Each grid row of the strip can come out a little smaller than the other: size each
            # frame against the tallest in its row, so the head only dips on the strides.
            per_row = len(walk_stems) // walk_rows
            row = walk_stems.index(stem) // per_row
            height = lambda st: (lambda b: b[3] - b[1])(raw(st).getbbox())
            fit = ("h", height(stem) / max(height(st) for st in walk_stems[row * per_row:(row + 1) * per_row]))
        fit = ("h", e["frame_scale"][stem]) if stem in e.get("frame_scale", {}) else fit
        im = raw(stem)
        if anim == "ko":
            box = im.getbbox()
            if (box[2] - box[0]) < (box[3] - box[1]) * 1.4:
                # Drawn still standing (Gemini often won't lay a bulky figure down): topple it
                # backward onto the ground, as long as it stood.
                im = im.crop(box).rotate(90, expand=True)
                fit = ("w", (box[3] - box[1]) / idle_height)
        frames.setdefault(anim, []).append(ac.fit_scale(im, fit, idle_height, base))
    palette = ac.build_palette([im for ims in frames.values() for im in ims])
    idle = frames["idle"][0]
    idle_geo = ac.frame_geometry(idle, 0, False, base=base)
    idle_reach = idle.width - idle_geo["ax"]
    idle_torso = ac.torso_x(idle) - idle_geo["ax"]
    fps = {"idle": 4, "walk": 12 if body == "humanoid" else 8, "attack1": 8, "attack2": 8, "block": 1, "hit": 6,
           "ko": 1}
    order, meta = [], {}
    for anim, ims in frames.items():
        active = [1] if anim.startswith("attack") else []
        meta[anim] = {"fps": fps[anim], "loop": anim in ("idle", "walk"), "active": active, "frames": []}
        for i, im in enumerate(ims):
            im = ac.apply_palette(im, palette)
            geo = ac.frame_geometry(im, idle_reach, i in active, anim == "ko" and body == "humanoid", base=base)
            if anim == "walk" and body == "humanoid":
                geo["ax"] = int(round(ac.torso_x(im) - idle_torso))  # pinned by the chest, as fighters' are
            order.append((anim, im, geo))
    sheet, rects = ac.pack([im for _, im, _ in order])
    for (anim, _, geo), (x, y, w, h) in zip(order, rects):
        meta[anim]["frames"].append({"x": x, "y": y, "w": w, "h": h, **geo})
    out.mkdir(parents=True, exist_ok=True)
    sheet.save(out / "sheet.png")
    (out / "sheet.json").write_text(json.dumps(
        {"image": "sheet.png", "height": base, "facing": "right", "animations": meta, "moves": moves},
        indent=1) + "\n")
    return len(order)


# --------------------------------------------------------------------------- build

def cutout(img):
    """Key out the magenta background, then any magenta left in gaps (between spokes, leaves) and
    the pink fringe it leaves on edges."""
    arr = np.array(ac.remove_background(img))
    r, g, b = (arr[:, :, k].astype(np.int16) for k in range(3))
    arr[(r - g > 70) & (b - g > 70), 3] = 0
    im = ac.drop_specks(Image.fromarray(arr, "RGBA"))
    return im.crop(im.getbbox())


def to_height(im, h):
    h = max(1, round(h))
    return im.resize((max(1, round(im.width * h / im.height)), h), Image.Resampling.BOX)


def rng_tree(n):
    """A join tree's height (fraction of the backdrop), varied a little so they don't look stamped."""
    return (1.02, 0.94, 0.98, 1.06, 0.92, 1.0)[n % 6]


def plan_waves(enemies, screens, rng):
    """Spread the enemies over the level in waves, one per screen from the second on (the last
    screen is the boss's), each enemy no earlier than its first_screen; later waves get bigger."""
    pool = sorted((e["first_screen"], rng.random(), e["name"]) for e in enemies for _ in range(e["count"]))
    wave_screens = list(range(2, screens))  # 1-based screen numbers
    if not pool or not wave_screens:
        return []
    weights = [1 + i * 0.5 for i in range(len(wave_screens))]
    sizes = [max(1, round(len(pool) * w / sum(weights))) for w in weights]
    waves, i = [], 0
    for s, size in zip(wave_screens, sizes):
        group = []
        while i < len(pool) and len(group) < size and pool[i][0] <= s:
            group.append(pool[i][2]); i += 1
        if group:
            waves.append({"x": round((s - 1) * W + W * 0.6), "screen": s, "enemies": group})
    for _, _, name in pool[i:]:  # anyone left over joins the last wave
        waves[-1]["enemies"].append(name) if waves else None
    return waves


def arena_view(folder, cfg):
    """Where the boss's arena picture (as the game server builds it: ARENA_HEIGHT tall, at least
    screen-wide, cropped from the bottom; server.py build_arena) sits in the street's last screen,
    whose backdrop ends in the same photo, smaller: {x, y, scale} of its top-left corner and size.
    The game grows it from there to full screen as the player walks up to the boss, so the arena
    is approached rather than swapped in."""
    with Image.open(find_arena(folder)) as src:
        sw, sh = src.size
    scale_a = max(H / sh, W / sw)  # the arena build's scale (server.py: ARENA_HEIGHT, ARENA_MIN_WIDTH)
    aw, ah = max(W, round(sw * scale_a)), max(H, round(sh * scale_a))
    scale_b = cfg["floor_y"] / round(sh * cfg["horizon"])  # the backdrop's: the photo above the horizon
    k = scale_b / scale_a
    # the backdrop ends with the photo's right edge at the screen's right edge
    return {"x": round(W - aw * k, 2), "y": round((ah - H) * k, 2), "scale": round(k, 4), "width": aw}


def mini_boss(folder, slug, waves, level_w):
    """The mini boss named in the boss's profile ("Mini boss: <character>"), placed halfway along
    the street between two waves, or None. after_wave: how many waves must be beaten first."""
    txt, _ = ac.find_sources(folder)
    name = ac.mini_boss_of(txt)
    if not name:
        return None
    key_ = lambda s: "".join(c for c in s.lower() if c.isalnum())
    for d in sorted(ac.ROOT.joinpath("Characters").iterdir()):
        built = ac.BUILD_DIR / ac.slugify(d.name) / "character.json"
        if not built.exists():
            continue
        shown = json.loads(built.read_text()).get("name", d.name)
        if key_(name) in (key_(d.name), key_(shown)):
            if ac.slugify(d.name) == slug:
                log(f"  build: {name} can't be the mini boss of their own campaign; skipped")
                return None
            k = len(waves) // 2  # the middle of the street
            before = waves[k - 1]["x"] if k else W * 0.6
            after = waves[k]["x"] if k < len(waves) else level_w - W
            return {"character": ac.slugify(d.name), "name": shown, "after_wave": k,
                    "x": round((before + after) / 2 + 40), "arena": f"{ac.slugify(d.name)}_home"}
    log(f"  build: no built character called {name!r} for the mini boss (check the Mini boss: line); skipped")
    return None


def build(folder, cfg, work):
    slug = ac.slugify(folder.name)
    out = CAMPAIGN_BUILD / slug
    (out / "props").mkdir(parents=True, exist_ok=True)
    level_w = W * cfg["screens"]
    floor_y = cfg["floor_y"]

    backs = sorted((p for p in work.glob("back_*.png") if p.stem.split("_")[1].isdigit()),
                   key=lambda p: int(p.stem.split("_")[1]))
    if not backs or not (work / "floor.png").exists():
        sys.exit("build: images missing; run the generate stage")
    pano = Image.open(backs[-1]).convert("RGB")
    meta = backs[-1].with_suffix(".json")
    if meta.exists() and (work / "jointree.png").exists():  # hide each join behind a tree
        tree = cutout(Image.open(work / "jointree.png").convert("RGB"))
        ground = WORK_H + round(WORK_H * 0.02)
        for n, x in enumerate(json.loads(meta.read_text())["joins"]):
            t = to_height(tree, WORK_H * rng_tree(n))
            edge = hard_edge(pano, x, crown_reach(t))
            if edge is not None:
                # a second, smaller tree behind the first, mirrored the other way, over the edge
                back = to_height(tree, t.height * 0.8)
                back = back if n % 2 else back.transpose(Image.FLIP_LEFT_RIGHT)
                pano.paste(back, (round(edge - back.width / 2), ground - back.height), back)
            if n % 2:
                t = t.transpose(Image.FLIP_LEFT_RIGHT)
            pano.paste(t, (round(x - t.width / 2), ground - t.height), t)
    back = pano.resize((round(pano.width * floor_y / pano.height), floor_y), Image.Resampling.BOX)
    need = round(back_needed(cfg))
    if back.width < need:
        sys.exit("build: the backdrop is too short for this many screens; run the generate stage")
    back = back.crop((back.width - need, 0, back.width, floor_y))  # keep the arena end
    back.save(out / "back.png")

    fh = H - floor_y
    floor = make_seamless(Image.open(work / "floor.png").convert("RGB"))
    floor.resize((round(floor.width * fh / floor.height), fh), Image.Resampling.BOX).save(out / "floor.png")

    rng = random.Random(slug)  # the same layout every build
    boss_zone = level_w - W  # the last screen is the boss's arena: keep it clear
    props, placed = [], []
    for old in (out / "props").glob("*.png"):
        old.unlink()
    for p in cfg["props"]:
        src = work / f"prop_{p['name']}.png"
        if not src.exists():
            log(f"  build: no image for prop {p['name']} yet; skipped (run the generate stage)")
            continue
        im = to_height(cutout(Image.open(src).convert("RGB")), SPRITE_HEIGHT * p["size"])
        im.save(out / "props" / f"{p['name']}.png")
        # tall things (lamp posts) at a steady rhythm; small things scattered, less often in front
        every = 330 if p["size"] > 1 else (650 if p["where"] == "front" else 560)
        x = rng.uniform(80, every)
        while x < boss_zone - 40:
            y = floor_y + rng.randint(2, 7) if p["where"] == "back" else H + rng.randint(4, 14)
            if all(abs(x - q) > 40 for q in placed):  # don't stack props on each other
                props.append({"image": f"props/{p['name']}.png", "x": round(x), "y": y, "layer": p["where"],
                              "breakable": p["size"] <= 1})  # the hero can smash it (not lamp posts)
                placed.append(x)
            x += every * rng.uniform(0.7, 1.3)
    props.sort(key=lambda q: (q["layer"], q["y"]))

    enemies = []
    for e in cfg.get("enemies", []):
        info = {k: e[k] for k in ("name", "look", "personality", "fighting_style", "moves", "count")}
        n = build_enemy(e, work / "enemies" / enemy_slug(e), out / "enemies" / enemy_slug(e))
        if n:
            info["sheet"] = f"enemies/{enemy_slug(e)}/sheet.json"
        else:
            log(f"  build: no sprites for {e['name']} yet (run the generate stage)")
        enemies.append(info)
    waves = plan_waves(cfg.get("enemies", []), cfg["screens"], rng)
    level = {
        "character": slug, "width": level_w, "height": H, "floor_y": floor_y,
        "story": {k: cfg.get(k, "") for k in ("title", "boss_motive", "intro", "boss_taunt", "outro")},
        "back": {"image": "back.png", "parallax": cfg["back_parallax"]},
        "floor": {"image": "floor.png"},
        "props": props,
        "enemies": enemies,
        # each wave stops the screen from scrolling at x until its enemies are beaten
        "waves": waves,
        "boss": {"x": boss_zone, "arena": f"{slug}_home", "view": arena_view(folder, cfg)},
    }
    mini = mini_boss(folder, slug, waves, level_w)
    if mini:
        level["mini_boss"] = mini
    (out / "level.json").write_text(json.dumps(level, indent=1, ensure_ascii=False) + "\n")
    if mini:
        log(f"  build: mini boss {mini['name']} after wave {mini['after_wave']} of {len(waves)}")
    log(f"  build: wrote {ac.rel(out)}/ ({cfg['screens']} screens, {len(props)} props, "
        f"{len(level['waves'])} waves of {sum(len(w['enemies']) for w in level['waves'])} enemies, "
        f"{sum('sheet' in e for e in enemies)} of {len(enemies)} enemy kinds drawn)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, help="character folder, e.g. Characters/ChuckT")
    ap.add_argument("--stage", choices=["parse", "generate", "build", "all"], default="all")
    ap.add_argument("--only", default="", help="comma list of pieces to (re)draw: back, floor, prop_<name>, enemies, enemy_<slug>")
    ap.add_argument("--force", action="store_true", help="redraw cached pieces even if unchanged")
    ap.add_argument("--reparse", action="store_true", help="read campaign.txt again even if unchanged")
    args = ap.parse_args()
    folder = args.folder.resolve()
    if not folder.is_dir():
        sys.exit(f"no such folder: {args.folder}")
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    log(f"[{folder.name} campaign]")
    work = folder / "campaign"
    work.mkdir(exist_ok=True)
    cfg_path = folder / "campaign.json"
    if args.stage in ("parse", "all"):
        cfg = stage_parse(folder, cfg_path, args.reparse)
    else:
        if not cfg_path.exists():
            sys.exit(f"no {ac.rel(cfg_path)} yet; run the parse stage")
        cfg = {**LAYOUT, **STORY_DEFAULTS, **json.loads(cfg_path.read_text())}
    if args.stage in ("generate", "all"):
        if not ac.gemini():
            sys.exit("generate: set GEMINI_API_KEY (or add gemini_key.txt)")
        stage_generate(folder, cfg, work, only, args.force)
    if args.stage in ("build", "all"):
        build(folder, cfg, work)


if __name__ == "__main__":
    main()
