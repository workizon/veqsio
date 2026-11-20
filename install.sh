#!/usr/bin/env bash
#
# Veqsio installer: sets up the whole stack on a clean Linux server.
#
#   curl -fsSL https://raw.githubusercontent.com/workizon/veqsio/main/install.sh | sudo bash
#
# With your own domain (automatic HTTPS from Let's Encrypt):
#
#   curl -fsSL https://raw.githubusercontent.com/workizon/veqsio/main/install.sh \
#     | sudo bash -s -- --domain support.example.com --email admin@example.com
#
# What it does (idempotent: run it again to upgrade):
#   1. checks the OS, CPU, memory and disk; installs git, curl, openssl and Docker (with Compose) if missing
#   2. downloads Veqsio to /opt/veqsio
#   3. creates .env with freshly generated secrets (existing secrets are never overwritten)
#   4. builds the images, applies database migrations, creates the first administrator (optionally loads demo data)
#   5. starts PostgreSQL, Redis, API, web, the internal router and Caddy (the only public entry point)
#
# Supported: Ubuntu, Debian, RHEL-family (Rocky, Alma, CentOS Stream, Fedora, Amazon Linux), x86_64 and arm64.
# Needs about 2 GB RAM (the web build is memory hungry), 10 GB disk, and ports 80/443 open.

set -Eeuo pipefail

INSTALLER_VERSION="1.1"
DIR_DEFAULT="/opt/veqsio"
REPO_DEFAULT="https://github.com/workizon/veqsio.git"
REF_DEFAULT="main"

DIR=""
REPO="${VEQSIO_REPO_URL:-$REPO_DEFAULT}"
REF="${VEQSIO_REF:-$REF_DEFAULT}"
DOMAIN=""
SSL_EMAIL=""
HTTP_PORT=""
HTTPS_PORT=""
ADMIN_EMAIL=""
ADMIN_PASSWORD_ARG=""
SWAP=0
LICENSE_KEY=""
DEMO_DATA=0
DEMO_FLAG=0   # 1 when --demo-data was given (then the question is not asked)
NO_TELEMETRY=0
DRY=0
SKIP_FETCH=0
FORCE_FETCH=0

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
info() { printf '%s==>%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!!%s  %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Veqsio installer ${INSTALLER_VERSION}

Usage: install.sh [options]

  --domain NAME        public host name; enables HTTPS (Let's Encrypt via Caddy). Its DNS A/AAAA record must
                       point to this server and ports 80/443 must be reachable from the internet.
  --email ADDRESS      contact address for Let's Encrypt expiry notices (recommended with --domain)
  --dir PATH           install directory (default: ${DIR_DEFAULT})
  --ref REF            git branch or tag to install (default: ${REF_DEFAULT})
  --repo URL           git repository (default: ${REPO_DEFAULT})
  --http-port N        public HTTP port (default 80)
  --https-port N       public HTTPS port (default 443)
  --admin-email ADDR   e-mail of the first administrator (default: admin@<domain or veqsio.local>)
  --admin-password PW  password of the first administrator (default: random, shown once at the end)
  --license-key KEY    Enterprise licence key (VQL1...); unlocks the licensed modules. Can also be pasted later in
                       Administration > System > Licence.
  --demo-data          fill a NEW installation with demo users, projects and issues (for a public demo; never use on
                       a real instance). Demo users share the password demo12345.
  --swap               create a 2 GB swap file if the server has < 2 GB RAM and no swap
  --no-telemetry       do not send the anonymous daily usage count (version, edition, rough size; see docs/telemetry.md). Can also be switched off later
                       in Administration > Instance settings > Updates, or with VEQSIO_TELEMETRY=off in .env
  --update-source      always fetch the latest sources (default when started from a checkout: use it as is)
  --dry-run            print what would be done; only writes .env and the Caddyfile into --dir
  -h, --help           this help

Environment: VEQSIO_REPO_URL, VEQSIO_REF override the defaults.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) SSL_EMAIL="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --http-port) HTTP_PORT="${2:-}"; shift 2 ;;
    --https-port) HTTPS_PORT="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD_ARG="${2:-}"; shift 2 ;;
    --license-key) LICENSE_KEY="${2:-}"; shift 2 ;;
    --demo-data) DEMO_DATA=1; DEMO_FLAG=1; shift ;;
    --swap) SWAP=1; shift ;;
    --no-telemetry) NO_TELEMETRY=1; shift ;;
    --update-source) FORCE_FETCH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------- input validation
valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; }
valid_email()  { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
valid_port()   { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
valid_ref()    { [[ "$1" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] && [[ "$1" != -* ]]; }

[ -z "$DOMAIN" ] || valid_domain "$DOMAIN" || die "--domain must be a host name like support.example.com"
[ -z "$SSL_EMAIL" ] || valid_email "$SSL_EMAIL" || die "--email is not a valid address"
[ -z "$ADMIN_EMAIL" ] || valid_email "$ADMIN_EMAIL" || die "--admin-email is not a valid address"
[ -z "$HTTP_PORT" ] || valid_port "$HTTP_PORT" || die "--http-port must be 1-65535"
[ -z "$HTTPS_PORT" ] || valid_port "$HTTPS_PORT" || die "--https-port must be 1-65535"
valid_ref "$REF" || die "--ref contains unsupported characters"
[ -z "$LICENSE_KEY" ] || [[ "$LICENSE_KEY" =~ ^VQL1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || die "--license-key does not look like a Veqsio licence key (VQL1.<payload>.<signature>)"
if [ -n "$ADMIN_PASSWORD_ARG" ]; then
  [ "${#ADMIN_PASSWORD_ARG}" -ge 12 ] || die "--admin-password must be at least 12 characters"
  [[ "$ADMIN_PASSWORD_ARG" =~ ^[A-Za-z0-9@%+=:,.^_-]+$ ]] || die "--admin-password may only contain letters, digits and @ % + = : , . ^ _ -"
fi

# ---------------------------------------------------------------- where to install
SCRIPT_SRC="${BASH_SOURCE[0]:-}"
if [ -z "$DIR" ] && [ -n "$SCRIPT_SRC" ] && [ -f "$SCRIPT_SRC" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"
  if [ -f "$SCRIPT_DIR/docker-compose.prod.yml" ] && [ -f "$SCRIPT_DIR/docker-compose.install.yml" ]; then
    DIR="$SCRIPT_DIR"      # started from a checkout: install in place
    SKIP_FETCH=1
  fi
fi
[ -n "$DIR" ] || DIR="$DIR_DEFAULT"
[ "$FORCE_FETCH" -eq 0 ] || SKIP_FETCH=0

run() {
  if [ "$DRY" -eq 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi
}

on_error() {
  local code=$? line=$1
  printf '%sInstallation failed%s (exit %s at line %s).\n' "$R" "$N" "$code" "$line" >&2
  if [ -d "$DIR" ] && [ -f "$DIR/.env" ] && command -v docker >/dev/null 2>&1; then
    echo "Look at the logs:  cd $DIR && docker compose logs --tail=100" >&2
  fi
  echo "It is safe to run the installer again." >&2
}
trap 'on_error $LINENO' ERR

# ---------------------------------------------------------------- system checks
require_root() {
  [ "$DRY" -eq 1 ] && return 0
  [ "$(id -u)" -eq 0 ] || die "run as root, e.g.:  curl -fsSL <url>/install.sh | sudo bash   (or: sudo ./install.sh)"
}

PKG=""
detect_os() {
  [ "$(uname -s)" = "Linux" ] || die "Linux is required (found $(uname -s))"
  case "$(uname -m)" in x86_64|amd64|aarch64|arm64) ;; *) die "unsupported CPU architecture: $(uname -m)" ;; esac
  [ -r /etc/os-release ] || die "cannot detect the distribution (/etc/os-release missing)"
  # read in a subshell: os-release defines VERSION, ID, NAME... and must not clobber our own variables
  local os_id os_like os_name
  os_id="$(. /etc/os-release; printf '%s' "${ID:-}")"
  os_like="$(. /etc/os-release; printf '%s' "${ID_LIKE:-}")"
  os_name="$(. /etc/os-release; printf '%s' "${PRETTY_NAME:-${NAME:-unknown}}")"
  local ids=" $os_id $os_like "
  case "$ids" in
    *" ubuntu "*|*" debian "*) PKG="apt" ;;
    *" rhel "*|*" centos "*|*" fedora "*|*" rocky "*|*" almalinux "*|*" amzn "*) PKG="dnf" ;;
    *) die "unsupported distribution '$os_name'. Install Docker with the Compose plugin and git manually, then run ./install.sh from a checkout." ;;
  esac
  if [ "$PKG" = "dnf" ] && ! command -v dnf >/dev/null 2>&1; then PKG="yum"; fi
  info "Detected $os_name ($(uname -m)), package manager: $PKG"
}

check_resources() {
  local mem_kb swap_kb avail_gb parent
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  swap_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  parent="$DIR"; while [ ! -d "$parent" ] && [ "$parent" != "/" ]; do parent="$(dirname "$parent")"; done
  avail_gb=$(df -Pk "$parent" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}')
  [ "${avail_gb:-0}" -ge 8 ] || warn "only ${avail_gb:-?} GB free on $parent; at least 10 GB is recommended (images, database, uploads)"
  if [ "$mem_kb" -lt 1900000 ] && [ "$swap_kb" -eq 0 ]; then
    if [ "$SWAP" -eq 1 ]; then
      info "Creating a 2 GB swap file (RAM is below 2 GB)"
      run fallocate -l 2G /swapfile || run dd if=/dev/zero of=/swapfile bs=1M count=2048
      run chmod 600 /swapfile
      run mkswap /swapfile
      run swapon /swapfile
      grep -q '^/swapfile ' /etc/fstab 2>/dev/null || { [ "$DRY" -eq 1 ] || echo '/swapfile none swap sw 0 0' >> /etc/fstab; }
    else
      warn "this server has less than 2 GB RAM and no swap; the web build may run out of memory. Re-run with --swap to add a swap file."
    fi
  fi
}

install_packages() {
  local missing=()
  for c in curl git openssl; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  [ -f /etc/ssl/certs/ca-certificates.crt ] || [ -d /etc/pki/ca-trust ] || missing+=("ca-certificates")
  if [ "${#missing[@]}" -eq 0 ]; then return 0; fi
  info "Installing packages: ${missing[*]}"
  case "$PKG" in
    apt) run apt-get update -y; run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" ;;
    dnf) run dnf install -y "${missing[@]}" ;;
    yum) run yum install -y "${missing[@]}" ;;
  esac
}

