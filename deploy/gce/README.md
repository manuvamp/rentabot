# Rent-A-Bot on a free Google Compute Engine VM

One `e2-micro` (free tier, `us-central1`), 30 GB `pd-standard` disk, **no external IPv4** (that costs $0.005/h),
external **IPv6** only (free), no public inbound ports. SSH goes through IAP, web traffic arrives through a Cloudflare
Tunnel (cloudflared on the VM dials out). PayPal has no IPv6, so PayPal calls go through a Cloudflare Worker egress
proxy (`deploy/cloudflare/paypal-egress`, `PAYPAL_API_BASE`). Code is shipped from your PC; GitHub has no IPv6 either,
so never `git clone` on the VM.

Expected cost: $0/month (e2-micro, disk and IPv6 inside the free tier; Cloudflare Tunnel and Workers free plan).
Do not add: an external IPv4, Cloud NAT, a load balancer, pd-balanced/pd-ssd, snapshot schedules.

Settings live in `config.sh` (project, zone, VM name). Run everything from Git Bash with `gcloud` logged in as the owner.

| script | what it does |
|---|---|
| `provision.sh` | project billing link, APIs, custom VPC with a dual-stack subnet, IAP-only SSH firewall, the VM. Idempotent. |
| `setup.sh` (runs `vm-setup.sh` on the VM) | 2 GB swap, Node 24, `rentabot` user, `/opt/rentabot`, `/var/lib/rentabot`, `/etc/rentabot`, systemd unit, journald cap, cloudflared installed (not configured). Idempotent. |
| `write-env.sh` | builds `/etc/rentabot/env` from `.env.paypal` and Secret Manager, keeps the VM's `SEAL_KEY`. Never prints a secret. `KEY=VALUE` or `KEY` (value from your env) overrides, `--restart`. |
| `deploy.sh` | builds `web/dist`, ships `git archive HEAD` + `web/dist` over IAP, `npm ci`, switches `/opt/rentabot/current`, restarts, health check. Keeps 3 releases. |

First time: `provision.sh`, `setup.sh`, `write-env.sh`, `deploy.sh`. Redeploy: commit, then `deploy.sh`.

## Operate

```bash
. deploy/gce/config.sh
vm_ssh --command 'systemctl status rentabot --no-pager; journalctl -u rentabot -n 100 --no-pager'
vm_ssh --command 'curl -fsS http://127.0.0.1:8790/api/health'
```

The app listens on `127.0.0.1:8790` only (`HOST=127.0.0.1`); the tunnel must route to `http://127.0.0.1:8790`.
Data (SQLite, seal key, demo keys) is in `/var/lib/rentabot`.

## Cloudflare (tunnel, DNS, egress Worker, PayPal webhook)

Needs `.secrets/cloudflare-token.json` (`token`, `account_id`; gitignored). Nothing here prints a secret.

1. `bash deploy/gce/tunnel.sh`: creates the remotely managed tunnel `rentabot` (ingress `rentabot.tech` and
   `www.rentabot.tech` to `http://127.0.0.1:8790`, catch-all 404), proxied CNAMEs to `<tunnel-id>.cfargotunnel.com`, and
   installs `cloudflared-rentabot.service` on the VM with `--edge-ip-version 6` and `--token-file` (the token is not in
   any command line). The zone must use Cloudflare's nameservers before the hostnames resolve.
2. Worker: from `deploy/cloudflare/paypal-egress` run `npx wrangler deploy` (workers.dev subdomain `rentabot`), put a fresh
   `EGRESS_SECRET` with `wrangler secret put`, then
   `PAYPAL_EGRESS_SECRET=<same> bash deploy/gce/write-env.sh PAYPAL_API_BASE=https://rentabot-paypal-egress.rentabot.workers.dev PAYPAL_EGRESS_SECRET --restart`.
3. Web egress Worker (page fetches to IPv4-only sites by house bots and url_live/page_mentions checks):
   `bash deploy/cloudflare/web-egress/deploy.sh --vm-env` deploys `rentabot-web-egress`, keeps its secret in
   `.secrets/web-egress.json` and writes `WEB_EGRESS_URL` + `WEB_EGRESS_SECRET` to the VM env (no restart; the next
   app deploy picks them up). See `deploy/cloudflare/web-egress/README.md`.
4. Webhook: `node deploy/paypal-webhook.mjs` (from a machine with IPv4) prints the webhook id, then
   `bash deploy/gce/write-env.sh PAYPAL_WEBHOOK_ID=<id> --restart`.
