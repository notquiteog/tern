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
# podman-compose (1.0.x and 1.x alike) leaves a container alone when its
# compose config is unchanged, even if its image was rebuilt or pulled, so
# `up` on its own would keep the old app running. Remove the containers of
# this project whose image has moved on; `up` then creates fresh ones.
replace_stale_containers() { # app-image -> prints the names it removed
  local app_image="$1" proj id name image have want full
  id="$(podman ps -a --format '{{.ID}}\t{{.Image}}' | awk -F'\t' -v img="$app_image" '$2 == img { print $1; exit }')"
  [ -n "$id" ] || return 0
  proj="$(podman inspect --format '{{ index .Config.Labels "io.podman.compose.project" }}' "$id" 2>/dev/null || true)"
  [ -n "$proj" ] || return 0
  local -A names=()
  while IFS=$'\t' read -r full name; do names["$full"]="$name"; done \
    < <(podman ps -a --no-trunc --filter "label=io.podman.compose.project=$proj" --format '{{.ID}}\t{{.Names}}')
  for full in "${!names[@]}"; do
    podman container exists "$full" 2>/dev/null || continue  # gone already, removed as a dependent
    image="$(podman inspect --format '{{.ImageName}}' "$full" 2>/dev/null || true)"
    have="$(podman inspect --format '{{.Image}}' "$full" 2>/dev/null || true)"
    want="$(podman image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"
    [ -n "$want" ] && [ "$want" != "$have" ] || continue
    # --depend also removes containers that depend on this one (app on db);
    # `up` recreates all of them.
    for id in $(podman rm -f --depend "$full" 2>/dev/null); do echo "${names[$id]:-$id}"; done
  done
}
REPLACED="$(replace_stale_containers localhost/tern:latest | tr '\n' ' ')"
[ -n "$REPLACED" ] && echo "    replacing (image changed): $REPLACED"
# podman-compose 1.0.x prints "name ... is already in use" for every existing
# container and then starts it; hide that line, the checks below are what count.
compose up -d --remove-orphans 2>&1 >/dev/null | grep -v 'container name .* is already in use' || true
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
if [ "${STALWART_ENABLED:-0}" = 1 ]; then ./bin/tern cert-sync || true; fi
echo "==> Pruning unused images"
podman image prune -f >/dev/null 2>&1 || true
echo "Done."