compose_ok() {
  # `!reset` in docker-compose.install.yml needs Compose 2.24+
  local v; v="$(docker compose version --short 2>/dev/null || true)"; v="${v#v}"
  [ -n "$v" ] || return 1
  local major minor; major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 24 ]; }
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && compose_ok; then
    info "Docker $(docker --version | awk '{print $3}' | tr -d ,) with Compose $(docker compose version --short) found"
    return 0
  fi
  local os_id os_ver; os_id="$(. /etc/os-release; printf '%s' "${ID:-}")"; os_ver="$(. /etc/os-release; printf '%s' "${VERSION_ID:-}")"
  case "$os_id" in
    rocky|almalinux|rhel|centos)
      # get.docker.com builds the repo URL from $releasever, which is "9.8" on Rocky/Alma 9.8 and has no
      # such directory on download.docker.com (404). Add the CentOS repo pinned to the major version instead.
      info "Installing Docker Engine and the Compose plugin (Docker CE repository for RHEL ${os_ver%%.*})"
      run dnf install -y dnf-plugins-core
      run curl -fsSL https://download.docker.com/linux/centos/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo
      run sed -i "s/\$releasever/${os_ver%%.*}/g" /etc/yum.repos.d/docker-ce.repo
      run dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *)
      info "Installing Docker Engine and the Compose plugin (official get.docker.com script)"
      local tmp; tmp="$(mktemp)"
      run curl -fsSL https://get.docker.com -o "$tmp"
      run sh "$tmp"
      rm -f "$tmp"
      ;;
  esac
  if [ "$DRY" -eq 0 ]; then
    command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
    compose_ok || die "Docker Compose 2.24+ is required but was not found after installing Docker"
  fi
}

