#!/usr/bin/env python3
"""Game server: basic auth from users.csv, character/arena listings, assets, high scores.

users.csv lines are  username,password,character : the last item is the fighter that user
always plays (a character's name or folder, e.g. Tonian or The Koop). Players only choose
their opponent, except the "guest" account, which may pick any fighter (its character
column can be left off: guest,password). Players can change their own password from the menu
(not the guest); that's stored hashed in data/scores.db and replaces the users.csv one. To undo
it, e.g. a forgotten password:  python server.py --reset-password NAME

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once
    .venv/bin/python server.py                 # http://localhost:8000
    ./server.py --port 9000 --host 0.0.0.0

Characters appear once add_character.py has built them into build/characters/.
A character's home arena is the Arena_* image in its Characters/<Name>/ folder, with
<Name>.mp3 as its music; matches against that character are fought there. Images in Arenas/
(with an optional same-named .mp3) are used for opponents without one. A game-sized copy of
each arena is made on first request.
"""

import argparse
import asyncio
import base64
import csv
import hashlib
import io
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image
from typing import Literal

from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
USERS_CSV = ROOT / "users.csv"
ARENA_DIR = ROOT / "Arenas"
CHAR_DIR = ROOT / "Characters"
REQUEST_DIR = ROOT / "CharacterRequests"  # account + fighter requests from guests, for an admin
SOUND_DIR = ROOT / "Sounds"
CHAR_BUILD = ROOT / "build" / "characters"
ARENA_BUILD = ROOT / "build" / "arenas"
STATIC_DIR = ROOT / "static"
DB_PATH = ROOT / "data" / "scores.db"

ARENA_HEIGHT = 224  # game renders at 384x224; arenas wider than that scroll with the camera
ARENA_MIN_WIDTH = 384  # the arena's edges are the stage's edges, so it must fill the screen
THUMB_WIDTH = 192
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
AUDIO_EXTS = {".mp3", ".ogg", ".m4a", ".wav"}

app = FastAPI(title="UNK Fighter", docs_url=None, redoc_url=None)


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


# --------------------------------------------------------------------------- auth

_users = {"mtime": None, "table": {}}


def users():
    """user -> (password, character name or None) from users.csv, reloaded whenever the file changes."""
    mtime = USERS_CSV.stat().st_mtime if USERS_CSV.exists() else None
    if mtime != _users["mtime"]:
        table = {}
        if mtime is not None:
            with USERS_CSV.open(newline="") as f:
                for row in csv.reader(f):
                    if len(row) >= 2 and row[0].strip() and not row[0].startswith("#"):
                        if row[0].strip().lower() in ("user", "username") and not table:
                            continue  # header row
                        table[row[0].strip()] = (row[1].strip(), row[-1].strip() if len(row) >= 3 else None)
        _users.update(mtime=mtime, table=table)
    return _users["table"]


# Passwords users change themselves are stored hashed in data/ (users.csv is mounted read-only
# when deployed, and data/ is kept across redeploys). A changed password replaces the users.csv
# one; `server.py --reset-password NAME` drops it, back to the users.csv password.

def hash_password(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1).hex()


def changed_password(user):
    """(salt bytes, hash hex) of the user's own password, or None if they use users.csv's."""
    with db() as conn:
        row = conn.execute("SELECT salt, hash FROM passwords WHERE username = ?", (user,)).fetchone()
    return (bytes.fromhex(row["salt"]), row["hash"]) if row else None


_verified = {}  # Authorization header -> stored hash it matched (scrypt is slow; every asset logs in)


def password_ok(user, password):
    if user not in users():
        return False  # removed from users.csv: no login, whatever password they set
    changed = changed_password(user)
    if changed:
        salt, stored = changed
        key = f"{user}:{password}"
        if _verified.get(key) != stored:
            if not secrets.compare_digest(hash_password(password, salt), stored):
                return False
            _verified[key] = stored
        return True
    return secrets.compare_digest(users()[user][0].encode(), password.encode())


def check_auth(header):
    if not header or not header.startswith("Basic "):
        return None
    try:
        user, _, password = base64.b64decode(header[6:]).decode().partition(":")
    except Exception:
        return None
    return user if password_ok(user, password) else None


