#!/usr/bin/env bash
# Deploy the web egress Worker and (first time) generate its shared secret. Prints no secret.
#
#   bash deploy/cloudflare/web-egress/deploy.sh            # deploy; reuse the secret in .secrets/web-egress.json
#   bash deploy/cloudflare/web-egress/deploy.sh --rotate   # deploy with a fresh secret (then re-run write-env.sh)
#   bash deploy/cloudflare/web-egress/deploy.sh --vm-env   # also write WEB_EGRESS_URL/WEB_EGRESS_SECRET to the VM env (no restart)
#
# Needs .secrets/cloudflare-token.json ({token, account_id}; gitignored). Writes .secrets/web-egress.json ({url, secret}).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=../cf-env.sh
. "$HERE/../cf-env.sh"
STORE="$REPO/.secrets/web-egress.json"
rotate=0; vm=0
for a in "$@"; do case "$a" in --rotate) rotate=1 ;; --vm-env) vm=1 ;; *) echo "unknown arg $a" >&2; exit 1 ;; esac; done

umask 077
js() { node -e "$1" "$STORE" "${@:2}"; }
secret=""
[ "$rotate" = 0 ] && [ -f "$STORE" ] && secret="$(js "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).secret||'')")"
[ -n "$secret" ] || secret="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"

cd "$HERE"
out="$(npx --yes wrangler@4 deploy 2>&1)" || { echo "$out" >&2; exit 1; }
url="$(printf '%s\n' "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$url" ] || { echo "$out" >&2; echo "could not find the workers.dev URL in the deploy output" >&2; exit 1; }
printf '%s' "$secret" | npx --yes wrangler@4 secret put EGRESS_SECRET >/dev/null
EG_URL="$url" EG_SECRET="$secret" js "require('fs').writeFileSync(process.argv[1], JSON.stringify({url: process.env.EG_URL, secret: process.env.EG_SECRET}, null, 2) + '\n')"
echo "deployed $url (secret stored in .secrets/web-egress.json)"

if [ "$vm" = 1 ]; then
  WEB_EGRESS_SECRET="$secret" bash "$REPO/deploy/gce/write-env.sh" "WEB_EGRESS_URL=$url" WEB_EGRESS_SECRET
fi
