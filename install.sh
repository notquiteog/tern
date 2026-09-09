#!/usr/bin/env bash
# =============================================================================
# Tern installer. One script, safe to run again: every answer you gave last
# time is the default next time, secrets are generated once and kept, and
# containers are only rebuilt or restarted when something changed.
#
#   sudo ./install.sh            interactive walkthrough
#   sudo ./install.sh --yes      non-interactive, values from .env / TERN_* env
#   sudo ./install.sh --help
# =============================================================================
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INSTALL_DIR"
ENV_FILE="$INSTALL_DIR/.env"
NONINTERACTIVE=0
SKIP_BUILD=0
for a in "$@"; do
  case "$a" in
    --yes|-y) NONINTERACTIVE=1 ;;
    --no-build) SKIP_BUILD=1 ;;
    --help|-h)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

# ---------- output helpers ----------
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=; D=; G=; Y=; R=; C=; N=; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '  %s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
note() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ask VAR "Prompt" "default"   -> sets VAR (uses existing value of VAR as default when set)
ask() {
  local var="$1" prompt="$2" def="${3:-}" cur="${!1:-}" ans
  [ -n "$cur" ] && def="$cur"
  if [ "$NONINTERACTIVE" = 1 ]; then printf -v "$var" '%s' "$def"; return; fi
  if [ -n "$def" ]; then read -r -p "  $prompt [$def]: " ans || true; else read -r -p "  $prompt: " ans || true; fi
  printf -v "$var" '%s' "${ans:-$def}"
}
ask_secret() {
  local var="$1" prompt="$2" ans
  if [ "$NONINTERACTIVE" = 1 ]; then return; fi
  read -r -s -p "  $prompt (blank to generate): " ans || true; echo
  [ -n "$ans" ] && printf -v "$var" '%s' "$ans"
  return 0  # a blank answer means "generate one"; under set -e a failed test here would end the script
}
# ask_yn VAR "Prompt" default(y/n)
ask_yn() {
  local var="$1" prompt="$2" def="${3:-n}" cur="${!1:-}" ans
  case "$cur" in 1|true|yes|y) def=y ;; 0|false|no|n) def=n ;; esac
  if [ "$NONINTERACTIVE" = 1 ]; then printf -v "$var" '%s' "$( [ "$def" = y ] && echo 1 || echo 0 )"; return; fi
  read -r -p "  $prompt [$( [ "$def" = y ] && echo Y/n || echo y/N )]: " ans || true
  ans="${ans:-$def}"
  case "$ans" in y|Y|yes|YES) printf -v "$var" '1' ;; *) printf -v "$var" '0' ;; esac
}
gen_secret() { if have openssl; then openssl rand -hex "${1:-32}"; else head -c "${1:-32}" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }
gen_password() { head -c 2000 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "${1:-20}"; echo; }  # bounded input: no SIGPIPE under pipefail

# ---------- root ----------
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then say "Re-running with sudo (rootful podman is needed for ports 80, 443 and 25)."; exec sudo -E "$0" "$@"; fi
  die "Run this as root (or install sudo)."
fi

say ""
say "${B}Tern${N} · self-hosted outreach inbox"
say "${D}This walks through everything: containers, domain and TLS, admin account, AI model, optional mail server.${N}"

# ---------- previous answers ----------
load_env() { # KEY=VALUE lines only; values may be quoted
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    printf -v "$key" '%s' "$val"
  done < "$ENV_FILE"
}
load_env
# TERN_* environment variables override .env for non-interactive installs.
for v in APP_URL SITE_ADDRESS ACME_EMAIL HTTP_PORT HTTPS_PORT ADMIN_USER ADMIN_PASSWORD AI_MODEL AI_ENABLED STALWART_ENABLED STALWART_HOST STALWART_DOMAIN GPU_ENABLED; do
  ov="TERN_$v"; [ -n "${!ov:-}" ] && printf -v "$v" '%s' "${!ov}"
done

# ---------- 1. packages ----------
step "1/8 Container runtime"
OS_ID=""; OS_LIKE=""
if [ -r /etc/os-release ]; then . /etc/os-release; OS_ID="${ID:-}"; OS_LIKE="${ID_LIKE:-}"; fi
pkg_install() {
  if have apt-get; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq "$@"
  elif have dnf; then dnf install -y -q "$@"
  elif have zypper; then zypper --non-interactive install "$@"
  elif have pacman; then pacman -Sy --noconfirm "$@"
  else return 1; fi
}
if ! have podman; then
  say "  podman is not installed; installing."
  pkg_install podman || die "Could not install podman automatically. Install it from https://podman.io/docs/installation and re-run."
fi
ok "podman $(podman --version | awk '{print $3}')"
if ! have podman-compose; then
  say "  podman-compose is not installed; installing."
  pkg_install podman-compose || { have pip3 && pip3 install --quiet podman-compose; } || true
fi
have podman-compose || die "podman-compose is required (apt install podman-compose, or pip3 install podman-compose)."
ok "podman-compose $(podman-compose --version 2>/dev/null | head -1 | awk '{print $NF}')"
have curl || pkg_install curl || die "curl is required"
have git || pkg_install git || true

