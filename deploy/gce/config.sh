#!/usr/bin/env bash
# Shared settings for the deploy scripts (sourced, no secrets). Override any of these from the environment.
# Your project and billing account come from the environment or from deploy/gce/config.local.sh (gitignored),
# for example: PROJECT_ID="my-project"  BILLING_ACCOUNT="000000-000000-000000" (billing is only needed by provision.sh).
_cfg_local="$(dirname "${BASH_SOURCE[0]}")/config.local.sh"
# shellcheck source=/dev/null
[ -f "$_cfg_local" ] && . "$_cfg_local"
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID, or create deploy/gce/config.local.sh}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-rentabot}"
NETWORK="${NETWORK:-rentabot-vpc}"
SUBNET="${SUBNET:-rentabot-subnet}"
APP_PORT="${APP_PORT:-8790}"

# IAP-tunnelled ssh / scp to the VM (it has no public IPv4 and no public inbound).
vm_ssh() { gcloud compute ssh "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE" --tunnel-through-iap --quiet "$@"; }
vm_scp() { gcloud compute scp --project="$PROJECT_ID" --zone="$ZONE" --tunnel-through-iap --quiet "$@"; }
