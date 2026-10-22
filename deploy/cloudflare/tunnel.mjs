// Idempotently create the remotely-managed Cloudflare Tunnel "rentabot", its ingress and the proxied DNS CNAMEs.
// Usage: node deploy/cloudflare/tunnel.mjs <token-out-file>
// Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment. Writes the tunnel run token to
// <token-out-file> (mode 0600) and prints only ids and statuses, never a secret.
import { writeFileSync } from 'node:fs'

const token = process.env.CLOUDFLARE_API_TOKEN
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const out = process.argv[2]
if (!token || !account || !out) throw new Error('need CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and an output file argument')

const ZONE = process.env.ZONE ?? 'rentabot.tech'
const NAME = process.env.TUNNEL_NAME ?? 'rentabot'
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8790'
const HOSTS = [ZONE, `www.${ZONE}`]

async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!json.success) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 400)}`)
  return json.result
}

let tunnel = (await cf('GET', `/accounts/${account}/cfd_tunnel?name=${NAME}&is_deleted=false`))[0]
if (!tunnel) tunnel = await cf('POST', `/accounts/${account}/cfd_tunnel`, { name: NAME, config_src: 'cloudflare' })
console.log('tunnel', tunnel.id, tunnel.name, tunnel.status)

await cf('PUT', `/accounts/${account}/cfd_tunnel/${tunnel.id}/configurations`, {
  config: { ingress: [...HOSTS.map((hostname) => ({ hostname, service: ORIGIN })), { service: 'http_status:404' }] },
})
console.log('ingress set:', HOSTS.join(', '), '->', ORIGIN)

const zone = (await cf('GET', `/zones?name=${ZONE}`))[0]
if (!zone) throw new Error(`zone ${ZONE} not found`)
console.log('zone', zone.id, zone.status)
const target = `${tunnel.id}.cfargotunnel.com`
for (const name of HOSTS) {
  const existing = (await cf('GET', `/zones/${zone.id}/dns_records?name=${name}`))[0]
  const record = { type: 'CNAME', name, content: target, proxied: true, ttl: 1 }
  if (existing) await cf('PUT', `/zones/${zone.id}/dns_records/${existing.id}`, record)
  else await cf('POST', `/zones/${zone.id}/dns_records`, record)
  console.log('dns', name, '->', target, 'proxied')
}

const runToken = await cf('GET', `/accounts/${account}/cfd_tunnel/${tunnel.id}/token`)
writeFileSync(out, String(runToken), { mode: 0o600 })
console.log('tunnel token written to the output file')
