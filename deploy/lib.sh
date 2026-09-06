# Shell helpers shared by install.sh, update.sh and bin/tern. Source after
# defining compose() (podman-compose with the right env file and COMPOSE_FILE).

# up -d for the whole stack. podman-compose 1.0.x tries to create every
# container even when it already exists, prints "name ... is already in use"
# and then simply starts it; hide that line so real errors stand out. Callers
# verify the result themselves, since older podman-compose does not fail.
compose_up() {
  compose up -d --remove-orphans "$@" 2>&1 >/dev/null | grep -v 'container name .* is already in use' || true
}

# podman-compose (1.0.x and 1.x alike) leaves a container alone when its
# compose config is unchanged, even if its image was rebuilt or pulled, so
# `up` on its own would keep the old app running. Remove the containers of
# this project whose image has moved on; `up` then creates fresh ones.
# Prints the names it removed. The project is found through the app image.
replace_stale_containers() { # app-image
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
