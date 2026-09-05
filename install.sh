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
gen_password() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-20}"; echo; }

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
ADMIN_PASSWORD_GENERATED=0
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ask_secret ADMIN_PASSWORD "Admin password"
  if [ -z "${ADMIN_PASSWORD:-}" ]; then ADMIN_PASSWORD="$(gen_password 20)"; ADMIN_PASSWORD_GENERATED=1; fi
fi
[ "${#ADMIN_PASSWORD}" -ge 10 ] || die "The admin password must be at least 10 characters."
ok "admin user: $ADMIN_USER"

# ---------- 4. AI ----------
step "4/8 AI drafting assistant (Ollama, runs locally)"
TOTAL_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
TOTAL_GIB="$(awk -v kb="$TOTAL_KB" 'BEGIN { printf "%.1f", kb/1024/1024 }')"
# Same tiers as server/src/ai/models.ts; change both.
rec_model() {
  awk -v g="$TOTAL_GIB" 'BEGIN {
    if (g >= 20) m="qwen2.5:14b"; else if (g >= 10) m="qwen2.5:7b"; else if (g >= 6) m="qwen2.5:3b"; else if (g >= 3.5) m="qwen2.5:1.5b"; else m="qwen2.5:0.5b"; print m }'
}
RECOMMENDED="$(rec_model)"
note "This machine has ${TOTAL_GIB} GB of RAM; recommended model: $RECOMMENDED"
note "Tiers: <3.5 GB qwen2.5:0.5b · 3.5-6 GB qwen2.5:1.5b · 6-10 GB qwen2.5:3b · 10-20 GB qwen2.5:7b · 20+ GB qwen2.5:14b"
ask_yn AI_ENABLED "Enable the AI assistant?" y
if [ "$AI_ENABLED" = 1 ]; then
  ask AI_MODEL "Model to download (any name from ollama.com/library)" "${AI_MODEL:-$RECOMMENDED}"
  AI_ENABLED_VAL=true
  GPU_DEFAULT=n
  if have nvidia-smi && ls /etc/cdi/*.yaml >/dev/null 2>&1; then GPU_DEFAULT=y; fi
  ask_yn GPU_ENABLED "Give Ollama an NVIDIA GPU (needs nvidia container toolkit + CDI)?" "$GPU_DEFAULT"
else
  AI_MODEL="${AI_MODEL:-$RECOMMENDED}"; AI_ENABLED_VAL=false; GPU_ENABLED=0
fi
# Memory limits scale with the box so a 4.5 GB VPS never swaps itself to death.
if awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g < 5) }'; then OLLAMA_MEM_LIMIT="2300m"; APP_MEM_LIMIT="640m"; STALWART_MEM_LIMIT="512m";
elif awk -v g="$TOTAL_GIB" 'BEGIN { exit !(g < 9) }'; then OLLAMA_MEM_LIMIT="4500m"; APP_MEM_LIMIT="768m"; STALWART_MEM_LIMIT="768m";
else OLLAMA_MEM_LIMIT="$(awk -v g="$TOTAL_GIB" 'BEGIN { printf "%dm", g*1024*0.6 }')"; APP_MEM_LIMIT="1024m"; STALWART_MEM_LIMIT="1024m"; fi

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
GPU_ENABLED=${GPU_ENABLED:-0}
OLLAMA_KEEP_ALIVE=10m
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
EOF
umask 022
ok ".env written (mode 600)"

# Caddyfile from template: substitute ${VAR} for a known list, nothing else.
render() {
  local content; content="$(cat "$1")"
  for v in ACME_EMAIL SITE_ADDRESS CADDY_GLOBAL STALWART_SITE STALWART_HOST STALWART_DOMAIN INSTALL_DIR; do
    content="${content//\$\{$v\}/${!v:-}}"
  done
  printf '%s\n' "$content"
}
CADDY_GLOBAL=""
if [ -z "$WEB_HOST" ]; then CADDY_GLOBAL="auto_https off"; fi
# Extra names for the mail domain (MTA-STS policy, client autoconfig) get
# certificates on demand, after the app confirms the name belongs here.
if [ "$STALWART_ENABLED" = 1 ]; then CADDY_GLOBAL="on_demand_tls {
		ask http://app:3080/api/caddy/ask
	}"; fi
STALWART_SITE=""
if [ "$STALWART_ENABLED" = 1 ]; then STALWART_SITE="$(render deploy/stalwart-site.tmpl)"; fi
mkdir -p deploy/generated
render deploy/Caddyfile.tmpl > deploy/generated/Caddyfile
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
if [ "$SKIP_BUILD" = 0 ]; then
  say "  Building the app image (a few minutes the first time)…"
  compose build app 2>&1 | grep -Ev '^(STEP|--> )' | tail -3 || true
  ok "image built"
fi
say "  Starting database…"
compose up -d db >/dev/null
for i in $(seq 1 30); do
  if compose exec -T db pg_isready -U tern -d tern >/dev/null 2>&1; then break; fi
  sleep 2
  [ "$i" = 30 ] && die "Postgres did not become ready. See: ./bin/tern logs db"
done
ok "database ready"
say "  Starting the rest…"
compose up -d --remove-orphans >/dev/null
for i in $(seq 1 60); do
  if compose exec -T app wget -qO- http://127.0.0.1:3080/healthz >/dev/null 2>&1; then break; fi
  sleep 2
  [ "$i" = 60 ] && die "The app did not come up. See: ./bin/tern logs app"
done
ok "app is healthy"

compose exec -T app tern-cli create-user --username "$ADMIN_USER" --password "$ADMIN_PASSWORD" --name "$ADMIN_USER" --role admin >/dev/null
ok "admin user ensured"

if [ "$AI_ENABLED" = 1 ]; then
  if compose exec -T ollama ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$AI_MODEL\(:latest\)\?"; then
    ok "model $AI_MODEL already present"
  else
    say "  Downloading $AI_MODEL (once; sizes range from 400 MB to several GB)…"
    if compose exec -T ollama ollama pull "$AI_MODEL"; then ok "model ready"; else warn "Model download failed; pull it later from Settings → AI or with: ./bin/tern pull-model $AI_MODEL"; fi
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
    compose up -d --force-recreate stalwart >/dev/null
    ok "Stalwart bootstrapped; admin is $STALWART_ADMIN_USER"
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
  ./bin/tern cert-sync || warn "TLS for SMTP/IMAP not installed yet (Caddy may still be fetching the certificate). It retries daily; run ./bin/tern cert-sync after DNS points here."
  STALWART_DNS="$(sw_api "$STALWART_ADMIN_USER:$STALWART_ADMIN_PASSWORD" '[["x:Domain/get",{"ids":null,"properties":["dnsZoneFile"]},"c1"]]' | sed -n 's/.*"dnsZoneFile":"\(.*\)"}\],"notFound.*/\1/p' | sed 's/\\n/\n/g; s/\\"/"/g')"
fi

# ---------- 8. systemd ----------
step "8/8 Start on boot"
if have systemctl && [ -d /etc/systemd/system ]; then
  render deploy/tern.service.tmpl > /etc/systemd/system/tern.service
  systemctl daemon-reload
  systemctl enable tern.service >/dev/null 2>&1 && ok "tern.service enabled (starts the stack at boot)"
  if [ "$STALWART_ENABLED" = 1 ]; then
    render deploy/tern-certsync.service.tmpl > /etc/systemd/system/tern-certsync.service
    render deploy/tern-certsync.timer.tmpl > /etc/systemd/system/tern-certsync.timer
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
if [ "$ADMIN_PASSWORD_GENERATED" = 1 ]; then say "  Password:       ${B}$ADMIN_PASSWORD${N}   ${D}(generated; change it in Settings → Security)${N}"; fi
[ "$AI_ENABLED" = 1 ] && say "  AI model:       $AI_MODEL  ${D}(change under Settings → AI)${N}"
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
  say "  2. At your DNS host, add an A record:  $STALWART_HOST → ${SERVER_IP:-<server IP>}"
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