GUEST_USER = "guest"


def can_choose_any(user):
    """The guest account (username "guest", any case) may play any character."""
    return bool(user) and user.lower() == GUEST_USER


DEV_USER = None  # set by --dev-user: skip the login prompt (loopback only, for local testing)
DEV_CHARACTER = None  # set by --dev-character: the dev user's fighter


def assigned_character(user):
    """(slug, name as written) of the user's fighter from users.csv; slug is None when the
    name matches no built character. Matching ignores case, spaces and punctuation, against
    either the folder slug or the display name, so "The Koop" finds thekoop."""
    name = DEV_CHARACTER if user == DEV_USER and DEV_CHARACTER else users().get(user, (None, None))[1]
    if not name:
        return None, None
    key = re.sub(r"[^a-z0-9]", "", name.lower())
    if CHAR_BUILD.exists():
        for folder in sorted(CHAR_BUILD.iterdir()):
            char = load_character(folder.name)
            if char and key in (re.sub(r"[^a-z0-9]", "", folder.name),
                                re.sub(r"[^a-z0-9]", "", char.get("name", "").lower())):
                return folder.name, name
    return None, name


LOGOUT_USER = "_logout_"  # can't be a real login: request usernames must start with a letter or digit


def logout(request):
    """Basic auth has no logout, so the page swaps the browser's saved login for a dummy one:
    it asks for this URL as LOGOUT_USER, which is challenged once and then accepted. The browser
    keeps sending the dummy, the server rejects it everywhere else, and the login prompt returns."""
    header = request.headers.get("authorization") or ""
    try:
        user = base64.b64decode(header[6:]).decode().partition(":")[0] if header.startswith("Basic ") else None
    except Exception:
        user = None
    if user == LOGOUT_USER:
        return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
    return Response("Logging out", status_code=401, headers={"WWW-Authenticate": 'Basic realm="UNK Fighter"'})


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if request.url.path == "/api/logout":
        return logout(request)
    user = check_auth(request.headers.get("authorization")) or DEV_USER
    if user is None:
        return Response("Login required. Reload the page to sign in.", status_code=401,
                        headers={"WWW-Authenticate": 'Basic realm="UNK Fighter"'})
    request.state.user = user
    response = await call_next(request)
    # Rebuilt sheets, arenas and game.js keep their URLs, so browsers must revalidate
    # (cheap: unchanged files come back 304 via ETag) rather than mix stale and fresh files.
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


# --------------------------------------------------------------------------- characters

def load_character(slug):
    folder = CHAR_BUILD / slug
    try:
        char = json.loads((folder / "character.json").read_text())
    except (OSError, ValueError):
        return None
    if not (folder / "sheet.json").exists() or not (folder / "sheet.png").exists():
        return None
    return char


def character_summary(slug, char):
    base = f"/assets/characters/{slug}"
    # Changes on every add_character.py rebuild, so no browser can pair a cached old
    # sheet.png with a new sheet.json (frames would be cut from the wrong rectangles).
    v = f"?v={int((CHAR_BUILD / slug / 'sheet.png').stat().st_mtime)}"
    return {
        "slug": slug,
        "name": char["name"],
        "summary": char["summary"],
        "stats": char["stats"],
        "ai": char["ai"],
        "taunts": char.get("taunts", []),
        "specials": [{k: sp.get(k) for k in ("id", "name", "input", "effect", "shout", "extra_props", "cooldown", "origin", "beam_frame", "beam_style")}
                     for sp in char["specials"]],
        "sheet": f"{base}/sheet.json",
        "version": v,
        "portrait": f"{base}/portrait.png{v}" if (CHAR_BUILD / slug / "portrait.png").exists() else None,
    }


@app.get("/api/characters")
def list_characters():
    out = []
    for folder in sorted(CHAR_BUILD.glob("*/")) if CHAR_BUILD.exists() else []:
        char = load_character(folder.name)
        if char:
            out.append(character_summary(folder.name, char))
    return out


# --------------------------------------------------------------------------- arenas

