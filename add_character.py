#!/usr/bin/env python3
"""Build game assets for a character folder.

    python add_character.py Characters/Tonian            # all stages
    python add_character.py --all                        # every folder in Characters/
    python add_character.py Characters/Tonian --stage parse
    python add_character.py Characters/Tonian --only punch,kick --force

Stages
  parse   <Name>.txt  -> Characters/<Name>/character.json   (editable; kept unless --reparse)
  frames  reference image + character.json -> Characters/<Name>/frames/*.png  (Gemini, cached)
  sheet   frames -> build/characters/<slug>/{sheet.png, sheet.json, character.json, props/, portrait.png}

--placeholder builds a playable sheet from crude transforms of the reference image,
with no API calls; the next real frames run replaces those frames.

A character folder holds <Folder>.txt and a <Folder>.(png|jpg|...) reference image.
An Arena_<Name>.(png|jpg|...) image is the character's home arena and <Folder>.mp3 its theme:
matches against that character are fought there to that music. The server picks both up
directly; no build needed.

Raw frames are cached next to the source, so a bad frame can be regenerated with
--only <anim> --force, or replaced by hand, and the sheet stage re-run for free.

Health, strength and defense the text doesn't state are worked out from the description, sharing
a 300-point budget (each 70..150, see settle_stats) so no character is simply better; stated
numbers are used as written, and inferred ones share whatever they leave of the 300.

Every new character frame gets a quick vision check (~$0.003) for extra or missing limbs and is
redrawn, up to 3 tries, if it fails. --check runs the same check on cached frames and redraws the
bad ones, e.g.  python add_character.py --all --check

Drafts: a folder needs only the reference image to start. Without <Folder>.txt a template one
is written for you to fill in; until it's edited the character gets default stats and no special
moves, and is playable. Edit the text file any time and run this again: a changed text file is re-parsed automatically (keeping fields you added by
hand, such as "proportions"), and only frames whose pose or prop changed are regenerated (new or
changed special moves, typically). Personality and expressions don't trigger regeneration;
use --only ... --force to refresh frames for those.

Needs GEMINI_API_KEY (or GOOGLE_API_KEY), from the environment or gemini_key.txt,
for parse and frames. Without a key, parse falls back to a simple rule-based reader of the text file.
Each Gemini call logs its tokens and estimated cost (see PRICES); a total is printed at the end.
"""

import argparse
import atexit
import difflib
import hashlib
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent

# gemini_key.txt is the single source of truth for the key.
if not os.environ.get("GEMINI_API_KEY") and (ROOT / "gemini_key.txt").exists():
    os.environ["GEMINI_API_KEY"] = (ROOT / "gemini_key.txt").read_text().strip()

CHAR_DIR = ROOT / "Characters"
BUILD_DIR = ROOT / "build" / "characters"

IMAGE_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image")
TEXT_MODEL = os.environ.get("GEMINI_TEXT_MODEL", "gemini-3.5-flash")

# Game renders at 384x224 (SNES-like); a standing fighter is this many pixels tall.
SPRITE_HEIGHT = 112
PORTRAIT_SIZE = 64
PALETTE_COLORS = 48
BG_KEY = (255, 0, 255)

INPUT_TOKENS = ["W", "A", "S", "D", "LMB", "RMB"]
FALLBACK_INPUTS = [["S", "D", "LMB"], ["D", "S", "RMB"], ["A", "A", "RMB"], ["S", "S", "RMB"],
                   ["W", "S", "LMB"], ["S", "A", "RMB"], ["D", "D", "RMB"], ["W", "W", "LMB"]]
MAX_SPECIALS = 4

# Each animation: list of (pose prompt, expression key); fps; loop; fit = (axis, ratio of SPRITE_HEIGHT),
# or ("idle", lo, hi): drawn at the same scale as the standing frame, so the head and body stay
# the size they are when standing (Gemini keeps the figure's scale across frames, but how low a
# crouch or how long a lying body comes out varies). The height ratio is clamped to lo..hi in
# case a frame comes back zoomed in or out.
ANIMATIONS = {
    "idle": dict(fps=4, loop=True, fit=("h", 1.0), frames=[
        ("fighting stance, fists raised to guard the face, knees slightly bent, weight on the back foot", "idle"),
        ("the same fighting stance at the low point of a breathing bounce, shoulders slightly lowered", "idle"),
    ]),
    "walk": dict(fps=6, loop=True, fit=("h", 1.0), frames=[
        ("walking forward in fighting stance, front leg stepping forward, fists up", "idle"),
        ("walking forward in fighting stance, back leg passing the front leg, fists up", "idle"),
    ]),
    "crouch": dict(fps=1, loop=False, fit=("h", 0.9), hurt_h=0.6, frames=[
        # Spelled out as body geometry: vaguer prompts came back standing or only slightly bent.
        ("LOW FIGHTING CROUCH as in Street Fighter II (hold down): a deep squat with the hips dropped "
         "almost to knee level, thighs horizontal, knees bent past 90 degrees and pushed forward, feet "
         "flat and wide apart, torso leaning forward and hunched, head pulled down between raised fists "
         "guarding the face. The figure's total height is only about 60% of its standing height, "
         "and the figure is wider than it is tall from the waist down", "idle"),
    ]),
    "jump": dict(fps=1, loop=False, fit=("idle", 0.6, 1.0), frames=[
        ("in mid-air during a jump, knees tucked up toward the chest, fists ready", "attack"),
    ]),
    "punch": dict(fps=12, loop=False, fit=("h", 1.0), active=[1], frames=[
        ("winding up a punch, rear fist pulled back by the shoulder", "attack"),
        ("throwing a straight punch with the arm fully extended forward to the right at head height", "attack"),
    ]),
    "kick": dict(fps=10, loop=False, fit=("h", 1.0), active=[1], frames=[
        # Leg count spelled out: with the two-footed stance as anchor, kicks came back with three legs.
        ("winding up a kick, standing on ONE leg with the other knee raised high; exactly two legs, "
         "only one foot on the ground", "attack"),
        ("high side kick: standing on ONE straight supporting leg (the only foot on the ground) while the "
         "OTHER leg is fully extended forward to the right at chest height. Exactly two legs in total, "
         "both attached at the hips, no extra legs or feet. Ignore the leg positions in the reference "
         "images: there is no second leg standing behind the kicking leg", "attack"),
    ]),
    "block": dict(fps=1, loop=False, fit=("h", 0.95), frames=[
        ("blocking, both forearms raised and crossed in front of the face, braced", "hit"),
    ]),
    # Extended move set. optional: a character built before these existed still gets a sheet,
    # and the game stands in the nearest basic animation (static/game.js FALLBACK_ANIMS).
    "crouch_block": dict(fps=1, loop=False, fit=("h", 0.9), hurt_h=0.6, optional=True, frames=[
        ("BLOCKING WHILE CROUCHING, in a DEEP LOW SQUAT like a Street Fighter II crouch: hips dropped almost to knee level, thighs horizontal, knees bent past 90 degrees, feet flat and wide apart, torso hunched forward, head no higher than a standing person's chest. The figure's total height is only about 60% of its standing height, and it is wider than it is tall from the waist down. Both forearms raised and crossed in front of the face, "
         "braced", "hit"),
    ]),
    "crouch_punch": dict(fps=12, loop=False, fit=("h", 0.9), hurt_h=0.6, active=[1], optional=True, frames=[
        ("CROUCHING PUNCH windup, in a DEEP LOW SQUAT like a Street Fighter II crouch: hips dropped almost to knee level, thighs horizontal, knees bent past 90 degrees, feet flat and wide apart, torso hunched forward, head no higher than a standing person's chest. The figure's total height is only about 60% of its standing height, and it is wider than it is tall from the waist down. Rear fist pulled back by the shoulder", "attack"),
        ("CROUCHING PUNCH, still in a DEEP LOW SQUAT like a Street Fighter II crouch: hips dropped almost to knee level, thighs horizontal, knees bent past 90 degrees, feet flat and wide apart, torso hunched forward, head no higher than a standing person's chest. The figure's total height is only about 60% of its standing height, and it is wider than it is tall from the waist down. One arm fully extended straight forward to the right at "
         "shoulder height of the squat", "attack"),
    ]),
    "crouch_kick": dict(fps=10, loop=False, fit=("h", 0.7), hurt_h=0.55, active=[1], optional=True, frames=[
        ("LOW SWEEP windup: squatting very low on ONE bent leg, the other leg drawn in with its foot near "
         "the ground, one hand touching the floor for balance. Exactly two legs. The figure's total height "
         "is only about 55% of its standing height", "attack"),
        ("LOW SWEEP KICK along the floor: squatting very low on ONE bent supporting leg, the OTHER leg fully "
         "extended straight forward to the right, flat along the ground at ankle height, one hand on the "
         "floor. Same clothes as the reference, jacket closed. Exactly two legs in total, both attached at the hips. The figure is much wider than it "
         "is tall, its total height only about half its standing height", "attack"),
    ]),
    "jump_punch": dict(fps=12, loop=False, fit=("idle", 0.5, 1.0), active=[1], optional=True, frames=[
        ("in mid-air during a jump, knees tucked up, one fist pulled back ready to strike", "attack"),
        ("JUMPING PUNCH in mid-air: knees tucked up, body leaning forward, one arm fully extended forward "
         "and angled down to the right, striking downward. Both feet off the ground", "attack"),
    ]),
    # Up + punch. Until a character has these frames, the game uses its jump punch.
    # fits: per-frame sizes; the rising frame's raised fist adds height, so it's drawn taller
    # for the body to match the standing sprite.
    "uppercut": dict(fps=12, loop=False, fit=("h", 1.0), fits=[("h", 1.0), ("h", 1.22)], active=[1], optional=True, frames=[
        ("crouching low with knees bent, one fist pulled down by the hip, about to spring upward into "
         "an uppercut", "attack"),
        ("RISING UPPERCUT: springing upward off the ground, the punching arm driving straight up overhead "
         "with the fist at the top, the other arm down, knees bent, feet just leaving the floor", "attack"),
    ]),
    "jump_kick": dict(fps=10, loop=False, fit=("idle", 0.5, 1.0), active=[1], optional=True, frames=[
        ("in mid-air during a jump, both knees tucked up toward the chest, about to kick. Exactly two legs, "
         "both feet off the ground", "attack"),
        ("FLYING JUMP KICK in mid-air: ONE leg fully extended forward and slightly down to the right, the "
         "OTHER leg bent and tucked under the body, arms up for balance. Exactly two legs in total, both "
         "attached at the hips, both feet off the ground", "attack"),
    ]),
    "dive_kick": dict(fps=1, loop=False, fit=("idle", 0.5, 1.0), active=[0], optional=True, frames=[
        ("DIVE KICK in mid-air, plunging DOWNWARD at a steep diagonal: body angled down to the right, ONE "
         "leg fully extended down and forward toward the ground at the lower right (the foot is the lowest "
         "point), the OTHER leg bent back, arms up behind. Exactly two legs in total, both attached at the "
         "hips, nothing touching the ground", "attack"),
    ]),
    "hit": dict(fps=6, loop=False, fit=("h", 0.95), frames=[
        ("recoiling from a hit, head snapped back, body leaning away to the left", "hit"),
    ]),
    "ko": dict(fps=1, loop=False, fit=("idle", 0.25, 0.6), frames=[
        # Spelled out: "lying flat" alone came back seen from above (upright on the canvas) or standing.
        ("knocked out, lying flat on the back on the ground, eyes closed, arms limp. Seen from the SIDE "
         "like the other frames, NOT from above: the body is horizontal, head at one end and feet at the "
         "other, so the figure is about three times wider than it is tall", "hit"),
    ]),
    "victory": dict(fps=2, loop=True, fit=("h", 1.05), frames=[
        ("victory pose that shows off the personality", "victory"),
    ]),
}