# ---------- 2. web address ----------
step "2/8 Web address and TLS"
note "With a domain, Caddy fetches a Let's Encrypt certificate automatically (ports 80 and 443 must reach this box)."
note "Without one, Tern is served over plain HTTP on a port of your choice; fine behind a VPN or for a first look."
PREV_HOST=""; case "${APP_URL:-}" in https://*) PREV_HOST="${APP_URL#https://}"; PREV_HOST="${PREV_HOST%%/*}";; esac
WEB_HOST="${WEB_HOST:-$PREV_HOST}"
ask WEB_HOST "Public hostname for the web app (blank = no domain, plain HTTP)" ""
if [ -n "$WEB_HOST" ]; then
  ask ACME_EMAIL "Email for Let's Encrypt renewal notices" "${ACME_EMAIL:-admin@${WEB_HOST#*.}}"
  HTTP_PORT="${HTTP_PORT:-80}"; HTTPS_PORT="${HTTPS_PORT:-443}"
  APP_URL="https://$WEB_HOST"; SITE_ADDRESS="https://$WEB_HOST"
  ok "Tern will be served at $APP_URL"
else
  ask HTTP_PORT "HTTP port to serve on" "${HTTP_PORT:-80}"
  HTTPS_PORT="${HTTPS_PORT:-443}"
  ACME_EMAIL="${ACME_EMAIL:-admin@localhost}"
  DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$DETECTED_IP" ] && DETECTED_IP="127.0.0.1"
  ask PUBLIC_IP "Address people will use to reach it" "${PUBLIC_IP:-$DETECTED_IP}"
  APP_URL="http://$PUBLIC_IP$( [ "$HTTP_PORT" = 80 ] && echo "" || echo ":$HTTP_PORT" )"
  SITE_ADDRESS=":80"
  warn "Plain HTTP: sign-in cookies are not marked Secure. Put a TLS proxy or VPN in front before using this on the open internet."
fi

# ---------- 3. admin ----------
step "3/8 Admin account"
ask ADMIN_USER "Admin username" "${ADMIN_USER:-admin}"
# A typed password is set (or reset) on the account. Blank generates one for
# a new install and leaves an existing account's password alone on a re-run.
ADMIN_PASSWORD_GENERATED=0
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ask_secret ADMIN_PASSWORD "Admin password (blank: generate one, or keep the current one on a re-run)"
  if [ -z "${ADMIN_PASSWORD:-}" ]; then ADMIN_PASSWORD="$(gen_password 20)"; ADMIN_PASSWORD_GENERATED=1; fi
fi
[ "${#ADMIN_PASSWORD}" -ge 10 ] || die "The admin password must be at least 10 characters (and not a common one; the app checks that too)."
ok "admin user: $ADMIN_USER"

# ---------- 4. AI ----------
step "4/8 AI drafting assistant (Ollama, runs locally)"
TOTAL_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
TOTAL_GIB="$(awk -v kb="$TOTAL_KB" 'BEGIN { printf "%.1f", kb/1024/1024 }')"
# ---------- The floor ----------
#
# The RAM at which this box can run a model Tern's AI features are built and
# tested against: qwen3.5:9b or gemma4:12b. Below it, drafting still works
# well — that is the easy half, and a 2b does it — but the features that ask a
# model for a decision or a shape rather than a paragraph start to drift: an
# AI responder judging whether a message needs a reply, a campaign step
# following a structured format, anything where the prompt sets a fence.
#
# The failure is quiet, which is why the installer now says which side of the
# line it landed on. It is a warning and never a wall: every tier below is
# offered, and a 4.5 GB VPS gets a working install.
#
# Same number as FLOOR_CHAT in server/src/ai/models.ts, and the tiers below
# mirror MODEL_TIERS there. Change all of them together.
FLOOR_GIB=16

# Same tiers as server/src/ai/models.ts; change both.
rec_model() {
  awk -v g="$TOTAL_GIB" 'BEGIN {
    if (g >= 24) m="gemma4:12b"; else if (g >= 16) m="qwen3.5:9b"; else if (g >= 10) m="qwen3.5:4b"; else if (g >= 6) m="qwen3.5:2b"; else m="qwen3.5:0.8b"; print m }'
}
RECOMMENDED="$(rec_model)"
note "This machine has ${TOTAL_GIB} GB of RAM; recommended model: $RECOMMENDED"
note "Tiers: <6 GB qwen3.5:0.8b · 6-10 GB qwen3.5:2b · 10-16 GB qwen3.5:4b · 16-24 GB qwen3.5:9b · 24+ GB gemma4:12b"
if awk -v g="$TOTAL_GIB" -v f="$FLOOR_GIB" 'BEGIN { exit !(g < f) }'; then
  note ""
  note "$RECOMMENDED is below the model Tern's AI features are tested against"
  note "(qwen3.5:9b, which wants about ${FLOOR_GIB} GB). It drafts, rewrites, fixes"
  note "grammar and suggests subject lines perfectly well — that is most of what"
  note "the assistant is for. What is less reliable below the line is anything"
  note "asked for a decision or a fixed format: AI responders judging whether a"
  note "message needs a reply, and campaign steps following a structure."
  note "Nothing here stops you, and you can point Admin -> AI model at a bigger"
  note "model later, or at a hosted provider, without reinstalling."