def arena_name(path):
    stem = path.stem
    return stem[6:] if stem.lower().startswith("arena_") else stem


def find_audio(folder, stem):
    """<stem>.<audio ext> in folder, if any."""
    return next((p for p in sorted(folder.iterdir())
                 if p.suffix.lower() in AUDIO_EXTS and p.stem.lower() == stem.lower()), None)


def arena_sources():
    """slug -> (source image, display name, home character slug or None, music or None)."""
    out = {}
    if ARENA_DIR.exists():
        for p in sorted(ARENA_DIR.iterdir()):
            if p.suffix.lower() in IMAGE_EXTS:
                out[slugify(arena_name(p))] = (p, arena_name(p), None, find_audio(ARENA_DIR, p.stem))
    if CHAR_DIR.exists():
        for folder in sorted(CHAR_DIR.iterdir()):
            homes = sorted(p for p in folder.glob("[Aa]rena_*") if p.suffix.lower() in IMAGE_EXTS) \
                if folder.is_dir() else []
            if homes:  # same slug rule as add_character.py, so it matches build/characters/<slug>
                char = slugify(folder.name)
                out[f"{char}_home"] = (homes[0], arena_name(homes[0]), char, find_audio(folder, folder.name))
    return out


def build_arena(slug, src):
    """Game-sized and thumbnail copies, rebuilt when the source image changes. The game copy is
    ARENA_HEIGHT tall and at least ARENA_MIN_WIDTH wide: the image's edges are where fighters
    stop, so a narrow (portrait-ish) image is scaled up to fill the screen, keeping the floor
    and trimming sky."""
    ARENA_BUILD.mkdir(parents=True, exist_ok=True)
    full, thumb = ARENA_BUILD / f"{slug}.png", ARENA_BUILD / f"{slug}_thumb.png"
    stale = not full.exists() or full.stat().st_mtime < src.stat().st_mtime
    if not stale:
        with Image.open(full) as im:
            stale = im.height != ARENA_HEIGHT or im.width < ARENA_MIN_WIDTH  # built before this rule
    if stale:
        img = Image.open(src).convert("RGB")
        scale = max(ARENA_HEIGHT / img.height, ARENA_MIN_WIDTH / img.width)
        w, h = max(ARENA_MIN_WIDTH, round(img.width * scale)), max(ARENA_HEIGHT, round(img.height * scale))
        img.resize((w, h), Image.Resampling.BOX).crop((0, h - ARENA_HEIGHT, w, h)).save(full)
        img.resize((THUMB_WIDTH, round(img.height * THUMB_WIDTH / img.width)), Image.Resampling.BOX).save(thumb)
    return full, thumb


@app.get("/api/arenas")
def list_arenas():
    out = []
    for slug, (src, name, home, music) in arena_sources().items():
        full, _ = build_arena(slug, src)
        with Image.open(full) as im:
            size = im.size
        out.append({"slug": slug, "name": name, "home": home, "width": size[0], "height": size[1],
                    "image": f"/assets/arenas/{slug}.png", "thumb": f"/assets/arenas/{slug}_thumb.png",
                    "music": f"/assets/music/{slug}{music.suffix.lower()}" if music else None})
    return out


# --------------------------------------------------------------------------- assets

def safe_file(base, rel):
    path = (base / rel).resolve()
    if not path.is_relative_to(base.resolve()) or not path.is_file():
        raise HTTPException(404)
    return path


@app.get("/assets/characters/{slug}/{rel:path}")
def character_asset(slug: str, rel: str):
    return FileResponse(safe_file(CHAR_BUILD / slug, rel))


@app.get("/assets/arenas/{name}")
def arena_asset(name: str):
    slug = name.removesuffix(".png").removesuffix("_thumb")
    src = arena_sources().get(slug)
    if not src:
        raise HTTPException(404)
    build_arena(slug, src[0])
    return FileResponse(safe_file(ARENA_BUILD, name))


@app.get("/assets/music/{name}")
def arena_music(name: str):
    src = arena_sources().get(Path(name).stem)
    if not src or not src[3]:
        raise HTTPException(404)
    return FileResponse(src[3])


