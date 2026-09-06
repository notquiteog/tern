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
. "$ROOT/deploy/lib.sh"

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

# Settings added after this install was made. They have defaults in
# compose.yml, but podman-compose only substitutes `${KEY:-default}` when KEY
# exists, so an older .env leaves the placeholder itself in the environment.
echo "==> Checking .env for newer settings"
TOTAL_GIB_U="$(awk '/MemTotal/ { printf "%.1f", $2/1048576 }' /proc/meminfo 2>/dev/null || echo 4)"
if awk -v g="$TOTAL_GIB_U" 'BEGIN { exit !(g < 5) }'; then NP=2; elif awk -v g="$TOTAL_GIB_U" 'BEGIN { exit !(g < 9) }'; then NP=4; else NP=8; fi
ensure_env OLLAMA_NUM_PARALLEL "$NP"
ensure_env OLLAMA_KV_CACHE_TYPE q8_0
ensure_env OLLAMA_MAX_QUEUE 32
set -a; . ./.env; set +a

echo "==> Pulling base images"
compose pull --ignore-pull-failures 2>/dev/null || true
echo "==> Rebuilding the app image"
compose build app 2>&1 | grep -Ev '^(STEP|--> )' | tail -3 || true
echo "==> Restarting services"
REPLACED="$(replace_stale_containers localhost/tern:latest | tr '\n' ' ')"
[ -n "$REPLACED" ] && echo "    replacing (image changed): $REPLACED"
compose_up
for i in $(seq 1 60); do
  if compose exec -T app wget -qO- http://127.0.0.1:3080/healthz >/dev/null 2>&1; then echo "    app healthy (v$NEWV)"; break; fi
  sleep 2; [ "$i" = 60 ] && { echo "app did not come back; see ./bin/tern logs app" >&2; exit 1; }
done
for svc in $(compose config --services 2>/dev/null | grep -E '^[A-Za-z0-9_.-]+$'); do
  compose exec -T "$svc" true >/dev/null 2>&1 || { echo "the $svc container is not running; see ./bin/tern logs $svc" >&2; exit 1; }
done
if [ "${AI_ENABLED:-true}" = true ] && [ -n "${AI_MODEL:-}" ]; then
  if ! compose exec -T ollama ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$AI_MODEL\(:latest\)\?"; then
    echo "==> Pulling model $AI_MODEL"; compose exec -T ollama ollama pull "$AI_MODEL" || true
  fi
fi
if [ "${STALWART_ENABLED:-0}" = 1 ]; then ./bin/tern stalwart-trust-proxy || echo "    could not set up Stalwart's listener for Caddy; run ./bin/tern stalwart-trust-proxy" >&2; fi
echo "==> Caddy configuration"
export INSTALL_DIR="$ROOT"
if write_caddyfile; then
  if caddy_reload; then echo "    Caddyfile regenerated and Caddy reloaded"; else echo "    Caddyfile regenerated; restart Caddy with ./bin/tern restart caddy" >&2; fi
else echo "    unchanged"; fi
if [ "${STALWART_ENABLED:-0}" = 1 ]; then ./bin/tern cert-sync || true; fi
echo "==> Pruning unused images"
podman image prune -f >/dev/null 2>&1 || true
echo "Done."