fi
ask_yn AI_ENABLED "Enable the AI assistant?" y
if [ "$AI_ENABLED" = 1 ]; then
  ask AI_MODEL "Model to download (any name from ollama.com/library)" "${AI_MODEL:-$RECOMMENDED}"
  AI_ENABLED_VAL=true
  GPU_DEFAULT=n
  if have nvidia-smi && ls /etc/cdi/*.yaml >/dev/null 2>&1; then GPU_DEFAULT=y; fi
  ask_yn GPU_ENABLED "Give Ollama an NVIDIA GPU (needs nvidia container toolkit + CDI)?" "$GPU_DEFAULT"
  # Meaning search needs a second, much smaller model. all-minilm is 46 MB
  # and 384 dimensions, which is enough for "find the thread about the
  # price"; nomic-embed-text is 274 MB and noticeably better, and is the
  # default once the box has room to hold it beside the chat model.
  # The embedding model, sized to the box like the chat model above — but
  # against the FLOOR rather than against what fits. qwen3-embedding:4b is what
  # meaning search is built and tested against; below it, retrieval is worst on
  # exactly the wording the feature exists to catch, and that is a failure
  # nobody sees as a failure.
  #
  # It loads BESIDE the chat model rather than instead of it, so it is sized
  # from what is left over, not from the whole box.
  if awk -v g="$TOTAL_GIB" -v f="$FLOOR_GIB" 'BEGIN { exit !(g >= f + 4) }'; then EMBED_DEFAULT="qwen3-embedding:4b"
  elif awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g >= 6) }'; then EMBED_DEFAULT="nomic-embed-text"
  else EMBED_DEFAULT="all-minilm"; fi
  AI_EMBED_MODEL="${AI_EMBED_MODEL:-$EMBED_DEFAULT}"
  note "Meaning search will use $AI_EMBED_MODEL. Nobody's mail is read until they turn the feature on for themselves."
  if [ "$AI_EMBED_MODEL" != "qwen3-embedding:4b" ]; then
    note "That is below the embedding floor (qwen3-embedding:4b, which wants about"
    note "3.5 GB beside the chat model). Meaning search will work and will retrieve"
    note "less well on wording that shares no words with the message you are after."
  fi
  # Said once, here, because it is the one model choice that is not free to
  # revisit: vectors made by one embedder are not comparable with another's, so
  # changing it re-indexes the whole mailbox.
  note "Changing this later rebuilds the index; ordinary text search keeps working meanwhile."
  # Dictation. Separate question because it is a separate container and the
  # only thing on the list that costs the base install real memory.
  if awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g >= 4) }'; then
    ask_yn VOICE_ENABLED "Add dictation (speak into any text box; a whisper.cpp container, about 500 MB)?" "$( [ "${VOICE_ENABLED:-0}" = 1 ] && echo y || echo n )"
    if [ "${VOICE_ENABLED:-0}" = 1 ]; then
      if awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g >= 8) }'; then WHISPER_MODEL="${WHISPER_MODEL:-small}"; WHISPER_MEM_LIMIT="1536m";
      else WHISPER_MODEL="${WHISPER_MODEL:-base}"; WHISPER_MEM_LIMIT="768m"; fi
      note "Dictation will use the '$WHISPER_MODEL' model. Recordings are never written to disk and transcripts are never stored."
    fi
  else
    VOICE_ENABLED=0
  fi
else
  AI_MODEL="${AI_MODEL:-$RECOMMENDED}"; AI_ENABLED_VAL=false; GPU_ENABLED=0; VOICE_ENABLED=0
fi
VOICE_ENABLED="${VOICE_ENABLED:-0}"
WHISPER_MODEL="${WHISPER_MODEL:-base}"
WHISPER_MEM_LIMIT="${WHISPER_MEM_LIMIT:-768m}"
# Matches config.ts's default. A box that never answered the AI questions still
# gets the floor rather than the smallest thing that runs.
AI_EMBED_MODEL="${AI_EMBED_MODEL:-qwen3-embedding:4b}"
# Memory limits scale with the box so a 4.5 GB VPS never swaps itself to death.
if awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g < 5) }'; then OLLAMA_MEM_LIMIT="2300m"; APP_MEM_LIMIT="640m"; STALWART_MEM_LIMIT="512m";
elif awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g < 9) }'; then OLLAMA_MEM_LIMIT="4500m"; APP_MEM_LIMIT="768m"; STALWART_MEM_LIMIT="768m";
else OLLAMA_MEM_LIMIT="$(awk -v g="$TOTAL_GIB" 'BEGIN { printf "%dm", g*1024*0.6 }')"; APP_MEM_LIMIT="1024m"; STALWART_MEM_LIMIT="1024m"; fi
# How many people Ollama answers at once. Each slot holds its own context
# window of KV cache, so this is sized from the same RAM the limit above is:
# a starting point for the people this box is likely to have. When more people
# have accounts than there are slots, Admin → AI model says so and
# `./bin/tern ai-slots` raises it to one slot each, memory allowing.
if awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g < 5) }'; then OLLAMA_NUM_PARALLEL=2;
elif awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g < 9) }'; then OLLAMA_NUM_PARALLEL=4;
else OLLAMA_NUM_PARALLEL=8; fi

# ---------- 5. Stalwart ----------
step "5/8 Mail server"
note "Tern connects to any JMAP mailbox (Fastmail, a Stalwart elsewhere, ...). You can also run Stalwart on this box."
note "That needs a domain, port 25 open in both directions at your host, and reverse DNS on this IP. See docs/PROVIDERS.md."
if [ -n "$WEB_HOST" ]; then
  ask_yn STALWART_ENABLED "Run a Stalwart mail server here?" "$( [ "${STALWART_ENABLED:-0}" = 1 ] && echo y || echo n )"
else
  [ "${STALWART_ENABLED:-0}" = 1 ] && warn "Stalwart needs a domain for TLS; disabling it for the plain-HTTP setup."
  STALWART_ENABLED=0
fi
if [ "$STALWART_ENABLED" = 1 ]; then
  ask STALWART_DOMAIN "Primary mail domain (the part after @)" "${STALWART_DOMAIN:-${WEB_HOST#*.}}"
  ask STALWART_HOST "Mail server hostname (A record + reverse DNS point here)" "${STALWART_HOST:-mx1.$STALWART_DOMAIN}"
  [ "$STALWART_HOST" != "$WEB_HOST" ] || die "The mail hostname must differ from the web app hostname."
  DETECTED_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)"
  [ -z "$DETECTED_IP" ] && DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ask SERVER_IP "This server's public IPv4 (used to verify the A and reverse DNS records)" "${SERVER_IP:-$DETECTED_IP}"
  # Only a globally routable address (2000::/3) is worth recording; link-local
  # and unique-local ones never appear to the outside world.
  DETECTED_IP6="$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | grep -E '^[23]' | head -1)"
  ask SERVER_IPV6 "This server's public IPv6, if it has one (blank for IPv4 only)" "${SERVER_IPV6:-$DETECTED_IP6}"
  STALWART_HTTP_PORT="${STALWART_HTTP_PORT:-8080}"
  STALWART_ADMIN_USER="${STALWART_ADMIN_USER:-}"
  STALWART_ADMIN_PASSWORD="${STALWART_ADMIN_PASSWORD:-}"
  [ -z "${STALWART_RECOVERY_ADMIN:-}" ] && STALWART_RECOVERY_ADMIN="recovery:$(gen_password 20)"
  ask_yn STALWART_FIRST_MAILBOX "Create a first mailbox on it now?" y
  if [ "$STALWART_FIRST_MAILBOX" = 1 ]; then
    ask STALWART_FIRST_USER "Mailbox local part (the part before @$STALWART_DOMAIN)" "${STALWART_FIRST_USER:-$ADMIN_USER}"
    STALWART_FIRST_PASSWORD="${STALWART_FIRST_PASSWORD:-}"
    [ -z "$STALWART_FIRST_PASSWORD" ] && ask_secret STALWART_FIRST_PASSWORD "Password for $STALWART_FIRST_USER@$STALWART_DOMAIN"
    [ -z "$STALWART_FIRST_PASSWORD" ] && STALWART_FIRST_PASSWORD="$(gen_password 22)"
  fi
else
  STALWART_HOST="${STALWART_HOST:-}"; STALWART_DOMAIN="${STALWART_DOMAIN:-}"; STALWART_HTTP_PORT="${STALWART_HTTP_PORT:-8080}"
fi

# ---------- 6. write config ----------
step "6/8 Writing configuration"
DB_PASSWORD="${DB_PASSWORD:-$(gen_secret 16)}"
SESSION_SECRET="${SESSION_SECRET:-$(gen_secret 32)}"
ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(gen_secret 32)}"
COMPOSE_FILE="compose.yml"
[ "$STALWART_ENABLED" = 1 ] && COMPOSE_FILE="$COMPOSE_FILE:compose.stalwart.yml"
[ "${GPU_ENABLED:-0}" = 1 ] && COMPOSE_FILE="$COMPOSE_FILE:compose.gpu.yml"
[ "${VOICE_ENABLED:-0}" = 1 ] && COMPOSE_FILE="$COMPOSE_FILE:compose.voice.yml"
TERN_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"

umask 077
cat > "$ENV_FILE" <<EOF
# Written by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Re-run ./install.sh to change anything.
APP_URL=$APP_URL
SITE_ADDRESS=$SITE_ADDRESS
WEB_HOST=$WEB_HOST
PUBLIC_IP=${PUBLIC_IP:-}
ACME_EMAIL=$ACME_EMAIL
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
TERN_VERSION=$TERN_VERSION

DB_PASSWORD=$DB_PASSWORD
SESSION_SECRET=$SESSION_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
TRUST_PROXY=true

ADMIN_USER=$ADMIN_USER

AI_ENABLED=$AI_ENABLED_VAL
AI_MODEL=$AI_MODEL
AI_EMBED_MODEL=$AI_EMBED_MODEL
GPU_ENABLED=${GPU_ENABLED:-0}
VOICE_ENABLED=${VOICE_ENABLED:-0}
WHISPER_MODEL=$WHISPER_MODEL
WHISPER_MEM_LIMIT=$WHISPER_MEM_LIMIT
OLLAMA_KEEP_ALIVE=10m
OLLAMA_NUM_PARALLEL=$OLLAMA_NUM_PARALLEL
OLLAMA_KV_CACHE_TYPE=q8_0
OLLAMA_MAX_QUEUE=32
OLLAMA_MEM_LIMIT=$OLLAMA_MEM_LIMIT
APP_MEM_LIMIT=$APP_MEM_LIMIT
STALWART_MEM_LIMIT=$STALWART_MEM_LIMIT

SYNC_POLL_SECONDS=${SYNC_POLL_SECONDS:-90}
INITIAL_SYNC_LIMIT=${INITIAL_SYNC_LIMIT:-3000}
ALLOW_INSECURE_JMAP=${ALLOW_INSECURE_JMAP:-true}

COMPOSE_FILE=$COMPOSE_FILE

STALWART_ENABLED=$STALWART_ENABLED
STALWART_HOST=$STALWART_HOST
STALWART_DOMAIN=$STALWART_DOMAIN
STALWART_HTTP_PORT=$STALWART_HTTP_PORT
STALWART_ADMIN_USER=$STALWART_ADMIN_USER
STALWART_ADMIN_PASSWORD=$STALWART_ADMIN_PASSWORD
STALWART_RECOVERY_ADMIN=${STALWART_RECOVERY_ADMIN:-}
STALWART_RECOVERY_MODE=
STALWART_FIRST_USER=${STALWART_FIRST_USER:-}
SERVER_IP=${SERVER_IP:-}
SERVER_IPV6=${SERVER_IPV6:-}
EOF
umask 022
ok ".env written (mode 600)"

# Caddyfile from the templates (deploy/lib.sh does the rendering, so
# update.sh can regenerate it too).
. "$INSTALL_DIR/deploy/lib.sh"
export ACME_EMAIL SITE_ADDRESS WEB_HOST STALWART_ENABLED STALWART_HOST STALWART_DOMAIN
CADDY_CHANGED=0; if write_caddyfile; then CADDY_CHANGED=1; fi
ok "deploy/generated/Caddyfile written"

# Firewall: open what the stack needs, if a firewall is managing this box.
if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow "$HTTP_PORT/tcp" >/dev/null && ufw allow "$HTTPS_PORT/tcp" >/dev/null && ok "ufw: allowed $HTTP_PORT and $HTTPS_PORT"
  if [ "$STALWART_ENABLED" = 1 ]; then for p in 25 465 587 993; do ufw allow "$p/tcp" >/dev/null; done; ok "ufw: allowed mail ports 25 465 587 993"; fi
fi

# ---------- 7. build & start ----------
step "7/8 Building and starting containers"
export COMPOSE_FILE
compose() { podman-compose --env-file "$ENV_FILE" "$@"; }

# Ports the stack binds on this host. A leftover mail server (Postfix, Exim)
# on 25 is the usual conflict; without this check the container fails with a
# "cannot listen on the TCP port" error buried in the podman-compose output.
foreign_listeners() { # port -> "pid comm" lines for listeners that are not our own containers
  have ss || return 0
  ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'users:(([^)]*)' \
    | sed 's/users:(("\([^"]*\)",pid=\([0-9]*\).*/\2 \1/' \
    | grep -Ev ' (podman|conmon|rootlessport|pasta[^ ]*|slirp4netns|netavark|aardvark-dns)$' | sort -u || true
}
check_ports() {
  local ports="$HTTP_PORT $HTTPS_PORT" p who pid comm unit base busy=0
  [ "$STALWART_ENABLED" = 1 ] && ports="$ports 25 465 587 993 4190 $STALWART_HTTP_PORT"
  for p in $ports; do
    who="$(foreign_listeners "$p" | head -1)"; [ -n "$who" ] || continue
    pid="${who%% *}"; comm="${who#* }"
    unit="$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ')"
    warn "port $p is already in use by $comm (pid $pid${unit:+, $unit})"
    case "$unit" in
      user@*.service|*.scope|'') note "To free it: stop $comm, or pick another port." ;;
      *.service)
        STOP_UNIT=""
        ask_yn STOP_UNIT "Stop and disable $unit so Tern can use port $p?" n
        if [ "$STOP_UNIT" = 1 ]; then
          base="${unit%%@*}"
          systemctl disable --now "$unit" >/dev/null 2>&1 || true
          [ "$base" != "$unit" ] && systemctl disable --now "$base.service" >/dev/null 2>&1 || true
          sleep 1
          if [ -z "$(foreign_listeners "$p")" ]; then ok "port $p is free"; continue; fi
          warn "port $p is still in use"
        else
          note "To free it yourself: systemctl disable --now $unit"
        fi ;;
    esac
    busy=1
  done
  [ "$busy" = 0 ] || die "Ports in use. Stop the programs above (or pick other ports) and re-run ./install.sh."
}
check_ports
if [ "$SKIP_BUILD" = 0 ]; then
  say "  Building the app image (a few minutes the first time)…"
  compose build app 2>&1 | grep -Ev '^(STEP|--> )' | tail -3 || true
  ok "image built"
