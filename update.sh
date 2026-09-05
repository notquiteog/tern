#!/usr/bin/env bash
# Update an existing Tern install: pull the latest code (if this is a git
# checkout), rebuild the app image, restart what changed, run migrations
# (the app applies them on start), refresh the mail host certificate, and
# prune old images. Safe to run repeatedly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
[ -f .env ] || { echo "No .env found; run ./install.sh first." >&2; exit 1; }
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null; then exec sudo -E "$0" "$@"; fi
set -a; . ./.env; set +a
export COMPOSE_FILE="${COMPOSE_FILE:-compose.yml}"
compose() { podman-compose --env-file "$ROOT/.env" "$@"; }

echo "==> Fetching code"
if [ -d .git ] && command -v git >/dev/null; then
  BEFORE="$(git rev-parse --short HEAD)"
  git pull --ff-only || { echo "git pull failed (local changes?). Resolve and re-run." >&2; exit 1; }
  AFTER="$(git rev-parse --short HEAD)"
  echo "    $BEFORE -> $AFTER"
else
  echo "    not a git checkout; using the code in place"
fi
NEWV="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
sed -i "s|^TERN_VERSION=.*|TERN_VERSION=$NEWV|" .env

echo "==> Pulling base images"
compose pull --ignore-pull-failures 2>/dev/null || true
echo "==> Rebuilding the app image"
compose build app 2>&1 | grep -Ev '^(STEP|--> )' | tail -3 || true
echo "==> Restarting services"
compose up -d --remove-orphans
for i in $(seq 1 60); do
  if compose exec -T app wget -qO- http://127.0.0.1:3080/healthz >/dev/null 2>&1; then echo "    app healthy (v$NEWV)"; break; fi
  sleep 2; [ "$i" = 60 ] && { echo "app did not come back; see ./bin/tern logs app" >&2; exit 1; }
done
if [ "${AI_ENABLED:-true}" = true ] && [ -n "${AI_MODEL:-}" ]; then
  if ! compose exec -T ollama ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$AI_MODEL\(:latest\)\?"; then
    echo "==> Pulling model $AI_MODEL"; compose exec -T ollama ollama pull "$AI_MODEL" || true
  fi
fi
if [ "${STALWART_ENABLED:-0}" = 1 ]; then ./bin/tern cert-sync || true; fi
echo "==> Pruning unused images"
podman image prune -f >/dev/null 2>&1 || true
echo "Done."
