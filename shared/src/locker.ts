// The credential locker: shapes and envelope crypto shared by the server, the web app, the bot SDK and agents.
// One implementation on WebCrypto (globalThis.crypto.subtle), so the browser, Node and third-party runtimes all
// produce and open the same envelopes. Design and threat model: docs/SECURITY.md.
//
// Envelope (v2):
//  - each item has its own random 256-bit data key (DEK); the value is AES-256-GCM under the DEK with
//    AAD "rab:locker:v2:<job_id>:<item_id>:<direction>", so a ciphertext moved to another job, item or direction fails.
//  - the DEK is wrapped once per recipient key:
//      e2e   : ECDH P-256 with a fresh ephemeral key -> HKDF-SHA256 -> AES-256-GCM. Only the private key holder opens it.
//      sealed: AES-256-GCM under a key-encryption key derived from the server's SEAL_KEY (kid names which one).
//    A wrap's AAD adds the recipient kid, so a wrap cannot be replayed onto another item or another key.
import { z } from 'zod'
import { Timestamp, type Consent, type AccessRequest } from './protocol.ts'

// ---------- schemas ----------

export const LockerDirection = z.enum(['access', 'handover'])
export type LockerDirection = z.infer<typeof LockerDirection>

/** What the encrypted value holds. `secret` is a plain string (share_secret, forwarding addresses, tokens). */
export const LockerKind = z.enum(['login', 'api_key', 'recovery_codes', 'note', 'secret'])
export type LockerKind = z.infer<typeof LockerKind>

/** Who can unwrap the data key: only the recipient's private key (e2e), or the server's key (sealed). */
export const LockerProtection = z.enum(['e2e', 'sealed'])
export type LockerProtection = z.infer<typeof LockerProtection>

export const LockerItemId = z.string().regex(/^sec_[A-Za-z0-9]{6,40}$/, 'must look like sec_…')
export const KeyId = z.string().regex(/^ek_[A-Za-z0-9]{6,40}$/, 'must look like ek_…')

/** The plaintext, before encryption. Only ever exists in the recipient's memory (or the server's, for sealed items). */
export const LockerSecret = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('login'), url: z.string().max(2000), username: z.string().max(400), password: z.string().max(2000), notes: z.string().max(2000).default('') }),
  z.object({ kind: z.literal('api_key'), key: z.string().min(1).max(10_000), notes: z.string().max(2000).default('') }),
  z.object({ kind: z.literal('recovery_codes'), codes: z.array(z.string().max(200)).min(1).max(50), notes: z.string().max(2000).default('') }),
  z.object({ kind: z.literal('note'), text: z.string().min(1).max(10_000) }),
  z.object({ kind: z.literal('secret'), value: z.string().min(1).max(10_000) }),
])
export type LockerSecret = z.infer<typeof LockerSecret>

const B64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64').max(40_000)

/** A public EC P-256 key as JWK. A private key (`d`) is refused: it must never leave its owner. */
export const PublicJwk = z
  .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .loose()
  .refine((j) => !('d' in j), 'This is a PRIVATE key (it has "d"). Register only the public part; keep the private key to yourself.')
export type PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string }

export const WrappedKey = z.object({
  /** Recipient key id (ek_…) for e2e; the server key id (srv_…) for sealed. */
  kid: z.string().max(60),
  alg: z.enum(['ECDH-ES+HKDF-SHA256+A256GCM', 'A256GCM-KW']),
  /** Ephemeral public key (e2e only). */
  epk: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }).optional(),
  iv: B64,
  /** The wrapped data key (ciphertext + GCM tag). */
  ct: B64,
})
export type WrappedKey = z.infer<typeof WrappedKey>

export const LockerCiphertext = z.object({
  v: z.literal(2),
  alg: z.literal('A256GCM'),
  iv: B64,
  /** AES-256-GCM ciphertext + tag of the JSON LockerSecret. */
  ct: B64.max(60_000),
})
export type LockerCiphertext = z.infer<typeof LockerCiphertext>

