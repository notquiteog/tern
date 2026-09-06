# Shell helpers shared by install.sh, update.sh and bin/tern. Source after
# defining compose() (podman-compose with the right env file and COMPOSE_FILE).

# up -d for the whole stack. podman-compose 1.0.x tries to create every
# container even when it already exists, prints "name ... is already in use"
# and then simply starts it; and when the config changed it stops and removes
# every container first, complaining about ones we already removed. Hide
# those lines so real errors stand out. Callers verify the result themselves,
# since older podman-compose does not fail.
compose_up() {
  compose up -d --remove-orphans "$@" 2>&1 >/dev/null \
    | grep -Ev 'container name .* is already in use|no container with (name or ID|ID or name) .* found' || true
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

# Add KEY=VALUE to .env when the key is not there yet; leave any existing
# value alone. Used by update.sh for settings added after an install was made:
# podman-compose leaves `${KEY:-default}` untouched when KEY is absent from
# .env, and both Ollama and the app then read the placeholder as a value.
ensure_env() { # KEY VALUE
  grep -q "^$1=" .env 2>/dev/null && return 0
  printf '%s=%s\n' "$1" "$2" >> .env
  echo "    added $1=$2 to .env"
}

# CIDRs of the compose networks the stack's containers sit on, one per line.
# Used to tell Stalwart which addresses are our own proxies. Empty when the
# stack is not running or podman cannot describe the network.
stack_subnets() {
  local id nets n
  id="$(podman ps -a --format '{{.ID}}\t{{.Image}}' | awk -F'\t' '$2 == "localhost/tern:latest" { print $1; exit }')"
  [ -n "$id" ] || return 0
  nets="$(podman inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$id" 2>/dev/null || true)"
  for n in $nets; do podman network inspect --format '{{range .Subnets}}{{.Subnet}} {{end}}' "$n" 2>/dev/null || true; done | tr ' ' '\n' | grep -v '^$' | sort -u
}

# ---- Caddyfile from the templates ----
# Substitutes ${VAR} for a known list of variables, nothing else. Reads
# ACME_EMAIL SITE_ADDRESS WEB_HOST STALWART_ENABLED STALWART_HOST
# STALWART_DOMAIN and INSTALL_DIR from the environment (.env has them).
render_template() {
  local content; content="$(cat "$1")"
  local v
  for v in ACME_EMAIL SITE_ADDRESS CADDY_GLOBAL ASK_SITE WEB_DISCOVERY STALWART_SITE STALWART_HOST STALWART_DOMAIN INSTALL_DIR; do
    content="${content//\$\{$v\}/${!v:-}}"
  done
  printf '%s\n' "$content"
}
# Writes deploy/generated/Caddyfile. Returns 0 when the file changed, 1 when it is the same as before.
write_caddyfile() {
  local dir="${INSTALL_DIR:-$ROOT}" out n
  CADDY_GLOBAL=""; ASK_SITE=""; WEB_DISCOVERY=""
  [ -z "${WEB_HOST:-}" ] && CADDY_GLOBAL="auto_https off"
  # Extra names for the mail domain (MTA-STS policy, client autoconfig) get
  # certificates on demand, and Caddy asks before issuing one so that a name
  # pointed here by someone else cannot mint certificates on this install.
  # The list of names is fixed at install time, so Caddy answers the question
  # itself on a container-local port: asking the app instead would take
  # MTA-STS and mail-app autoconfig down with it every time the app restarts.
  if [ "${STALWART_ENABLED:-0}" = 1 ]; then
    CADDY_GLOBAL="on_demand_tls {
		ask http://127.0.0.1:9099
	}"
    local names=""
    for n in "${WEB_HOST:-}" "${STALWART_HOST:-}"; do [ -n "$n" ] && names="$names domain=$n"; done
    for n in mta-sts autoconfig autodiscover ua-auto-config; do [ -n "${STALWART_DOMAIN:-}" ] && names="$names domain=$n.$STALWART_DOMAIN"; done
    ASK_SITE="
# Caddy's own answer to \"may this name have a certificate?\", bound to the
# loopback inside the container and reachable by nothing else.
http://127.0.0.1:9099 {
	@known query${names}
	handle @known {
		respond 200
	}
	handle {
		respond 404
	}
}
"
    # A mail app pointed at the web address rather than the mail host still
    # finds the server: the JMAP session, Thunderbird autoconfig and Outlook
    # autodiscover paths are redirected there instead of being answered with
    # the web app's HTML, which no mail client can parse.
    if [ -n "${STALWART_HOST:-}" ]; then WEB_DISCOVERY="@maildiscovery path /.well-known/jmap /jmap /jmap/* /.well-known/autoconfig/* /mail/config-v1.1.xml
	redir @maildiscovery https://$STALWART_HOST{uri} 308
	@autodiscover path_regexp (?i)^/autodiscover/
	redir @autodiscover https://$STALWART_HOST{uri} 308
"; fi
  fi
  STALWART_SITE=""
  if [ "${STALWART_ENABLED:-0}" = 1 ]; then STALWART_SITE="$(INSTALL_DIR="$dir" render_template "$dir/deploy/stalwart-site.tmpl")"; fi
  mkdir -p "$dir/deploy/generated"
  out="$(INSTALL_DIR="$dir" render_template "$dir/deploy/Caddyfile.tmpl")"
  if [ -f "$dir/deploy/generated/Caddyfile" ] && [ "$out" = "$(cat "$dir/deploy/generated/Caddyfile")" ]; then return 1; fi
  printf '%s\n' "$out" > "$dir/deploy/generated/Caddyfile"
  return 0
}
# Ask the running Caddy to pick up deploy/generated/Caddyfile (it is bind-mounted).
caddy_reload() {
  local cid
  cid="$(podman ps -q --filter label=com.docker.compose.service=caddy --filter "label=com.docker.compose.project.working_dir=${INSTALL_DIR:-$ROOT}" | head -1)"
  [ -n "$cid" ] || return 1
  podman exec "$cid" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
}

# Names of containers whose image moved on (what replace_stale_containers would remove), without removing anything.
replace_stale_containers_dryrun() {
  local id proj full image have want
  id="$(podman ps -a --format '{{.ID}}\t{{.Image}}' | awk -F'\t' '$2 == "localhost/tern:latest" { print $1; exit }')"
  [ -n "$id" ] || return 0
  proj="$(podman inspect --format '{{ index .Config.Labels "io.podman.compose.project" }}' "$id" 2>/dev/null || true)"
  [ -n "$proj" ] || return 0
  for full in $(podman ps -a -q --no-trunc --filter "label=io.podman.compose.project=$proj"); do
    image="$(podman inspect --format '{{.ImageName}}' "$full" 2>/dev/null || true)"
    have="$(podman inspect --format '{{.Image}}' "$full" 2>/dev/null || true)"
    want="$(podman image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"
    [ -n "$want" ] && [ "$want" != "$have" ] && podman inspect --format '{{.Name}}' "$full"
  done
  return 0
}
