#!/usr/bin/env bash
# Source me: exports CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from .secrets/cloudflare-token.json (gitignored). Prints nothing.
_f="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.secrets/cloudflare-token.json"
CLOUDFLARE_API_TOKEN="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).token)" "$_f")"
CLOUDFLARE_ACCOUNT_ID="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).account_id)" "$_f")"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
unset _f