/** Item metadata: everything except the secret. Safe to show both parties at any time. */
export const LockerItem = z.object({
  id: LockerItemId,
  job_id: z.string(),
  direction: LockerDirection,
  kind: LockerKind,
  protection: LockerProtection,
  /** "end-to-end" or "sealed by Rent-A-Bot": show it wherever the item is shown. */
  protection_label: z.string(),
  label: z.string(),
  /** Host the credential is for (handover logins), or ''. Not secret. */
  site: z.string(),
  /** access: the AccessRequest it answers. */
  access_id: z.string().nullable(),
  /** handover: the delivered unit it belongs to. */
  deliverable_id: z.string().nullable(),
  unit_ref: z.string().nullable(),
  /** Who put it in: the buyer (access) or the seller (handover). */
  from_role: z.enum(['buyer', 'seller']),
  /** The putter runs on Rent-A-Bot's servers (house bot): the server could see the value when it was made. */
  server_run_sender: z.boolean(),
  status: z.enum(['locked', 'available', 'released', 'shredded']),
  /** Plain words: why it is locked, or until when it is available. */
  status_reason: z.string(),
  created_at: Timestamp,
  released_at: Timestamp.nullable(),
  expires_at: Timestamp.nullable(),
  shredded_at: Timestamp.nullable(),
  shred_reason: z.string().nullable(),
  opens: z.int().nonnegative(),
})
export type LockerItem = z.infer<typeof LockerItem>

export const LockerAuditEntry = z.object({
  ts: Timestamp,
  item_id: z.string().nullable(),
  /** put, open, denied, acknowledge, shred, expire, action, action_rejected, key_registered, key_revoked */
  event: z.string(),
  role: z.string(),
  who: z.string(),
  surface: z.enum(['mcp', 'rest', 'web', 'platform']),
  detail: z.string(),
})
export type LockerAuditEntry = z.infer<typeof LockerAuditEntry>

export const EncryptionKey = z.object({
  kid: KeyId,
  agent_id: z.string(),
  jwk: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }),
  /** SHA-256 JWK thumbprint (RFC 7638), base64url; compare it out of band to trust a key. */
  fingerprint: z.string(),
  label: z.string(),
  /** client: the private key lives only with the agent/person. server_run: a house bot's key, sealed on Rent-A-Bot's server. */
  custody: z.enum(['client', 'server_run']),
  created_at: Timestamp,
  revoked_at: Timestamp.nullable(),
})
export type EncryptionKey = z.infer<typeof EncryptionKey>

export const ActionReceipt = z.object({
  id: z.string(),
  access_id: z.string().nullable(),
  action: z.string(),
  target: z.string(),
  unit_ref: z.string().nullable(),
  external_ref: z.string().nullable(),
  accepted: z.boolean(),
  reason: z.string(),
  ts: Timestamp,
})
export type ActionReceipt = z.infer<typeof ActionReceipt>

export const PROTECTION_LABEL: Record<LockerProtection, string> = { e2e: 'end-to-end', sealed: 'sealed by Rent-A-Bot' }

// ---------- consent in plain words ----------

const ACTION_WORDS: Record<string, [string, string]> = {
  send_email: ['send', 'emails'],
  fill_form: ['fill in', 'forms'],
  create_account: ['create', 'accounts'],
  post_content: ['post', 'times'],
  browse: ['open', 'pages'],
  call_api: ['make', 'API calls'],
  write: ['write', 'drafts'],
  analyze: ['run', 'analyses'],
}
const VIA: Record<AccessRequest['kind'], string> = {
  inbox_verification: 'your inbox (read verification mail)',
  inbox_send: 'your inbox',
  account_login: 'your login',
  api_key: 'your API key',
  target_endpoint: 'your endpoint',
  repo: 'your repository',
  other: 'this access',
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "This bot may send up to 40 emails (10 a day) via your inbox, only to x.com, until Nov 3." */
export function consentText(access: Pick<AccessRequest, 'kind' | 'scope'> & { consent?: Consent | undefined }, botName = 'This bot'): string {
  const c = access.consent
  if (!c) return `${botName} gets ${VIA[access.kind]} for: ${access.scope || 'the job'}. No action limits were set.`
  // Limits count every consented action of this grant together (log_action enforces the same rule).
  const words = c.actions.map((a) => ACTION_WORDS[a] ?? [a.replace('_', ' '), 'times'])
  const single = words.length === 1
  const acts = words.map(([verb, noun]) => (single && c.max_total ? `${verb} up to ${c.max_total} ${noun}` : `${verb} ${noun}`))
  const limits = [!single && c.max_total ? `up to ${c.max_total} actions in total` : '', c.max_per_day ? `at most ${c.max_per_day} a day` : ''].filter(Boolean)
  const perDay = limits.length ? ` (${limits.join(', ')})` : ''
  const to = c.targets.length ? `, only to ${c.targets.slice(0, 5).join(', ')}${c.targets.length > 5 ? ` and ${c.targets.length - 5} more` : ''}` : ', only to the targets the job names'
  const until = c.until ? `, until ${day(c.until)}` : ''
  return `${botName} may ${acts.join(' and ')}${perDay} via ${VIA[access.kind]}${to}${until}.`
}

/** Does `target` fall inside the consented targets? Domains match themselves and subdomains; addresses match exactly or by @domain. */
export function targetAllowed(target: string, allowed: string[]): boolean {
  const t = target.trim().toLowerCase()
  const host = t.includes('@') ? t.split('@').pop()! : (() => {
    try {
      return new URL(t.includes('://') ? t : `https://${t}`).hostname
    } catch {
      return t
    }
  })()
  return allowed.some((raw) => {
    const a = raw.trim().toLowerCase().replace(/^\*\./, '')
    if (!a) return false
    if (a.includes('@') && !a.startsWith('@')) return t === a
    const dom = a.replace(/^@/, '')
    return host === dom || host.endsWith(`.${dom}`)
  })
}

// ---------- crypto ----------

const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto (crypto.subtle) is not available; use a secure context (https) or Node 20+.')
  return s
}
const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64 = {
  encode(bytes: Uint8Array): string {
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(s)
  },
  decode(text: string): Uint8Array<ArrayBuffer> {
    const s = atob(text)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  },
}
const b64url = (bytes: Uint8Array) => b64.encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => globalThis.crypto.getRandomValues(new Uint8Array(n))

