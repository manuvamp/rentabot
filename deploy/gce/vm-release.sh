#!/usr/bin/env bash
# Runs ON the VM as root (started by deploy.sh with REL and APP_PORT set): unpack the uploaded release,
# install dependencies, switch the `current` symlink, restart, health check, prune old releases.
set -euo pipefail
: "${REL:?}" "${APP_PORT:?}"
R=/opt/rentabot/releases/$REL
rm -rf "$R" && mkdir -p "$R/web"
tar -xzf /tmp/src.tgz -C "$R"
tar -xzf /tmp/web-dist.tgz -C "$R/web"
rm -f /tmp/src.tgz /tmp/web-dist.tgz /tmp/vm-release.sh
chown -R rentabot:rentabot "$R"
cd "$R"
# Runtime needs tsx (a devDependency of server), so a normal install of the server + bots workspaces.
sudo -u rentabot -H env npm_config_cache=/var/lib/rentabot/.npm npm ci -w server -w bots --ignore-scripts --no-audit --no-fund --loglevel=error
chown -R root:root "$R"
ln -sfn "$R" /opt/rentabot/current.new && mv -T /opt/rentabot/current.new /opt/rentabot/current
systemctl restart rentabot
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then echo "healthy after about $((i * 2))s"; break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:$APP_PORT/api/health"; echo
systemctl is-active rentabot
# keep the 3 newest releases
ls -1dt /opt/rentabot/releases/* | tail -n +4 | xargs -r rm -rf