FRAME_PROMPT = """You are producing animation frames for a 1990s SNES "Street Fighter II" style 2D fighting game.
The first image is the reference for the character.{anchor_note}
Draw the SAME character: same face, hair, glasses, facial hair, clothing, colors and body proportions.{proportions_note}
Personality: {personality}

Pose: {pose}
Facial expression: {expression}

Requirements:
- exactly one full-body sprite, side view facing RIGHT (a 3/4 view toward the right is fine, like Street Fighter II)
- the whole body is visible including both feet, centered, about 80% of the image height
- normal anatomy: exactly two legs and two arms, every limb attached; a raised or kicking leg is one
  of the two, so only one foot stays on the ground
- 16-bit pixel-art style with crisp pixels, limited palette, dark outlines
- no text, no UI, no shadow, no ground, no rocks, no other people, no animals or objects held{prop_note}
- background: perfectly flat solid magenta (#FF00FF) with no gradient or texture"""

PROP_PROMPT = """Draw a single object as a sprite for a 1990s SNES "Street Fighter II" style 2D fighting game: {description}
Requirements: only the object, no people, no hands, no text unless the description asks for it,
16-bit pixel-art style with crisp pixels and dark outlines, centered, filling about 80% of the image,
background: perfectly flat solid magenta (#FF00FF) with no gradient or texture."""

PORTRAIT_PROMPT = """Using the reference image, draw a character-select portrait for a 1990s SNES "Street Fighter II" style game.
Head and shoulders of the SAME character, facing the viewer, expression: {expression}.
16-bit pixel-art style with crisp pixels and dark outlines, no text, no frame or border,
background: perfectly flat solid magenta (#FF00FF) with no gradient or texture."""

PARSE_PROMPT = """Convert this fighting-game character description into JSON.

Rules:
- health, strength, defense: copy a number the text states exactly; null when the text doesn't give it.
- inferred_stats: ALWAYS fill in, judged from the description alone (ignore any stated numbers): health
  (toughness, size, stamina), strength (hitting power) and defense (guarding, armor, resilience). Share
  a budget of exactly 300 points between the three, each 70..150, so no character is simply better.
  e.g. a big hard-hitting brute 130/120/50 is not allowed (defense under 70); use 120/110/70. A frail,
  fast glass cannon 75/150/75; an armored tank 120/70/110; an all-rounder 100/100/100.
  reason: one short phrase naming the traits from the text that set them.
- If the text gives explicit punch, kick, special or block values, copy them into "explicit", otherwise use null.
- ai_traits are 0..1 weights inferred from the fighting style ("mostly punches" -> punch high, "jumps rarely" -> jump low).
- expressions: short facial-expression phrases matching the personality for idle, attack, hit and victory.
- victory_pose: one sentence describing a victory pose that fits the personality.
- taunts: two or three short lines the character might say.
- specials: at most 4, in the order given. For each special move: input is the button sequence the text states,
  using only the tokens W, A, S, D, LMB (punch: left click or J), RMB (kick: right click or K); an empty list
  if the text gives none (also map "punch"/"J" to LMB, "kick"/"K" to RMB, forward to D, back to A, up to W,
  down to S). effect is one of "projectile", "melee", "area", "stun", "charge" (the fighter rides or summons
  something that runs across the whole screen over the opponent: a vehicle, a stampede; its prop is that thing),
  "stretch" (a limb stretches across the screen to hit), "teleport" (vanishes and reappears behind the opponent),
  "bind" (ties up or tangles the opponent's legs so they can only hop slowly for a few seconds),
  "beam" (a continuous ray, e.g. from the eyes or hands, that shoots across the whole screen),
  "uppercut" (a rising jump attack that launches the opponent into the air),
  "flurry" (a rapid burst of many kicks or punches in place, hitting over and over),
  "flip" (a crouch then a rising backflip or somersault kick that launches the opponent),
  "audit" (bureaucratic money trouble: a calculator sprays a fan of numbers across the screen and, if it
  reaches the opponent, their money bursts out of their pockets and whirls around them, pelting them),
  "orbital" (a strike from the sky or space: a target locks onto the opponent, then a giant beam or
  bombardment comes straight down on that spot),
  "dash" (sprints across the whole screen through the opponent),
  "tornado" (becomes a whirlwind that storms across the screen and back; its prop is the whirlwind),
  "cat" (stops fighting to pet an animal, its prop, which runs in from across the screen; heals),
  "slideshow" (a giant boring presentation fills the screen and puts the opponent to sleep),
  "rain" (something, its prop, is thrown up and rains down over the whole screen),
  "float" (hovers in the air for a few seconds, e.g. to dodge attacks).
  suggested_input: ALWAYS propose a sequence that suits the move, in fighting-game style, for a fighter facing
  right (D = toward the opponent, A = away). 2 or 3 directions then LMB or RMB: end in LMB for hand, weapon
  or thrown moves, RMB for leg, dash or body moves. Conventions: throwing or projectile S, D, LMB; rising or
  uppercut D, S, D, LMB; charging rush A, D, LMB or RMB; spin or area S, A, RMB; leaping or from-above
  W, S, LMB; defensive or tricky A, S, A, RMB. A move the text calls the strongest or ultimate gets a longer,
  harder one (5-6 directions). Every move's sequence must differ, and none may appear inside another
  move's sequence (stated or suggested) except at its very end.
  pose_frames: exactly two short pose descriptions (windup, release) for the character performing the move, facing right.
  Describe only the character's body and anything they hold or wear; the game draws beams, blasts and strikes itself.
  cooldown: "short" if the text says the move can be used often (low cooldown), "long" for an ultimate or
  strongest move, otherwise "normal".
  height_ratio: rough figure height vs standing for those frames (crouching ~0.65, standing 1.0).
  prop: a visual description of an object the move summons or throws, drawn on its own, or null if none.
  prop_size: the prop's height relative to the character's height.
  shout: what the character yells, or null.
- warnings: anything ambiguous or contradictory (a missing input sequence or stat is expected: don't warn).

Description:
"""