fi
# Start (or update) the whole stack and make sure every part of it is up.
# Older podman-compose does not fail on its own, so the checks matter.
start_stack() {
  local replaced
  replaced="$(replace_stale_containers localhost/tern:latest | tr '\n' ' ')"
  [ -n "$replaced" ] && note "replacing (image changed): $replaced"
  compose_up
  for i in $(seq 1 30); do
    if compose exec -T db pg_isready -U tern -d tern >/dev/null 2>&1; then break; fi
    sleep 2
    [ "$i" = 30 ] && die "Postgres did not become ready. See: ./bin/tern logs db"
  done
  ok "database ready"
  for i in $(seq 1 60); do
    if compose exec -T app wget -qO- http://127.0.0.1:3080/healthz >/dev/null 2>&1; then break; fi
    sleep 2
    [ "$i" = 60 ] && die "The app did not come up. See: ./bin/tern logs app"
  done
  ok "app is healthy"
  for svc in $(compose config --services 2>/dev/null | grep -E '^[A-Za-z0-9_.-]+$'); do
    compose exec -T "$svc" true >/dev/null 2>&1 && continue
    # Dictation is optional and the app says so when the transcriber is
    # absent, so a whisper that will not start is a warning, not the end of
    # an otherwise good install. Everything else is load-bearing.
    if [ "$svc" = whisper ]; then
      warn "the whisper container is not running; dictation stays off. See: ./bin/tern logs whisper"
    else
      die "The $svc container is not running. See: ./bin/tern logs $svc"
    fi
  done
  ok "all containers running"
}
# Recreate the given services' containers (and the containers that depend on
# them). `compose up --force-recreate <svc>` cannot do this on podman-compose
# 1.0.x: its partial `down` fails because dependents hold the container.
recreate_services() {
  local svc cid
  for svc in "$@"; do
    cid="$(podman ps -aq --filter "label=com.docker.compose.service=$svc" --filter "label=com.docker.compose.project.working_dir=$INSTALL_DIR" | head -1)"
    [ -n "$cid" ] && podman container exists "$cid" 2>/dev/null && podman rm -f --depend "$cid" >/dev/null
  done
  start_stack
}
say "  Starting containers…"
start_stack
# A re-run with a changed Caddyfile: the container is unchanged, so tell Caddy to reload it.
if [ "$CADDY_CHANGED" = 1 ]; then caddy_reload && ok "Caddy reloaded its configuration" || warn "Caddy did not reload; ./bin/tern restart caddy"; fi

