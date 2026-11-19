#!/usr/bin/env bash
# Offline checks for install.sh (no containers are started): syntax, generated config, idempotency,
# input validation and the exposed-ports policy of the compose overlay.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

bash -n install.sh && ok "install.sh syntax"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp docker-compose.prod.yml docker-compose.install.yml "$T/"; mkdir -p "$T/nginx"; cp nginx/nginx.conf "$T/nginx/"

# 1. HTTPS install
./install.sh --dry-run --dir "$T" --domain support.example.com --email ops@example.com >/dev/null
grep -q '^WEB_URL=https://support.example.com$' "$T/.env" || fail "WEB_URL"
grep -q '^COMPOSE_FILE=docker-compose.prod.yml:docker-compose.install.yml$' "$T/.env" || fail "COMPOSE_FILE"
grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "$T/.env" || fail "generated POSTGRES_PASSWORD"
grep -qE '^SECRETS_ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=$' "$T/.env" || fail "generated SECRETS_ENCRYPTION_KEY"
[ "$(stat -c %a "$T/.env")" = "600" ] || fail ".env must be mode 600"
grep -q '^support.example.com {' "$T/.install/Caddyfile" || fail "Caddyfile site"
grep -q 'email ops@example.com' "$T/.install/Caddyfile" || fail "Caddyfile email"
ok "HTTPS config generated"

# 2. Idempotency: secrets survive a second run, flags can change the domain
cp "$T/.env" "$T/.env.1"
./install.sh --dry-run --dir "$T" >/dev/null
for k in POSTGRES_PASSWORD SECRETS_ENCRYPTION_KEY GRAFANA_ADMIN_PASSWORD; do
  [ "$(grep "^$k=" "$T/.env.1")" = "$(grep "^$k=" "$T/.env")" ] || fail "$k changed on re-run"
done
ok "secrets are kept on re-run"

# 3. Plain HTTP install on a fresh dir
U="$(mktemp -d)"; trap 'rm -rf "$T" "$U"' EXIT
cp docker-compose.prod.yml docker-compose.install.yml "$U/"; mkdir -p "$U/nginx"; cp nginx/nginx.conf "$U/nginx/"
./install.sh --dry-run --dir "$U" --http-port 8080 >/dev/null
grep -qE '^WEB_URL=http://[^/]+:8080$' "$U/.env" || fail "HTTP URL with custom port"
grep -q '^:80 {' "$U/.install/Caddyfile" || fail "HTTP Caddyfile"
ok "HTTP config generated"

# 4. Input validation
for bad in "--domain not_a_domain" "--email nope" "--http-port 70000" "--admin-password short" "--ref -x"; do
  # shellcheck disable=SC2086
  if ./install.sh --dry-run --dir "$U" $bad >/dev/null 2>&1; then fail "accepted invalid input: $bad"; fi
done
ok "invalid input rejected"

# 5. Only Caddy is published on the host
if docker compose version >/dev/null 2>&1; then
  ( cd "$T" && docker compose --profile tools config --format json ) | python3 -c "
import json, sys
c = json.load(sys.stdin)
pub = sorted(n for n, s in c['services'].items() if s.get('ports'))
assert pub == ['caddy'], f'published services: {pub}'
assert c['services']['migrate']['profiles'] == ['tools']
" || fail "only caddy may publish ports"
  ok "only Caddy publishes ports"
else
  echo "skip: docker compose not available"
fi
# 6. licence key and demo data flags
./install.sh --dry-run --dir "$T" --license-key VQL1.abc_DEF-1.sig_2-x --demo-data >"$T/out.txt" 2>&1 || fail "licence/demo flags rejected"
grep -q '^VEQSIO_LICENSE_KEY=VQL1.abc_DEF-1.sig_2-x$' "$T/.env" || fail "licence key written to .env"
grep -q 'load demo data' "$T/out.txt" || fail "demo data step missing in the plan"
if ./install.sh --dry-run --dir "$T" --license-key not-a-key >/dev/null 2>&1; then fail "invalid licence key accepted"; fi
ok "licence key and demo data flags"

echo "installer checks passed"