# Containers and image builds use the IPv4-only docker0 network. If the host resolves names through IPv6-only
# nameservers (the Hetzner default on RHEL-family images), builds hang forever in `bun install`. In that case give
# Docker public IPv4 resolvers, but never overwrite an existing /etc/docker/daemon.json.
ensure_docker_dns() {
  [ "$DRY" -eq 0 ] || return 0
  [ -f /etc/docker/daemon.json ] && return 0
  local ns; ns="$(awk '/^nameserver[ \t]/ {print $2}' /etc/resolv.conf 2>/dev/null || true)"
  # act only when nameservers are listed and every one of them is IPv6 (a v4 or stub resolver such as 127.0.0.53 is handled by Docker)
  [ -n "$ns" ] || return 0
  ! printf '%s\n' "$ns" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || return 0
  info "The host has no usable IPv4 DNS server; configuring Docker to use 1.1.1.1 and 8.8.8.8"
  mkdir -p /etc/docker
  printf '{\n  "dns": ["1.1.1.1", "8.8.8.8"]\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
}

# ---------------------------------------------------------------- sources
fetch_source() {
  if [ "$SKIP_FETCH" -eq 1 ]; then info "Using the existing checkout in $DIR"; return 0; fi
  if [ ! -d "$DIR/.git" ] && [ -f "$DIR/docker-compose.install.yml" ]; then
    info "Using the Veqsio sources already present in $DIR (not a git checkout, so they are not updated)"
    return 0
  fi
  if [ -d "$DIR/.git" ]; then
    info "Updating sources in $DIR ($REF)"
    run git -C "$DIR" fetch --depth 1 origin "$REF"
    run git -C "$DIR" checkout -q FETCH_HEAD
  else
    [ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ] || die "$DIR exists and is not empty (and is not a Veqsio checkout)"
    info "Downloading Veqsio ($REF) to $DIR"
    run git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
  fi
}

# ---------------------------------------------------------------- configuration
declare -A ENVV=()
load_env() {
  [ -f "$DIR/.env" ] || return 0
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    k="${line%%=*}"; v="${line#*=}"; ENVV["$k"]="$v"
  done < "$DIR/.env"
}
rand_hex() { openssl rand -hex "$1"; }
rand_pw()  { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24; }
envget() { printf '%s' "${ENVV[$1]:-}"; }
envdefault() { [ -n "${ENVV[$1]:-}" ] || ENVV["$1"]="$2"; }

