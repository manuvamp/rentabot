// The credential locker: one per job, two directions, envelope-encrypted (docs/SECURITY.md).
//   access   (buyer -> seller): answers an access request of the signed contract. The seller can open it only while the job
//            is funded and not finished, and only while the access request is the one it was shared for. Shredded at job end.
//   handover (seller -> buyer): credentials the bot created, tied to a delivered unit. The buyer sees the metadata at once and
//            can open it only once that unit is paid (captured) or covered by an agreed settlement. Kept until the buyer
//            acknowledges it or 30 days after release, then shredded. A unit that is never paid is shredded when the job ends.
// Each item: a random data key encrypts the value (AES-256-GCM, AAD rab:locker:v2:<job>:<item>:<direction>); the data key is
// wrapped per recipient: end-to-end (ECDH P-256, the server cannot open it) or sealed under the server key (kid = srv_…).
// The server enforces the gates in both modes by withholding ciphertext and wraps. Shredding deletes the ciphertext and
// every wrap (SQLite secure_delete zeroes the freed pages); metadata and the audit stay.
// Values never go to the room, events, logs, errors or AI prompts: the room/delivery guard rejects text that contains a
// sealed value or looks like a credential, and the AI client scrubs registered values (intelligence/ai/redact-guard.ts).
import { createHash, hkdfSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LockerCiphertext,
  LockerSecret,
  PROTECTION_LABEL,
  TERMINAL_STATES,
  WrappedKey,
  b64,
  consentText,
  decryptValue,
  encryptValue,
  exportPublicJwk,
  generateLockerKeyPair,
  importPrivateJwk,
  jwkThumbprint,
  secretSummary,
  targetAllowed,
  unwrapWithKek,
  wrapWithKek,
  type ActionReceipt,
  type EncryptionKey,
  type ItemRef,
  type JobState,
  type LockerAuditEntry,
  type LockerDirection,
  type LockerItem,
  type PublicJwk,
  type RealAction,
  type Role,
} from '@rentabot/shared'
import { containsKnownValue, containsPlatformSecret, credentialPattern, forgetLockerValue, registerLockerValue, secretParts } from '../intelligence/ai/redact-guard.ts'
import type { CheckRunner } from './checks.ts'
import type { Actor, Domain } from './domain.ts'
import type { EscrowService } from './escrow.ts'
import type { JobRecord } from './model.ts'
import { keyFrom, unseal } from './secrets.ts'
import { OpError } from './types.ts'
import { hashCanonical, newId } from './util.ts'