@app.get("/api/sounds")
def list_sounds():
    """Sound files by effect name: Sounds/<effect>.(wav|mp3|...), with <effect>-2, <effect>-3, ...
    as variants the game picks between at random. Effects without a file are silent."""
    out = {}
    for p in sorted(SOUND_DIR.iterdir()) if SOUND_DIR.exists() else []:
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS:
            base, _, n = p.stem.rpartition("-")
            out.setdefault(base if base and n.isdigit() else p.stem, []).append(f"/assets/sounds/{p.name}")
    return out


@app.get("/assets/sounds/{name}")
def sound_file(name: str):
    return FileResponse(safe_file(SOUND_DIR, name))


@app.get("/assets/selection-music")
def selection_music():
    """SelectionScreen.(mp3|ogg|...) in the project root loops on the character select screen."""
    src = find_audio(ROOT, "SelectionScreen")
    if not src:
        raise HTTPException(404)
    return FileResponse(src)


@app.get("/assets/map.jpeg")
def select_background():
    """Map.jpeg in the project root is the character select screen's background."""
    return FileResponse(safe_file(ROOT, "Map.jpeg"))


@app.get("/assets/splash.mp4")
def splash():
    """SplashScreen.mp4 in the project root plays before the menu; the page skips it if absent."""
    return FileResponse(safe_file(ROOT, "SplashScreen.mp4"))


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/static/{rel:path}")
def static(rel: str):
    return FileResponse(safe_file(STATIC_DIR, rel))


# --------------------------------------------------------------------------- scores

def db():
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY, username TEXT NOT NULL, character TEXT NOT NULL,
        opponent TEXT NOT NULL, arena TEXT NOT NULL, won INTEGER NOT NULL,
        health_left INTEGER NOT NULL, duration REAL NOT NULL, score INTEGER NOT NULL,
        created REAL NOT NULL)""")
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(scores)")]
    if "initials" not in cols:
        conn.execute("ALTER TABLE scores ADD COLUMN initials TEXT")  # guests' arcade initials
    if "best_combo" not in cols:
        conn.execute("ALTER TABLE scores ADD COLUMN best_combo INTEGER NOT NULL DEFAULT 0")
    if "difficulty" not in cols:
        conn.execute("ALTER TABLE scores ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'easy'")
    conn.execute("""CREATE TABLE IF NOT EXISTS passwords (
        username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, changed REAL NOT NULL)""")
    return conn


def player_key(t=""):
    """SQL for who a score belongs to on the chart: each set of guest initials is its own
    player; everyone else is their username. t is an optional table alias, e.g. "s."."""
    return f"CASE WHEN {t}initials IS NOT NULL THEN {t}username || ':' || {t}initials ELSE {t}username END"
INITIALS_WINDOW = 15 * 60  # seconds after a match during which a guest may sign it


ROUNDS_TO_WIN = 2       # as in game.js
SPECIAL_POINTS = 150    # per special move that lands (before the difficulty multiplier)
COMBO_BASE = 50         # a combo of n hits is worth COMBO_BASE * n^2 (as in game.js)
MAX_COMBO = 60          # longer combos score as this many hits
BREAKER_POINTS = 1000   # per combo breaker the player pulled off (as in game.js)
DIFFICULTY_BONUS = {"easy": 1.0, "medium": 1.5, "hard": 2.0}  # score multiplier for the opponent AI level


class MatchResult(BaseModel):
    character: str
    opponent: str
    arena: str
    won: bool
    health_left: int = Field(ge=0)
    duration: float = Field(gt=0, description="seconds")
    round_health: list[int] = Field(default=[], max_length=ROUNDS_TO_WIN,
                                    description="health left at the end of each round the player won")
    specials_landed: int = Field(default=0, ge=0, le=150)  # a special every 4 s over 5 rounds at most
    combos: list[int] = Field(default=[], max_length=1000,
                              description="length of each combo (2+ landed hits in a row) the player landed")
    breakers: int = Field(default=0, ge=0, le=100, description="combo breakers the player pulled off")
    difficulty: Literal["easy", "medium", "hard"] = "easy"


def compute_score(result, player, opponent):
    """Combos (50 x hits^2 each, the big one) + 1000 per combo breaker + health left over the rounds won (both full
    bars = 1000) + 150 per special move landed + win bonus + speed bonus, scaled by how tough
    the opponent is relative to the player's own character and by the difficulty level."""
    def power(c):
        s = c["stats"]
        return s["health"] + 10 * (s["punch_damage"] + s["kick_damage"]) + 100 * s["block"]

    ratio = min(2.0, max(0.5, power(opponent) / power(player)))
    max_health = player["stats"]["health"]
    if result.round_health:
        health_pct = sum(min(h, max_health) for h in result.round_health) / (ROUNDS_TO_WIN * max_health)
    else:  # a client from before round_health: the final health only
        health_pct = result.health_left / max_health
    score = 1000 * health_pct + SPECIAL_POINTS * result.specials_landed
    score += sum(COMBO_BASE * min(n, MAX_COMBO) ** 2 for n in result.combos)
    score += BREAKER_POINTS * result.breakers
    if result.won:
        score += 1000 + max(0.0, 180 - result.duration) * 5
    return round(score * ratio * DIFFICULTY_BONUS[result.difficulty])