PARSE_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "summary": {"type": "string"},
        "health": {"type": ["number", "null"]},
        "strength": {"type": ["number", "null"]},
        "defense": {"type": ["number", "null"]},
        "inferred_stats": {"type": "object", "properties": {
            "health": {"type": "number"}, "strength": {"type": "number"}, "defense": {"type": "number"},
            "reason": {"type": "string"}}, "required": ["health", "strength", "defense", "reason"]},
        "explicit": {"type": "object", "properties": {
            "punch": {"type": ["number", "null"]},
            "kick": {"type": ["number", "null"]},
            "special": {"type": ["number", "null"]},
            "block": {"type": ["number", "null"]},
        }},
        "ai_traits": {"type": "object", "properties": {
            k: {"type": "number"} for k in ("punch", "kick", "jump", "block", "special", "aggression", "mobility")
        }, "required": ["punch", "kick", "jump", "block", "special", "aggression", "mobility"]},
        "expressions": {"type": "object", "properties": {
            k: {"type": "string"} for k in ("idle", "attack", "hit", "victory")
        }, "required": ["idle", "attack", "hit", "victory"]},
        "victory_pose": {"type": "string"},
        "taunts": {"type": "array", "items": {"type": "string"}},
        "specials": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"},
            "description": {"type": "string"},
            "input": {"type": "array", "items": {"type": "string", "enum": INPUT_TOKENS}},
            "suggested_input": {"type": "array", "items": {"type": "string", "enum": INPUT_TOKENS}},
            "effect": {"type": "string", "enum": ["projectile", "melee", "area", "stun", "charge", "stretch", "teleport", "bind", "beam", "uppercut", "flurry", "flip", "audit", "orbital", "dash", "tornado", "cat", "slideshow", "rain", "float"]},
            "pose_frames": {"type": "array", "items": {"type": "string"}},
            "height_ratio": {"type": "number"},
            "prop": {"type": ["string", "null"]},
            "prop_size": {"type": "number"},
            "shout": {"type": ["string", "null"]},
            "cooldown": {"type": "string", "enum": ["short", "normal", "long"]},
        }, "required": ["name", "description", "input", "suggested_input", "effect", "pose_frames",
                        "height_ratio"]}},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "summary", "health", "strength", "defense", "inferred_stats", "ai_traits", "expressions",
                 "victory_pose", "specials", "warnings"],
}


def log(msg):
    print(msg, flush=True)


def rel(path):
    return path.relative_to(ROOT) if path.is_relative_to(ROOT) else path


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


class NotReady(Exception):
    """A folder that can't be built yet (e.g. no reference image); --all skips it."""


def find_sources(folder):
    """(<Folder>.txt or None, <Folder>.<ext> reference image); falls back to the first of each.
    The text file is optional: without it the character is a draft (see draft_profile)."""
    def named_first(paths):
        return sorted(paths, key=lambda p: (p.stem.lower() != folder.name.lower(), p.name))
    txts = named_first(folder.glob("*.txt"))
    # Arena_* images are the character's home arena (served by server.py), not references.
    imgs = named_first(p for p in folder.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
                       and not p.name.lower().startswith("arena_"))
    if not imgs:
        raise NotReady(f"needs a reference image ({folder.name}.png or .jpeg)")
    return (txts[0] if txts else None), imgs[0]


def draft_profile(name):
    """Stand-in for a parsed profile when there's no text file yet: average stats, neutral
    traits, no special moves. Shaped like parse_with_gemini's result."""
    return dict(
        name=name, summary="a determined street fighter",
        health=100, strength=100, defense=100, explicit={},
        ai_traits=dict(punch=0.5, kick=0.5, jump=0.4, block=0.4, special=0.3, aggression=0.6, mobility=0.5),
        expressions=dict(idle="focused", attack="fierce", hit="pained", victory="triumphant"),
        victory_pose="arms raised in triumph", taunts=[], specials=[],
        warnings=[f"draft: {name}.txt not filled in yet, so default stats and no special moves"])


# Lines starting with # are notes for whoever fills it in; the parser never sees them.
PROFILE_TEMPLATE = """# Profile for {name}. Fill this in, then run add_character.py again: only what changed is
# rebuilt. Lines starting with # are ignored. Replace the line below with a sentence or two on
# personality and fighting style, e.g. "Grumpy and rude. Mostly punches, jumps rarely."
{name} is ...

# Health, strength and defense are worked out from the description above (sharing 300 points,
# so nobody is simply better). To set any yourself, remove the # from its line and change it:
# Health: 100
# Strength: 100
# Defense: 100

Special moves:
# Up to 4, one per line starting with "- ". Each needs only a name and what happens; a button
# sequence that suits the move is picked for you. To choose your own, end the line with one:
# directions are relative to the opponent (D toward them, A away, W up, S down), then punch
# (left click or J) or kick (right click or K). e.g.
# - Giant denied stamp, stomps the opponent with an enormous DENIED stamp, yelling "DENIED!!". Triggered with S, D, punch.
"""


def ensure_profile(folder, txt):
    """(text file, whether it's real): writes PROFILE_TEMPLATE as <Folder>.txt when there's none.
    An unedited template counts as no profile, so the character stays a draft until it's filled in."""
    if txt is None:
        txt = folder / f"{folder.name}.txt"
        txt.write_text(PROFILE_TEMPLATE.format(name=folder.name))
        log(f"  parse: wrote a template {rel(txt)} to fill in")
    # Compared without # notes, so revising the template's notes doesn't make old copies look edited.
    blank = profile_text(txt).strip() == notes_removed(PROFILE_TEMPLATE.format(name=folder.name)).strip()
    return txt, not blank


def notes_removed(text):
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


def profile_text(txt):
    """The text file without its # note lines."""
    return notes_removed(txt.read_text())


def text_hash(txt):
    return hashlib.sha1(txt.read_bytes()).hexdigest()[:12] if txt else None


# --------------------------------------------------------------------------- Gemini

# USD per 1M tokens: (input, text + thinking output, image output). Paid-tier standard
# rates from https://ai.google.dev/gemini-api/docs/pricing (Nov 2026); gemini-3.5-flash from
# third-party listings. Models not listed here still report tokens, just no cost.
PRICES = {
    "gemini-3.1-flash-image": (0.50, 3.00, 60.00),
    "gemini-3-pro-image": (2.00, 12.00, 120.00),
    "gemini-3.5-flash": (1.50, 9.00, 9.00),
}


class Usage:
    """Token counts and estimated cost per model, summed over the run."""

    def __init__(self):
        self.models = {}  # model -> {"calls", "input", "text", "image"}

    def record(self, model, resp):
        meta = getattr(resp, "usage_metadata", None)
        if meta is None:
            return
        image = sum(d.token_count or 0 for d in meta.candidates_tokens_details or []
                    if "IMAGE" in str(d.modality))
        call = {"calls": 1, "input": meta.prompt_token_count or 0,
                "text": (meta.candidates_token_count or 0) - image + (meta.thoughts_token_count or 0),
                "image": image}
        total = self.models.setdefault(model, dict.fromkeys(call, 0))
        for k, v in call.items():
            total[k] += v
        log(f"    tokens: {self.describe(model, call)}")

    @staticmethod
    def cost(model, t):
        rates = PRICES.get(model)
        if rates is None:
            return None
        return (t["input"] * rates[0] + t["text"] * rates[1] + t["image"] * rates[2]) / 1e6

    def describe(self, model, t):
        out = f"{t['input']:,} in, {t['text']:,} text/thinking out"
        if t["image"]:
            out += f", {t['image']:,} image out"
        c = self.cost(model, t)
        return out + (f"  ~${c:.3f}" if c is not None else "  (no price for this model)")

    def summary(self):
        if not self.models:
            return
        log("Gemini usage:")
        for model, t in self.models.items():
            log(f"  {model}: {t['calls']} call(s), {self.describe(model, t)}")
        costs = [self.cost(m, t) for m, t in self.models.items()]
        known = sum(c for c in costs if c is not None)
        log(f"  estimated total: ${known:.3f}" + (" + unpriced models" if None in costs else ""))