if [ "$ADMIN_PASSWORD_GENERATED" = 1 ]; then
  CU="$(compose exec -T app tern-cli create-user --username "$ADMIN_USER" --password "$ADMIN_PASSWORD" --name "$ADMIN_USER" --role admin --if-missing 2>&1 | tail -1)"
  case "$CU" in
    exists*) ADMIN_PASSWORD_GENERATED=0; ok "admin user $ADMIN_USER exists; password unchanged" ;;
    created*) ok "admin user $ADMIN_USER created" ;;
    updated*) warn "admin user $ADMIN_USER existed and its password was reset (older app image); the new one is printed below" ;;
    *) die "Could not create the admin user: $CU" ;;
  esac
else
  if CU="$(compose exec -T app tern-cli create-user --username "$ADMIN_USER" --password "$ADMIN_PASSWORD" --name "$ADMIN_USER" --role admin 2>&1 | tail -1)"; then
    ok "admin user $ADMIN_USER: password set"
  else
    die "Could not set the admin password: $CU"
  fi
fi

if [ "$AI_ENABLED" = 1 ]; then
  if compose exec -T ollama ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$AI_MODEL\(:latest\)\?"; then
    ok "model $AI_MODEL already present"
  else
    say "  Downloading $AI_MODEL (once; sizes range from 400 MB to several GB)…"
    if compose exec -T ollama ollama pull "$AI_MODEL"; then ok "model ready"; else warn "Model download failed; pull it later from Settings → AI or with: ./bin/tern pull-model $AI_MODEL"; fi
  fi
  # The embedding model for meaning search. Small, and pulled now so the
  # first person to turn the feature on does not wait for a download.
  if compose exec -T ollama ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$AI_EMBED_MODEL\(:latest\)\?"; then
    ok "embedding model $AI_EMBED_MODEL already present"
  else
    say "  Downloading $AI_EMBED_MODEL for meaning search (46 MB to 2.5 GB)…"
    if compose exec -T ollama ollama pull "$AI_EMBED_MODEL"; then ok "embedding model ready"; else warn "Embedding model download failed; meaning search will say so until it is pulled: ./bin/tern pull-model $AI_EMBED_MODEL"; fi
  fi