@app.post("/api/scores")
def submit_score(result: MatchResult, request: Request):
    if result.character != assigned_character(request.state.user)[0] and not can_choose_any(request.state.user):
        raise HTTPException(400, "that isn't your fighter")
    if result.opponent == result.character:
        raise HTTPException(400, "you can't fight yourself")
    player, opponent = load_character(result.character), load_character(result.opponent)
    if not player or not opponent:
        raise HTTPException(400, "unknown character")
    if result.arena not in arena_sources():
        raise HTTPException(400, "unknown arena")
    if result.health_left > player["stats"]["health"] or (result.won and result.health_left == 0):
        raise HTTPException(400, "impossible health value")
    if any(not 0 < h <= player["stats"]["health"] for h in result.round_health) or \
            (result.won and result.round_health and len(result.round_health) != ROUNDS_TO_WIN):
        raise HTTPException(400, "impossible round health")
    if result.duration < 3:
        raise HTTPException(400, "match too short")
    if any(n < 2 or n > 2000 for n in result.combos):
        raise HTTPException(400, "impossible combo")

    score = compute_score(result, player, opponent)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO scores (username, character, opponent, arena, won, health_left, duration, score, created,"
            " best_combo, difficulty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (request.state.user, result.character, result.opponent, result.arena, int(result.won),
             result.health_left, result.duration, score, time.time(), max(result.combos, default=0),
             result.difficulty))
        best = conn.execute("SELECT MAX(score) FROM scores WHERE username = ?",
                            (request.state.user,)).fetchone()[0]
        rank = conn.execute("SELECT COUNT(DISTINCT username) FROM scores s WHERE"
                            " (SELECT MAX(score) FROM scores WHERE username = s.username) > ?",
                            (best,)).fetchone()[0] + 1
    return {"id": cur.lastrowid, "score": score, "personal_best": best, "rank": rank}


class Initials(BaseModel):
    initials: str = Field(pattern=r"^[A-Za-z0-9]{3}$")


@app.post("/api/scores/{score_id}/initials")
def sign_score(score_id: int, body: Initials, request: Request):
    """The guest account puts its arcade initials on its own just-played score, once."""
    if not can_choose_any(request.state.user):
        raise HTTPException(403, "only the guest account enters initials")
    initials = body.initials.upper()
    with db() as conn:
        row = conn.execute("SELECT username, initials, created FROM scores WHERE id = ?", (score_id,)).fetchone()
        if not row or row["username"] != request.state.user:
            raise HTTPException(404, "no such score")
        if row["initials"] or time.time() - row["created"] > INITIALS_WINDOW:
            raise HTTPException(409, "that score can't be signed any more")
        conn.execute("UPDATE scores SET initials = ? WHERE id = ?", (initials, score_id))
        rank = conn.execute(f"SELECT COUNT(DISTINCT {player_key()}) FROM scores WHERE score > "
                            "(SELECT score FROM scores WHERE id = ?)", (score_id,)).fetchone()[0] + 1
    return {"initials": initials, "rank": rank}


