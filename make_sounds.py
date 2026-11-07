#!/usr/bin/env python3
"""Generate the game's sound effects and announcer voice with ElevenLabs into Sounds/, where the
game plays them from (static/sound.js). Fight sounds are full-quality stereo like a modern fighting
game (see polish); jingles, interface sounds and the announcer are processed to sound like SNES
samples (see snesify).

    python make_sounds.py                    # everything not generated yet
    python make_sounds.py hit_heavy vo_ko    # just these (regenerated even if they exist)
    python make_sounds.py --process-only     # redo the SNES processing on cached raw audio (free)
    python make_sounds.py --list-voices      # see announcer voices; choose one with --voice NAME_OR_ID

Sounds you make yourself (e.g. downloaded from the ElevenLabs website) replace a generated one:

    python make_sounds.py --import ~/Downloads/Punch.mp3 hit_heavy        # replaces all hit_heavy variants
    python make_sounds.py --import ~/Downloads/Punch.mp3                  # pick the sound from a list
    python make_sounds.py --import ~/Downloads/Swing.mp3 punch_whoosh-2   # replace just version 2
    python make_sounds.py --import ~/Downloads/Punch2.mp3 hit_heavy --add # one more variant
    python make_sounds.py --import Punch.wav hit_heavy --as-is            # no trimming or leveling
    python make_sounds.py --imported                                      # list your imported sounds

To try new versions without touching the game's sounds:

    python make_sounds.py --audition 4 hit_light block   # 4 of each into Sounds/audition/
    python make_sounds.py --import Sounds/audition/hit_light-3.wav hit_light --as-is   # keep one

An import trims leading/trailing silence and levels the peak to -1 dBFS like the generated
sounds, and is written as Sounds/<name>.wav. The files it replaces are moved to
Sounds/raw/replaced/. Imported names are recorded in Sounds/imported.json. A sound you have
imported any version of is yours: none of its versions are regenerated, reprocessed or added to,
unless you name it with --force, which asks you to confirm and moves your files aside (never
deletes them). Use --dry-run to see what a run would do first. Version 1 of a sound is <name>.wav, version
k is <name>-k.wav.

Raw API audio is cached in Sounds/raw/, so processing can be retuned without new credits.
Frequent sounds get several variants (Sounds/hit_light.wav, hit_light-2.wav, ...); the game
picks one at random each time. An effect the game asks for without a file is silent.

Needs ELEVENLABS_API_KEY, from the environment or elevenlabs_key.txt.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from math import gcd
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, lfilter, resample_poly

ROOT = Path(__file__).resolve().parent
SOUND_DIR = ROOT / "Sounds"
RAW_DIR = SOUND_DIR / "raw"
CHAR_BUILD = ROOT / "build" / "characters"
IMPORTED_FILE = SOUND_DIR / "imported.json"   # effect name -> {"files": [...], "sources": [...]}
AUDITION_DIR = SOUND_DIR / "audition"
PROMPTS_FILE = RAW_DIR / "prompts.json"     # raw stem -> the prompt its cached audio was made from
REPLACED_DIR = RAW_DIR / "replaced"           # earlier versions moved aside by an import
AUDIO_EXTS = {".mp3", ".ogg", ".m4a", ".wav", ".aac", ".flac", ".aif", ".aiff"}
KEY_FILE = ROOT / "elevenlabs_key.txt"
if not os.environ.get("ELEVENLABS_API_KEY") and KEY_FILE.exists():
    os.environ["ELEVENLABS_API_KEY"] = KEY_FILE.read_text().strip()

API = "https://api.elevenlabs.io/v1"
RAW_RATE = 32000                     # the SNES DSP's output rate; ElevenLabs offers pcm_32000
MODERN_RATE = 44100                  # fight sounds: full bandwidth
SFX_MODEL = "eleven_text_to_sound_v3"
TTS_MODEL = "eleven_multilingual_v2"
SFX_CREDITS_PER_SECOND = 40          # with duration_seconds set (ElevenLabs docs, Nov 2026)
SFX_MIN_SECONDS = 0.5                # API minimum; trimming removes the extra tail
# Used when the key can't list voices (no voices_read permission): ElevenLabs' premade "Brian".
DEFAULT_VOICE = {"voice_id": "nPczCjzI2devNBz1zQrb", "name": "Brian"}

STYLE = "one-shot sound effect for a 1990s 16-bit arcade fighting game like Street Fighter II, dry, no music"
MODERN_STYLE = ("one-shot sound effect for a modern AAA fighting game like Street Fighter 6 or Tekken 8: "
                "high fidelity, crisp, punchy, layered, hard-hitting, clean studio quality, dry, no music, no voice")

# name: prompt, seconds, variants, processing: plain=True -> the prompt is sent as written (the way
# the ElevenLabs website is used) and the result only trimmed and leveled (clean); modern=True ->
# polish (stereo, 44.1 kHz, our bass/room/limiter); else snesify.
PLAIN = dict(modern=True, plain=True)
WHOOSH = dict(modern=True)
HIT = dict(modern=True, bass=2, room=(0.25, 0.06))
HEAVY = dict(modern=True, bass=3, room=(0.5, 0.1))
BIG = dict(modern=True, bass=3, room=(1.0, 0.15))
BELL = dict(rate=22050, bits=12, drive=0.0, echo=(0.12, 0.3, 0.2))
JINGLE = dict(rate=22050, bits=12, drive=0.0, max_seconds=2.0)
UI = dict(rate=22050, bits=12, drive=0.0, max_seconds=0.4)
EFFECTS = {
    # Fight sounds: short plain prompts in the style that worked on the ElevenLabs website.
    "punch_whoosh": ("A fast punch swing whoosh sound effect for a modern day fighting game", 1.0, 3, PLAIN),
    "kick_whoosh": ("A powerful kick swing whoosh sound effect for a modern day fighting game", 1.0, 3, PLAIN),
    "hit_light": ("A loud epic sounding punch sound effect for a modern day fighting game", 1.0, 3, PLAIN),
    "hit_heavy": ("A loud epic sounding heavy kick hit sound effect for a modern day fighting game",
                  1.0, 3, PLAIN),
    "block": ("A loud epic sounding blocked punch sound effect for a modern day fighting game", 1.0, 2, PLAIN),
    "land": ("a fighter landing on the ground, solid two-foot impact thud with a little grit", 0.5, 1, HIT),
    # Every special move announces itself with this: big on purpose.
    "special": ("an extravagant super-move activation: a whooshing rush of wind sucked in, a rising "
                "crackling energy charge, then a massive explosive release with thunder, shimmering "
                "magical sparkles and a deep cinematic boom", 2.5, 2, dict(BIG, max_seconds=3.5)),
    "throw": ("a heavy metal box thrown spinning through the air, powerful whoosh", 0.8, 1, WHOOSH),
    "slam": ("a heavy metal computer server crashing down onto someone, huge metallic impact with debris",
             1.2, 1, BIG),
    "dizzy": ("cartoon dizziness, little stars twinkling and birds chirping around a head", 1.2, 1,
              dict(rate=16000, bits=10, drive=0.0)),
    "ko": ("a final knockout blow, massive cinematic slow-motion impact with a deep boom, then a body "
           "hitting the floor", 2.0, 1, BIG),
    # Jingles and interface sounds (also called by the game; see static/game.js)
    "round": ("a single boxing ring bell ding at the start of a round", 1.0, 1, BELL),
    "fight": ("a short heroic 16-bit synth brass fanfare stab, four rising notes", 0.8, 1, JINGLE),
    "tick": ("a clear loud electronic countdown beep, one short high-pitched tone", 0.5, 1, UI),
    "time_up": ("a short 16-bit buzzer jingle, three descending notes, time is up", 1.0, 1, JINGLE),
    "win": ("a short triumphant 16-bit victory jingle, rising arpeggio ending on a held note", 1.5, 1, JINGLE),
    "lose": ("a short sad 16-bit defeat jingle, three slow descending notes", 1.5, 1, JINGLE),
    "ready": ("a bright two-note 16-bit power-up chime", 0.5, 1, UI),
    "pause": ("a short 16-bit game pause blip", 0.5, 1, UI),
    "menu_move": ("a clear short video game menu selection beep, one bright square-wave tone", 0.5, 1, UI),
    "menu_select": ("a short bright 16-bit menu confirm chime, two rising notes", 0.5, 1, UI),
}

# What each effect is, for the --import menu.
HINTS = {
    "punch_whoosh": "punch swing (before it lands)",
    "kick_whoosh": "kick swing (before it lands)",
    "hit_light": "a punch landing",
    "hit_heavy": "a kick or heavy hit landing",
    "block": "an attack blocked",
    "land": "landing from a jump",
    "special": "a special move starting",
    "throw": "something thrown",
    "slam": "something slammed down on a fighter",
    "dizzy": "fighter stunned",
    "ko": "knockout blow",
    "round": "round start bell",
    "fight": "fight start stinger",
    "tick": "last-seconds countdown beep",
    "time_up": "time runs out",
    "win": "you win jingle",
    "lose": "you lose jingle",
    "ready": "fighters ready",
    "pause": "game paused",
    "menu_move": "menu cursor move",
    "menu_select": "menu choice confirmed",
}

ANNOUNCER = dict(rate=16000, bits=10, drive=0.5, echo=(0.12, 0.35, 0.3))
VOICE_LINES = {
    "vo_round_1": "Round one!",
    "vo_round_2": "Round two!",
    "vo_round_3": "Round three!",
    "vo_round_4": "Round four!",
    "vo_final_round": "Final round!",
    "vo_fight": "FIGHT!",
    "vo_ko": "K.O.!",
    "vo_time": "Time!",
    "vo_perfect": "Perfect!",
    "vo_you_win": "You win!",
    "vo_you_lose": "You lose!",
    "vo_draw": "Draw game!",
    # Read plainly, then the opening syllable is repeated like an arcade sampler: "co-co-co-COMBO".
    "vo_combo_breaker": "COMBO BREAKER!!!",
}
# Per-line processing beyond ANNOUNCER: a longer cut-off, and stutter = (syllable seconds, repeats).
VOICE_PROC = {"vo_combo_breaker": dict(max_seconds=3.5, stutter=(0.13, 3))}
# Announcer delivery: low stability and high style make it shouty and dramatic.
VOICE_SETTINGS = dict(stability=0.3, similarity_boost=0.8, style=0.7, use_speaker_boost=True)


def log(msg):
    print(msg, flush=True)


def rel(path):
    return path.relative_to(ROOT) if path.is_relative_to(ROOT) else path


# --------------------------------------------------------------------------- ElevenLabs

def api(path, body=None, query=""):
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("Set ELEVENLABS_API_KEY or put the key in elevenlabs_key.txt")
    req = urllib.request.Request(f"{API}{path}{'?' + query if query else ''}",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"xi-api-key": key, "Content-Type": "application/json"},
                                 method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read(), r.headers
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        if e.code == 401 and "missing_permissions" in detail:
            raise PermissionError(detail) from None
        if e.code == 401:
            sys.exit(f"ElevenLabs rejected the API key (401): {detail}")
        raise RuntimeError(f"ElevenLabs {e.code}: {detail}") from None


def pcm_to_float(data):
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768


def generate_sfx(prompt, seconds, modern=False, plain=False):
    """(audio, rate, credits): stereo (n, 2) at MODERN_RATE when modern, else mono at RAW_RATE.
    plain sends the prompt as written with the website's default prompt influence."""
    seconds = max(seconds, SFX_MIN_SECONDS)
    rate = MODERN_RATE if modern else RAW_RATE
    text = prompt if plain else f"{prompt}. {MODERN_STYLE if modern else STYLE}"
    data, _ = api("/sound-generation", dict(text=text, duration_seconds=seconds,
                                             prompt_influence=0.3 if plain else 0.6, model_id=SFX_MODEL),
                  query=f"output_format=pcm_{rate}")
    audio = pcm_to_float(data)
    # Sound effects come back as interleaved stereo PCM (twice the samples of the duration);
    # read as mono they'd play at half speed, an octave low. Text to speech is mono.
    if len(audio) > 1.5 * seconds * rate:
        audio = audio[:len(audio) // 2 * 2].reshape(-1, 2)
        if not modern:
            audio = audio.mean(axis=1)
    return audio, rate, round(seconds * SFX_CREDITS_PER_SECOND)


def generate_speech(text, voice_id):
    data, headers = api(f"/text-to-speech/{voice_id}", dict(text=text, model_id=TTS_MODEL,
                                                             voice_settings=VOICE_SETTINGS),
                        query=f"output_format=pcm_{RAW_RATE}")
    cost = headers.get("character-cost") or headers.get("x-character-count") or len(text)
    return pcm_to_float(data), int(cost)


def list_voices():
    data, _ = api("/voices")
    return json.loads(data)["voices"]


def pick_voice(choice):
    """--voice NAME_OR_ID, else the last voice used, else a deep male premade voice."""
    remembered = RAW_DIR / "voice.json"
    try:
        voices = list_voices()
    except PermissionError:
        if choice:
            return {"voice_id": choice, "name": choice}  # can't look names up; treat it as an id
        log(f"  (key can't list voices; using {DEFAULT_VOICE['name']}. Pass --voice VOICE_ID for another)")
        return json.loads(remembered.read_text()) if remembered.exists() else DEFAULT_VOICE
    if choice:
        for v in voices:
            if choice in (v["voice_id"], v["name"]) or v["name"].lower().startswith(choice.lower()):
                break
        else:
            sys.exit(f"No voice matching {choice!r}; see --list-voices")
    elif remembered.exists():
        return json.loads(remembered.read_text())
    else:
        def score(v):
            text = " ".join([v.get("description") or "", *map(str, (v.get("labels") or {}).values())]).lower()
            return (("male" in text and "female" not in text) * 2
                    + sum(w in text for w in ("deep", "intense", "strong", "authoritative", "announcer", "narrat"))
                    + (v.get("category") == "premade"))
        v = max(voices, key=score)
    chosen = {"voice_id": v["voice_id"], "name": v["name"]}
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    remembered.write_text(json.dumps(chosen) + "\n")
    return chosen


# --------------------------------------------------------------------------- SNES processing

def trim(x, sr, floor_db):
    """Cut leading and trailing audio quieter than floor_db below the peak (mono or (n, ch))."""
    level = np.abs(x) if x.ndim == 1 else np.abs(x).max(axis=1)
    peak = level.max()
    if peak < 1e-4:
        raise ValueError("silent audio")
    loud = np.nonzero(level > peak * 10 ** (floor_db / 20))[0]
    return x[max(0, loud[0] - int(0.004 * sr)): loud[-1] + int(0.03 * sr)]


def fade(y, rate):
    fade_in, fade_out = int(0.001 * rate), int(0.02 * rate)
    y[:fade_in] *= np.linspace(0, 1, fade_in)[:, None] if y.ndim > 1 else np.linspace(0, 1, fade_in)
    y[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None] if y.ndim > 1 else np.linspace(1, 0, fade_out)
    return y


def polish(x, sr, bass=0, room=None, max_seconds=3.0):
    """Modern fight-game finish for stereo (n, 2) audio at full rate: trimmed, rumble cut,
    optionally bass-boosted below ~150 Hz by `bass` dB, a touch of stereo room
    (room=(seconds, mix)), width capped, gently limited and normalized to -1 dBFS.
    Returns int16 (n, 2)."""
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    y = trim(x, sr, -50)
    hb, ha = butter(2, 30 / (sr / 2), "high")
    y = lfilter(hb, ha, y, axis=0)
    if bass:
        lb, la = butter(2, 150 / (sr / 2))
        y = y + (10 ** (bass / 20) - 1) * lfilter(lb, la, y, axis=0)
    if room:
        length, mix = room
        n = int(length * sr)
        rng = np.random.default_rng(0)
        env = np.exp(-6.9 * np.arange(n) / n)                     # -60 dB at the end
        rb, ra = butter(1, 6000 / (sr / 2))
        tail = np.stack([np.convolve(y[:, c], lfilter(rb, ra, rng.standard_normal(n) * env))
                         for c in range(2)], axis=1)               # a different IR per side: width
        y = np.concatenate([y, np.zeros((n - 1, 2))]) + tail / np.abs(tail).max() * mix * np.abs(y).max()
    mid, side = (y[:, 0] + y[:, 1]) / 2, (y[:, 0] - y[:, 1]) / 2
    rms = lambda v: np.sqrt(np.mean(v ** 2)) + 1e-9
    side *= min(1.0, 0.5 * rms(mid) / rms(side))                   # tame phasey width; keeps it mono-safe
    y = np.stack([mid + side, mid - side], axis=1)
    y = y / np.abs(y).max()
    y = np.tanh(y * 1.6) / np.tanh(1.6)                           # soft limiter: more punch, no clipping
    y = fade(y[:int(max_seconds * sr)], sr)
    return (y / np.abs(y).max() * 0.89 * 32767).astype(np.int16)


def clean(x, sr, max_seconds=3.0):
    """Light finish that keeps ElevenLabs' own sound: trimmed, faded, peak at -1 dBFS, stereo int16."""
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    y = fade(trim(x, sr, -50)[:int(max_seconds * sr)].astype(np.float64), sr)
    return (y / np.abs(y).max() * 0.89 * 32767).astype(np.int16)


def process(x, sr, proc):
    """(int16 audio, rate) for raw audio x at sr, per an effect's processing settings."""
    if proc.get("plain"):
        return clean(x, sr, proc.get("max_seconds", 3.0)), sr
    if proc.get("modern"):
        return polish(x, sr, **{k: v for k, v in proc.items() if k != "modern"}), sr
    return snesify(x, **proc), proc.get("rate", 16000)


def snesify(x, rate=16000, bits=10, drive=0.3, echo=None, max_seconds=2.5, stutter=None):
    """Make clean audio sound like an SNES sample: trimmed, resampled down (the SNES ran most
    samples well under 32 kHz), muffled like its Gaussian interpolation, driven, optionally
    echoed like its echo unit, and quantized for BRR-style grit. Returns int16 at `rate`."""
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = trim(x, RAW_RATE, -40)
    if stutter:  # repeat the opening syllable, sampler style: "co-co-co-COMBO"
        seconds, repeats = stutter
        syl = x[:int(seconds * RAW_RATE)].copy()
        tail = int(0.015 * RAW_RATE)
        syl[-tail:] *= np.linspace(1, 0, tail)
        x = np.concatenate([syl] * repeats + [x])

    g = gcd(rate, RAW_RATE)
    y = resample_poly(x, rate // g, RAW_RATE // g)
    b, a = butter(2, 0.8)                               # gentle top-end roll-off (SNES muffle)
    y = lfilter(b, a, y)
    y /= np.abs(y).max()
    if drive:
        k = 1 + drive * 4
        y = np.tanh(y * k) / np.tanh(k)
    if echo:
        delay, feedback, mix = echo
        d = int(delay * rate)
        out = np.concatenate([y, np.zeros(d * 6)])
        tap = y.copy()
        lb, la = butter(1, 0.35)                        # each repeat is darker, like the SNES echo FIR
        for k in range(1, 7):  # first repeat at `mix`, each later one `feedback` quieter
            tap = lfilter(lb, la, tap) * feedback
            out[k * d:k * d + len(tap)] += tap * mix / feedback
        y = out
    y = fade(y[:int(max_seconds * rate)], rate)
    y = y / np.abs(y).max() * 0.95
    q = 2 ** (bits - 1)
    y = np.round(y * q) / q
    return (y * 32767).astype(np.int16)


# --------------------------------------------------------------------------- imports

def read_imported():
    try:
        return json.loads(IMPORTED_FILE.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def write_imported(data):
    if data:
        IMPORTED_FILE.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    elif IMPORTED_FILE.exists():
        IMPORTED_FILE.unlink()


def sound_files(name):
    """Files the game plays for effect `name`: <name>.<ext> and <name>-<n>.<ext>."""
    out = []
    for f in sorted(SOUND_DIR.iterdir()) if SOUND_DIR.exists() else []:
        if f.is_file() and f.suffix.lower() in AUDIO_EXTS:
            base, _, n = f.stem.rpartition("-")
            if f.stem == name or (base == name and n.isdigit()):
                out.append(f)
    return sorted(out, key=lambda f: (int(f.stem.rpartition("-")[2]) if f.stem != name else 1, f.name))


def move_aside(files):
    """Move files into a fresh Sounds/raw/replaced/<time>/ folder; returns that folder."""
    if not files:
        return None
    import time
    dest = REPLACED_DIR / time.strftime("%Y%m%d-%H%M%S")
    k = 1
    while dest.exists():
        k += 1
        dest = REPLACED_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{k}"
    dest.mkdir(parents=True)
    for f in files:
        f.rename(dest / f.name)
    return dest


def decode(path):
    """Any audio file -> (float32 samples (n,) or (n, ch), rate). WAV is read directly;
    anything else is converted with afconvert (macOS) or ffmpeg."""
    import shutil
    import subprocess
    import tempfile
    if path.suffix.lower() == ".wav":
        try:
            sr, data = wavfile.read(path)
            return to_float(data), sr
        except ValueError:
            pass  # a WAV flavour scipy can't read: convert it like the rest
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "decoded.wav"
        if shutil.which("afconvert"):
            cmd = ["afconvert", "-f", "WAVE", "-d", "LEI16", str(path), str(out)]
        elif shutil.which("ffmpeg"):
            cmd = ["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-c:a", "pcm_s16le", str(out)]
        else:
            sys.exit("can't decode that file: install ffmpeg, or convert it to .wav first")
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode or not out.exists():
            sys.exit(f"couldn't decode {path}: {(r.stderr or r.stdout).strip()}")
        import warnings
        with warnings.catch_warnings():  # afconvert adds a padding chunk scipy warns about
            warnings.simplefilter("ignore", wavfile.WavFileWarning)
            sr, data = wavfile.read(out)
        return to_float(data), sr


def to_float(data):
    if data.dtype.kind == "f":
        return data.astype(np.float32)
    if data.dtype == np.uint8:
        return (data.astype(np.float32) - 128) / 128
    return data.astype(np.float32) / np.iinfo(data.dtype).max


def level(x, sr):
    """Trim silence and level an imported sound like the generated ones: peak at -1 dBFS."""
    y = trim(x, sr, -50)
    if y.ndim > 1 and y.shape[1] > 2:
        y = y[:, :2]
    y = fade(y.astype(np.float64), sr)
    return (y / np.abs(y).max() * 0.89 * 32767).astype(np.int16)


def choose_sound(src):
    """Ask which sound `src` should replace, from a numbered list."""
    if not sys.stdin.isatty():
        sys.exit("say which sound to replace: make_sounds.py --import FILE NAME")
    imported = read_imported()
    choices = []
    for _, base, kind, prompt, *_ in jobs():
        if base not in (c[0] for c in choices):
            choices.append((base, HINTS.get(base, "") if kind == "sfx" else f'announcer: "{prompt}"'))
    log(f"Which sound should {Path(src).name} replace?")
    width = len(str(len(choices)))
    for i, (name, hint) in enumerate(choices, 1):
        n = len(sound_files(name))
        tags = (["yours"] if name in imported else []) + ([f"{n} versions"] if n > 1 else [])
        tags = f"  [{', '.join(tags)}]" if tags else ""
        log(f"  {i:>{width}}. {name:<20} {hint}{tags}")
    while True:
        try:
            answer = input(f"Number (1-{len(choices)}, Enter to cancel): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            sys.exit("cancelled")
        if not answer:
            sys.exit("cancelled")
        if answer.isdigit() and 1 <= int(answer) <= len(choices):
            return choices[int(answer) - 1][0]
        if answer in (c[0] for c in choices):
            return answer
        log(f"  type a number from 1 to {len(choices)}")


def choose_version(name):
    """For a sound with several versions (or slots for them): (slot or None for all, add?)."""
    files = sound_files(name)
    slots = max(len(files), EFFECTS[name][2] if name in EFFECTS else 1)
    if slots < 2:
        return None, False
    mine = set(read_imported().get(name, {"files": []})["files"])
    by_slot = {}
    for f in files:
        base, _, n = f.stem.rpartition("-")
        by_slot[int(n) if base == name and n.isdigit() else 1] = f
    slots = max([slots, *by_slot])
    log(f"{name} has {len(files)} of {slots} versions (the game picks one at random):")
    for k in range(1, slots + 1):
        f = by_slot.get(k)
        label = (f.name + ("  [yours]" if f.name in mine else "")) if f else f"{version_stem(name, k)}.wav  (empty)"
        log(f"  {k}. {label}")
    while True:
        try:
            answer = input("Which version should it be? Number, a = replace all of them, + = add another "
                           "(Enter = all): ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            sys.exit("cancelled")
        if answer in ("", "a", "all"):
            return None, False
        if answer == "+":
            return None, True
        if answer.isdigit() and int(answer) >= 1:
            return int(answer), False
        log("  type a version number, a or +")


def version_stem(name, k):
    return name if k == 1 else f"{name}-{k}"


def split_version(target):
    """'punch_whoosh-2' -> ('punch_whoosh', 2); a plain name -> (name, None)."""
    known = {base for _, base, *_ in jobs()}
    base, _, n = target.rpartition("-")
    if target not in known and base in known and n.isdigit() and int(n) >= 1:
        return base, int(n)
    return target, None


def import_sound(src, name, add=False, as_is=False, slot=None):
    src = Path(src).expanduser()
    if not src.is_file():
        sys.exit(f"no such file: {src}")
    known = {base for _, base, *_ in jobs()}
    if name not in known:
        hint = ""
        if "punch" in name.lower() or "kick" in name.lower() or "hit" in name.lower():
            hint = ("\n(a punch is two sounds: punch_whoosh for the swing, hit_light / hit_heavy "
                    "for the impact; kicks use kick_whoosh)")
        sys.exit(f"unknown sound name: {name}{hint}\nknown: {', '.join(sorted(known))}")

    if as_is:
        x, sr = decode(src)
        if np.abs(x).max() < 1e-4:
            sys.exit(f"{src.name} is silent")
        processed = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    else:
        x, sr = decode(src)
        try:
            processed = level(x, sr)
        except ValueError:
            sys.exit(f"{src.name} is silent")
    seconds = len(processed) / sr

    imported = read_imported()
    entry = imported.get(name, {"files": [], "sources": []})
    existing = sound_files(name)
    if add:
        names = {f.stem for f in existing}
        k = 1
        while (name if k == 1 else f"{name}-{k}") in names:
            k += 1
        stem = name if k == 1 else f"{name}-{k}"
        # Generated variants alongside your own would play at random with them; move them aside.
        generated = [f for f in existing if f.name not in entry["files"]]
        moved = move_aside(generated)
        if moved:
            entry = {"files": [], "sources": []}
            stem = name
            log(f"moved the generated {name} sounds to {rel(moved)}/")
    elif slot:
        stem = version_stem(name, slot)
        old = [f for f in existing if f.stem == stem]
        moved = move_aside(old)
        if moved:
            log(f"moved the earlier version {slot} ({', '.join(f.name for f in old)}) to {rel(moved)}/")
        keep = [(f, s) for f, s in zip(entry["files"], entry["sources"]) if Path(f).stem != stem]
        entry = {"files": [f for f, _ in keep], "sources": [s for _, s in keep]}
    else:
        moved = move_aside(existing)
        if moved:
            log(f"moved {len(existing)} earlier {name} file(s) to {rel(moved)}/")
        entry = {"files": [], "sources": []}
        stem = name

    out = SOUND_DIR / f"{stem}.wav"
    wavfile.write(out, sr, processed)
    entry["files"].append(out.name)
    entry["sources"].append(str(src))
    imported[name] = entry
    write_imported(imported)
    ch = "stereo" if processed.ndim > 1 and processed.shape[1] > 1 else "mono"
    log(f"wrote {rel(out)} ({seconds:.2f}s, {ch}, {sr} Hz{', as is' if as_is else ', trimmed and leveled'})")
    now = sound_files(name)
    if len(now) > 1:
        mine = set(entry["files"])
        log(f"{name} now has {len(now)} versions, picked at random: "
            + ", ".join(f.name + (" (yours)" if f.name in mine else "") for f in now))
    if seconds > 3 and not name.startswith("vo_") and name not in ("win", "lose"):
        log(f"note: {seconds:.1f}s is long for a game sound; trim it if it drags")
    log("reload the game page to hear it (no server restart needed)")


def read_prompts():
    try:
        return json.loads(PROMPTS_FILE.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def write_prompts(data):
    PROMPTS_FILE.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def audition(names, count):
    """Make `count` fresh versions of each named effect in Sounds/audition/<name>-<k>.wav,
    processed like the real thing; the game's sounds and the raw cache are left alone."""
    if not names:
        sys.exit("name the sounds to audition, e.g. make_sounds.py --audition 4 hit_light block")
    unknown = [n for n in names if n not in EFFECTS]
    if unknown:
        sys.exit(f"--audition is for sound effects; unknown: {', '.join(unknown)}")
    total = sum(round(max(EFFECTS[n][1], SFX_MIN_SECONDS) * SFX_CREDITS_PER_SECOND) * count for n in names)
    log(f"auditioning {count} version(s) of {', '.join(names)} (~{total} credits)")
    raw_dir = AUDITION_DIR / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    credits = 0
    for name in names:
        prompt, seconds, _, proc = EFFECTS[name]
        for k in range(1, count + 1):
            stem = f"{name}-{k}"
            try:
                audio, rate, cost = generate_sfx(prompt, seconds, proc.get("modern", False), proc.get("plain", False))
            except (RuntimeError, PermissionError) as e:
                log(f"  {stem}: failed: {e}")
                continue
            credits += cost
            wavfile.write(raw_dir / f"{stem}.wav", rate, (audio * 32767).astype(np.int16))
            try:
                processed, out_rate = process(audio.astype(np.float32), rate, proc)
            except ValueError as e:
                log(f"  {stem}: {e}")
                continue
            wavfile.write(AUDITION_DIR / f"{stem}.wav", out_rate, processed)
            log(f"  wrote {rel(AUDITION_DIR / stem)}.wav")
    log(f"ElevenLabs usage: ~{credits} credits")
    log("keep one with: make_sounds.py --import Sounds/audition/<name>-<k>.wav <name> --as-is"
        "  (--add for another version)")


# --------------------------------------------------------------------------- main

def character_lines():
    lines = {}
    for f in sorted(CHAR_BUILD.glob("*/character.json")) if CHAR_BUILD.exists() else []:
        c = json.loads(f.read_text())
        lines[f"vo_win_{c['slug']}"] = f"{c['name']} wins!"
    return lines


def jobs():
    """(output stem, kind, prompt or text, seconds, processing) for every file to make."""
    out = []
    for name, (prompt, seconds, variants, proc) in EFFECTS.items():
        for k in range(1, variants + 1):
            out.append((name if k == 1 else f"{name}-{k}", name, "sfx", prompt, seconds, proc))
    for name, text in {**VOICE_LINES, **character_lines()}.items():
        out.append((name, name, "voice", text, None, dict(ANNOUNCER, **VOICE_PROC.get(name, {}))))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*", help="effect or voice line names to (re)generate, e.g. hit_heavy vo_ko")
    ap.add_argument("--process-only", action="store_true", help="re-process cached raw audio; no API calls")
    ap.add_argument("--voice", help="announcer voice name or id (remembered for later runs)")
    ap.add_argument("--list-voices", action="store_true")
    ap.add_argument("--import", dest="import_file", metavar="FILE",
                    help="use your own audio file for the one sound named after it (see above)")
    ap.add_argument("--add", action="store_true", help="with --import: add a variant instead of replacing")
    ap.add_argument("--as-is", action="store_true", help="with --import: no trimming or leveling")
    ap.add_argument("--audition", type=int, metavar="N",
                    help="make N versions of each named sound in Sounds/audition/ (the game's are untouched)")
    ap.add_argument("--imported", action="store_true", help="list sounds you have imported")
    ap.add_argument("--force", action="store_true",
                    help="regenerate named sounds even if you imported them (asks first; your files are moved aside)")
    ap.add_argument("--yes", action="store_true", help="with --force: don't ask for confirmation")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would be generated or rewritten, without changing anything or spending credits")
    args = ap.parse_args()

    if args.imported:
        imported = read_imported()
        if not imported:
            log("no imported sounds")
        for name, e in sorted(imported.items()):
            log(f"{name:<16} {', '.join(e['files'])}  <- {', '.join(Path(s).name for s in e['sources'])}")
        return
    if args.import_file:
        if len(args.names) > 1:
            sys.exit("usage: make_sounds.py --import FILE [NAME]  (e.g. --import ~/Downloads/Punch.mp3 hit_heavy)")
        if not Path(args.import_file).expanduser().is_file():
            sys.exit(f"no such file: {args.import_file}")
        if args.names:
            name, slot = split_version(args.names[0])
            add = args.add
        else:
            name, slot = choose_sound(args.import_file), None
            add = args.add
            if not add:
                slot, add = choose_version(name)
        if slot and add:
            sys.exit("give either a version (name-2) or --add, not both")
        import_sound(args.import_file, name, add=add, as_is=args.as_is, slot=slot)
        return

    if args.list_voices:
        for v in list_voices():
            labels = ", ".join(f"{k}: {val}" for k, val in (v.get("labels") or {}).items())
            log(f"{v['name']:<24} {v['voice_id']}  {labels}")
        return

    all_jobs = jobs()
    if args.audition:
        audition(args.names, args.audition)
        return
    known = {base for _, base, *_ in all_jobs}
    unknown = [n for n in args.names if n not in known]
    if unknown:
        sys.exit(f"unknown names: {', '.join(unknown)}\nknown: {', '.join(sorted(known))}")
    selected = [j for j in all_jobs if not args.names or j[1] in args.names]
    imported = read_imported()
    # A sound you imported any version of is yours: none of its versions are generated,
    # reprocessed or added to, unless you name it with --force (and confirm).
    forced = [n for n in args.names if n in imported] if args.force else []
    if forced:
        files = [f for n in forced for f in sound_files(n)]
        log("--force replaces your own sounds with generated ones:")
        for n in forced:
            log(f"  {n}: {', '.join(f.name for f in sound_files(n)) or '(no files)'}")
        log("  (they are moved to Sounds/raw/replaced/, not deleted)")
        if args.dry_run:
            log("dry run: nothing changed")
            return
        if not args.yes:
            if not sys.stdin.isatty():
                sys.exit("add --yes to confirm")
            try:
                ok = input("Type yes to go ahead: ").strip().lower() == "yes"
            except (EOFError, KeyboardInterrupt):
                ok = False
            if not ok:
                sys.exit("cancelled; nothing changed")
        moved = move_aside(files)
        for n in forced:
            imported.pop(n)
        write_imported(imported)
        log(f"moved your files to {rel(moved)}/" if moved else "no files to move")
    kept = sorted({j[1] for j in selected if j[1] in imported})
    if kept:
        log(f"keeping your own sounds: {', '.join(kept)}"
            + (" (name them with --force to replace them with generated ones)" if args.names else ""))
        selected = [j for j in selected if j[1] not in imported]

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    voice = None
    credits = 0
    prompts = read_prompts()
    stale = []
    for stem, base, kind, prompt, seconds, proc in selected:
        raw, out = RAW_DIR / f"{stem}.wav", SOUND_DIR / f"{stem}.wav"
        if raw.exists() and not args.names and prompts.get(stem, prompt) != prompt:
            stale.append(base)   # made from an older prompt: don't reprocess it with new settings
            continue
        if args.dry_run:
            if not args.process_only and (args.names or not raw.exists()):
                cost = round(max(seconds or 0, SFX_MIN_SECONDS) * SFX_CREDITS_PER_SECOND) if kind == "sfx" else 0
                credits += cost
                log(f"  {stem}: would generate{f' (~{cost} credits)' if cost else ''} and write {rel(out)}")
            elif raw.exists():
                log(f"  {stem}: would rewrite {rel(out)} from cached audio")
            continue
        if not args.process_only and (args.names or not raw.exists()):
            audio = None
            for attempt in range(2):  # the API occasionally returns silence; ask once more
                try:
                    if kind == "sfx":
                        log(f"  {stem}: generating ({seconds}s)")
                        audio, rate, cost = generate_sfx(prompt, seconds, proc.get("modern", False),
                                                         proc.get("plain", False))
                    else:
                        voice = voice or pick_voice(args.voice)
                        log(f"  {stem}: \"{prompt}\" in {voice['name']}'s voice")
                        audio, cost = generate_speech(prompt, voice["voice_id"])
                        rate = RAW_RATE
                except (RuntimeError, PermissionError) as e:
                    log(f"  {stem}: failed: {e}")
                    break
                credits += cost
                log(f"    ~{cost} credits")
                if np.abs(audio).max() > 1e-3:
                    break
                log("    came back silent")
                audio = None
            if audio is None:
                continue
            wavfile.write(raw, rate, (audio * 32767).astype(np.int16))
            prompts[stem] = prompt
            write_prompts(prompts)
        if not raw.exists():
            continue
        sr, data = wavfile.read(raw)
        try:
            x = data.astype(np.float32) / 32768
            processed, rate = process(x, sr, proc)
        except ValueError as e:  # e.g. a silent result cached by an older run: regenerate next time
            log(f"  {stem}: {e}; removed the cached raw audio")
            raw.unlink()
            continue
        wavfile.write(out, rate, processed)
        log(f"  {stem}: wrote {rel(out)}")
    if stale:
        log(f"left as they are (their prompt changed since the cached audio was made): "
            f"{', '.join(sorted(set(stale)))}\n  regenerate with: make_sounds.py {' '.join(sorted(set(stale)))}"
            f"  (or try first with --audition)")
    if credits:
        log(f"ElevenLabs usage: ~{credits} credits" + (" (estimate; dry run, nothing spent)" if args.dry_run else ""))
    if args.dry_run:
        log("dry run: nothing changed")


if __name__ == "__main__":
    main()