/** A fresh locker item id the client picks before encrypting (the id is bound into the AAD). */
export function newLockerItemId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const r = randomBytes(20)
  return `sec_${[...r].map((b) => alphabet[b % 62]).join('')}`
}

export const itemAad = (job_id: string, item_id: string, direction: LockerDirection) => `rab:locker:v2:${job_id}:${item_id}:${direction}`
export const wrapAad = (job_id: string, item_id: string, direction: LockerDirection, kid: string) => `${itemAad(job_id, item_id, direction)}:wrap:${kid}`

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

/** A new P-256 ECDH key pair. extractable=true so the owner can export a recovery kit. */
export async function generateLockerKeyPair(extractable = true): Promise<CryptoKeyPair> {
  return (await subtle().generateKey(ECDH, extractable, ['deriveBits'])) as CryptoKeyPair
}
export async function exportPublicJwk(key: CryptoKey): Promise<PublicJwk> {
  const j = await subtle().exportKey('jwk', key)
  return { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! }
}
export async function importPublicJwk(jwk: PublicJwk): Promise<CryptoKey> {
  return subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, ECDH, true, [])
}
export async function importPrivateJwk(jwk: JsonWebKey, extractable = false): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, ECDH, extractable, ['deriveBits'])
}
/** RFC 7638 thumbprint of an EC public key, base64url SHA-256. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  const canon = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
  return b64url(new Uint8Array(await subtle().digest('SHA-256', enc.encode(canon))))
}

async function aesKey(raw: Uint8Array<ArrayBuffer>, usage: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usage)
}
async function gcmEncrypt(key: CryptoKey, aad: string, plain: Uint8Array<ArrayBuffer>) {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain))
  return { iv: b64.encode(iv), ct: b64.encode(ct) }
}
async function gcmDecrypt(key: CryptoKey, aad: string, iv: string, ct: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: b64.decode(iv), additionalData: enc.encode(aad) }, key, b64.decode(ct)))
}

async function hkdfKey(sharedBits: ArrayBuffer, info: string): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('rab:locker:v2:ecdh'), info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export interface ItemRef {
  job_id: string
  item_id: string
  direction: LockerDirection
}

/** Encrypt a value under a fresh data key; returns the ciphertext and the raw data key (wrap it, then drop it). */
export async function encryptValue(ref: ItemRef, secret: LockerSecret): Promise<{ ciphertext: LockerCiphertext; dek: Uint8Array<ArrayBuffer> }> {
  const dek = randomBytes(32)
  const k = await aesKey(dek, ['encrypt'])
  const { iv, ct } = await gcmEncrypt(k, itemAad(ref.job_id, ref.item_id, ref.direction), enc.encode(JSON.stringify(LockerSecret.parse(secret))))
  return { ciphertext: { v: 2, alg: 'A256GCM', iv, ct }, dek }
}

export async function decryptValue(ref: ItemRef, ciphertext: LockerCiphertext, dek: Uint8Array<ArrayBuffer>): Promise<LockerSecret> {
  const k = await aesKey(dek, ['decrypt'])
  const plain = await gcmDecrypt(k, itemAad(ref.job_id, ref.item_id, ref.direction), ciphertext.iv, ciphertext.ct)
  return LockerSecret.parse(JSON.parse(dec.decode(plain)))
}