@app.get("/api/scores")
def high_scores(limit: int = 10):
    """Best score per player, highest first. A player is a user, or for the guest account each
    set of initials; "name" is what the chart shows (initials, GUEST, or the username)."""
    with db() as conn:
        rows = conn.execute(f"""
            SELECT id, username, initials, character, opponent, arena, score, best_combo, created FROM scores s
            WHERE score = (SELECT MAX(score) FROM scores WHERE {player_key()} = {player_key("s.")})
            GROUP BY {player_key("s.")}
            ORDER BY score DESC LIMIT ?""", (min(limit, 100),)).fetchall()
    return [{**dict(r), "name": r["initials"] or (r["username"].upper() if can_choose_any(r["username"])
                                                  else r["username"])} for r in rows]


# --------------------------------------------------------------------------- account requests

# The guest account can ask for its own account and fighter. Each request is a folder an admin
# reviews: CharacterRequests/<Name>/ with <Name>.txt (the description, as add_character.py reads
# it), <Name>.<jpg|png|webp> (the photo) and users.csv (username,password,Name). To accept one,
# move the folder into Characters/, add its users.csv line to the main users.csv, and run
# add_character.py on it.
MAX_PHOTO_BYTES = 8 * 1024 * 1024
MAX_PENDING_REQUESTS = 100


class AccountRequest(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,29}$")
    password: str = Field(min_length=6, max_length=200)
    character: str = Field(min_length=2, max_length=40)
    description: str = Field(min_length=20, max_length=4000)
    photo: str = Field(description="the photo as a data: URL (base64)")


def requested_usernames():
    names = set()
    for f in REQUEST_DIR.glob("*/users.csv") if REQUEST_DIR.exists() else []:
        with f.open(newline="") as fh:
            names |= {row[0].strip().lower() for row in csv.reader(fh) if row and row[0].strip()}
    return names


@app.post("/api/account-request")
def account_request(body: AccountRequest, request: Request):
    """Guest only: ask for an account and a fighter (see above)."""
    if not can_choose_any(request.state.user):
        raise HTTPException(403, "only the guest account can request a new account")
    username = body.username.strip()
    taken = {u.lower() for u in users()} | requested_usernames() | {GUEST_USER}
    if username.lower() in taken:
        raise HTTPException(409, "that username is taken")
    # The character's name doubles as its folder name, so keep it to plain characters.
    name = re.sub(r"\s+", " ", body.character).strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _'-]*", name):
        raise HTTPException(400, "use only letters, numbers, spaces, - _ and ' in the character name")
    key = slugify(name)
    existing = {slugify(p.name) for d in (CHAR_DIR, REQUEST_DIR) if d.exists() for p in d.iterdir() if p.is_dir()}
    if key in existing:
        raise HTTPException(409, "there's already a character (or a request) with that name")
    if REQUEST_DIR.exists() and sum(1 for p in REQUEST_DIR.iterdir() if p.is_dir()) >= MAX_PENDING_REQUESTS:
        raise HTTPException(429, "too many requests are waiting for review; try again later")
    m = re.fullmatch(r"data:image/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)", body.photo)
    if not m:
        raise HTTPException(400, "the photo must be an image")
    try:
        data = base64.b64decode(m.group(1), validate=False)
    except ValueError:
        raise HTTPException(400, "the photo couldn't be read")
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "the photo is too big (8 MB at most)")
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
            fmt = im.format
    except Exception:
        raise HTTPException(400, "the photo couldn't be read as an image")
    ext = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}.get(fmt)
    if not ext:
        raise HTTPException(400, "the photo must be a JPEG, PNG or WebP image")

    folder = REQUEST_DIR / name
    folder.mkdir(parents=True)
    (folder / f"{name}{ext}").write_bytes(data)
    stamp = time.strftime("%Y-%m-%d %H:%M")
    (folder / f"{name}.txt").write_text(
        f"# Requested by {username} through the game's guest account, {stamp}.\n"
        f"# Review, then move this folder into Characters/ and run add_character.py on it.\n"
        f"{body.description.strip()}\n")
    with (folder / "users.csv").open("w", newline="") as f:
        csv.writer(f).writerow([username, body.password, name])
    return {"ok": True, "character": name}