fi

# The speech model. The container fetches its own weights on first start
# (see compose.voice.yml): whisper-server exits when the model file is
# missing, so it could never be downloaded through a running container. All
# that is left here is to wait for it and say what is happening, since a
# first start is a 150-500 MB download before the port opens.
if [ "${VOICE_ENABLED:-0}" = 1 ]; then
  if compose exec -T whisper test -s "/models/ggml-${WHISPER_MODEL}.bin" 2>/dev/null; then
    ok "speech model $WHISPER_MODEL already present"
  else
    say "  Fetching the '$WHISPER_MODEL' speech model (once; 150 MB to 500 MB)…"
    VOICE_OK=0
    for i in $(seq 1 150); do
      if compose exec -T whisper wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1; then VOICE_OK=1; break; fi
      sleep 4
    done
    if [ "$VOICE_OK" = 1 ]; then
      ok "speech model ready"
    else
      warn "the speech model is still not in place; dictation stays off until it is. Watch it with: ./bin/tern logs whisper"
    fi
  fi
fi

# ---------- Stalwart bootstrap ----------
STALWART_DNS=""
if [ "$STALWART_ENABLED" = 1 ]; then
  SW="http://127.0.0.1:$STALWART_HTTP_PORT"
  sw_api() { # sw_api user:pass '<json methodCalls>'
    curl -sS -u "$1" -H 'Content-Type: application/json' "$SW/jmap" -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":$2}"
  }
  if ! compose exec -T stalwart test -f /etc/stalwart/config.json >/dev/null 2>&1; then
    say "  Bootstrapping Stalwart (hostname $STALWART_HOST, domain $STALWART_DOMAIN)…"
    for i in $(seq 1 30); do curl -sf -u "$STALWART_RECOVERY_ADMIN" "$SW/api/account" >/dev/null 2>&1 && break; sleep 2; [ "$i" = 30 ] && die "Stalwart's bootstrap listener did not answer on $SW"; done
    RESP="$(sw_api "$STALWART_RECOVERY_ADMIN" "[[\"x:Bootstrap/set\",{\"update\":{\"singleton\":{\"serverHostname\":\"$STALWART_HOST\",\"defaultDomain\":\"$STALWART_DOMAIN\",\"requestTlsCertificate\":false,\"generateDkimKeys\":true,\"tracer\":{\"@type\":\"Stdout\",\"level\":\"info\",\"ansi\":false}}}},\"c1\"]]")"
    STALWART_ADMIN_USER="$(printf '%s' "$RESP" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
    STALWART_ADMIN_PASSWORD="$(printf '%s' "$RESP" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')"
    [ -n "$STALWART_ADMIN_USER" ] && [ -n "$STALWART_ADMIN_PASSWORD" ] || die "Bootstrap failed: $RESP"
    sed -i "s|^STALWART_ADMIN_USER=.*|STALWART_ADMIN_USER=$STALWART_ADMIN_USER|; s|^STALWART_ADMIN_PASSWORD=.*|STALWART_ADMIN_PASSWORD=$STALWART_ADMIN_PASSWORD|; s|^STALWART_RECOVERY_ADMIN=.*|STALWART_RECOVERY_ADMIN=|" "$ENV_FILE"
    STALWART_RECOVERY_ADMIN=""
    ok "Stalwart bootstrapped; admin is $STALWART_ADMIN_USER"
    # The app reads the Stalwart admin credentials from .env when its container
    # is created, and they did not exist until now; without a fresh app
    # container there is no Settings → Mail server page.
    say "  Restarting Stalwart and the app with the new credentials…"
    recreate_services stalwart app
  fi
  for i in $(seq 1 30); do curl -sf -u "$STALWART_ADMIN_USER:$STALWART_ADMIN_PASSWORD" "$SW/api/account" >/dev/null 2>&1 && break; sleep 2; [ "$i" = 30 ] && warn "Stalwart is not answering with the stored admin credentials; check ./bin/tern logs stalwart"; done
  DOMAIN_ID="$(sw_api "$STALWART_ADMIN_USER:$STALWART_ADMIN_PASSWORD" '[["x:Domain/get",{"ids":null,"properties":["id","name"]},"c1"]]' | sed -n 's/.*"list":\[{[^}]*"id":"\([^"]*\)".*/\1/p')"
  if [ "${STALWART_FIRST_MAILBOX:-0}" = 1 ] && [ -n "$DOMAIN_ID" ] && [ -n "${STALWART_FIRST_USER:-}" ]; then
    EXISTS="$(sw_api "$STALWART_ADMIN_USER:$STALWART_ADMIN_PASSWORD" "[[\"x:Account/query\",{\"filter\":{\"name\":\"$STALWART_FIRST_USER\"}},\"c1\"]]" | grep -c '"ids":\["' || true)"
    if [ "$EXISTS" = 0 ]; then
      CR="$(sw_api "$STALWART_ADMIN_USER:$STALWART_ADMIN_PASSWORD" "[[\"x:Account/set\",{\"create\":{\"a\":{\"@type\":\"User\",\"name\":\"$STALWART_FIRST_USER\",\"domainId\":\"$DOMAIN_ID\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"$STALWART_FIRST_PASSWORD\"}}}}},\"c1\"]]")"
      if printf '%s' "$CR" | grep -q '"created"'; then ok "mailbox $STALWART_FIRST_USER@$STALWART_DOMAIN created"; STALWART_FIRST_CREATED=1; else warn "Could not create the mailbox: $CR"; fi
    else
      ok "mailbox $STALWART_FIRST_USER@$STALWART_DOMAIN already exists"
    fi
  fi
  ./bin/tern stalwart-trust-proxy >/dev/null && ok "Stalwart never bans our own containers" || warn "Could not set Stalwart's trusted networks; run ./bin/tern stalwart-trust-proxy later"
  ./bin/tern cert-sync || warn "TLS for SMTP/IMAP not installed yet (Caddy may still be fetching the certificate). It retries daily; run ./bin/tern cert-sync after DNS points here."
  STALWART_DNS="$(sw_api "$STALWART_ADMIN_USER:$STALWART_ADMIN_PASSWORD" '[["x:Domain/get",{"ids":null,"properties":["dnsZoneFile"]},"c1"]]' | sed -n 's/.*"dnsZoneFile":"\(\([^"\\]\|\\.\)*\)".*/\1/p' | sed 's/\\n/\n/g; s/\\"/"/g')"
fi

# ---------- 8. systemd ----------
step "8/8 Start on boot"
if have systemctl && [ -d /etc/systemd/system ]; then
  render_template deploy/tern.service.tmpl > /etc/systemd/system/tern.service
  systemctl daemon-reload
  systemctl enable tern.service >/dev/null 2>&1 && ok "tern.service enabled (starts the stack at boot)"
  if [ "$STALWART_ENABLED" = 1 ]; then
    render_template deploy/tern-certsync.service.tmpl > /etc/systemd/system/tern-certsync.service
    render_template deploy/tern-certsync.timer.tmpl > /etc/systemd/system/tern-certsync.timer
    systemctl daemon-reload; systemctl enable --now tern-certsync.timer >/dev/null 2>&1 && ok "daily certificate sync timer enabled"
  fi
else
  warn "systemd not found; start the stack after a reboot with: ./bin/tern up"
fi

# ---------- summary ----------
say ""
say "${G}${B}Tern is running.${N}"
say ""
say "  Web app:        ${B}$APP_URL${N}"
say "  Sign in as:     $ADMIN_USER"
if [ "$ADMIN_PASSWORD_GENERATED" = 1 ]; then say "  Password:       ${B}$ADMIN_PASSWORD${N}   ${D}(generated; change it in Settings → Security)${N}"; else say "  Password:       ${D}unchanged (reset with: ./bin/tern cli set-password --username $ADMIN_USER --password '…')${N}"; fi
[ "$AI_ENABLED" = 1 ] && say "  AI model:       $AI_MODEL  ${D}(change under Admin → AI model)${N}"
[ "$AI_ENABLED" = 1 ] && say "  Meaning search: $AI_EMBED_MODEL  ${D}(off until each person turns it on)${N}"
[ "${VOICE_ENABLED:-0}" = 1 ] && say "  Dictation:      whisper $WHISPER_MODEL  ${D}(off until each person turns it on)${N}"
say "  Features:       every one that reads mail or uses the model is off by default; Settings → Features"
if [ "$STALWART_ENABLED" = 1 ]; then
  say ""
  say "  Mail server:    https://$STALWART_HOST/admin   ${D}(Stalwart admin panel)${N}"
  say "  Stalwart admin: $STALWART_ADMIN_USER / $STALWART_ADMIN_PASSWORD   ${D}(also in .env)${N}"
  if [ "${STALWART_FIRST_CREATED:-0}" = 1 ]; then
    say "  First mailbox:  $STALWART_FIRST_USER@$STALWART_DOMAIN / $STALWART_FIRST_PASSWORD"
    say "                  ${D}Add it in Tern: Settings → Accounts → Add account → Stalwart (this server).${N}"
  fi
  say ""
  say "  ${B}Mail server admin login${N}   https://$STALWART_HOST/admin"
  say "     user: $STALWART_ADMIN_USER   password: $STALWART_ADMIN_PASSWORD"
  say "     ${D}Also under Settings → Mail server → Admin access in Tern (admins only), and kept in .env.${N}"
  say ""
  say "  ${B}DNS walkthrough for $STALWART_DOMAIN${N}   (full guide: docs/DNS.md)"
  say "  1. At your hosting provider, set reverse DNS of ${SERVER_IP:-<server IP>} to $STALWART_HOST."
  if [ -n "${SERVER_IPV6:-}" ]; then
    say "     Do the same for $SERVER_IPV6 — mail sent over IPv6 is judged on that address's reverse DNS."
  fi
  say "  2. At your DNS host, add an A record:  $STALWART_HOST → ${SERVER_IP:-<server IP>}"
  if [ -n "${SERVER_IPV6:-}" ]; then
    say "     and an AAAA record:                 $STALWART_HOST → $SERVER_IPV6"
  fi
  say "  3. Add the records the mail server generated (MX, SPF, two DKIM keys, DMARC, MTA-STS, TLS-RPT, mail-app autoconfig):"
  if [ -n "$STALWART_DNS" ]; then printf '%s\n' "$STALWART_DNS" | sed 's/^/       /'; fi
  say "  4. Brand logo (BIMI): upload an SVG or generate an avatar under Settings → Mail server → Brand logo; its record appears in DNS setup."
  say "  5. Verify: Settings → Mail server → Check DNS, or   ./bin/tern dns-check --port25"
  say "  6. When the MTA-STS rows are green, switch MTA-STS to enforce on the same page."
fi
say ""
say "  Next:  open the web app, then Settings → Accounts → Add account (Fastmail token, Stalwart, or any JMAP server)."
say "  Docs:  docs/SETUP.md (first run) · docs/PROVIDERS.md (Fastmail / Stalwart / DNS) · docs/CUSTOMIZING.md"
say "  Ops:   ./bin/tern logs app · ./bin/tern update (after git pull) · ./bin/tern backup"
say ""
