// Register (or update) the PayPal webhook for this deployment and print its id.
// Usage: node deploy/paypal-webhook.mjs [url]     (default https://rentabot.tech/api/paypal/webhook)
// Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV from .env.paypal (gitignored) or the environment.
// Run it from a machine with IPv4 (the VM has none). Prints the webhook id only, never a secret.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, '.env.paypal')
const cfg = { ...Object.fromEntries(existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]) : []), ...process.env }
const base = cfg.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
const url = process.argv[2] ?? 'https://rentabot.tech/api/paypal/webhook'
// Everything server/src/rails/webhook.ts normalizes and core/escrow.ts reacts to.
const EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.DENIED',
  'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'VAULT.PAYMENT-TOKEN.CREATED',
  'VAULT.PAYMENT-TOKEN.DELETED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
]

const api = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.name ?? ''} ${json.message ?? ''} ${JSON.stringify(json.details ?? '').slice(0, 300)}`)
  return json
}

const tok = await api('POST', '/v1/oauth2/token', 'grant_type=client_credentials', {
  authorization: `Basic ${Buffer.from(`${cfg.PAYPAL_CLIENT_ID}:${cfg.PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
  'content-type': 'application/x-www-form-urlencoded',
})
const auth = { authorization: `Bearer ${tok.access_token}` }
const existing = (await api('GET', '/v1/notifications/webhooks', undefined, auth)).webhooks ?? []
const mine = existing.find((w) => w.url === url)
let hook
if (mine) {
  hook = await api('PATCH', `/v1/notifications/webhooks/${mine.id}`, [{ op: 'replace', path: '/event_types', value: EVENTS.map((name) => ({ name })) }], auth)
  console.log('updated existing webhook')
} else {
  hook = await api('POST', '/v1/notifications/webhooks', { url, event_types: EVENTS.map((name) => ({ name })) }, auth)
  console.log('created webhook')
}
console.log('webhook_id', hook.id, 'url', hook.url, 'events', (hook.event_types ?? []).length)
