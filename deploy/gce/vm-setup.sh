#!/usr/bin/env bash
# Runs ON the VM (as root): swap, Node, the rentabot user and directories, the systemd unit, cloudflared (installed,
# not configured). Idempotent. Run it from your PC with:  bash deploy/gce/setup.sh   (which copies and runs this).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo bash vm-setup.sh)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

NODE_MAJOR="${NODE_MAJOR:-24}"
APP_PORT="${APP_PORT:-8790}"

echo "== swap (2 GB)"
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=20' > /etc/sysctl.d/90-rentabot.conf
sysctl -q -p /etc/sysctl.d/90-rentabot.conf || true

echo "== packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg xz-utils unattended-upgrades >/dev/null

echo "== Node $NODE_MAJOR (official tarball, checksum verified)"
need_node=1
if [ -x /opt/node/bin/node ] && /opt/node/bin/node -v | grep -q "^v${NODE_MAJOR}\."; then need_node=0; fi
if [ "$need_node" = 1 ]; then
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v[0-9.]*-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node.new && mkdir /opt/node.new
  tar -xJf "$tmp/$file" -C /opt/node.new --strip-components=1
  rm -rf /opt/node && mv /opt/node.new /opt/node
  rm -rf "$tmp"
fi
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx
node -v; npm -v

echo "== user and directories"
id rentabot >/dev/null 2>&1 || useradd --system --home-dir /var/lib/rentabot --shell /usr/sbin/nologin rentabot
install -d -o rentabot -g rentabot -m 0750 /var/lib/rentabot
install -d -o root -g root -m 0755 /opt/rentabot /opt/rentabot/releases
install -d -o root -g rentabot -m 0750 /etc/rentabot
[ -f /etc/rentabot/env ] || install -o root -g rentabot -m 0640 /dev/null /etc/rentabot/env

echo "== journald (persistent, capped)"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/rentabot.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=200M
EOF
systemctl restart systemd-journald

echo "== systemd unit"
cat > /etc/systemd/system/rentabot.service <<EOF
[Unit]
Description=Rent-A-Bot (API, MCP, Sandbox Web, house bots, web app)
After=network-online.target
Wants=network-online.target
# A crash loop must not hammer the box: at most 10 restarts in 5 minutes, then stop and wait for a human.
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=rentabot
Group=rentabot
WorkingDirectory=/opt/rentabot/current
EnvironmentFile=/etc/rentabot/env
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=512
Environment=HOME=/var/lib/rentabot
ExecStart=/opt/rentabot/current/node_modules/.bin/tsx server/src/index.ts
Restart=always
RestartSec=5
MemoryMax=700M
MemorySwapMax=1G
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/rentabot
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable rentabot.service >/dev/null 2>&1

echo "== cloudflared (installed, not configured)"
if ! command -v cloudflared >/dev/null 2>&1; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared >/dev/null
fi
cloudflared --version

echo "== done (APP_PORT=$APP_PORT)"
free -m | sed -n 1,3p
df -h / | tail -1
