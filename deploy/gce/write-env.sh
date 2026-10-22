#!/usr/bin/env bash
# Build /etc/rentabot/env on the VM from the local secret sources, without ever printing a secret.
#
#   bash deploy/gce/write-env.sh                       # (re)write; keeps existing SEAL_KEY and other VM-only values
#   bash deploy/gce/write-env.sh PAYPAL_API_BASE=https://paypal-egress.example.workers.dev
#   PAYPAL_EGRESS_SECRET=... bash deploy/gce/write-env.sh PAYPAL_EGRESS_SECRET     # value taken from your local env var
#   bash deploy/gce/write-env.sh --restart              # also restart the service afterwards
#
# Sources:
#   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET   <repo>/.env.paypal (gitignored)
#   ANTHROPIC_API_KEY                         gcloud secrets (orano-anthropic-api-key in orano-ai-backend)
#   SEAL_KEY                                  kept from the VM file if present, else a fresh random 32-byte hex
#   PAYPAL_WEBHOOK_ID, PAYPAL_API_BASE, PAYPAL_EGRESS_SECRET   kept from the VM file if present, else empty
#   WEB_EGRESS_URL, WEB_EGRESS_SECRET         kept from the VM file (set by deploy/cloudflare/web-egress/deploy.sh --vm-env)
# Other keys already in the VM file are left alone. Values only travel over IAP (scp) and sit briefly in a private temp file that is deleted on exit.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"
SECRET_PROJECT="${SECRET_PROJECT:-orano-ai-backend}"
SECRET_NAME="${SECRET_NAME:-orano-anthropic-api-key}"

declare -A cur=() set_=()
restart=0
for a in "$@"; do
  case "$a" in
    --restart) restart=1 ;;
    *=*) set_["${a%%=*}"]="${a#*=}" ;;
    *) [ -n "${!a:-}" ] || { echo "env var $a is empty or unset" >&2; exit 1; }; set_["$a"]="${!a}" ;;
  esac
done

# 1. what the VM has now (needed to keep SEAL_KEY stable: it seals job secrets in the database)
old="$(vm_ssh --command 'sudo cat /etc/rentabot/env' 2>/dev/null | tr -d '\r' || true)"
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] && cur["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
done <<<"$old"

# 2. secrets from their local sources
pp="$REPO/.env.paypal"
[ -f "$pp" ] || { echo "missing $pp" >&2; exit 1; }
pp_get() { sed -n "s/^$1=//p" "$pp" | head -1 | tr -d '\r"'"'"; }
pp_id="$(pp_get PAYPAL_CLIENT_ID)"; pp_secret="$(pp_get PAYPAL_CLIENT_SECRET)"
[ -n "$pp_id" ] && [ -n "$pp_secret" ] || { echo "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in .env.paypal" >&2; exit 1; }
anthropic="$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$SECRET_PROJECT" | tr -d '\r\n')"
[ -n "$anthropic" ] || { echo "could not read $SECRET_NAME" >&2; exit 1; }
seal="${cur[SEAL_KEY]:-}"
[ -n "$seal" ] || seal="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"

# 3. managed values (static config first, then secrets, then kept-from-VM, then explicit overrides)
declare -A out=()
for k in "${!cur[@]}"; do out["$k"]="${cur[$k]}"; done
out[NODE_ENV]=production
out[DEMO_MODE]=1
out[DEMO_TIME_SCALE]=60
out[HOUSE_BOTS]=1
out[PORT]="$APP_PORT"
out[HOST]=127.0.0.1
out[PUBLIC_URL]=https://rentabot.tech
out[DATA_DIR]=/var/lib/rentabot
out[PAYPAL_ENV]=sandbox
out[AI_PROVIDER]=anthropic
out[AI_SPEND_CAP_USD]=20
out[PAYPAL_CLIENT_ID]="$pp_id"
out[PAYPAL_CLIENT_SECRET]="$pp_secret"
out[ANTHROPIC_API_KEY]="$anthropic"
out[SEAL_KEY]="$seal"
for k in PAYPAL_WEBHOOK_ID PAYPAL_API_BASE PAYPAL_EGRESS_SECRET; do out[$k]="${out[$k]:-}"; done
for k in "${!set_[@]}"; do out[$k]="${set_[$k]}"; done

# 4. write. gcloud's plink wrapper on Windows eats stdin, so the file goes through a private temp file
#    (umask 077, deleted on exit) and scp over IAP; the VM copy in /tmp is removed right after install.
umask 077
SCRATCH="$(cygpath -u "${TEMP:-/tmp}" 2>/dev/null || echo "${TEMP:-/tmp}")/agent-scratch/rab-deploy-env"
mkdir -p "$SCRATCH"
trap 'rm -rf "$SCRATCH"' EXIT
{
  echo "# Managed by deploy/gce/write-env.sh. Mode 0640 root:rentabot."
  for k in $(printf '%s
' "${!out[@]}" | sort); do printf '%s=%s
' "$k" "${out[$k]}"; done
} > "$SCRATCH/rentabot-env"
(cd "$SCRATCH" && vm_scp rentabot-env "$VM_NAME:/tmp/rentabot-env")
vm_ssh --command 'sudo install -o root -g rentabot -m 0640 /tmp/rentabot-env /etc/rentabot/env && rm -f /tmp/rentabot-env'

echo "wrote /etc/rentabot/env with $(printf '%s\n' "${!out[@]}" | wc -l) keys (names only: $(printf '%s ' $(printf '%s\n' "${!out[@]}" | sort)))"
if [ "$restart" = 1 ]; then vm_ssh --command 'sudo systemctl restart rentabot && sleep 3 && systemctl is-active rentabot'; fi