public_ip() {
  local ip=""
  if [ "$DRY" -eq 0 ]; then ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"; fi
  [[ "$ip" =~ ^[0-9a-fA-F:.]+$ ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "${ip:-localhost}"
}

NEW_INSTALL=0
write_config() {
  mkdir -p "$DIR" "$DIR/.install" "$DIR/backups"
  load_env
  [ -f "$DIR/.env" ] || NEW_INSTALL=1

  [ -z "$DOMAIN" ] || ENVV[VEQSIO_DOMAIN]="$DOMAIN"
  [ -z "$SSL_EMAIL" ] || ENVV[VEQSIO_SSL_EMAIL]="$SSL_EMAIL"
  [ -z "$HTTP_PORT" ] || ENVV[HTTP_PORT]="$HTTP_PORT"
  [ -z "$HTTPS_PORT" ] || ENVV[HTTPS_PORT]="$HTTPS_PORT"
  [ -z "$ADMIN_EMAIL" ] || ENVV[ADMIN_EMAIL]="$ADMIN_EMAIL"
  [ -z "$LICENSE_KEY" ] || ENVV[VEQSIO_LICENSE_KEY]="$LICENSE_KEY"
  [ "$NO_TELEMETRY" -eq 0 ] || ENVV[VEQSIO_TELEMETRY]="off"

  envdefault HTTP_PORT 80
  envdefault HTTPS_PORT 443
  envdefault VEQSIO_DOMAIN ""
  envdefault VEQSIO_SSL_EMAIL ""
  envdefault POSTGRES_USER veqsio
  envdefault POSTGRES_DB veqsio
  envdefault POSTGRES_PASSWORD "$(rand_hex 24)"
  envdefault SECRETS_ENCRYPTION_KEY "$(openssl rand -base64 32)"
  envdefault GRAFANA_ADMIN_USER admin
  envdefault GRAFANA_ADMIN_PASSWORD "$(rand_pw)"
  envdefault STORAGE_TYPE mock
  envdefault PAT_DEFAULT_EXPIRY_DAYS 90
  envdefault PAT_MAX_EXPIRY_DAYS 365
  envdefault SMTP_HOST ""
  envdefault SMTP_PORT 587
  envdefault SMTP_USER ""
  envdefault SMTP_PASS ""
  envdefault SMTP_FROM ""
  envdefault SMTP_TLS true
  envdefault VEQSIO_LICENSE_KEY ""

  local d; d="$(envget VEQSIO_DOMAIN)"
  local url
  if [ -n "$d" ]; then
    url="https://$d"; [ "$(envget HTTPS_PORT)" = "443" ] || url="$url:$(envget HTTPS_PORT)"
    envdefault ADMIN_EMAIL "admin@$d"
  else
    url="http://$(public_ip)"; [ "$(envget HTTP_PORT)" = "80" ] || url="$url:$(envget HTTP_PORT)"
    envdefault ADMIN_EMAIL "admin@veqsio.local"
  fi
  # URLs follow the domain/port flags on every run; everything else is preserved
  ENVV[WEB_URL]="$url"; ENVV[BASE_URL]="$url"; ENVV[NEXT_PUBLIC_API_URL]="$url"
  envdefault OIDC_REDIRECT_BASE_URL ""
  ENVV[COMPOSE_FILE]="docker-compose.prod.yml:docker-compose.install.yml"
  ENVV[COMPOSE_PROJECT_NAME]="veqsio"

  local order=(VEQSIO_DOMAIN VEQSIO_SSL_EMAIL HTTP_PORT HTTPS_PORT WEB_URL BASE_URL NEXT_PUBLIC_API_URL OIDC_REDIRECT_BASE_URL
    POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD SECRETS_ENCRYPTION_KEY STORAGE_TYPE
    PAT_DEFAULT_EXPIRY_DAYS PAT_MAX_EXPIRY_DAYS SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM SMTP_TLS
    VEQSIO_LICENSE_KEY VEQSIO_TELEMETRY GRAFANA_ADMIN_USER GRAFANA_ADMIN_PASSWORD ADMIN_EMAIL COMPOSE_FILE COMPOSE_PROJECT_NAME)
  local tmp="$DIR/.env.tmp" k
  umask 077
  {
    echo "# Generated by install.sh $INSTALLER_VERSION. Secrets below were created on first install: keep this file private."
    echo "# Edit values and run 'docker compose up -d' to apply (or re-run install.sh)."
    for k in "${order[@]}"; do printf '%s=%s\n' "$k" "${ENVV[$k]:-}"; done
    # keep unknown keys the operator added by hand
    for k in "${!ENVV[@]}"; do
      case " ${order[*]} " in *" $k "*) ;; *) printf '%s=%s\n' "$k" "${ENVV[$k]}" ;; esac
    done
  } > "$tmp"
  mv "$tmp" "$DIR/.env"
  chmod 600 "$DIR/.env"
  info ".env written ($([ "$NEW_INSTALL" -eq 1 ] && echo 'new secrets generated' || echo 'existing secrets kept'))"

  # Caddy: the only public listener. With a domain it obtains and renews certificates by itself.
  local caddy="$DIR/.install/Caddyfile"
  if [ -n "$d" ]; then
    {
      echo "{"
      [ -z "$(envget VEQSIO_SSL_EMAIL)" ] || echo "	email $(envget VEQSIO_SSL_EMAIL)"
      echo "}"
      echo
      echo "$d {"
      echo "	encode zstd gzip"
      echo "	reverse_proxy nginx:80"
      echo "}"
    } > "$caddy"
  else
    {
      echo "{"
      echo "	auto_https off"
      echo "}"
      echo
      echo ":80 {"
      echo "	reverse_proxy nginx:80"
      echo "}"
    } > "$caddy"
  fi
  chmod 644 "$caddy"
}