usage = Usage()
atexit.register(usage.summary)  # also on sys.exit, e.g. a quota error partway through

_client = None


def gemini():
    global _client
    if _client is None:
        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not key:
            return None
        from google import genai
        _client = genai.Client(api_key=key)
    return _client


def generate_image(prompt, refs, attempts=3):
    from google.genai import types
    contents = [prompt] + list(refs)
    config = types.GenerateContentConfig(
        response_modalities=["IMAGE"], image_config=types.ImageConfig(aspect_ratio="1:1"))
    for attempt in range(1, attempts + 1):
        try:
            resp = gemini().models.generate_content(model=IMAGE_MODEL, contents=contents, config=config)
            usage.record(IMAGE_MODEL, resp)
            for part in (resp.candidates[0].content.parts if resp.candidates else []) or []:
                if part.inline_data and part.inline_data.data:
                    return Image.open(io.BytesIO(part.inline_data.data)).convert("RGB")
            cand = resp.candidates[0] if resp.candidates else None
            why = getattr(cand, "finish_reason", None) or getattr(resp.prompt_feedback, "block_reason", None)
            msg = getattr(cand, "finish_message", None) or ""
            log(f"    no image returned (attempt {attempt}): {why} {msg}".rstrip())
        except Exception as e:  # network errors, rate limits, safety blocks
            if "RESOURCE_EXHAUSTED" in str(e) and "limit: 0" in str(e):
                sys.exit(f"{IMAGE_MODEL} has no quota for this API key (free tier keys can't generate "
                         "images). Enable billing on the key's Google Cloud project, or try --image-model.")
            log(f"    error (attempt {attempt}): {str(e)[:300]}")
            time.sleep(5 * attempt)
    raise RuntimeError("image generation failed")


ANATOMY_PROMPT = """This is one sprite of a single video game character drawn in this pose: {pose}
Check the CHARACTER's own body only (ignore animals, props, effects and motion lines).
Count legs: a leg is a thigh, shin and foot joined at the hips; count one that is partly hidden.
Count arms the same way. List any anatomy problems: extra or missing legs, arms, feet or hands,
a limb not attached to the body, two heads. A normal person has exactly 2 legs and 2 arms."""

ANATOMY_SCHEMA = {"type": "object", "properties": {
    "legs": {"type": "integer"}, "arms": {"type": "integer"},
    "problems": {"type": "array", "items": {"type": "string"}}}, "required": ["legs", "arms", "problems"]}


def check_arms(kind):
    """Whether to count arms: not for special moves (blurred multiple fists are often the point)
    or a body lying on its side (the far arm is usually hidden)."""
    return kind != "ko" and not kind.startswith("special")


def shape_problems(kind, img, idle_img):
    """Pose checks a vision model can't be trusted with: a body lying down really is wide.
    (Height can't be checked this way: every pose is drawn filling the picture, a squat included.)"""
    if kind == "ko" and (shape := lying_shape(img)) < 1.8:
        return [f"not lying down ({shape:.1f}x as wide as tall)"]
    return []


def lying_shape(img):
    """Width / height of the figure: a body lying on its side is ~3, standing ~0.5."""
    cut = drop_specks(remove_background(img))
    x0, y0, x1, y1 = cut.getbbox()
    return (x1 - x0) / (y1 - y0)


ANATOMY_TRIES = 3  # images per frame before keeping one that still fails the check


def anatomy_problems(img, pose, arms=True):
    """What's wrong with a generated character frame, per a quick vision check (~$0.002); empty
    if it looks like one person with two legs and two arms. Image models often add a leg on kicks
    and jumps: the standing pose they're anchored to has two feet planted. arms=False for special
    moves, where blurred multiple fists are often the point."""
    from google.genai import types
    config = types.GenerateContentConfig(
        response_mime_type="application/json", response_json_schema=ANATOMY_SCHEMA,
        thinking_config=types.ThinkingConfig(thinking_level="low"))
    small = img.copy()
    small.thumbnail((512, 512))
    try:
        resp = gemini().models.generate_content(
            model=TEXT_MODEL, contents=[ANATOMY_PROMPT.format(pose=pose), small], config=config)
        usage.record(TEXT_MODEL, resp)
        r = json.loads(resp.text)
    except Exception as e:  # a failed check shouldn't stop the build
        log(f"    anatomy check failed: {str(e)[:200]}")
        return []
    problems = [p for p in r.get("problems") or [] if arms or "arm" not in p.lower()]
    if r.get("legs") != 2:
        problems.insert(0, f"{r.get('legs')} legs")
    if arms and r.get("arms") != 2:
        problems.insert(0, f"{r.get('arms')} arms")
    return problems


# --------------------------------------------------------------------------- parse

STAT_BUDGET, STAT_MIN, STAT_MAX = 300, 70, 150
COOLDOWNS = {"short": 1.2, "long": 12}  # seconds; "normal" moves share the game's 4 s special cooldown
CORE_STATS = ("health", "strength", "defense")


def balance(stats, budget=STAT_BUDGET):
    """Scale inferred stats to share `budget`, each within STAT_MIN..STAT_MAX, so a vivid
    description can't make a character simply better than the rest."""
    free = dict(stats)
    fixed = {}
    while free:  # clamp whatever falls outside the range, then share what's left among the rest
        left = budget - sum(fixed.values())
        total = sum(free.values()) or 1
        scaled = {k: v * left / total for k, v in free.items()}
        out = {k: v for k, v in scaled.items() if not STAT_MIN <= v <= STAT_MAX}
        if not out:
            fixed.update(scaled)
            break
        for k, v in out.items():
            fixed[k] = min(STAT_MAX, max(STAT_MIN, v))
            del free[k]
    return {k: round(fixed[k]) for k in stats}


def settle_stats(p):
    """Fill health/strength/defense in p: numbers the text states win; the rest come from the
    description (inferred_stats), sharing what's left of STAT_BUDGET after the stated ones.
    Returns the names of the inferred stats."""
    inferred = p.get("inferred_stats") or {}
    missing = [k for k in CORE_STATS if p.get(k) is None]
    if missing:
        left = STAT_BUDGET - sum(p[k] for k in CORE_STATS if k not in missing)
        guess = balance({k: float(inferred.get(k) or 100) for k in missing}, left)
        p.update(guess)
    return missing


def derive_stats(p):
    s, d = p["strength"] / 100, p["defense"] / 100
    ex = p.get("explicit") or {}
    return {
        "health": int(p["health"]),
        "punch_damage": ex.get("punch") or round(5 * s),
        "kick_damage": ex.get("kick") or round(7 * s),
        "special_damage": ex.get("special") or round(14 * s),
        # fraction of incoming damage removed while blocking
        "block": ex.get("block") or round(min(0.9, 0.5 * d), 2),
        "walk_speed": round(1.6 + 0.8 * p["ai_traits"]["mobility"], 2),
        "jump_power": round(5.5 + 1.5 * p["ai_traits"]["mobility"], 2),
    }


PREVIOUS_NOTE = """

This is a RE-PARSE of an edited description. The edit, as a diff from the earlier version:
{diff}
Previous result, parsed from the earlier version. Update every value the edit affects (a move
whose text changed gets new description, pose_frames, prop etc. matching the new text; a new move
is added; a removed move is dropped). Copy every other value EXACTLY, word for word, especially
pose_frames, prop and victory_pose, which drawn sprites are based on:
{previous}"""


def previous_parse(char):
    """An existing character.json in parse-result shape, for parse_with_gemini to stay consistent with."""
    keep = ("name", "description", "effect", "pose_frames", "height_ratio", "prop", "prop_size", "shout")
    src = char.get("source", {})
    stats = {k: None if k in src.get("inferred", []) else src.get(k) for k in CORE_STATS}
    return {"name": char["name"], "summary": char["summary"], **stats,
            "inferred_stats": src.get("inferred_stats"), "ai_traits": char["ai"],
            "expressions": char["expressions"], "victory_pose": char["victory_pose"],
            "taunts": char.get("taunts", []),
            "specials": [{**{k: sp.get(k) for k in keep},
                          # a suggested input is offered again as the suggestion, so it stays put
                          "input": sp["input"] if sp.get("input_source", "stated") == "stated" else [],
                          "suggested_input": sp["input"]} for sp in char["specials"]]}