/** Wrap a data key for one recipient public key (ECDH-ES with an ephemeral key). */
export async function wrapForRecipient(ref: ItemRef, dek: Uint8Array<ArrayBuffer>, recipient: { kid: string; jwk: PublicJwk }): Promise<WrappedKey> {
  const eph = await generateLockerKeyPair(true)
  const pub = await importPublicJwk(recipient.jwk)
  const bits = await subtle().deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256)
  const aad = wrapAad(ref.job_id, ref.item_id, ref.direction, recipient.kid)
  const kek = await hkdfKey(bits, aad)
  const { iv, ct } = await gcmEncrypt(kek, aad, dek)
  return { kid: recipient.kid, alg: 'ECDH-ES+HKDF-SHA256+A256GCM', epk: await exportPublicJwk(eph.publicKey), iv, ct }
}

export async function unwrapWithPrivateKey(ref: ItemRef, wrap: WrappedKey, privateKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  if (wrap.alg !== 'ECDH-ES+HKDF-SHA256+A256GCM' || !wrap.epk) throw new Error('not an end-to-end wrap')
  const epk = await importPublicJwk(wrap.epk)
  const bits = await subtle().deriveBits({ name: 'ECDH', public: epk }, privateKey, 256)
  const aad = wrapAad(ref.job_id, ref.item_id, ref.direction, wrap.kid)
  return gcmDecrypt(await hkdfKey(bits, aad), aad, wrap.iv, wrap.ct)
}

/** Wrap / unwrap a data key under a symmetric key-encryption key (the server's sealed mode). */
export async function wrapWithKek(ref: ItemRef, dek: Uint8Array<ArrayBuffer>, kek: CryptoKey, kid: string): Promise<WrappedKey> {
  const { iv, ct } = await gcmEncrypt(kek, wrapAad(ref.job_id, ref.item_id, ref.direction, kid), dek)
  return { kid, alg: 'A256GCM-KW', iv, ct }
}
export async function unwrapWithKek(ref: ItemRef, wrap: WrappedKey, kek: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  if (wrap.alg !== 'A256GCM-KW') throw new Error('not a sealed wrap')
  return gcmDecrypt(kek, wrapAad(ref.job_id, ref.item_id, ref.direction, wrap.kid), wrap.iv, wrap.ct)
}

/** Client side, one call: encrypt a secret for every active recipient key. Returns what put_locker_item takes. */
export async function sealForRecipients(ref: ItemRef, secret: LockerSecret, recipients: { kid: string; jwk: PublicJwk }[]): Promise<{ ciphertext: LockerCiphertext; wraps: WrappedKey[] }> {
  if (!recipients.length) throw new Error('The recipient has no encryption key; use the server-sealed mode (send value) or ask them to register a key.')
  const { ciphertext, dek } = await encryptValue(ref, secret)
  const wraps = await Promise.all(recipients.map((r) => wrapForRecipient(ref, dek, r)))
  dek.fill(0)
  return { ciphertext, wraps }
}

/** Client side, one call: open an e2e item with one of your private keys. */
export async function openWithPrivateKey(ref: ItemRef, ciphertext: LockerCiphertext, wraps: WrappedKey[], keys: { kid: string; privateKey: CryptoKey }[]): Promise<LockerSecret> {
  for (const w of wraps) {
    const k = keys.find((x) => x.kid === w.kid)
    if (!k) continue
    const dek = await unwrapWithPrivateKey(ref, w, k.privateKey)
    try {
      return await decryptValue(ref, ciphertext, dek)
    } finally {
      dek.fill(0)
    }
  }
  throw new Error('None of your keys can open this item (it was encrypted for another key, or your key was revoked).')
}

// ---------- recovery kit: the private key under a passphrase ----------

export const RecoveryKit = z.object({
  kind: z.literal('rentabot-locker-recovery-kit'),
  v: z.literal(1),
  kid: z.string(),
  agent_id: z.string(),
  public_jwk: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }),
  kdf: z.object({ name: z.literal('PBKDF2-SHA256'), iterations: z.int().min(100_000), salt: B64 }),
  iv: B64,
  ct: B64,
  created_at: Timestamp,
})
export type RecoveryKit = z.infer<typeof RecoveryKit>

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function makeRecoveryKit(opts: { kid: string; agent_id: string; privateKey: CryptoKey; publicJwk: PublicJwk; passphrase: string; iterations?: number }): Promise<RecoveryKit> {
  if (opts.passphrase.length < 10) throw new Error('Use a passphrase of at least 10 characters.')
  const iterations = opts.iterations ?? 600_000
  const salt = randomBytes(16)
  const jwk = await subtle().exportKey('jwk', opts.privateKey)
  const k = await passphraseKey(opts.passphrase, salt, iterations)
  const { iv, ct } = await gcmEncrypt(k, `rab:recovery:v1:${opts.kid}`, enc.encode(JSON.stringify(jwk)))
  return { kind: 'rentabot-locker-recovery-kit', v: 1, kid: opts.kid, agent_id: opts.agent_id, public_jwk: opts.publicJwk, kdf: { name: 'PBKDF2-SHA256', iterations, salt: b64.encode(salt) }, iv, ct, created_at: new Date().toISOString() }
}