check_dns() {
  local d; d="$(envget VEQSIO_DOMAIN)"
  [ -n "$d" ] || return 0
  [ "$DRY" -eq 0 ] || return 0
  local resolved mine
  resolved="$(getent ahostsv4 "$d" 2>/dev/null | awk 'NR==1 {print $1}')"
  mine="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$resolved" ]; then
    warn "$d does not resolve yet. HTTPS will only work after its DNS record points to this server (${mine:-this IP})."
  elif [ -n "$mine" ] && [ "$resolved" != "$mine" ]; then
    warn "$d resolves to $resolved but this server's public IP looks like $mine. Let's Encrypt validation will fail until they match."
  else
    info "DNS check: $d -> $resolved"
  fi
}

open_firewall() {
  [ "$DRY" -eq 0 ] || return 0
  local h s; h="$(envget HTTP_PORT)"; s="$(envget HTTPS_PORT)"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    info "ufw is active: allowing ports $h and $s"
    ufw allow "$h/tcp" >/dev/null; ufw allow "$s/tcp" >/dev/null; ufw allow "$s/udp" >/dev/null
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    info "firewalld is active: allowing ports $h and $s"
    firewall-cmd --permanent --add-port="$h/tcp" --add-port="$s/tcp" --add-port="$s/udp" >/dev/null; firewall-cmd --reload >/dev/null
  fi
}

# ---------------------------------------------------------------- stack
dc() { (cd "$DIR" && docker compose "$@"); }

backup_before_upgrade() {
  [ "$NEW_INSTALL" -eq 0 ] || return 0
  [ "$DRY" -eq 0 ] || return 0
  if [ -n "$(dc ps -q postgres 2>/dev/null)" ]; then
    local f="$DIR/backups/pre-upgrade-$(date +%Y%m%d-%H%M%S).sql.gz"
    info "Backing up the database to $f"
    dc exec -T postgres pg_dump -U "$(envget POSTGRES_USER)" "$(envget POSTGRES_DB)" | gzip > "$f"
    chmod 600 "$f"
  fi
}

wait_healthy() {
  local deadline=$(( $(date +%s) + 420 )) st
  info "Waiting for the API and the web app to become healthy (the first start takes a few minutes)"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    st="$(docker inspect -f '{{.State.Health.Status}}' veqsio-api veqsio-web 2>/dev/null | tr '\n' ' ')"
    if [ "$st" = "healthy healthy " ]; then return 0; fi
    sleep 5
  done
  warn "services are not healthy yet (last status: ${st:-unknown}). Check:  cd $DIR && docker compose ps && docker compose logs --tail=100"
  return 1
}

# On a new installation with a terminal attached, offer to load demo data. Default is "no"; without a terminal
# (cron, automation, no /dev/tty) nothing is asked and nothing is loaded unless --demo-data was given.
ask_demo_data() {
  [ "$DEMO_FLAG" -eq 0 ] || return 0
  [ "$NEW_INSTALL" -eq 1 ] || return 0
  [ "$DRY" -eq 0 ] || return 0
  # /dev/tty can exist and look readable/writable yet fail to open (ssh without -t, cron): try to really open it
  { : </dev/tty >/dev/tty; } 2>/dev/null || return 0
  local answer=""
  printf '\n%s?%s  Load demo data (sample users, projects and issues, for trying Veqsio out)? [y/N] ' "$B" "$N" > /dev/tty
  read -r -t 60 answer < /dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) DEMO_DATA=1 ;; esac
}

# Build identifier shown in the footer and in /rest/api/2/serverInfo: the commit when this is a git checkout, else the UTC build time.
stamp_build() {
  [ -z "${VEQSIO_BUILD:-}" ] || return 0
  VEQSIO_BUILD="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d.%H%M)"
  export VEQSIO_BUILD
  info "Build $VEQSIO_BUILD"
}