def parse_with_gemini(text, previous=None, old_text=None, attempts=3):
    from google.genai import types
    config = types.GenerateContentConfig(
        response_mime_type="application/json", response_json_schema=PARSE_SCHEMA,
        thinking_config=types.ThinkingConfig(thinking_level="low"),
        http_options=types.HttpOptions(timeout=120_000))
    for attempt in range(1, attempts + 1):
        try:
            prompt = PARSE_PROMPT + text
            if previous and old_text is not None:  # unchanged parts must match, or their frames are redrawn
                diff = "\n".join(difflib.unified_diff(old_text.splitlines(), text.splitlines(), "before", "after",
                                                      lineterm="", n=0))
                prompt += PREVIOUS_NOTE.format(diff=diff or "(no change)",
                                               previous=json.dumps(previous, indent=1, ensure_ascii=False))
            resp = gemini().models.generate_content(model=TEXT_MODEL, contents=prompt, config=config)
            usage.record(TEXT_MODEL, resp)
            return json.loads(resp.text)
        except Exception as e:  # 503 high demand, timeouts, malformed JSON
            if attempt == attempts:
                raise
            log(f"    parse error (attempt {attempt}): {str(e)[:200]}")
            time.sleep(10 * attempt)


def input_clash(a, b):
    """True when two special inputs can't coexist: identical, or the shorter appears inside the
    longer anywhere but its end, so it fires partway through the longer one (the game matches
    the latest inputs, longest sequence first, so a shared ending is fine)."""
    a, b = tuple(a), tuple(b)
    if len(a) > len(b):
        a, b = b, a
    if a == b:
        return True
    return any(b[i:i + len(a)] == a for i in range(len(b) - len(a)))


def parse_offline(text, name):
    """Rule-based fallback when there is no API key. Good enough to test the pipeline."""
    num = lambda key, default: float(m.group(1)) if (m := re.search(rf"{key}\s*:\s*(\d+)", text, re.I)) else default
    low = text.lower()
    trait = lambda word: 0.8 if re.search(rf"mostly {word}", low) else 0.15 if re.search(rf"{word}\w* rarely|rarely {word}", low) else 0.5
    specials = []
    for line in re.findall(r"^\s*-\s*(.+)$", text, re.M):
        seq = re.search(r"triggered with (?:the sequence )?(.+?)\.?\s*$", line, re.I)
        tokens = []
        if seq:
            for t in re.split(r"[,\s]+", seq.group(1).lower().replace("left click", "lmb").replace("right click", "rmb")):
                t = t.upper()
                if t in INPUT_TOKENS:
                    tokens.append(t)
        title = re.split(r"[,.]", line)[0].strip()
        shout = re.search(r'"([^"]+)"', line)
        specials.append(dict(
            name=title, description=line.strip(), input=tokens, effect="melee",
            pose_frames=[f"getting ready to perform this move: {title}", f"performing this move: {title}"],
            height_ratio=1.0, prop=None, prop_size=0.5, shout=shout.group(1) if shout else None))
    return dict(
        name=name, summary=text.split("\n")[0].strip(),
        health=num("health", 100), strength=num("strength", 100), defense=num("defense", 100), explicit={},
        ai_traits=dict(punch=trait("punch"), kick=trait("kick"), jump=trait("jump"), block=0.4, special=0.3,
                       aggression=0.6, mobility=trait("jump")),
        expressions=dict(idle="confident", attack="fierce", hit="pained", victory="triumphant"),
        victory_pose="arms raised in triumph", taunts=[], specials=specials,
        warnings=["parsed offline without Gemini; review this file"])


def stage_parse(folder, reparse):
    out = folder / "character.json"
    txt, img = find_sources(folder)
    txt, filled_in = ensure_profile(folder, txt)
    if not filled_in:
        txt = None  # the untouched template: parse as a draft
    existing = json.loads(out.read_text()) if out.exists() else None
    if existing and not reparse:
        # Files from before text hashes were recorded count as up to date; record it now so
        # later edits are noticed.
        if "text_hash" not in existing.get("source", {}):
            existing.setdefault("source", {})["text_hash"] = text_hash(txt)
            existing["source"]["parsed_text"] = profile_text(txt) if txt else None
            out.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n")
        recorded = existing["source"]["text_hash"]
        if existing.get("draft") and txt:
            log(f"  parse: {txt.name} added, parsing it")
        elif recorded != text_hash(txt):
            log(f"  parse: {txt.name} changed, re-parsing")
        elif gemini() and existing.get("parsed_offline"):
            log("  parse: re-parsing with Gemini (last parse was offline)")
        else:
            log(f"  parse: keeping existing {rel(out)} (use --reparse to regenerate)")
            return existing
    if not txt:
        log(f"  parse: {folder.name}.txt not filled in yet, making a draft with default stats")
        p = draft_profile(folder.name)
    elif gemini():
        log(f"  parse: {txt.name} via {TEXT_MODEL}")
        old_text = (existing or {}).get("source", {}).get("parsed_text")
        p = parse_with_gemini(profile_text(txt), previous_parse(existing) if old_text else None, old_text)
    else:
        log("  parse: no GEMINI_API_KEY, using offline parser")
        p = parse_offline(profile_text(txt), folder.name)

    inferred = settle_stats(p) if txt and gemini() else []
    if inferred:
        log(f"  parse: {', '.join(inferred)} from the description: "
            + ", ".join(f"{k} {p[k]}" for k in inferred)
            + f" ({(p.get('inferred_stats') or {}).get('reason', '')})")
    warnings = list(p.get("warnings") or [])
    used = set()
    specials = []
    if len(p["specials"]) > MAX_SPECIALS:
        warnings.append(f"{len(p['specials'])} special moves found; kept the first {MAX_SPECIALS}")
    moves = p["specials"][:MAX_SPECIALS]
    # Inputs the text states are claimed first; moves without one take the parser's suggestion
    # (picked to suit the move), or a stock sequence if that clashes.
    stated = [[t for t in sp.get("input", []) if t in INPUT_TOKENS] for sp in moves]
    seqs = [None] * len(moves)
    for i in sorted(range(len(moves)), key=lambda i: not stated[i]):
        sp, seq, how = moves[i], stated[i], "stated"
        if not seq:
            seq, how = [t for t in sp.get("suggested_input", []) if t in INPUT_TOKENS], "suggested"
        clash = next((u for u in used if input_clash(seq, u)), None)
        if not seq or clash:
            why = f"{', '.join(seq)} clashes with {', '.join(clash)}" if seq else "had no usable input"
            seq, how = next(f for f in FALLBACK_INPUTS if not any(input_clash(f, u) for u in used)), "stock"
            warnings.append(f"special{i + 1} '{sp['name']}' {why}; assigned {', '.join(seq)}")
        elif how == "suggested":
            log(f"  parse: {sp['name']}: suggested {' '.join(seq)} (add a sequence to the text to choose your own)")
        used.add(tuple(seq))
        seqs[i] = (seq, how)
    for i, sp in enumerate(moves, 1):
        seq, how = seqs[i - 1]
        frames = (sp.get("pose_frames") or [])[:2] or [f"performing {sp['name']}"]
        specials.append({
            "id": f"special{i}", "name": sp["name"], "description": sp["description"], "input": seq,
            "input_source": how,  # stated in the text, suggested by the parser, or stock
            "effect": sp.get("effect", "melee"), "shout": sp.get("shout"),
            # seconds before it can be used again: short, normal (the shared special cooldown) or long
            **({"cooldown": COOLDOWNS[sp["cooldown"]]} if sp.get("cooldown") in ("short", "long") else {}),
            "pose_frames": frames, "height_ratio": sp.get("height_ratio") or 1.0,
            "prop": sp.get("prop"), "prop_size": sp.get("prop_size") or 0.5,
        })
    if not specials:
        warnings.append("no special moves found")

    char = {
        "name": p.get("name") or folder.name,
        "slug": slugify(folder.name),
        "summary": p["summary"],
        # parsed_text: what this was parsed from, so a re-parse can see exactly what was edited.
        "source": {"text": txt.name if txt else None, "text_hash": text_hash(txt),
                   "parsed_text": profile_text(txt) if txt else None, "image": img.name,
                   "health": p["health"], "strength": p["strength"], "defense": p["defense"],
                   # which of those came from the description rather than stated numbers, and why
                   "inferred": inferred, "inferred_stats": p.get("inferred_stats") if inferred else None},
        "stats": derive_stats(p),
        "ai": {k: round(float(v), 2) for k, v in p["ai_traits"].items()},
        "expressions": p["expressions"],
        "victory_pose": p["victory_pose"],
        "taunts": p.get("taunts") or [],
        "specials": specials,
        "warnings": warnings,
    }
    if not txt:
        char["draft"] = True
    elif not gemini():
        char["parsed_offline"] = True
    # Hand-set special settings the parser can't produce: the "abduct" effect and its extra props
    # (e.g. {"car": {"description": ..., "size": 0.9}}), kept for a move of the same name.
    old_specials = {sp["name"]: sp for sp in (existing or {}).get("specials", [])}
    for sp in char["specials"]:
        old = old_specials.get(sp["name"], {})
        if old.get("extra_props"):
            sp["extra_props"] = old["extra_props"]
        if old.get("effect") == "abduct":
            sp["effect"] = "abduct"
        for k in ("origin", "beam_frame", "beam_style"):  # set by hand: where a shot or beam comes from, its look
            if k in old:
                sp[k] = old[k]
    # Keep fields added by hand (e.g. "proportions"); the parser never writes them.
    for k, v in (existing or {}).items():
        if k not in char and k not in ("draft", "parsed_offline"):
            char[k] = v
    out.write_text(json.dumps(char, indent=2, ensure_ascii=False) + "\n")
    log(f"  parse: wrote {rel(out)}")
    for w in warnings:
        log(f"  WARNING: {w}")
    return char


