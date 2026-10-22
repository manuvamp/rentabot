#!/usr/bin/env bash
# Deploy the current git HEAD to the VM. Never clones on the VM (GitHub has no IPv6): code is shipped from this PC.
#
#   bash deploy/gce/deploy.sh            # ships HEAD
#   REF=<commit> bash deploy/gce/deploy.sh
#
# Steps: build web/dist here -> git archive HEAD + web/dist -> scp over IAP -> unpack into a new release dir,
# `npm ci` (server + bots workspaces) -> switch /opt/rentabot/current -> restart -> health check.
# Only COMMITTED code is deployed: both the server code and the web build come from a clean export of REF.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"
cd "$REPO"

SCRATCH="$(cygpath -u "${TEMP:-/tmp}" 2>/dev/null || echo "${TEMP:-/tmp}")/agent-scratch/rab-deploy"
mkdir -p "$SCRATCH"
trap 'rm -rf "$SCRATCH"' EXIT
REF="${REF:-HEAD}"   # commit to ship (default HEAD)
REL="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short "$REF")"

echo "== build web from $REF (clean export, so uncommitted work in your tree is never shipped)"
mkdir -p "$SCRATCH/src"
git archive "$REF" | tar -x -C "$SCRATCH/src"
(cd "$SCRATCH/src" && npm ci -w web -w shared --no-audit --no-fund --loglevel=error && npm run build -w web >/dev/null)
[ -f "$SCRATCH/src/web/dist/index.html" ] || { echo "web/dist/index.html missing after build" >&2; exit 1; }

echo "== package $REL"
git archive --format=tar.gz "$REF" -o "$SCRATCH/src.tgz"
tar -czf "$SCRATCH/web-dist.tgz" -C "$SCRATCH/src/web" dist
ls -l "$SCRATCH"/*.tgz | awk '{print $5, $NF}'

echo "== upload"
# relative names from inside the scratch dir: a Windows drive path ("C:\...") would confuse scp as host:path
cp "$HERE/vm-release.sh" "$SCRATCH/vm-release.sh"
(cd "$SCRATCH" && vm_scp src.tgz web-dist.tgz vm-release.sh "$VM_NAME:/tmp/")

echo "== install on VM"
vm_ssh --command "sudo REL=$REL APP_PORT=$APP_PORT bash /tmp/vm-release.sh"
echo "== deployed $REL"
