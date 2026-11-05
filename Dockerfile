# UNK Fighter game server, containerized.
#
#   docker build -t unk-fighter .
#   docker run --rm -p 8000:8000 \
#       -v "$PWD/users.csv:/app/users.csv:ro" \
#       -v "$PWD/data:/app/data" \
#       unk-fighter
#
# Or just use docker-run.sh, or docker compose (see DEPLOY.md).
#
# The sprite sheets are built here from the frames in Characters/ (stage 1), so a fresh
# clone builds with nothing installed on the host but Docker: no Python, no API keys.
# Logins (users.csv) and the high-score database (data/) are mounted at runtime, so they
# survive rebuilds. Gemini and ElevenLabs are only used by the asset tools on your machine.

# ---- Stage 1: build the sprite sheets (needs numpy/scipy; makes no API calls), then drop
# what the server doesn't use: raw frames and the asset tools.
FROM python:3.13-slim AS build
ENV PIP_NO_CACHE_DIR=1
WORKDIR /src
COPY requirements.txt requirements-server.txt ./
RUN pip install -r requirements.txt
COPY . .
RUN python add_character.py --all --stage sheet \
 && rm -rf Characters/*/frames add_character.py make_sounds.py requirements.txt check_gemini.py

# ---- Stage 2: the server image.
FROM python:3.13-slim

ENV UNK_HOST=0.0.0.0 \
    UNK_PORT=8000 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install Python deps first so they cache across code and content changes.
COPY requirements-server.txt .
RUN pip install -r requirements-server.txt

# Code + game content with freshly built sheets. Secrets, scores, local builds and dev
# files never enter the build (.dockerignore).
COPY --from=build /src/ ./

EXPOSE 8000

# server.py binds UNK_HOST:UNK_PORT.
CMD ["python", "server.py"]