# --------------------------------------------------------------------------- frames

def frame_plan(char):
    """Every image the character needs: (filename stem, kind, prompt-ish data)."""
    plan = []
    for anim, spec in ANIMATIONS.items():
        for i, (pose, expr_key) in enumerate(spec["frames"]):
            if anim == "victory":
                pose = char["victory_pose"]
            plan.append((f"{anim}_{i}", anim, dict(pose=pose, expression=char["expressions"][expr_key])))
    for sp in char["specials"]:
        for i, pose in enumerate(sp["pose_frames"]):
            plan.append((f"{sp['id']}_{i}", sp["id"], dict(
                pose=f"special move \"{sp['name']}\": {pose}", expression=char["expressions"]["attack"],
                prop=sp["prop"] if sp["effect"] not in ("projectile", "beam") or i == 0 else None)))
        if sp["prop"]:
            plan.append((f"prop_{sp['id']}", "prop", dict(description=sp["prop"])))
        for name, extra in sp.get("extra_props", {}).items():
            plan.append((f"prop_{sp['id']}_{name}", "prop", dict(description=extra["description"])))
    plan.append(("portrait", "portrait", dict(expression=char["expressions"]["idle"])))
    return plan


def stage_frames(folder, char, only, force, check=False):
    if not gemini():
        sys.exit("frames: set GEMINI_API_KEY to generate frames")
    _, ref_path = find_sources(folder)
    ref = Image.open(ref_path).convert("RGB")
    ref.thumbnail((1024, 1024))
    frames_dir = folder / "frames"
    frames_dir.mkdir(exist_ok=True)

    placeholders = read_placeholders(frames_dir)
    made = read_made(frames_dir)
    plan = frame_plan(char)
    idle_path = frames_dir / "idle_0.png"
    idle_img = lambda: (Image.open(idle_path).convert("RGB")
                        if idle_path.exists() and "idle_0" not in placeholders else None)
    for stem, kind, data in plan:
        path = frames_dir / f"{stem}.png"
        selected = not only or kind in only or stem in only
        key = frame_key(kind, data)
        if path.exists() and stem not in made:
            made[stem] = key  # made before keys were recorded (or by hand): treat as current
        changed = path.exists() and made.get(stem) != key
        cached = path.exists() and not force and stem not in placeholders and not changed
        if selected and cached and check and kind not in ("prop", "portrait"):
            cached_img = Image.open(path).convert("RGB")
            problems = anatomy_problems(cached_img, data["pose"], check_arms(kind))
            problems += shape_problems(kind, cached_img, idle_img())
            if problems:
                log(f"  frames: {stem} has {', '.join(problems)}")
                cached = False
        if not selected or cached:
            continue
        if changed and not force:
            log(f"  frames: {stem}'s pose changed")
        anchor = frames_dir / "idle_0.png"
        if "idle_0" in placeholders:
            anchor = frames_dir / "missing"
        refs = [ref]
        if kind == "prop":
            prompt = PROP_PROMPT.format(description=data["description"])
            refs = []
        elif kind == "portrait":
            prompt = PORTRAIT_PROMPT.format(expression=data["expression"])
        else:
            use_anchor = stem != "idle_0" and anchor.exists()
            if use_anchor:
                refs.append(Image.open(anchor).convert("RGB"))
            prop = data.get("prop")
            prompt = FRAME_PROMPT.format(
                # Style only: "match its proportions" made crouches and kicks copy the standing pose.
                # Head size called out: bent and seated poses tended to come back with bigger heads.
                anchor_note=" The second image is an approved sprite of the same character: match its art style, "
                            "pixel size, colors and body build exactly, and keep the head the same size relative "
                            "to the body as in that sprite (small, realistic), but NOT its pose; the pose comes "
                            "only from the description below." if use_anchor else "",
                personality=char["summary"], pose=data["pose"], expression=data["expression"],
                prop_note=f"\n- include this object as part of the move: {prop}" if prop else "",
                # Optional "proportions" in character.json corrects a reference that reads too
                # cartoonish (e.g. an oversized head); it wins over the reference image.
                proportions_note=f"\nException, overriding the reference images: {char['proportions']}"
                                 if char.get("proportions") else "")
        log(f"  frames: generating {stem}")
        for attempt in range(1, ANATOMY_TRIES + 1):
            img = generate_image(prompt, refs)
            if kind in ("prop", "portrait"):
                break
            problems = anatomy_problems(img, data["pose"], check_arms(kind))
            problems += shape_problems(kind, img, idle_img())
            if not problems:
                break
            log(f"    {', '.join(problems)}; " + ("trying again" if attempt < ANATOMY_TRIES
                                                  else "keeping it anyway, check it by hand"))
        img.save(path)
        placeholders.discard(stem)
        write_placeholders(frames_dir, placeholders)
        made[stem] = key
        write_made(frames_dir, made)
    write_made(frames_dir, made)
    missing = [s for s, _, _ in plan if not (frames_dir / f"{s}.png").exists()]
    if missing:
        log(f"  frames: still missing {', '.join(missing)}")


# Placeholder frames are crude transforms of the reference image so the game is playable
# before (or without) image generation. They're listed in frames/.placeholder and are
# replaced by the next real frames run.

def frame_key(kind, data):
    """What a frame is a picture of: its pose and prop (not personality or expression), so
    editing a special move's description regenerates its frames on the next run."""
    what = [kind, data.get("pose"), data.get("prop"), data.get("description")]
    return hashlib.sha1(json.dumps(what).encode()).hexdigest()[:12]


def read_made(frames_dir):
    """stem -> frame_key of the prompt each cached frame was generated from (frames/.made.json)."""
    f = frames_dir / ".made.json"
    return json.loads(f.read_text()) if f.exists() else {}


def write_made(frames_dir, made):
    (frames_dir / ".made.json").write_text(json.dumps(made, indent=1, sort_keys=True) + "\n")


def read_placeholders(frames_dir):
    f = frames_dir / ".placeholder"
    return set(f.read_text().split()) if f.exists() else set()


def write_placeholders(frames_dir, stems):
    f = frames_dir / ".placeholder"
    if stems:
        f.write_text("\n".join(sorted(stems)) + "\n")
    elif f.exists():
        f.unlink()


