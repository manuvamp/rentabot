#!/usr/bin/env bash
# Provision the free-tier GCE host for Rent-A-Bot. Idempotent: safe to re-run.
#
# Cost model (all inside the Compute Engine free tier):
#   - one e2-micro in us-central1 (free: 1 instance, 720 h/month)
#   - 30 GB pd-standard boot disk (free; pd-balanced / pd-ssd are NOT free)
#   - NO external IPv4 address (that costs $0.005/h), no Cloud NAT, no load balancer
#   - external IPv6 on the VM (free) is the only public address; internet egress goes out over IPv6
#   - no public inbound at all: SSH only through IAP; web traffic arrives through a Cloudflare Tunnel
#
# Usage (Git Bash on Windows or Linux/macOS, gcloud logged in as the owner):
#   bash deploy/gce/provision.sh
# Overrides: PROJECT_ID, BILLING_ACCOUNT, REGION, ZONE, VM_NAME.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"

say() { printf '\n== %s\n' "$*"; }

say "Project $PROJECT_ID"
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --name="Rent-A-Bot tech"
fi
if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
fi

say "APIs"
gcloud services enable compute.googleapis.com iap.googleapis.com --project="$PROJECT_ID"

say "Network $NETWORK / subnet $SUBNET (dual stack, external IPv6)"
if ! gcloud compute networks describe "$NETWORK" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute networks create "$NETWORK" --project="$PROJECT_ID" --subnet-mode=custom
fi
if ! gcloud compute networks subnets describe "$SUBNET" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute networks subnets create "$SUBNET" --project="$PROJECT_ID" --network="$NETWORK" --region="$REGION" \
    --range=10.10.0.0/24 --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL --enable-private-ip-google-access
fi

say "Firewall: tcp:22 from the IAP range only"
if ! gcloud compute firewall-rules describe allow-iap-ssh --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-iap-ssh --project="$PROJECT_ID" --network="$NETWORK" \
    --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=rentabot
fi

say "VM $VM_NAME ($ZONE)"
if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE"     --machine-type=e2-micro     --image-family=debian-12 --image-project=debian-cloud     --boot-disk-size=30GB --boot-disk-type=pd-standard     --network-interface="subnet=$SUBNET,no-address,stack-type=IPV4_IPV6,ipv6-network-tier=PREMIUM"     --tags=rentabot
fi

say "Result"
gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
  --format='value(name,status,machineType.basename(),networkInterfaces[0].networkIP,networkInterfaces[0].ipv6AccessConfigs[0].externalIpv6,disks[0].diskSizeGb)'
echo "External IPv4 addresses (must be empty):" \
  "$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
