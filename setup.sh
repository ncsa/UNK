#!/bin/bash
# SOURCE this (don't execute it) so the exports and activation reach your shell:
#
#     source setup.sh
#     ./start.sh            # on the server
#     ./server.py           # or, on your own machine
#
# Always: the deployment settings for the HTTPS setup (start.sh / docker-compose.https.yml).
# Only where the API key files are (your own machine; they're kept out of git and the Docker
# image, so never on the server): load the keys and create/activate the Python venv for the
# asset tools. On the server nothing else is needed: the Docker image brings its own Python.

export UNK_HOSTNAME=docent.ncsa.illinois.edu
export ACME_EMAIL=mchenry@illinois.edu
echo "unk: UNK_HOSTNAME=$UNK_HOSTNAME ACME_EMAIL=$ACME_EMAIL"

# Directory of this script, so it works no matter where you source it from
# (BASH_SOURCE under bash, $0 under zsh).
_UNK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

if [ -f "$_UNK_DIR/gemini_key.txt" ] || [ -f "$_UNK_DIR/elevenlabs_key.txt" ]; then
  # Keys live only in the *_key.txt files (the tools also read them directly); nothing is
  # hardcoded here.
  [ -f "$_UNK_DIR/gemini_key.txt" ] && export GEMINI_API_KEY="$(tr -d '\r\n' < "$_UNK_DIR/gemini_key.txt")"
  [ -f "$_UNK_DIR/elevenlabs_key.txt" ] && export ELEVENLABS_API_KEY="$(tr -d '\r\n' < "$_UNK_DIR/elevenlabs_key.txt")"

  # Create the venv on first use, then activate it. A failure is reported, not fatal: this
  # file is sourced, so it must never exit your shell.
  if [ ! -f "$_UNK_DIR/.venv/bin/activate" ]; then
    echo "unk: creating the Python venv in .venv"
    python3 -m venv "$_UNK_DIR/.venv" && "$_UNK_DIR/.venv/bin/pip" install -q -r "$_UNK_DIR/requirements.txt" \
      || echo "unk: couldn't set up .venv; the game server and Docker don't need it" >&2
  fi
  if [ -f "$_UNK_DIR/.venv/bin/activate" ]; then
    source "$_UNK_DIR/.venv/bin/activate"
    echo "unk: keys loaded from *_key.txt, venv active ($(python --version 2>&1))"
  fi
fi

unset _UNK_DIR
