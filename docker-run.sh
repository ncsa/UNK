#!/bin/bash
# Build and run the UNK Fighter container on http://localhost:8000.
#
#   ./docker-run.sh
#   UNK_PORT=9000 ./docker-run.sh
#
# users.csv (logins) and data/ (high scores) are mounted, not baked into the image.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
IMAGE="unk-fighter"
PORT="${UNK_PORT:-8000}"

echo "Building $IMAGE…"
docker build -t "$IMAGE" "$DIR"

mkdir -p "$DIR/data"
mounts=( -v "$DIR/data:/app/data" )
[ -f "$DIR/users.csv" ] && mounts+=( -v "$DIR/users.csv:/app/users.csv:ro" ) \
    || echo "WARNING: users.csv not found — logins will fail until you add one." >&2

echo "Running $IMAGE on http://localhost:$PORT …"
exec docker run --rm -it -p "$PORT:8000" "${mounts[@]}" "$IMAGE"
