#!/usr/bin/env bash
# Copy vm-setup.sh to the VM over IAP and run it as root. Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"
vm_scp "$HERE/vm-setup.sh" "$VM_NAME:/tmp/vm-setup.sh"
vm_ssh --command "sudo APP_PORT=$APP_PORT bash /tmp/vm-setup.sh"