def pose_transform(ref, bg, squash=1.0, lean=0.0, shear=0.0, lie=False):
    """Squash vertically, rotate about the feet (degrees, + leans right) or shear, on a padded canvas."""
    w, h = ref.size
    img = ref.resize((w, max(1, round(h * squash))), Image.Resampling.BICUBIC) if squash != 1.0 else ref
    canvas = Image.new("RGB", (w * 2, h + h // 4), bg)
    canvas.paste(img, (w // 2, canvas.height - img.height))
    feet = (canvas.width // 2, canvas.height - 1)
    if shear:
        canvas = canvas.transform(canvas.size, Image.Transform.AFFINE,
                                  (1, shear, -shear * feet[1], 0, 1, 0), fillcolor=bg)
    if lean or lie:
        canvas = canvas.rotate(90 if lie else -lean, center=feet, expand=lie, fillcolor=bg,
                               resample=Image.Resampling.BICUBIC)
    return canvas


def stage_placeholder_frames(folder, char):
    _, ref_path = find_sources(folder)
    ref = load_frame(ref_path, 1024)
    arr = np.asarray(ref)
    bg = tuple(int(v) for v in np.median(np.concatenate([arr[0], arr[:, 0], arr[:, -1]]), axis=0))
    # Cut off ground the character stands on (rows that span most of the width).
    coverage = (np.abs(arr.astype(np.int16) - bg).sum(-1) > 70).mean(axis=1)
    bottom = len(coverage)
    while bottom > len(coverage) // 2 and coverage[bottom - 1] > 0.6:
        bottom -= 1
    if bottom < len(coverage):
        ref = ref.crop((0, 0, ref.width, bottom))
        ref = Image.fromarray(np.asarray(drop_specks(remove_background(ref)).convert("RGBA")).copy(), "RGBA")
        flat = Image.new("RGB", ref.size, bg)
        flat.paste(ref, mask=ref.getchannel("A"))
        ref = flat
    frames_dir = folder / "frames"
    frames_dir.mkdir(exist_ok=True)
    poses = {
        "idle_0": {}, "idle_1": dict(squash=0.97), "walk_0": dict(shear=-0.06), "walk_1": dict(shear=0.06),
        "crouch_0": dict(squash=0.62), "jump_0": dict(squash=0.85, lean=-4),
        "punch_0": dict(lean=-5), "punch_1": dict(lean=9), "kick_0": dict(lean=-8), "kick_1": dict(lean=14),
        "block_0": dict(squash=0.95, lean=-4), "hit_0": dict(lean=-12), "ko_0": dict(lie=True),
        "victory_0": dict(squash=1.03),
    }
    for sp in char["specials"]:
        poses[f"{sp['id']}_0"] = dict(lean=-8, squash=min(1.0, sp["height_ratio"]))
        if len(sp["pose_frames"]) > 1:
            poses[f"{sp['id']}_1"] = dict(lean=12, squash=min(1.0, sp["height_ratio"]))
    placeholders = read_placeholders(frames_dir)
    for stem, kw in poses.items():
        path = frames_dir / f"{stem}.png"
        if path.exists() and stem not in placeholders:
            continue  # never overwrite a real frame
        pose_transform(ref, bg, **kw).save(path)
        placeholders.add(stem)
    portrait = frames_dir / "portrait.png"
    if not portrait.exists() or "portrait" in placeholders:
        a = np.asarray(ref.convert("L")) < 235
        rows, cols = np.nonzero(a.any(axis=1))[0], np.nonzero(a.any(axis=0))[0]
        top, height = rows.min(), rows.max() - rows.min()
        cx = int(np.nonzero(a[top:top + height // 6].any(axis=0))[0].mean()) if height else ref.width // 2
        side = max(8, height // 4)
        ref.crop((cx - side // 2, top - side // 10, cx + side // 2, top + side - side // 10)).save(portrait)
        placeholders.add("portrait")
    write_placeholders(frames_dir, placeholders)
    log(f"  frames: wrote {len(placeholders)} placeholder frames")


# --------------------------------------------------------------------------- sheet

def remove_background(img, tol=70):
    """Key out the flat background: flood-fill from the border, plus any interior pockets
    of the key color when the background is a saturated chroma key (e.g. magenta)."""
    rgb = np.asarray(img.convert("RGB")).astype(np.int16)
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.abs(rgb - bg).sum(-1)
    near = dist < tol

    labels, _ = ndimage.label(near)
    edge_labels = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    is_bg = np.isin(labels, edge_labels[edge_labels > 0])
    if bg.max() - bg.min() > 120:  # chroma key: holes between limbs are background too
        is_bg |= dist < tol * 0.8
    # Trim the anti-aliased fringe that sits between the key color and the sprite.
    edge = np.zeros_like(is_bg)
    edge[1:] |= is_bg[:-1]; edge[:-1] |= is_bg[1:]; edge[:, 1:] |= is_bg[:, :-1]; edge[:, :-1] |= is_bg[:, 1:]
    is_bg |= edge & (dist < tol * 2.2)

    alpha = np.where(is_bg, 0, 255).astype(np.uint8)
    out = np.dstack([rgb.astype(np.uint8), alpha])
    return Image.fromarray(out, "RGBA")


def drop_specks(img, min_frac=0.02):
    """Remove small disconnected blobs (leftover noise) from an RGBA image."""
    arr = np.array(img)
    labels, n = ndimage.label(arr[:, :, 3] > 0, structure=np.ones((3, 3)))
    if not n:
        return img
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    keep = sizes >= sizes.sum() * min_frac
    arr[~keep[labels], 3] = 0
    return Image.fromarray(arr, "RGBA")


def load_frame(path, max_side=768):
    img = Image.open(path).convert("RGB")
    img.thumbnail((max_side, max_side))
    return img


def fit_scale(img, fit, idle_height=None, base=SPRITE_HEIGHT):
    """Crop to content and scale so the content's height (or width) hits the target, a fraction of
    base (the character's standing height). For ("idle", lo, hi), idle_height is the standing
    frame's unscaled content height."""
    img = img.crop(img.getbbox())
    if fit[0] == "idle":
        _, lo, hi = fit
        fit = ("h", min(hi, max(lo, img.height / idle_height)))
    axis, ratio = fit
    target = base * ratio
    scale = target / (img.height if axis == "h" else img.width)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    small = img.convert("RGBa").resize(size, Image.Resampling.BOX).convert("RGBA")
    arr = np.array(small)
    arr[:, :, 3] = np.where(arr[:, :, 3] >= 128, 255, 0)
    return Image.fromarray(arr, "RGBA")


def build_palette(images):
    px = np.concatenate([np.asarray(im)[np.asarray(im)[:, :, 3] > 0][:, :3] for im in images])
    side = int(np.ceil(np.sqrt(len(px))))
    px = np.resize(px, (side * side, 3))  # pad by repeating pixels to a square
    q = Image.fromarray(px.reshape(side, side, 3).astype(np.uint8), "RGB").quantize(
        colors=PALETTE_COLORS, method=Image.Quantize.MEDIANCUT)
    palette = Image.new("P", (1, 1))
    palette.putpalette(q.getpalette()[:PALETTE_COLORS * 3])
    return palette


def apply_palette(img, palette):
    alpha = img.getchannel("A")
    q = img.convert("RGB").quantize(palette=palette, dither=Image.Dither.NONE).convert("RGBA")
    q.putalpha(alpha)
    return q


def frame_geometry(img, idle_reach, active, lying=False, hurt_h=None, base=SPRITE_HEIGHT):
    """Anchor = feet (center of the lowest opaque rows); boxes are relative to the anchor.
    lying: a body on the ground is drawn in slight perspective, its feet or a hand reaching a few
    pixels below the rest, so anchoring at the lowest pixel left it hovering. Rest it on the
    typical underside instead (median over columns); the lowest bits sink in like a floor seen
    from above."""
    a = np.asarray(img)[:, :, 3] > 0
    h, w = a.shape
    band = a[max(0, h - max(2, h // 10)):]
    ax = int(round(np.nonzero(band)[1].mean())) if band.any() else w // 2
    ay = h
    if lying:
        bottoms = [np.nonzero(a[:, x])[0].max() + 1 for x in range(w) if a[:, x].any()]
        ay = int(np.median(bottoms))
    hurt = [int(-w * 0.35), -h, int(w * 0.7), h]
    if hurt_h:  # crouches: drawn near full size, but only this fraction of standing height can be hit
        top = min(h, int(base * hurt_h))
        hurt = [hurt[0], -top, hurt[2], top]
    geo = {"ax": ax, "ay": ay, "hurt": hurt, "hit": None}
    if active:
        reach = w - ax
        if reach > idle_reach + 3:
            x0 = max(ax + idle_reach - 4, w - int(base * 0.22))
            rows = np.nonzero(a[:, x0:].any(axis=1))[0]
            geo["hit"] = [x0 - ax, int(rows.min()) - ay, w - x0, int(rows.max() - rows.min() + 1)]
        else:  # pose didn't visibly extend; use a generic box in front of the body
            geo["hit"] = [idle_reach - 6, -int(h * 0.8), int(base * 0.25), int(h * 0.3)]
    return geo


def pack(frames, pad=1):
    """Shelf-pack a list of RGBA images; returns sheet and rects."""
    width = 1024
    x = y = shelf = 0
    rects = []
    for im in frames:
        if x + im.width + pad > width:
            x, y, shelf = 0, y + shelf + pad, 0
        rects.append((x, y, im.width, im.height))
        x += im.width + pad
        shelf = max(shelf, im.height)
    sheet = Image.new("RGBA", (width, y + shelf), (0, 0, 0, 0))
    for im, (rx, ry, _, _) in zip(frames, rects):
        sheet.paste(im, (rx, ry))
    return sheet.crop((0, 0, max(r[0] + r[2] for r in rects), sheet.height)), rects


def stage_sheet(folder, char):
    frames_dir = folder / "frames"
    out = BUILD_DIR / char["slug"]
    # character.json "stature": standing height relative to everyone else's, e.g. 1.2 for a giant;
    # every frame, box and prop scales with it.
    stature = char.get("stature", 1)
    base = round(SPRITE_HEIGHT * stature)
    (out / "props").mkdir(parents=True, exist_ok=True)

    anims = {name: dict(spec) for name, spec in ANIMATIONS.items()}
    for sp in char["specials"]:
        # Standing scale, like crouch and ko: the parser's height_ratio is only a guess, and frames
        # drawn with big effects (a tornado around the fighter) are taller than the fighter.
        anims[sp["id"]] = dict(fps=8, loop=False, fit=("idle", 0.5, 1.6),
                               active=[len(sp["pose_frames"]) - 1], frames=sp["pose_frames"])

    raw = lambda name: drop_specks(remove_background(load_frame(frames_dir / f"{name}.png")))
    if not (frames_dir / "idle_0.png").exists():
        sys.exit(f"sheet: missing {rel(frames_dir / 'idle_0.png')}; run the frames stage")
    idle = raw("idle_0")
    idle_height = idle.crop(idle.getbbox()).height

    processed = {}
    for name, spec in anims.items():
        imgs = []
        if spec.get("optional") and not all((frames_dir / f"{name}_{i}.png").exists()
                                            for i in range(len(spec["frames"]))):
            continue  # not generated yet for this character: the game stands in a basic animation
        for i in range(len(spec["frames"])):
            p = frames_dir / f"{name}_{i}.png"
            if not p.exists():
                sys.exit(f"sheet: missing {rel(p)}; run the frames stage")
            # character.json "frame_scale" overrides a frame's height as a fraction of the
            # standing sprite, e.g. {"special2_0": 0.8} for a crouching special pose that the
            # generator drew as tall as a standing one.
            fit = spec["fits"][i] if spec.get("fits") else spec["fit"]
            if f"{name}_{i}" in char.get("frame_scale", {}):
                fit = ("h", char["frame_scale"][f"{name}_{i}"])
            imgs.append(fit_scale(raw(f"{name}_{i}"), fit, idle_height, base))
        processed[name] = imgs

    palette = build_palette(processed["idle"] + processed["punch"] + processed["kick"])
    idle = processed["idle"][0]
    idle_reach = idle.width - frame_geometry(idle, 0, False, base=base)["ax"]

    order, meta = [], {}
    for name, imgs in processed.items():
        spec = anims[name]
        meta[name] = {"fps": spec["fps"], "loop": spec["loop"], "active": spec.get("active", []), "frames": []}
        for i, im in enumerate(imgs):
            raw = np.asarray(im).astype(int)  # before the palette, which mutes a bright beam's color
            im = apply_palette(im, palette)
            geo = frame_geometry(im, idle_reach, i in spec.get("active", []), name == "ko", spec.get("hurt_h"), base)
            if name.startswith("special"):
                # The highest point (e.g. an uppercut's raised fist) and the front-most point (a fist
                # thrust forward), relative to the feet, for the game to attach things to.
                a = np.asarray(im)[:, :, 3] > 0
                ys, xs = np.nonzero(a)
                top = ys.min()
                geo["top"] = [int(round(xs[ys <= top + 2].mean())) - geo["ax"], int(top) - geo["ay"]]
                front = xs.max()
                geo["front"] = [int(front) - geo["ax"], int(round(ys[xs >= front - 2].mean())) - geo["ay"]]
                # Rows where the drawing runs off the front edge (a beam cut by the canvas), so the
                # game can continue it across the screen: [top, bottom, start] relative to the feet,
                # start being where the beam begins (e.g. the eyes), so the game draws over it all.
                rows = np.nonzero(raw[:, -1, 3] > 0)[0]
                if len(rows):
                    band = raw[rows.min():rows.max() + 1]
                    r, g, b, a = (band[:, :, k] for k in range(4))
                    beamy = (a > 0) & (((r > g + 60) & (r > b + 30)) | ((r > 200) & (g > 170) & (b > 170)))
                    start, misses = band.shape[1] - 1, 0
                    for x in range(band.shape[1] - 1, -1, -1):
                        opaque = a[:, x] > 0
                        if opaque.any() and beamy[:, x][opaque].mean() >= 0.5:
                            start, misses = x, 0
                        elif (misses := misses + 1) > 2:
                            break
                    geo["edge"] = [int(rows.min()) - geo["ay"], int(rows.max()) + 1 - geo["ay"], start - geo["ax"]]
            order.append((name, im, geo))
    sheet, rects = pack([im for _, im, _ in order])
    for (name, _, geo), (x, y, w, h) in zip(order, rects):
        meta[name]["frames"].append({"x": x, "y": y, "w": w, "h": h, **geo})
    sheet.save(out / "sheet.png")

    props = {}
    for sp in char["specials"]:
        p = frames_dir / f"prop_{sp['id']}.png"
        if sp["prop"] and p.exists():
            # Its own palette: the fighter's has none of a prop's colors (a white van came out peach).
            im = fit_scale(drop_specks(remove_background(load_frame(p))), ("h", sp["prop_size"]), base=base)
            im = apply_palette(im, build_palette([im]))
            im.save(out / "props" / f"{sp['id']}.png")
            props[sp["id"]] = f"props/{sp['id']}.png"
        for name, extra in sp.get("extra_props", {}).items():
            p = frames_dir / f"prop_{sp['id']}_{name}.png"
            if p.exists():
                im = fit_scale(drop_specks(remove_background(load_frame(p))), ("h", extra["size"]), base=base)
                im = apply_palette(im, build_palette([im]))
                im.save(out / "props" / f"{sp['id']}_{name}.png")
                props[f"{sp['id']}_{name}"] = f"props/{sp['id']}_{name}.png"

    portrait = frames_dir / "portrait.png"
    if portrait.exists():
        im = remove_background(load_frame(portrait))
        im = im.crop(im.getbbox())
        side = max(im.size)
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.paste(im, ((side - im.width) // 2, side - im.height))
        apply_palette(fit_scale(sq, ("h", PORTRAIT_SIZE / SPRITE_HEIGHT)), palette).save(out / "portrait.png")

    (out / "sheet.json").write_text(json.dumps(
        {"image": "sheet.png", "height": base, "facing": "right", "animations": meta, "props": props},
        indent=1) + "\n")
    if stature != 1:  # hand-measured points are in standard-size pixels
        char = json.loads(json.dumps(char))
        for sp in char["specials"]:
            if sp.get("origin"):
                sp["origin"] = [round(v * stature) for v in sp["origin"]]
    (out / "character.json").write_text(json.dumps(char, indent=2) + "\n")
    log(f"  sheet: wrote {rel(out)}/ ({len(order)} frames, {len(props)} props)")


# --------------------------------------------------------------------------- main

def main():
    global IMAGE_MODEL, TEXT_MODEL
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folders", nargs="*", type=Path, help="character folder(s)")
    ap.add_argument("--all", action="store_true", help="process every folder in Characters/")
    ap.add_argument("--stage", choices=["parse", "frames", "sheet", "all"], default="all")
    ap.add_argument("--only", default="", help="comma list of animations/frames to (re)generate, e.g. punch,kick_1")
    ap.add_argument("--force", action="store_true", help="regenerate frames even if cached")
    ap.add_argument("--check", action="store_true",
                    help="check cached frames for extra or missing limbs and regenerate the bad ones")
    ap.add_argument("--reparse", action="store_true", help="regenerate character.json from the text file")
    ap.add_argument("--placeholder", action="store_true",
                    help="make crude frames from the reference image instead of calling Gemini")
    ap.add_argument("--image-model", default=IMAGE_MODEL)
    ap.add_argument("--text-model", default=TEXT_MODEL)
    args = ap.parse_args()
    IMAGE_MODEL, TEXT_MODEL = args.image_model, args.text_model

    folders = sorted(p for p in CHAR_DIR.iterdir() if p.is_dir()) if args.all else args.folders
    if not folders:
        ap.error("give a character folder or --all")
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    for folder in folders:
        folder = folder.resolve()
        log(f"[{folder.name}]")
        try:
            built = folder / "character.json"
            if args.stage == "sheet" and built.exists() and not args.reparse:
                # Sheets only: use the parsed profile as is (no API key needed, e.g. in Docker).
                char = json.loads(built.read_text())
            else:
                char = stage_parse(folder, args.reparse)
        except NotReady as e:
            log(f"  skipped: {e}")
            continue
        if args.stage in ("frames", "all"):
            if args.placeholder:
                stage_placeholder_frames(folder, char)
            else:
                stage_frames(folder, char, only, args.force, args.check)
        if args.stage in ("sheet", "all"):
            stage_sheet(folder, char)


if __name__ == "__main__":
    main()