export async function openRecoveryKit(kit: RecoveryKit, passphrase: string, extractable = true): Promise<CryptoKey> {
  const k = await passphraseKey(passphrase, b64.decode(kit.kdf.salt), kit.kdf.iterations)
  let plain: Uint8Array<ArrayBuffer>
  try {
    plain = await gcmDecrypt(k, `rab:recovery:v1:${kit.kid}`, kit.iv, kit.ct)
  } catch {
    throw new Error('Wrong passphrase, or the recovery kit was changed.')
  }
  return importPrivateJwk(JSON.parse(dec.decode(plain)) as JsonWebKey, extractable)
}

/** A short one-line view of a secret for tables (never the password itself). */
export function secretSummary(s: LockerSecret): { username: string; site: string } {
  if (s.kind === 'login') {
    let site = s.url
    try {
      site = new URL(s.url.includes('://') ? s.url : `https://${s.url}`).hostname
    } catch {
      /* keep */
    }
    return { username: s.username, site }
  }
  return { username: '', site: '' }
}

/** The string a legacy reader (get_secret) gets: the value for `secret`, else the JSON. */
export const secretAsString = (s: LockerSecret) => (s.kind === 'secret' ? s.value : JSON.stringify(s))

// ---------- SDK: the same calls for bots (bots/src/rab.ts), agents and any third-party runtime ----------

/** Whatever calls an op by name (an MCP client, a REST wrapper) and returns its structured result. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpCaller = (name: string, args: Record<string, unknown>) => Promise<any>

export interface LockerKey {
  kid: string
  privateKey: CryptoKey
}

export function lockerClient(call: OpCaller) {
  return {
    /** Generate a key pair, register the public half, return the private key (keep it; it never leaves you). */
    async registerKey(label = 'runtime'): Promise<LockerKey & { publicJwk: PublicJwk }> {
      const pair = await generateLockerKeyPair(true)
      const publicJwk = await exportPublicJwk(pair.publicKey)
      const r = await call('register_encryption_key', { jwk: publicJwk, label })
      return { kid: r.key.kid as string, privateKey: pair.privateKey, publicJwk }
    },

    /**
     * Put a secret for the other side of a job: end-to-end when they have active keys, else sealed by Rent-A-Bot.
     * Buyer: pass access_id. Seller (handover of something the bot created): pass deliverable_id + unit_ref.
     */
    async put(opts: { job_id: string; secret: LockerSecret; label: string; site?: string; access_id?: string; deliverable_id?: string; unit_ref?: string; e2eOnly?: boolean }) {
      const direction: LockerDirection = opts.access_id ? 'access' : 'handover'
      const keys = await call('list_encryption_keys', { job_id: opts.job_id })
      const recipients = (direction === 'access' ? keys.seller : keys.buyer) as { kid: string; jwk: PublicJwk }[]
      const where = { job_id: opts.job_id, label: opts.label, site: opts.site ?? secretSummary(opts.secret).site, access_id: opts.access_id, deliverable_id: opts.deliverable_id, unit_ref: opts.unit_ref }
      if (!recipients.length) {
        if (opts.e2eOnly) throw new Error('The other side has no encryption key, and e2eOnly was set.')
        return call('put_locker_item', { ...where, secret: opts.secret })
      }
      const item_id = newLockerItemId()
      const sealed = await sealForRecipients({ job_id: opts.job_id, item_id, direction }, opts.secret, recipients)
      return call('put_locker_item', { ...where, kind: opts.secret.kind, item_id, ...sealed })
    },

    /** Open an item and return the secret in clear (sealed: from the server; end-to-end: decrypted here with your keys). */
    async open(job_id: string, item_id: string, keys: LockerKey[] = []): Promise<LockerSecret> {
      const r = await call('open_locker_item', { job_id, item_id })
      if (r.secret) return LockerSecret.parse(r.secret)
      return openWithPrivateKey({ job_id, item_id, direction: r.item.direction }, LockerCiphertext.parse(r.ciphertext), (r.wraps as unknown[]).map((w) => WrappedKey.parse(w)), keys)
    },
  }
}
