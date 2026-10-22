#!/usr/bin/env bash
# Create/refresh the Cloudflare Tunnel + DNS (deploy/cloudflare/tunnel.mjs) and install cloudflared on the VM.
# Needs .secrets/cloudflare-token.json. Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"
. "$HERE/../cloudflare/cf-env.sh"
umask 077
SCRATCH="$(cygpath -u "${TEMP:-/tmp}" 2>/dev/null || echo "${TEMP:-/tmp}")/agent-scratch/rab-cf"
mkdir -p "$SCRATCH"
trap 'rm -rf "$SCRATCH"' EXIT
(cd "$SCRATCH" && node "$(cygpath -m "$HERE" 2>/dev/null || echo "$HERE")/../cloudflare/tunnel.mjs" tunnel-token.txt)
cp "$HERE/vm-tunnel.sh" "$SCRATCH/vm-tunnel.sh"
(cd "$SCRATCH" && vm_scp tunnel-token.txt vm-tunnel.sh "$VM_NAME:/tmp/")
vm_ssh --command "sudo bash /tmp/vm-tunnel.sh"