class PasswordChange(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(min_length=6, max_length=200)


@app.post("/api/password")
def change_password(body: PasswordChange, request: Request):
    """A logged-in user sets their own password (not the shared guest account)."""
    user = request.state.user
    if can_choose_any(user):
        raise HTTPException(403, "the guest account's password can't be changed")
    if user not in users():
        raise HTTPException(403, "this account isn't in users.csv")
    if not password_ok(user, body.current):
        raise HTTPException(400, "your current password isn't right")
    if body.new == body.current:
        raise HTTPException(400, "the new password is the same as the current one")
    salt = secrets.token_bytes(16)
    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO passwords (username, salt, hash, changed) VALUES (?, ?, ?, ?)",
                     (user, salt.hex(), hash_password(body.new, salt), time.time()))
    for key in [k for k in _verified if k.startswith(f"{user}:")]:
        del _verified[key]
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    with db() as conn:
        row = conn.execute("SELECT MAX(score) AS best, COUNT(*) AS matches, SUM(won) AS wins"
                           " FROM scores WHERE username = ?", (request.state.user,)).fetchone()
    slug, name = assigned_character(request.state.user)
    return {"username": request.state.user, "best": row["best"] or 0,
            "matches": row["matches"], "wins": row["wins"] or 0,
            "character": slug, "character_name": name,
            "choose_any": can_choose_any(request.state.user),
            "can_change_password": not can_choose_any(request.state.user) and request.state.user in users(),
            "can_request_account": can_choose_any(request.state.user),
            "can_logout": request.state.user != DEV_USER}  # --dev-user logs everyone in anyway


@app.exception_handler(FileNotFoundError)
def missing_file(request, exc):
    return JSONResponse({"detail": "not found"}, status_code=404)


class QuietCancelledRequests(logging.Filter):
    """Drop the traceback uvicorn logs for each request it cancels at shutdown (e.g. a half-sent
    video): it's expected, not an error."""
    def filter(self, record):
        exc = record.exc_info[1] if record.exc_info else None
        while exc is not None:
            if isinstance(exc, asyncio.CancelledError):
                return False
            exc = exc.__context__ or exc.__cause__
        return True


def main():
    import uvicorn
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # UNK_HOST / UNK_PORT set the defaults (the Docker image binds 0.0.0.0:8000).
    ap.add_argument("--host", default=os.environ.get("UNK_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("UNK_PORT", "8000")))
    ap.add_argument("--reload", action="store_true", help="restart on code changes (development)")
    ap.add_argument("--dev-user", help="treat unauthenticated requests as this user (local testing only)")
    ap.add_argument("--dev-character", help="the dev user's fighter, if users.csv doesn't give one")
    ap.add_argument("--reset-password", metavar="NAME",
                    help="forget the password NAME set in the game, so users.csv's applies again, and exit")
    args = ap.parse_args()
    if args.reset_password:
        with db() as conn:
            n = conn.execute("DELETE FROM passwords WHERE username = ?", (args.reset_password,)).rowcount
        print(f"{args.reset_password}: " + ("back to the users.csv password" if n else "had not changed their password"))
        return
    if args.dev_user:
        if args.host not in ("127.0.0.1", "localhost", "::1") or args.reload:
            ap.error("--dev-user only works on a loopback host without --reload")
        global DEV_USER, DEV_CHARACTER
        DEV_USER, DEV_CHARACTER = args.dev_user, args.dev_character
        print(f"warning: login disabled, every request is user {DEV_USER!r}")
    if not users():
        print(f"warning: no users in {USERS_CSV.name}; add lines of the form  username,password,character")
    # Browsers hold keep-alive connections (and stream music/video) indefinitely, so a graceful
    # shutdown would wait on them; give in-flight requests a moment, then close everything.
    logging.getLogger("uvicorn.error").addFilter(QuietCancelledRequests())
    uvicorn.run("server:app" if args.reload else app, host=args.host, port=args.port, reload=args.reload,
                timeout_graceful_shutdown=1)


if __name__ == "__main__":
    main()
