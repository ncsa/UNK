#!/bin/bash
# Load the game's API keys from their *_key.txt files and activate the venv.
# SOURCE this (don't execute it) so the exports + activation affect your shell:
#
#     source setup.sh
#     ./server.py
#
# Keys live only in the *_key.txt files (the single source of truth the tools
# also read directly); nothing is hardcoded here.

# Directory of this script, so it works no matter where you source it from
# (BASH_SOURCE under bash, $0 under zsh).
_UNK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

_unk_load_key() {   # _unk_load_key VAR_NAME key_file.txt
  local var="$1" file="$_UNK_DIR/$2" value
  if [ -f "$file" ]; then
    value="$(tr -d '\r\n' < "$file")"
    export "$var=$value"
  else
    echo "setup.sh: $2 not found — $var not set" >&2
  fi
}

_unk_load_key GEMINI_API_KEY  gemini_key.txt
[ -f "$_UNK_DIR/elevenlabs_key.txt" ] && _unk_load_key ELEVENLABS_API_KEY elevenlabs_key.txt  # optional: make_sounds.py

unset -f _unk_load_key

# Create the venv on first use, then activate it.
if [ ! -f "$_UNK_DIR/.venv/bin/activate" ]; then
  echo "setup.sh: creating venv in .venv"
  python3 -m venv "$_UNK_DIR/.venv" && "$_UNK_DIR/.venv/bin/pip" install -q -r "$_UNK_DIR/requirements.txt"
fi
source "$_UNK_DIR/.venv/bin/activate"
echo "unk: keys loaded from *_key.txt, venv active ($(python --version 2>&1))"

unset _UNK_DIR
