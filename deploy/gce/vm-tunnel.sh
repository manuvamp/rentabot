#!/usr/bin/env bash
# Runs ON the VM as root (started by tunnel.sh): install the cloudflared tunnel as a systemd service. The tunnel run
# token comes from /tmp/tunnel-token.txt (uploaded by tunnel.sh) and is stored in /etc/cloudflared/token (0600),
# read through --token-file so it never appears in a command line or the unit file.
set -euo pipefail
install -d -m 0755 /etc/cloudflared
install -o root -g root -m 0600 /tmp/tunnel-token.txt /etc/cloudflared/token
rm -f /tmp/tunnel-token.txt /tmp/vm-tunnel.sh
cat > /etc/systemd/system/cloudflared-rentabot.service <<'UNIT'
[Unit]
Description=Cloudflare Tunnel for Rent-A-Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# The VM has no IPv4 address: reach the Cloudflare edge over IPv6.
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --edge-ip-version 6 run --token-file /etc/cloudflared/token
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable cloudflared-rentabot >/dev/null 2>&1
systemctl restart cloudflared-rentabot
sleep 8
systemctl is-active cloudflared-rentabot
journalctl -u cloudflared-rentabot --no-pager -n 15 | cut -c1-200