start_stack() {
  backup_before_upgrade
  info "Building images (the first build takes 5-10 minutes)"
  stamp_build
  run dc build api web migrate
  info "Starting PostgreSQL and Redis"
  run dc up -d postgres redis
  if [ "$DRY" -eq 0 ]; then
    local i
    for i in $(seq 1 60); do
      [ "$(docker inspect -f '{{.State.Health.Status}}' veqsio-postgres 2>/dev/null)" = "healthy" ] && break
      sleep 2
    done
  fi
  info "Applying database migrations"
  run dc run --rm migrate

  ADMIN_PASSWORD_GENERATED=""
  ask_demo_data
  if [ "$DRY" -eq 1 ]; then
    echo "   [dry-run] create the first administrator if the users table is empty"
    [ "$DEMO_DATA" -eq 0 ] || echo "   [dry-run] load demo data"
  else
    local users
    users="$(dc exec -T postgres psql -U "$(envget POSTGRES_USER)" -d "$(envget POSTGRES_DB)" -tAc 'select count(*) from users' 2>/dev/null | tr -d '[:space:]' || echo 0)"
    if [ "${users:-0}" = "0" ]; then
      local pw="${ADMIN_PASSWORD_ARG:-$(rand_pw)}"
      info "Creating the first administrator ($(envget ADMIN_EMAIL))"
      ADMIN_EMAIL="$(envget ADMIN_EMAIL)" ADMIN_PASSWORD="$pw" dc run --rm migrate bun seed.ts >/dev/null
      ADMIN_PASSWORD_GENERATED="$pw"
      if [ "$DEMO_DATA" -eq 1 ]; then
        info "Loading demo data (users, projects, issues, sprints, dashboards)"
        dc run --rm migrate bun seed-demo.ts
      fi
      umask 077
      printf 'Veqsio administrator\nURL:      %s\nUsername: admin\nE-mail:   %s\nPassword: %s\n' \
        "$(envget WEB_URL)" "$(envget ADMIN_EMAIL)" "$pw" > "$DIR/.admin-credentials"
    else
      info "Users already exist: skipping the administrator seed"
      [ "$DEMO_DATA" -eq 0 ] || warn "--demo-data is only applied to a new, empty installation; skipped"
    fi
  fi

  info "Starting Veqsio"
  run dc up -d --remove-orphans postgres redis api web nginx caddy
  [ "$DRY" -eq 1 ] || wait_healthy || true
}

summary() {
  echo
  printf '%s================================================================%s\n' "$B" "$N"
  printf '%s Veqsio is installed%s\n' "$B" "$N"
  printf '%s================================================================%s\n' "$B" "$N"
  echo " Open:      $(envget WEB_URL)"
  if [ -n "${ADMIN_PASSWORD_GENERATED:-}" ]; then
    echo " Username:  admin"
    echo " Password:  ${ADMIN_PASSWORD_GENERATED}   <- shown once; also saved in $DIR/.admin-credentials (mode 600)"
    echo "            Change it after the first sign-in and delete that file."
  fi
  echo
  echo " Directory: $DIR"
  echo " Logs:      cd $DIR && docker compose logs -f"
  echo " Upgrade:   sudo bash $DIR/install.sh --update-source     (database is backed up first)"
  echo " Backups:   $DIR/backups"
  if [ "$(envget VEQSIO_TELEMETRY)" = "off" ]; then
    echo " Usage statistics: off (VEQSIO_TELEMETRY=off)."
  else
    echo " Usage statistics: once a day this server sends the project an anonymous count (random id, version, edition, rough number of users; no names,"
    echo "            addresses, host names or data). Details: docs/telemetry.md. Switch it off: re-run with --no-telemetry, or set VEQSIO_TELEMETRY=off in"
    echo "            $DIR/.env, or untick it in Administration > Instance settings > Updates."
  fi
  if [ -z "$(envget VEQSIO_DOMAIN)" ]; then
    echo
    echo " Served over plain HTTP. For HTTPS point a DNS name at this server and run:"
    echo "   sudo bash $DIR/install.sh --domain your.host.name --email you@example.com"
  fi
  if [ -z "$(envget SMTP_HOST)" ]; then
    echo
    echo " E-mail is not configured: set SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM in $DIR/.env"
    echo " (then 'docker compose up -d'), or use Admin > System > Mail server."
  fi
  echo
}

# ---------------------------------------------------------------- main
main() {
  info "Veqsio installer $INSTALLER_VERSION$([ "$DRY" -eq 1 ] && echo ' (dry run)')"
  require_root
  detect_os
  check_resources
  install_packages
  install_docker
  ensure_docker_dns
  fetch_source
  write_config
  check_dns
  open_firewall
  start_stack
  summary
}

main "$@"
