#!/usr/bin/env python3
"""Game server: basic auth from users.csv, character/arena listings, assets, high scores.

users.csv lines are  username,password,character : the last item is the fighter that user
always plays (a character's name or folder, e.g. Tonian or The Koop). Players only choose
their opponent, except the first account in the file (the admin), who may pick any fighter.

    source setup.sh
    ./server.py                 # http://localhost:8000
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
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
USERS_CSV = ROOT / "users.csv"
ARENA_DIR = ROOT / "Arenas"
CHAR_DIR = ROOT / "Characters"
SOUND_DIR = ROOT / "Sounds"
CHAR_BUILD = ROOT / "build" / "characters"
ARENA_BUILD = ROOT / "build" / "arenas"
STATIC_DIR = ROOT / "static"
DB_PATH = ROOT / "data" / "scores.db"

ARENA_HEIGHT = 224  # game renders at 384x224; arenas wider than that scroll with the camera
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


def check_auth(header):
    if not header or not header.startswith("Basic "):
        return None
    try:
        user, _, password = base64.b64decode(header[6:]).decode().partition(":")
    except Exception:
        return None
    expected = users().get(user, (None,))[0]
    if expected is not None and secrets.compare_digest(expected.encode(), password.encode()):
        return user
    return None


def can_choose_any(user):
    """The first account in users.csv may play any character."""
    return bool(users()) and user == next(iter(users()))


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


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    user = check_auth(request.headers.get("authorization")) or DEV_USER
    if user is None:
        return Response("Login required", status_code=401,
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
        "specials": [{k: sp.get(k) for k in ("id", "name", "input", "effect", "shout")}
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
    """Game-sized and thumbnail copies, rebuilt when the source image changes."""
    ARENA_BUILD.mkdir(parents=True, exist_ok=True)
    full, thumb = ARENA_BUILD / f"{slug}.png", ARENA_BUILD / f"{slug}_thumb.png"
    if not full.exists() or full.stat().st_mtime < src.stat().st_mtime:
        img = Image.open(src).convert("RGB")
        w = round(img.width * ARENA_HEIGHT / img.height)
        img.resize((w, ARENA_HEIGHT), Image.Resampling.BOX).save(full)
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
    return conn


class MatchResult(BaseModel):
    character: str
    opponent: str
    arena: str
    won: bool
    health_left: int = Field(ge=0)
    duration: float = Field(gt=0, description="seconds")


def compute_score(result, player, opponent):
    """Win bonus + remaining health + speed bonus, scaled by how tough the opponent is
    relative to the player's own character."""
    def power(c):
        s = c["stats"]
        return s["health"] + 10 * (s["punch_damage"] + s["kick_damage"]) + 100 * s["block"]

    ratio = min(2.0, max(0.5, power(opponent) / power(player)))
    health_pct = result.health_left / player["stats"]["health"]
    score = 1000 * health_pct
    if result.won:
        score += 1000 + max(0.0, 180 - result.duration) * 5
    return round(score * ratio)


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
    if result.duration < 3:
        raise HTTPException(400, "match too short")

    score = compute_score(result, player, opponent)
    with db() as conn:
        conn.execute(
            "INSERT INTO scores (username, character, opponent, arena, won, health_left, duration, score, created)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (request.state.user, result.character, result.opponent, result.arena, int(result.won),
             result.health_left, result.duration, score, time.time()))
        best = conn.execute("SELECT MAX(score) FROM scores WHERE username = ?",
                            (request.state.user,)).fetchone()[0]
        rank = conn.execute("SELECT COUNT(DISTINCT username) FROM scores s WHERE"
                            " (SELECT MAX(score) FROM scores WHERE username = s.username) > ?",
                            (best,)).fetchone()[0] + 1
    return {"score": score, "personal_best": best, "rank": rank}


@app.get("/api/scores")
def high_scores(limit: int = 10):
    """Best score per user, highest first."""
    with db() as conn:
        rows = conn.execute("""
            SELECT username, character, opponent, arena, score, created FROM scores s
            WHERE score = (SELECT MAX(score) FROM scores WHERE username = s.username)
            GROUP BY username ORDER BY score DESC LIMIT ?""", (min(limit, 100),)).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/me")
def me(request: Request):
    with db() as conn:
        row = conn.execute("SELECT MAX(score) AS best, COUNT(*) AS matches, SUM(won) AS wins"
                           " FROM scores WHERE username = ?", (request.state.user,)).fetchone()
    slug, name = assigned_character(request.state.user)
    return {"username": request.state.user, "best": row["best"] or 0,
            "matches": row["matches"], "wins": row["wins"] or 0,
            "character": slug, "character_name": name,
            "choose_any": can_choose_any(request.state.user)}


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
    args = ap.parse_args()
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
