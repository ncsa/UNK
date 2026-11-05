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
# The image serves the sprite sheets committed in build/characters (made on your machine by
# add_character.py), so building it only installs the server's few packages and copies files:
# no API keys, no image processing. Logins (users.csv) and the high-score database (data/) are
# mounted at runtime, so they survive rebuilds.

FROM python:3.13-slim

ENV UNK_HOST=0.0.0.0 \
    UNK_PORT=8000 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install Python deps first so they cache across code and content changes.
COPY requirements-server.txt .
RUN pip install -r requirements-server.txt

# Code + game content, including the built sheets. Secrets, scores, raw frames, asset tools
# and dev files never enter the build (.dockerignore).
COPY . .

EXPOSE 8000

# server.py binds UNK_HOST:UNK_PORT.
CMD ["python", "server.py"]