const FUNDED_OPEN: JobState[] = ['IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'CURE', 'DISPUTED', 'RULED', 'APPEALED']
const DAY = 86_400_000
/** Handovers stay openable this long after release unless the buyer acknowledges them first. Real time, never demo-scaled. */
export const HANDOVER_RETENTION_MS = 30 * DAY
const MAX_KEYS_PER_AGENT = 20

export type LockerSurface = 'mcp' | 'rest' | 'web' | 'platform'
export interface LockerCaller {
  role: Role
  actor: Actor
  surface: LockerSurface
}

interface ItemRow {
  id: string
  job_id: string
  direction: LockerDirection
  kind: LockerItem['kind']
  protection: 'e2e' | 'sealed'
  label: string
  site: string
  access_id: string | null
  access_hash: string | null
  deliverable_id: string | null
  unit_ref: string | null
  from_role: 'buyer' | 'seller'
  from_agent: string
  server_run: number
  ciphertext: string | null
  created_at: string
  released_at: string | null
  expires_at: string | null
  shredded_at: string | null
  shred_reason: string | null
}
interface KeyRow {
  kid: string
  agent_id: string
  jwk: string
  fingerprint: string
  label: string
  custody: 'client' | 'server_run'
  created_at: string
  revoked_at: string | null
}

export interface PutInput {
  access_id?: string | undefined
  deliverable_id?: string | undefined
  unit_ref?: string | undefined
  label: string
  kind?: LockerItem['kind'] | undefined
  site: string
  secret?: LockerSecret | undefined
  value?: string | undefined
  item_id?: string | undefined
  ciphertext?: LockerCiphertext | undefined
  wraps?: WrappedKey[] | undefined
}

/** Key-encryption key for sealed items, derived from SEAL_KEY (separate from the v1 seal key by HKDF). */
async function kekFrom(sealKey: string): Promise<{ kid: string; key: CryptoKey }> {
  const raw = Buffer.from(hkdfSync('sha256', keyFrom(sealKey), 'rab:locker:v2', 'rab:locker:v2:kek', 32))
  const kid = `srv_${createHash('sha256').update('rab:locker:kid:').update(raw).digest('hex').slice(0, 16)}`
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  raw.fill(0)
  return { kid, key }
}

const accessHash = (rec: JobRecord, access_id: string) => {
  const a = rec.requirements?.access.find((x) => x.id === access_id)
  return a ? hashCanonical(a) : null
}
const unitKey = (deliverable_id: string | null, ref: string | null) => `${deliverable_id}|${ref}`

export class Locker {
  private d: Domain
  private checks: CheckRunner
  private escrow: EscrowService
  private kek!: { kid: string; key: CryptoKey }
  private oldKeks = new Map<string, CryptoKey>()
  /** Plaintext parts of live sealed items, by item id: the exact-match guard and the AI scrub registry. */
  private sealed = new Map<string, { job_id: string; parts: string[] }>()

  constructor(d: Domain, checks: CheckRunner, escrow: EscrowService) {
    this.d = d
    this.checks = checks
    this.escrow = escrow
  }

  get serverKid() {
    return this.kek.kid
  }

  /** Derive the server keys, migrate v1 secrets, re-wrap items sealed under a retired key, load the guard registry. */
  async init(oldSealKeys: string[] = []) {
    // Freed pages are overwritten with zeros, so a shredded ciphertext does not linger in the database file.
    this.d.db.raw.exec('PRAGMA secure_delete = ON')
    this.kek = await kekFrom(this.d.cfg.sealKey)
    for (const k of oldSealKeys) {
      const old = await kekFrom(k)
      if (old.kid !== this.kek.kid) this.oldKeks.set(old.kid, old.key)
    }
    await this.migrateV1()
    await this.rewrapRetired()
    for (const row of this.d.db.all<ItemRow>("SELECT * FROM locker_items WHERE protection = 'sealed' AND shredded_at IS NULL")) {
      try {
        this.remember(row, await this.decryptSealed(row))
      } catch {
        /* sealed under a key this server no longer has: it cannot be opened, so it cannot leak either */
      }
    }
  }

  // ---------- keys ----------

  private renderKey(r: KeyRow): EncryptionKey {
    return { kid: r.kid, agent_id: r.agent_id, jwk: JSON.parse(r.jwk) as PublicJwk, fingerprint: r.fingerprint, label: r.label, custody: r.custody, created_at: r.created_at, revoked_at: r.revoked_at }
  }
  keysOf(agent_id: string, activeOnly = true): EncryptionKey[] {
    return this.d.db
      .all<KeyRow>(`SELECT * FROM enc_keys WHERE agent_id = ? ${activeOnly ? 'AND revoked_at IS NULL' : ''} ORDER BY created_at`, agent_id)
      .map((r) => this.renderKey(r))
  }

  async registerKey(agent_id: string, jwk: PublicJwk, label: string, custody: 'client' | 'server_run' = 'client'): Promise<{ key: EncryptionKey; replayed: boolean }> {
    const clean: PublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
    try {
      await crypto.subtle.importKey('jwk', { ...clean, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
    } catch {
      throw new OpError('invalid_input', 'That is not a valid P-256 public key (the point is not on the curve).', 'Export the public key with exportPublicJwk() from @rentabot/shared or crypto.subtle.exportKey("jwk", publicKey).')
    }
    const fingerprint = await jwkThumbprint(clean)
    const same = this.d.db.get<KeyRow>('SELECT * FROM enc_keys WHERE agent_id = ? AND fingerprint = ? AND revoked_at IS NULL', agent_id, fingerprint)
    if (same) return { key: this.renderKey(same), replayed: true }
    if (this.keysOf(agent_id).length >= MAX_KEYS_PER_AGENT) throw new OpError('invalid_input', `You already have ${MAX_KEYS_PER_AGENT} active keys.`, 'Revoke keys you no longer use with revoke_encryption_key.')
    const kid = newId('ek')
    this.d.db.run('INSERT INTO enc_keys (kid, agent_id, jwk, fingerprint, label, custody, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', kid, agent_id, JSON.stringify(clean), fingerprint, label, custody, this.d.nowIso())
    return { key: this.renderKey(this.d.db.get<KeyRow>('SELECT * FROM enc_keys WHERE kid = ?', kid)!), replayed: false }
  }

  revokeKey(actor: Actor, kid: string): EncryptionKey {
    const r = this.d.db.get<KeyRow>('SELECT * FROM enc_keys WHERE kid = ?', kid)
    if (!r || !actor.agents.has(r.agent_id)) throw new OpError('not_found', `Key ${kid} not found.`, 'list_encryption_keys shows your keys.')
    if (!r.revoked_at) this.d.db.run('UPDATE enc_keys SET revoked_at = ? WHERE kid = ?', this.d.nowIso(), kid)
    return this.renderKey(this.d.db.get<KeyRow>('SELECT * FROM enc_keys WHERE kid = ?', kid)!)
  }

  /**
   * A house bot's key pair (HOUSE_BOTS=1): the private key is sealed under the server key in DATA_DIR and its public key is
   * registered with custody "server_run", so buyers see that the bot runs on Rent-A-Bot's servers.
   */
  async ensureServerRunKey(agent_id: string, dataDir = this.d.cfg.dataDir): Promise<{ kid: string; privateKey: CryptoKey }> {
    const file = join(dataDir, 'locker-house-keys.json')
    const store = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Record<string, { kid: string; kek: string; iv: string; ct: string }>
    const entry = store[agent_id]
    const active = entry ? this.d.db.get<KeyRow>('SELECT * FROM enc_keys WHERE kid = ? AND agent_id = ? AND revoked_at IS NULL', entry.kid, agent_id) : undefined
    const aad = (kid: string) => new TextEncoder().encode(`rab:house-key:v1:${agent_id}:${kid}`)
    if (entry && active) {
      const kek = entry.kek === this.kek.kid ? this.kek.key : this.oldKeks.get(entry.kek)
      if (kek) {
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.decode(entry.iv), additionalData: aad(entry.kid) }, kek, b64.decode(entry.ct)))
        const privateKey = await importPrivateJwk(JSON.parse(new TextDecoder().decode(plain)) as JsonWebKey)
        plain.fill(0)
        if (entry.kek !== this.kek.kid) await this.sealHouseKey(store, file, agent_id, entry.kid, privateKey, aad)
        return { kid: entry.kid, privateKey }
      }
    }
    const pair = await generateLockerKeyPair(true)
    const { key } = await this.registerKey(agent_id, await exportPublicJwk(pair.publicKey), 'house bot (server-run)', 'server_run')
    await this.sealHouseKey(store, file, agent_id, key.kid, pair.privateKey, aad)
    return { kid: key.kid, privateKey: pair.privateKey }
  }
  private async sealHouseKey(store: Record<string, unknown>, file: string, agent_id: string, kid: string, privateKey: CryptoKey, aad: (kid: string) => Uint8Array<ArrayBuffer>) {
    const jwk = new TextEncoder().encode(JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey)))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(kid) }, this.kek.key, jwk))
    jwk.fill(0)
    store[agent_id] = { kid, kek: this.kek.kid, iv: b64.encode(iv), ct: b64.encode(ct) }
    writeFileSync(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  }

  // ---------- gates ----------

  /** Unit keys whose handovers may be released: passed their checks AND covered by money actually captured for the seller
   *  (or secured by an agreed settlement), allocated unit by unit in delivery order at the quoted unit price. */
  private releasable(rec: JobRecord): { released: Set<string>; state: Map<string, 'passed' | 'failed' | 'pending'> } {
    const released = new Set<string>()
    const state = new Map<string, 'passed' | 'failed' | 'pending'>()
    const contract = this.d.buildContract(rec)
    if (!contract || !rec.delivery) return { released, state }
    const units = this.checks.units(rec)
    for (const [did, u] of Object.entries(units)) {
      for (const r of u.passed) state.set(unitKey(did, r), 'passed')
      for (const r of u.failed) state.set(unitKey(did, r), 'failed')
      for (const r of u.pending) state.set(unitKey(did, r), 'pending')
    }
    let budget = this.escrow.confirmedSellerGross(rec)
    if (rec.agreement && !TERMINAL_STATES.includes(rec.state)) budget = Math.max(budget, rec.agreement.secured_cents)
    if (budget <= 0) return { released, state }
    for (const d of contract.spec.deliverables) {
      const line = contract.quote.lines.find((l) => l.deliverable_id === d.id)
      const passed = units[d.id]?.passed ?? []
      if (!line || !passed.length) continue
      const price = Math.round(Number(line.unit_price) * 100)
      if (line.model === 'per_unit') {
        for (const ref of passed) {
          if (budget < price) break
          budget -= price
          released.add(unitKey(d.id, ref))
        }
      } else if (passed.length >= d.quantity && budget >= price) {
        budget -= price
        for (const ref of passed) released.add(unitKey(d.id, ref))
      }
    }
    return { released, state }
  }

  private accessOk(row: ItemRow, rec: JobRecord) {
    return !!row.access_id && !!row.access_hash && accessHash(rec, row.access_id) === row.access_hash
  }

  private status(row: ItemRow, rec: JobRecord, rel: ReturnType<Locker['releasable']>): Pick<LockerItem, 'status' | 'status_reason'> {
    if (row.shredded_at) return { status: 'shredded', status_reason: `Shredded: ${row.shred_reason ?? 'done'}.` }
    if (row.direction === 'access') {
      if (!this.accessOk(row, rec)) return { status: 'locked', status_reason: `Access request ${row.access_id} changed after this was shared, so it cannot be opened. Share it again.` }
      if (FUNDED_OPEN.includes(rec.state)) return { status: 'available', status_reason: 'The seller can open it until the job ends; then it is shredded.' }
      return { status: 'locked', status_reason: 'Opens for the seller once the escrow is funded.' }
    }
    const k = unitKey(row.deliverable_id, row.unit_ref)
    if (rel.released.has(k)) return { status: 'released', status_reason: `Paid: the buyer can open it${row.expires_at ? ` until ${row.expires_at}` : ' for 30 days'}. Change the password, then acknowledge.` }
    const st = rel.state.get(k)
    if (!st) return { status: 'locked', status_reason: `Unit ${row.unit_ref} of ${row.deliverable_id} has not been delivered yet.` }
    if (st === 'failed') return { status: 'locked', status_reason: 'The unit failed its checks: this is never released unless a settlement pays for it.' }
    if (st === 'pending') return { status: 'locked', status_reason: 'The unit\'s checks are still pending.' }
    return { status: 'locked', status_reason: 'The unit passed its checks; it opens once that unit is paid.' }
  }

  /** First time a handover is seen releasable: stamp released_at and the 30-day expiry. */
  private markReleased(rec: JobRecord, rows: ItemRow[], rel: ReturnType<Locker['releasable']>) {
    for (const r of rows) {
      if (r.direction !== 'handover' || r.shredded_at || r.released_at || !rel.released.has(unitKey(r.deliverable_id, r.unit_ref))) continue
      r.released_at = this.d.nowIso()
      r.expires_at = new Date(this.d.nowMs() + HANDOVER_RETENTION_MS).toISOString()
      this.d.db.run('UPDATE locker_items SET released_at = ?, expires_at = ? WHERE id = ?', r.released_at, r.expires_at, r.id)
      this.audit(rec.id, r.id, 'released', 'platform', 'Rent-A-Bot', 'platform', `Unit ${r.unit_ref} is paid; the buyer can open this until ${r.expires_at}.`)
    }
  }

  // ---------- rendering, audit ----------

  private rows(job_id: string): ItemRow[] {
    return this.d.db.all<ItemRow>('SELECT * FROM locker_items WHERE job_id = ? ORDER BY created_at, id', job_id)
  }
  private render(row: ItemRow, rec: JobRecord, rel: ReturnType<Locker['releasable']>): LockerItem {
    const opens = this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM locker_audit WHERE item_id = ? AND event = 'open'", row.id)?.n ?? 0
    return {
      id: row.id,
      job_id: row.job_id,
      direction: row.direction,
      kind: row.kind,
      protection: row.protection,
      protection_label: PROTECTION_LABEL[row.protection] + (row.protection === 'e2e' && row.server_run ? ' (sent by a server-run bot)' : ''),
      label: row.label,
      site: row.site,
      access_id: row.access_id,
      deliverable_id: row.deliverable_id,
      unit_ref: row.unit_ref,
      from_role: row.from_role,
      server_run_sender: !!row.server_run,
      ...this.status(row, rec, rel),
      created_at: row.created_at,
      released_at: row.released_at,
      expires_at: row.expires_at,
      shredded_at: row.shredded_at,
      shred_reason: row.shred_reason,
      opens: Number(opens),
    }
  }

  private who(a: Actor): string {
    const name = this.d.agent(a.agent_id)?.name ?? a.agent_id
    return a.user_id ? `${name} (person ${a.user_id})` : name
  }
  private audit(job_id: string, item_id: string | null, event: string, role: string, who: string, surface: LockerSurface, detail: string) {
    this.d.db.run('INSERT INTO locker_audit (job_id, item_id, event, role, who, surface, detail, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', job_id, item_id, event, role, who, surface, detail.slice(0, 400), this.d.nowIso())
  }
  auditLog(job_id: string): LockerAuditEntry[] {
    return this.d.db
      .all<{ ts: string; item_id: string | null; event: string; role: string; who: string; surface: LockerSurface; detail: string }>('SELECT ts, item_id, event, role, who, surface, detail FROM locker_audit WHERE job_id = ? ORDER BY id', job_id)
      .map((r) => ({ ...r }))
  }

  list(rec: JobRecord): LockerItem[] {
    const rows = this.rows(rec.id)
    const rel = this.releasable(rec)
    this.markReleased(rec, rows, rel)
    return rows.map((r) => this.render(r, rec, rel))
  }
  item(rec: JobRecord, item_id: string): LockerItem {
    const row = this.d.db.get<ItemRow>('SELECT * FROM locker_items WHERE id = ? AND job_id = ?', item_id, rec.id)
    if (!row) throw new OpError('not_found', `No locker item ${item_id} on this job.`, 'list_locker_items shows the job\'s items.')
    return this.render(row, rec, this.releasable(rec))
  }

  /** Access requests that have a live answer in the locker. */
  answeredAccess(job_id: string): Set<string> {
    return new Set(this.d.db.all<{ access_id: string }>("SELECT access_id FROM locker_items WHERE job_id = ? AND direction = 'access' AND shredded_at IS NULL", job_id).map((r) => r.access_id))
  }
  liveAccessItemIds(job_id: string): string[] {
    return this.d.db.all<{ id: string }>("SELECT id FROM locker_items WHERE job_id = ? AND direction = 'access' AND shredded_at IS NULL ORDER BY created_at", job_id).map((r) => r.id)
  }

  // ---------- put ----------

  async put(rec: JobRecord, c: LockerCaller, input: PutInput): Promise<LockerItem> {
    const direction: LockerDirection | null = c.role === 'buyer' ? 'access' : c.role === 'seller' ? 'handover' : null
    if (!direction) throw new OpError('forbidden', 'Only the buyer and the seller put items in the locker.', 'Arbiters read metadata with list_locker_items.')
    let accessHashV: string | null = null
    if (direction === 'access') {
      if (!input.access_id || input.deliverable_id || input.unit_ref)
        throw new OpError('invalid_input', 'As the buyer you answer an access request: send access_id (A1…) and no deliverable_id/unit_ref.', `Access requests on this job: ${(rec.requirements?.access ?? []).map((a) => a.id).join(', ') || 'none'}.`)
      accessHashV = accessHash(rec, input.access_id)
      if (!accessHashV) throw new OpError('invalid_input', `The seller did not request access ${input.access_id}.`, `Use one of: ${(rec.requirements?.access ?? []).map((a) => a.id).join(', ') || 'none requested'}.`)
    } else {
      if (!input.deliverable_id || !input.unit_ref || input.access_id)
        throw new OpError('invalid_input', 'As the seller you hand over credentials for a unit: send deliverable_id and unit_ref, and no access_id.', 'Use the unit ref you deliver (or delivered) with submit_delivery.')
      if (!rec.spec.deliverables.some((x) => x.id === input.deliverable_id)) throw new OpError('invalid_input', `Unknown deliverable ${input.deliverable_id}.`, `Deliverables: ${rec.spec.deliverables.map((x) => x.id).join(', ')}.`)
    }
    // Metadata is visible before release: it must not carry the secret.
    this.guardText(rec, [input.label, input.site, input.unit_ref ?? ''], c, 'item label or site')

    const sealedInput = input.secret ?? (input.value !== undefined ? { kind: 'secret' as const, value: input.value } : undefined)
    const e2e = input.item_id !== undefined || input.ciphertext !== undefined || input.wraps !== undefined
    if (!!sealedInput === e2e)
      throw new OpError('invalid_input', 'Send either `secret`/`value` (sealed by Rent-A-Bot) or `item_id` + `ciphertext` + `wraps` (end-to-end), not both or neither.', 'End-to-end: sealForRecipients() from @rentabot/shared with the keys from list_encryption_keys.')
    const recipient = direction === 'access' ? rec.seller_agent_id : rec.buyer_agent_id
    const id = e2e ? input.item_id : newId('sec')
    if (!id || (e2e && (!input.ciphertext || !input.wraps?.length)))
      throw new OpError('invalid_input', 'End-to-end items need item_id, ciphertext and at least one wrap.', 'Pick item_id with newLockerItemId() BEFORE encrypting: it is bound into the AAD.')
    if (this.d.db.get('SELECT id FROM locker_items WHERE id = ?', id)) throw new OpError('invalid_input', `Item id ${id} is already used.`, 'Generate a fresh one with newLockerItemId() and encrypt again.')
    const ref: ItemRef = { job_id: rec.id, item_id: id, direction }

    let kind: LockerItem['kind']
    let ciphertext: LockerCiphertext
    const wraps: WrappedKey[] = []
    let site = input.site
    let secret: LockerSecret | null = null
    if (e2e) {
      const active = new Set(this.keysOf(recipient).map((k) => k.kid))
      const kids = new Set<string>()
      for (const w of input.wraps!) {
        if (w.alg !== 'ECDH-ES+HKDF-SHA256+A256GCM' || !w.epk) throw new OpError('invalid_input', `Wrap ${w.kid} is not an end-to-end wrap.`, 'Use wrapForRecipient()/sealForRecipients().')
        if (!active.has(w.kid)) throw new OpError('invalid_input', `Wrap for ${w.kid}, which is not an active key of the ${direction === 'access' ? 'seller' : 'buyer'}.`, 'Fetch the current keys with list_encryption_keys {job_id} and encrypt again.')
        if (kids.has(w.kid)) throw new OpError('invalid_input', `Two wraps for ${w.kid}.`, 'One wrap per recipient key.')
        kids.add(w.kid)
        wraps.push(w)
      }
      kind = input.kind ?? 'secret'
      ciphertext = input.ciphertext!
    } else {
      const parsed = LockerSecret.safeParse(sealedInput)
      if (!parsed.success) throw new OpError('invalid_input', 'The secret does not match its kind (login needs url, username and password; api_key needs key; recovery_codes needs codes; note needs text).', 'See LockerSecret in docs/SECURITY.md.')
      secret = parsed.data
      if (input.kind && input.kind !== secret.kind) throw new OpError('invalid_input', `kind ${input.kind} does not match the secret's kind ${secret.kind}.`, 'Drop kind, or make them match.')
      kind = secret.kind
      if (!site) site = secretSummary(secret).site
      const { ciphertext: ct, dek } = await encryptValue(ref, secret)
      wraps.push(await wrapWithKek(ref, dek, this.kek.key, this.kek.kid))
      dek.fill(0)
      ciphertext = ct
    }

    const label = input.label
    const now = this.d.nowIso()
    const serverRun = this.d.db.get("SELECT kid FROM enc_keys WHERE agent_id = ? AND custody = 'server_run'", c.actor.agent_id) ? 1 : 0
    this.d.db.tx(() => {
      if (direction === 'access')
        for (const old of this.d.db.all<ItemRow>("SELECT * FROM locker_items WHERE job_id = ? AND direction = 'access' AND access_id = ? AND shredded_at IS NULL", rec.id, input.access_id!)) this.shredRow(rec, old, 'replaced by a newer answer', c)
      this.d.db.run(
        'INSERT INTO locker_items (id, job_id, direction, kind, protection, label, site, access_id, access_hash, deliverable_id, unit_ref, from_role, from_agent, server_run, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, rec.id, direction, kind, e2e ? 'e2e' : 'sealed', label, site.slice(0, 200), input.access_id ?? null, accessHashV, input.deliverable_id ?? null, input.unit_ref ?? null, c.role, c.actor.agent_id, serverRun, JSON.stringify(ciphertext), now,
      )
      for (const w of wraps) this.d.db.run('INSERT INTO locker_wraps (item_id, kid, data) VALUES (?, ?, ?)', id, w.kid, JSON.stringify(w))
    })
    if (secret) this.remember({ id, job_id: rec.id } as ItemRow, secret)
    const prot = PROTECTION_LABEL[e2e ? 'e2e' : 'sealed']
    this.audit(rec.id, id, 'put', c.role, this.who(c.actor), c.surface, `${direction} ${kind} "${label}" (${prot})`)
    const item = this.item(rec, id)
    if (direction === 'access') {
      const now_ = item.status === 'available'
      // body.secret_id keeps the v1 contract the bots read (get_secret / open_locker_item take it).
      this.d.system(rec, `The buyer put a ${kind} for access ${input.access_id} ("${label}") in the locker, ${prot}. ${now_ ? 'The seller can open it now.' : 'It opens for the seller once the escrow is funded.'}`, { secret_id: id, locker_item_id: id, access_id: input.access_id, protection: item.protection })
    } else {
      this.d.system(rec, `The seller handed over a ${kind}${site ? ` for ${site}` : ''} with unit ${input.unit_ref} of ${input.deliverable_id} ("${label}"), ${prot}. The buyer can open it once that unit is paid.`, { locker_item_id: id, deliverable_id: input.deliverable_id, unit_ref: input.unit_ref, protection: item.protection })
    }
    this.d.bus.publish('secret', rec.id, this.d.audience(rec), `Locker: ${direction} item added`, { locker_item_id: id, secret_id: id, direction, access_id: input.access_id ?? null, unit_ref: input.unit_ref ?? null, status: item.status })
    return item
  }

  // ---------- open ----------

  async open(rec: JobRecord, c: LockerCaller, item_id: string): Promise<{ item: LockerItem; secret?: LockerSecret; ciphertext?: LockerCiphertext; wraps?: WrappedKey[]; aad: string }> {
    const row = this.d.db.get<ItemRow>('SELECT * FROM locker_items WHERE id = ? AND job_id = ?', item_id, rec.id)
    if (!row) throw new OpError('not_found', 'No such locker item on this job.', 'list_locker_items shows the job\'s items.')
    const deny = (code: 'forbidden' | 'invalid_state', message: string, hint: string): never => {
      this.audit(rec.id, row.id, 'denied', c.role, this.who(c.actor), c.surface, message)
      throw new OpError(code, message, hint)
    }
    if (row.shredded_at) deny('invalid_state', `This item was shredded (${row.shred_reason ?? 'done'}).`, 'Ask the other side to put a new one if you still need it.')
    if (c.role !== 'buyer' && c.role !== 'seller') deny('forbidden', 'Locker values are only for the two parties; arbiters and the mediator never open them.', 'list_locker_items shows the metadata and the audit.')
    const rel = this.releasable(rec)
    if (row.direction === 'access') {
      if (c.role !== 'seller') deny('forbidden', 'Only the seller opens access items. To change one, shred it and put a new one.', 'list_locker_items shows its status.')
      if (!FUNDED_OPEN.includes(rec.state)) deny('invalid_state', `Access items open only while the job is funded and not finished (it is ${rec.state}).`, 'Wait for funding; after the job ends they are shredded.')
      if (!this.accessOk(row, rec)) deny('invalid_state', `Access request ${row.access_id} changed after this was shared.`, 'Ask the buyer to share it again for the current contract.')
    } else {
      if (c.role !== 'buyer') deny('forbidden', 'Only the buyer opens handovers. You already know what you created.', 'list_locker_items shows whether it was released.')
      if (!rel.released.has(unitKey(row.deliverable_id, row.unit_ref))) deny('invalid_state', `Not released: ${this.status(row, rec, rel).status_reason}`, 'Handovers open once their unit is paid (captured) or covered by an agreed settlement.')
      this.markReleased(rec, [row], rel)
    }
    const ref: ItemRef = { job_id: rec.id, item_id: row.id, direction: row.direction }
    const aad = `rab:locker:v2:${rec.id}:${row.id}:${row.direction}`
    const firstOpen = !this.d.db.get("SELECT id FROM locker_audit WHERE item_id = ? AND event = 'open' AND role = ?", row.id, c.role)
    let out: { item: LockerItem; secret?: LockerSecret; ciphertext?: LockerCiphertext; wraps?: WrappedKey[]; aad: string }
    if (row.protection === 'sealed') {
      let secret: LockerSecret
      try {
        secret = await this.decryptSealed(row)
      } catch {
        deny('invalid_state', 'This item was sealed under a server key this server no longer has; it cannot be opened.', 'Ask the other side to put it again.')
        throw new Error('unreachable')
      }
      out = { item: this.render(row, rec, rel), secret, aad }
    } else {
      const agent = c.role === 'seller' ? rec.seller_agent_id : rec.buyer_agent_id
      const active = new Set(this.keysOf(agent).map((k) => k.kid))
      const wraps = this.d.db.all<{ data: string }>('SELECT data FROM locker_wraps WHERE item_id = ?', row.id).map((w) => WrappedKey.parse(JSON.parse(w.data))).filter((w) => active.has(w.kid))
      if (!wraps.length) deny('invalid_state', 'None of your active keys can open this item (it was encrypted for keys you revoked or never had).', 'Restore the key from your recovery kit, or ask the other side to put it again for your current keys.')
      out = { item: this.render(row, rec, rel), ciphertext: LockerCiphertext.parse(JSON.parse(row.ciphertext!)), wraps, aad }
    }
    this.audit(rec.id, row.id, 'open', c.role, this.who(c.actor), c.surface, `${row.direction} ${row.kind} "${row.label}" (${PROTECTION_LABEL[row.protection]})`)
    if (firstOpen) this.d.system(rec, `The ${c.role} opened locker item "${row.label}" (${row.direction}, ${PROTECTION_LABEL[row.protection]}). Every open is in the locker audit.`, { locker_item_id: row.id })
    out.item = this.render(row, rec, rel)
    return out
  }

  // ---------- shred ----------

  shred(rec: JobRecord, c: LockerCaller, item_id: string, acknowledged: boolean): LockerItem {
    const row = this.d.db.get<ItemRow>('SELECT * FROM locker_items WHERE id = ? AND job_id = ?', item_id, rec.id)
    if (!row) throw new OpError('not_found', 'No such locker item on this job.', 'list_locker_items shows the job\'s items.')
    if (row.shredded_at) return this.item(rec, item_id)
    const released = !!row.released_at || this.releasable(rec).released.has(unitKey(row.deliverable_id, row.unit_ref))
    if (c.role === 'buyer') {
      if (acknowledged && (row.direction !== 'handover' || !released)) throw new OpError('invalid_input', 'acknowledged=true is for a released handover you took over.', 'To discard anything else, shred it with acknowledged=false.')
    } else if (c.role === 'seller') {
      if (acknowledged) throw new OpError('invalid_input', 'Only the buyer acknowledges handovers.', 'Shred with acknowledged=false.')
      if (row.direction === 'handover' && released) throw new OpError('forbidden', 'This handover was paid for and released: it is the buyer\'s now.', 'The buyer acknowledges or shreds it.')
    } else throw new OpError('forbidden', 'Only the buyer and the seller shred locker items.', 'list_locker_items shows the audit.')
    this.shredRow(rec, row, acknowledged ? 'the buyer took over the account and changed the password' : `shredded by the ${c.role}`, c)
    this.d.system(rec, `The ${c.role} ${acknowledged ? 'acknowledged' : 'shredded'} locker item "${row.label}"; its ciphertext and keys are deleted.`, { locker_item_id: row.id })
    this.d.bus.publish('secret', rec.id, this.d.audience(rec), 'Locker: item shredded', { locker_item_id: row.id, status: 'shredded' })
    return this.item(rec, item_id)
  }

  private shredRow(rec: Pick<JobRecord, 'id'>, row: ItemRow, reason: string, c: LockerCaller | null) {
    const now = this.d.nowIso()
    this.d.db.run('UPDATE locker_items SET ciphertext = NULL, shredded_at = ?, shred_reason = ? WHERE id = ?', now, reason, row.id)
    this.d.db.run('DELETE FROM locker_wraps WHERE item_id = ?', row.id)
    row.shredded_at = now
    row.shred_reason = reason
    const mem = this.sealed.get(row.id)
    if (mem) {
      for (const p of mem.parts) forgetLockerValue(p)
      this.sealed.delete(row.id)
    }
    this.audit(rec.id, row.id, c ? 'shred' : 'expire', c?.role ?? 'platform', c ? this.who(c.actor) : 'Rent-A-Bot', c?.surface ?? 'platform', reason)
  }

  /** Flush the WAL so shredded pages leave it too. */
  private checkpoint() {
    try {
      this.d.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* in-memory databases have no WAL */
    }
  }

  /** Job ended: shred every access item and every handover whose unit was not paid; start the clock on paid ones. */
  onTerminal(rec: JobRecord) {
    const rows = this.rows(rec.id).filter((r) => !r.shredded_at)
    if (!rows.length) return
    const rel = this.releasable(rec)
    this.markReleased(rec, rows, rel)
    for (const r of rows) {
      if (r.direction === 'access') this.shredRow(rec, r, `the job ended (${rec.state})`, null)
      else if (!rel.released.has(unitKey(r.deliverable_id, r.unit_ref))) this.shredRow(rec, r, `the job ended (${rec.state}) and this unit was not paid`, null)
    }
    this.checkpoint()
  }

  /** Shred handovers past their 30 days, and anything left on finished jobs (safety net). */
  tick() {
    const now = this.d.nowIso()
    let n = 0
    for (const r of this.d.db.all<ItemRow>('SELECT * FROM locker_items WHERE shredded_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?', now)) {
      this.shredRow({ id: r.job_id }, r, '30 days after release (the buyer did not acknowledge it)', null)
      n++
    }
    for (const r of this.d.db.all<ItemRow>(`SELECT li.* FROM locker_items li JOIN jobs j ON j.id = li.job_id WHERE li.shredded_at IS NULL AND li.released_at IS NULL AND j.state IN (${TERMINAL_STATES.map(() => '?').join(',')})`, ...TERMINAL_STATES)) {
      this.shredRow({ id: r.job_id }, r, 'the job ended', null)
      n++
    }
    if (n) this.checkpoint()
  }

  // ---------- crypto plumbing ----------

  private async decryptSealed(row: Pick<ItemRow, 'id' | 'job_id' | 'direction' | 'ciphertext'>): Promise<LockerSecret> {
    const w = this.d.db.get<{ data: string }>("SELECT data FROM locker_wraps WHERE item_id = ? AND kid LIKE 'srv_%'", row.id)
    if (!w || !row.ciphertext) throw new Error('no sealed wrap')
    const wrap = WrappedKey.parse(JSON.parse(w.data))
    const kek = wrap.kid === this.kek.kid ? this.kek.key : this.oldKeks.get(wrap.kid)
    if (!kek) throw new Error('unknown server key')
    const ref: ItemRef = { job_id: row.job_id, item_id: row.id, direction: row.direction }
    const dek = await unwrapWithKek(ref, wrap, kek)
    try {
      return await decryptValue(ref, LockerCiphertext.parse(JSON.parse(row.ciphertext)), dek)
    } finally {
      dek.fill(0)
    }
  }

  private remember(row: Pick<ItemRow, 'id' | 'job_id'>, secret: LockerSecret) {
    if (this.sealed.has(row.id)) return
    const parts = secretParts(secret as never)
    for (const p of parts) registerLockerValue(p)
    this.sealed.set(row.id, { job_id: row.job_id, parts })
  }

  /** Items whose sealed wrap uses a retired server key that is still configured (SEAL_KEYS_OLD): re-wrap under the current one. */
  private async rewrapRetired() {
    for (const [kid, kek] of this.oldKeks) {
      for (const r of this.d.db.all<{ item_id: string; data: string; job_id: string; direction: LockerDirection }>('SELECT w.item_id, w.data, i.job_id, i.direction FROM locker_wraps w JOIN locker_items i ON i.id = w.item_id WHERE w.kid = ?', kid)) {
        const ref: ItemRef = { job_id: r.job_id, item_id: r.item_id, direction: r.direction }
        const dek = await unwrapWithKek(ref, WrappedKey.parse(JSON.parse(r.data)), kek)
        const wrap = await wrapWithKek(ref, dek, this.kek.key, this.kek.kid)
        dek.fill(0)
        this.d.db.tx(() => {
          this.d.db.run('DELETE FROM locker_wraps WHERE item_id = ? AND kid = ?', r.item_id, kid)
          this.d.db.run('INSERT OR REPLACE INTO locker_wraps (item_id, kid, data) VALUES (?, ?, ?)', r.item_id, wrap.kid, JSON.stringify(wrap))
        })
      }
    }
  }

  /** v1 vault rows (secrets table, AES-GCM under SEAL_KEY) become sealed locker items; the v1 ciphertext is wiped. */
  private async migrateV1() {
    const rows = this.d.db.all<{ id: string; job_id: string; access_id: string; label: string; sealed: string; created_at: string }>('SELECT id, job_id, access_id, label, sealed, created_at FROM secrets WHERE sealed IS NOT NULL')
    if (!rows.length) return
    const v1 = keyFrom(this.d.cfg.sealKey)
    for (const s of rows) {
      const rec = this.d.tryLoad(s.job_id)
      let value: string | null = null
      try {
        value = unseal(v1, `${s.job_id}:${s.id}`, s.sealed)
      } catch {
        value = null
      }
      if (rec && value && !TERMINAL_STATES.includes(rec.state) && !this.d.db.get('SELECT id FROM locker_items WHERE id = ?', s.id)) {
        const ref: ItemRef = { job_id: s.job_id, item_id: s.id, direction: 'access' }
        const { ciphertext, dek } = await encryptValue(ref, { kind: 'secret', value })
        const wrap = await wrapWithKek(ref, dek, this.kek.key, this.kek.kid)
        dek.fill(0)
        this.d.db.tx(() => {
          this.d.db.run(
            "INSERT INTO locker_items (id, job_id, direction, kind, protection, label, site, access_id, access_hash, from_role, from_agent, ciphertext, created_at) VALUES (?, ?, 'access', 'secret', 'sealed', ?, '', ?, ?, 'buyer', ?, ?, ?)",
            s.id, s.job_id, s.label, s.access_id, accessHash(rec, s.access_id), rec.buyer_agent_id, JSON.stringify(ciphertext), s.created_at,
          )
          this.d.db.run('INSERT INTO locker_wraps (item_id, kid, data) VALUES (?, ?, ?)', s.id, wrap.kid, JSON.stringify(wrap))
        })
      }
      this.d.db.run('UPDATE secrets SET sealed = NULL, wiped_at = ? WHERE id = ?', this.d.nowIso(), s.id)
    }
    this.checkpoint()
  }

  // ---------- guard ----------

  /** Reject text that carries one of this job's sealed values, or anything that looks like a credential. Never echoes the value. */
  guardText(rec: JobRecord, texts: (string | undefined | null)[], c: LockerCaller, where: string) {
    const known = [...this.sealed.values()].filter((v) => v.job_id === rec.id).flatMap((v) => v.parts)
    for (const t of texts) {
      if (!t) continue
      if (containsKnownValue(t, known)) {
        this.audit(rec.id, null, 'blocked', c.role, this.who(c.actor), c.surface, `Blocked a ${where} that contained a locker value.`)
        throw new OpError('invalid_input', `Blocked: this ${where} contains a value from the job's locker. Credentials never go into the room, deliveries or inputs.`, 'Refer to the locker item by its label instead; the other side opens it with open_locker_item.')
      }
      if (containsPlatformSecret(t)) throw new OpError('invalid_input', `Blocked: this ${where} contains a credential the platform keeps for its bots. Credentials never go into the room, deliveries or inputs.`, 'Leave the value out; refer to the connection by name.')
      const p = credentialPattern(t)
      if (p) throw new OpError('invalid_input', `Blocked: this ${where} looks like it contains ${p}. Credentials never go into the room, deliveries or inputs.`, 'Put it in the locker with put_locker_item and refer to it by label. If this is a false alarm, rephrase (for example "password: [in locker]").')
    }
  }

  // ---------- consent and action receipts ----------

  private usage(job_id: string, access_id: string) {
    const since = new Date(this.d.nowMs() - DAY).toISOString()
    const total = this.d.db.get<{ n: number | null }>('SELECT SUM(count) AS n FROM locker_actions WHERE job_id = ? AND access_id = ? AND accepted = 1', job_id, access_id)?.n ?? 0
    const today = this.d.db.get<{ n: number | null }>('SELECT SUM(count) AS n FROM locker_actions WHERE job_id = ? AND access_id = ? AND accepted = 1 AND ts > ?', job_id, access_id, since)?.n ?? 0
    return { total: Number(total), today: Number(today) }
  }

  consentView(rec: JobRecord) {
    const answered = this.answeredAccess(rec.id)
    const bot = this.d.bot(rec.seller_bot_id)?.name ?? 'This bot'
    return (rec.requirements?.access ?? []).map((a) => {
      const u = this.usage(rec.id, a.id)
      return {
        access_id: a.id,
        kind: a.kind,
        required: a.required,
        text: consentText(a, bot),
        answered: answered.has(a.id),
        usage: a.consent ? { access_id: a.id, used_total: u.total, max_total: a.consent.max_total ?? null, used_today: u.today, max_per_day: a.consent.max_per_day ?? null } : null,
      }
    })
  }

  actions(job_id: string): ActionReceipt[] {
    return this.d.db
      .all<{ id: string; access_id: string | null; action: string; target: string; unit_ref: string | null; external_ref: string | null; count: number; accepted: number; reason: string; ts: string }>('SELECT * FROM locker_actions WHERE job_id = ? ORDER BY ts, id', job_id)
      .map((r) => ({ id: r.id, access_id: r.access_id, action: r.count > 1 ? `${r.action} ×${r.count}` : r.action, target: r.target, unit_ref: r.unit_ref, external_ref: r.external_ref, accepted: !!r.accepted, reason: r.reason, ts: r.ts }))
  }
  rejectedActions(job_id: string): number {
    return Number(this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM locker_actions WHERE job_id = ? AND accepted = 0', job_id)?.n ?? 0)
  }

  logAction(rec: JobRecord, c: LockerCaller, input: { action: RealAction; target: string; access_id?: string | undefined; unit_ref?: string | undefined; external_ref?: string | undefined; count: number }) {
    const grants = (rec.requirements?.access ?? []).filter((a) => !input.access_id || a.id === input.access_id)
    const grant = grants.find((a) => a.consent?.actions.includes(input.action))
    const record = (accepted: boolean, reason: string, access_id: string | null) => {
      const id = newId('act')
      this.d.db.run(
        'INSERT INTO locker_actions (id, job_id, access_id, action, target, unit_ref, external_ref, count, accepted, reason, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, rec.id, access_id, input.action, input.target, input.unit_ref ?? null, input.external_ref ?? null, input.count, accepted ? 1 : 0, reason, this.d.nowIso(),
      )
      return id
    }
    const reject = (reason: string, access_id: string | null): never => {
      record(false, reason, access_id)
      this.audit(rec.id, null, 'action_rejected', c.role, this.who(c.actor), c.surface, `${input.action} → ${input.target}: ${reason}`)
      this.d.system(rec, `Integrity: the seller reported ${input.action.replace('_', ' ')} → ${input.target}${input.count > 1 ? ` ×${input.count}` : ''}, which the buyer's consent does not allow (${reason}). It was rejected and flagged.`, { action: input.action, target: input.target, rejected: true, integrity_flag: true })
      throw new OpError('policy_blocked', `Not allowed by the buyer's consent: ${reason}.`, 'Do not take this action. list_locker_items shows the consent and what is left of it.')
    }
    // Credentials do not belong in receipts either.
    this.guardText(rec, [input.target, input.external_ref, input.unit_ref], c, 'action receipt')
    if (!grant) reject(input.access_id ? `access ${input.access_id} has no consent for ${input.action}` : `no access grant in the contract consents to ${input.action}`, input.access_id ?? null)
    const g = grant!
    const consent = g.consent!
    if (consent.until && this.d.nowMs() > Date.parse(consent.until)) reject(`the consent for ${g.id} ended ${consent.until}`, g.id)
    const allowed = consent.targets.length ? targetAllowed(input.target, consent.targets) : this.namedInContract(rec, input.target)
    if (!allowed) reject(consent.targets.length ? `${input.target} is not one of the consented targets` : `${input.target} is not named in the job spec (no targets were listed)`, g.id)
    const u = this.usage(rec.id, g.id)
    if (consent.max_total && u.total + input.count > consent.max_total) reject(`over the limit of ${consent.max_total} (already ${u.total})`, g.id)
    if (consent.max_per_day && u.today + input.count > consent.max_per_day) reject(`over the daily limit of ${consent.max_per_day} (already ${u.today} in the last 24 hours)`, g.id)
    const id = record(true, 'within consent', g.id)
    const after = this.usage(rec.id, g.id)
    this.audit(rec.id, null, 'action', c.role, this.who(c.actor), c.surface, `${input.action} → ${input.target}${input.external_ref ? ` (${input.external_ref})` : ''}`)
    this.d.system(
      rec,
      `Action: ${input.action.replace('_', ' ')} → ${input.target}${input.count > 1 ? ` ×${input.count}` : ''} via ${g.id} (${after.total}${consent.max_total ? `/${consent.max_total}` : ''} used${consent.max_per_day ? `, ${after.today}/${consent.max_per_day} in 24h` : ''}).`,
      { action: input.action, target: input.target, access_id: g.id, unit_ref: input.unit_ref ?? null, external_ref: input.external_ref ?? null, count: input.count },
    )
    const receipt = this.actions(rec.id).find((a) => a.id === id)!
    return { receipt, usage: { access_id: g.id, used_total: after.total, max_total: consent.max_total ?? null, used_today: after.today, max_per_day: consent.max_per_day ?? null } }
  }

  /** With no consented targets, a target must be named in the signed spec or inputs (its address, or its domain). */
  private namedInContract(rec: JobRecord, target: string): boolean {
    const hay = JSON.stringify({ spec: rec.spec, inputs: rec.inputs, answers: rec.answers }).toLowerCase()
    const t = target.trim().toLowerCase()
    if (t.length >= 4 && hay.includes(t)) return true
    let host = t.includes('@') ? t.split('@').pop()! : t
    try {
      host = new URL(host.includes('://') ? host : `https://${host}`).hostname
    } catch {
      /* keep */
    }
    return host.includes('.') && hay.includes(host)
  }
}
