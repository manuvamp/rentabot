// The credential locker: envelope crypto, gating in every state, consent receipts, the redaction guard,
// and the no-plaintext-anywhere invariant (DB file, WAL, events, room, logs, AI-provider inputs).
// Every value here is an obvious fake.
import {
  PublicJwk,
  consentText,
  decryptValue,
  encryptValue,
  exportPublicJwk,
  generateLockerKeyPair,
  makeRecoveryKit,
  newLockerItemId,
  openRecoveryKit,
  openWithPrivateKey,
  sealForRecipients,
  targetAllowed,
  unwrapWithKek,
  unwrapWithPrivateKey,
  wrapWithKek,
  type LockerSecret,
  type WrappedKey,
} from '@rentabot/shared'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiUnavailable, type AiClient, type JsonCall } from '../../src/intelligence/ai/provider.ts'
import { guardAiClient, registerLockerValue, forgetLockerValue, scrubForAi } from '../../src/intelligence/ai/redact-guard.ts'
import { createNegotiator } from '../../src/intelligence/negotiation/negotiator.ts'
import { createPolicyGate } from '../../src/intelligence/policy/gate.ts'
import { createCopilot } from '../../src/intelligence/copilot/copilot.ts'
import { DAY, directorySpec, harness, units, type Harness } from './helpers.ts'

let h: Harness | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.close()
  h = null
})

const FAKE_PASSWORD = 'FAKE-pw-9f3c1e-not-a-real-password'
const FAKE_KEY = 'FAKE-apikey-7d2b8a64e1-not-real'
const FAKE_INBOX = 'FAKE-inbox-token-4c8e2f-not-real'

const ref = (job_id = 'job_AAAAAAAAAAAA', item_id = 'sec_BBBBBBBBBBBB', direction: 'access' | 'handover' = 'access') => ({ job_id, item_id, direction })

// ---------- envelope crypto ----------

describe('envelope crypto (WebCrypto, same code in browser and Node)', () => {
  const secret: LockerSecret = { kind: 'login', url: 'https://producthunt.example', username: 'orano-bot', password: FAKE_PASSWORD, notes: '' }

  it('round-trips end-to-end for every recipient key', async () => {
    const a = await generateLockerKeyPair()
    const b = await generateLockerKeyPair()
    const r = ref()
    const { ciphertext, wraps } = await sealForRecipients(r, secret, [
      { kid: 'ek_aaaaaaaa', jwk: await exportPublicJwk(a.publicKey) },
      { kid: 'ek_bbbbbbbb', jwk: await exportPublicJwk(b.publicKey) },
    ])
    expect(JSON.stringify({ ciphertext, wraps })).not.toContain(FAKE_PASSWORD)
    expect(await openWithPrivateKey(r, ciphertext, wraps, [{ kid: 'ek_bbbbbbbb', privateKey: b.privateKey }])).toEqual(secret)
    expect(await openWithPrivateKey(r, ciphertext, wraps, [{ kid: 'ek_aaaaaaaa', privateKey: a.privateKey }])).toEqual(secret)
  })

  it('detects tampering: wrong AAD (job, item, direction), wrong recipient, relabelled wrap, flipped bit', async () => {
    const me = await generateLockerKeyPair()
    const other = await generateLockerKeyPair()
    const r = ref()
    const { ciphertext, wraps } = await sealForRecipients(r, secret, [{ kid: 'ek_meeeeeee', jwk: await exportPublicJwk(me.publicKey) }])
    const mine = [{ kid: 'ek_meeeeeee', privateKey: me.privateKey }]
    await expect(openWithPrivateKey(ref('job_OTHERJOBXXXX'), ciphertext, wraps, mine)).rejects.toThrow()
    await expect(openWithPrivateKey(ref(undefined, 'sec_OTHERITEMXX'), ciphertext, wraps, mine)).rejects.toThrow()
    await expect(openWithPrivateKey(ref(undefined, undefined, 'handover'), ciphertext, wraps, mine)).rejects.toThrow()
    // Wrong recipient: someone else's private key under the same kid.
    await expect(openWithPrivateKey(r, ciphertext, wraps, [{ kid: 'ek_meeeeeee', privateKey: other.privateKey }])).rejects.toThrow()
    // A wrap relabelled to another kid fails (the kid is in the wrap AAD).
    const relabelled: WrappedKey[] = wraps.map((w) => ({ ...w, kid: 'ek_otherkid' }))
    await expect(openWithPrivateKey(r, ciphertext, relabelled, [{ kid: 'ek_otherkid', privateKey: me.privateKey }])).rejects.toThrow()
    // A flipped ciphertext bit fails authentication.
    const ct = Buffer.from(ciphertext.ct, 'base64')
    ct[3] ^= 1
    await expect(openWithPrivateKey(r, { ...ciphertext, ct: ct.toString('base64') }, wraps, mine)).rejects.toThrow()
    // The data key unwraps, but only under the right AAD.
    await expect(unwrapWithPrivateKey(ref('job_OTHERJOBXXXX'), wraps[0], me.privateKey)).rejects.toThrow()
  })

  it('server-sealed wraps (A256GCM-KW) round-trip and fail under another key or item', async () => {
    const kek = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt'])
    const kek2 = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt'])
    const r = ref()
    const { ciphertext, dek } = await encryptValue(r, { kind: 'secret', value: FAKE_INBOX })
    const w = await wrapWithKek(r, dek, kek, 'srv_test')
    expect(await decryptValue(r, ciphertext, await unwrapWithKek(r, w, kek))).toEqual({ kind: 'secret', value: FAKE_INBOX })
    await expect(unwrapWithKek(r, w, kek2)).rejects.toThrow()
    await expect(unwrapWithKek(ref(undefined, 'sec_OTHERITEMXX'), w, kek)).rejects.toThrow()
  })

  it('recovery kit: the private key under a passphrase; a wrong passphrase fails', async () => {
    const pair = await generateLockerKeyPair()
    const kit = await makeRecoveryKit({ kid: 'ek_kitkitkit', agent_id: 'agt_xxxxxxxx', privateKey: pair.privateKey, publicJwk: await exportPublicJwk(pair.publicKey), passphrase: 'correct horse battery', iterations: 100_000 })
    expect(JSON.stringify(kit)).not.toContain('"d"')
    const restored = await openRecoveryKit(kit, 'correct horse battery')
    const r = ref()
    const { ciphertext, wraps } = await sealForRecipients(r, secret, [{ kid: 'ek_kitkitkit', jwk: kit.public_jwk }])
    expect(await openWithPrivateKey(r, ciphertext, wraps, [{ kid: 'ek_kitkitkit', privateKey: restored }])).toEqual(secret)
    await expect(openRecoveryKit(kit, 'wrong passphrase!!')).rejects.toThrow(/Wrong passphrase/)
  })

  it('refuses a private JWK as a public key', async () => {
    const pair = await generateLockerKeyPair()
    const priv = await crypto.subtle.exportKey('jwk', pair.privateKey)
    expect(PublicJwk.safeParse(priv).success).toBe(false)
    expect(PublicJwk.safeParse(await exportPublicJwk(pair.publicKey)).success).toBe(true)
  })

  it('consent reads in plain words; targets match domains and addresses', () => {
    const text = consentText({ kind: 'inbox_send', scope: 'send only', consent: { actions: ['send_email'], max_total: 40, max_per_day: 10, targets: ['investors.example'], until: '2026-11-03T00:00:00.000Z' } }, 'Investor Outreach')
    expect(text).toBe('Investor Outreach may send up to 40 emails (at most 10 a day) via your inbox, only to investors.example, until Nov 3.')
    expect(targetAllowed('ann@investors.example', ['investors.example'])).toBe(true)
    expect(targetAllowed('https://app.investors.example/x', ['investors.example'])).toBe(true)
    expect(targetAllowed('ann@evil-investors.example', ['investors.example'])).toBe(false)
    expect(targetAllowed('bob@x.example', ['ann@x.example'])).toBe(false)
    expect(targetAllowed('ann@x.example', ['ann@x.example'])).toBe(true)
  })

  it('the AI guard scrubs registered values and credential-looking strings', async () => {
    registerLockerValue(FAKE_INBOX)
    const seen: string[] = []
    const stub = { config: {} as AiClient['config'], enabled: true, askJson: async (c: JsonCall<unknown>) => (seen.push(c.system, c.prompt), {}) } as unknown as AiClient
    await guardAiClient(stub).askJson({ model: 'm', system: 'sys', prompt: `forward to ${FAKE_INBOX}; password: ${FAKE_PASSWORD}; key sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE`, schema: {} as never })
    expect(seen.join('\n')).not.toContain(FAKE_INBOX)
    expect(seen.join('\n')).not.toContain(FAKE_PASSWORD)
    expect(seen.join('\n')).not.toContain('sk-ant-FAKE')
    forgetLockerValue(FAKE_INBOX)
    expect(scrubForAi(`x ${FAKE_INBOX}`)).toContain(FAKE_INBOX)
  })
})

// ---------- jobs ----------

const consentReqs = {
  inputs_schema: { type: 'object', properties: {} },
  access: [
    { id: 'A1', kind: 'inbox_send', why: 'Send the outreach from your inbox', scope: 'send only', required: true, consent: { actions: ['send_email'], max_total: 3, max_per_day: 2, targets: ['investors.example'] } },
    { id: 'A2', kind: 'api_key', why: 'Directory API', scope: 'POST /listings', required: false },
  ],
  assumptions: [],
  questions: [],
}
const quote = (q: number, unit: string) => ({
  lines: [{ deliverable_id: 'D1', model: 'per_unit', unit_price: unit, quantity: q, max_total: (Number(unit) * q).toFixed(2) }],
  total_max: { value: (Number(unit) * q).toFixed(2), currency: 'USD' },
  turnaround: 'P7D',
  excludes: [],
  valid_until: '2026-12-31T00:00:00.000Z',
})

async function negotiated(hh: Harness, q = 4, unit = '5.00') {
  const spec = { ...directorySpec(q), budget_cap: { value: '100.00', currency: 'USD' } }
  const created = await hh.call('create_job', hh.buyer, { bot_id: hh.bots['Directory Blaster'], spec, idempotency_key: `create-${Math.random()}` })
  const job_id = created.job.id
  await hh.call('submit_requirements', hh.seller, { job_id, requirements: consentReqs })
  await hh.call('send_quote', hh.seller, { job_id, quote: quote(q, unit) })
  return job_id
}
async function sign(hh: Harness, job_id: string) {
  const j = await hh.call('get_job', hh.seller, { job_id })
  await hh.call('accept_contract', hh.seller, { job_id, contract_hash: j.job.contract_hash })
  await hh.call('accept_contract', hh.buyer, { job_id, contract_hash: j.job.contract_hash })
}
async function fund(hh: Harness, job_id: string) {
  await hh.call('fund_job', hh.buyer, { job_id, idempotency_key: `fund-${job_id}` })
  await hh.settle()
}
async function registerKey(hh: Harness, who: Harness['buyer']) {
  const pair = await generateLockerKeyPair()
  const r = await hh.call('register_encryption_key', who, { jwk: await exportPublicJwk(pair.publicKey), label: 'test' })
  return { kid: r.key.kid, privateKey: pair.privateKey, jwk: r.key.jwk }
}
const item = async (hh: Harness, job_id: string, id: string) => (await hh.call('list_locker_items', hh.buyer, { job_id })).items.find((i) => i.id === id)!

describe('locker gating', () => {
  it('access: locked until funded, seller-only, e2e or sealed, shredded at the end; consent is in the contract hash', async () => {
    h = await harness()
    const job_id = await negotiated(h)
    // Consent is part of the signed contract: changing it changes the hash.
    const before = (await h.call('get_job', h.buyer, { job_id })).job.contract_hash
    await h.call('submit_requirements', h.seller, { job_id, requirements: { ...consentReqs, access: [{ ...consentReqs.access[0], consent: { ...consentReqs.access[0].consent, max_total: 4 } }, consentReqs.access[1]] } })
    const after = (await h.call('get_job', h.buyer, { job_id })).job.contract_hash
    expect(after).not.toBe(before)
    await h.call('submit_requirements', h.seller, { job_id, requirements: consentReqs })

    const sellerKey = await registerKey(h, h.seller)
    // Buyer answers A1 sealed by Rent-A-Bot, A2 end-to-end for the seller's key.
    const sealed = await h.call('put_locker_item', h.buyer, { job_id, access_id: 'A1', label: 'Outreach inbox', value: FAKE_INBOX })
    expect(sealed.item).toMatchObject({ direction: 'access', protection: 'sealed', protection_label: 'sealed by Rent-A-Bot', status: 'locked' })
    const keys = await h.call('list_encryption_keys', h.buyer, { job_id })
    expect(keys.seller.map((k) => k.kid)).toEqual([sellerKey.kid])
    const item_id = newLockerItemId()
    const enc = await sealForRecipients({ job_id, item_id, direction: 'access' }, { kind: 'api_key', key: FAKE_KEY, notes: '' }, keys.seller)
    // A wrap for a key that is not the seller's is refused.
    const stranger = await registerKey(h, h.stranger)
    const bad = await sealForRecipients({ job_id, item_id, direction: 'access' }, { kind: 'api_key', key: FAKE_KEY, notes: '' }, [{ kid: stranger.kid, jwk: stranger.jwk }])
    expect((await h.fails('put_locker_item', h.buyer, { job_id, access_id: 'A2', label: 'Directory API', item_id, ...bad })).code).toBe('invalid_input')
    const e2e = await h.call('put_locker_item', h.buyer, { job_id, access_id: 'A2', label: 'Directory API', kind: 'api_key', item_id, ...enc })
    expect(e2e.item).toMatchObject({ protection: 'e2e', protection_label: 'end-to-end' })

    // NEGOTIATING / AGREED: nobody opens.
    expect((await h.fails('open_locker_item', h.seller, { job_id, item_id: sealed.item.id })).code).toBe('invalid_state')
    await sign(h, job_id)
    expect((await h.fails('open_locker_item', h.seller, { job_id, item_id: sealed.item.id })).code).toBe('invalid_state')
    await fund(h, job_id)
    // Funded: the seller opens; the buyer and strangers do not.
    expect((await h.fails('open_locker_item', h.buyer, { job_id, item_id: sealed.item.id })).code).toBe('forbidden')
    expect((await h.fails('open_locker_item', h.stranger, { job_id, item_id: sealed.item.id })).code).toBe('not_found')
    const got = await h.call('open_locker_item', h.seller, { job_id, item_id: sealed.item.id })
    expect(got.secret).toEqual({ kind: 'secret', value: FAKE_INBOX })
    const ge = await h.call('open_locker_item', h.seller, { job_id, item_id })
    expect(ge.secret).toBeUndefined()
    expect(await openWithPrivateKey({ job_id, item_id, direction: 'access' }, ge.ciphertext!, ge.wraps!, [{ kid: sellerKey.kid, privateKey: sellerKey.privateKey }])).toEqual({ kind: 'api_key', key: FAKE_KEY, notes: '' })
    // get_secret still works for sealed items and refuses e2e ones.
    expect((await h.call('get_secret', h.seller, { job_id, secret_id: sealed.item.id })).value).toBe(FAKE_INBOX)
    expect((await h.fails('get_secret', h.seller, { job_id, secret_id: item_id })).code).toBe('invalid_input')
    // Revoking the seller's key withholds the e2e wraps.
    await h.call('revoke_encryption_key', h.seller, { kid: sellerKey.kid })
    expect((await h.fails('open_locker_item', h.seller, { job_id, item_id })).code).toBe('invalid_state')

    // Audit: who, which surface; both sides see the same log.
    const list = await h.call('list_locker_items', h.seller, { job_id })
    expect(list.audit.filter((a) => a.event === 'open').length).toBeGreaterThanOrEqual(3)
    expect(list.audit.some((a) => a.event === 'denied' && a.role === 'buyer')).toBe(true)
    expect(list.audit.every((a) => a.surface === 'rest' || a.surface === 'platform')).toBe(true)
    expect(list.consent[0].text).toMatch(/may send up to 3 emails \(at most 2 a day\) via your inbox, only to investors\.example/)

    // Terminal: everything shredded, metadata and audit stay.
    await h.call('decline_job', h.seller, { job_id, reason: 'Cannot do it after all' })
    const end = await h.call('list_locker_items', h.buyer, { job_id })
    expect(end.items.every((i) => i.status === 'shredded')).toBe(true)
    expect((await h.fails('open_locker_item', h.seller, { job_id, item_id: sealed.item.id })).code).toBe('invalid_state')
    const db = h.core.internal.services.d.db
    expect(db.all('SELECT * FROM locker_wraps')).toHaveLength(0)
    expect(db.all('SELECT id FROM locker_items WHERE ciphertext IS NOT NULL')).toHaveLength(0)
  })

  it('an access item shared for an older access request cannot be opened after the request changes', async () => {
    h = await harness()
    const job_id = await negotiated(h)
    const put = await h.call('put_locker_item', h.buyer, { job_id, access_id: 'A1', label: 'Outreach inbox', value: FAKE_INBOX })
    await h.call('submit_requirements', h.seller, { job_id, requirements: { ...consentReqs, access: [{ ...consentReqs.access[0], consent: { actions: ['send_email'], max_total: 400, targets: [] } }, consentReqs.access[1]] } })
    await h.call('send_quote', h.seller, { job_id, quote: quote(4, '5.00') })
    await sign(h, job_id)
    await fund(h, job_id)
    expect((await item(h, job_id, put.item.id)).status_reason).toMatch(/changed after this was shared/)
    expect((await h.fails('open_locker_item', h.seller, { job_id, item_id: put.item.id })).code).toBe('invalid_state')
  })

  it('handover: metadata at once; delivered-unpaid locked; paid released; failed shredded; acknowledge and 30-day expiry shred', async () => {
    h = await harness()
    const job_id = await negotiated(h)
    await sign(h, job_id)
    // Unfunded: the seller cannot hand over yet.
    expect((await h.fails('put_locker_item', h.seller, { job_id, deliverable_id: 'D1', unit_ref: 'listing-1', label: 'PH account', value: FAKE_PASSWORD })).code).toBe('invalid_state')
    await fund(h, job_id)
    const buyerKey = await registerKey(h, h.buyer)
    const login = (n: number): LockerSecret => ({ kind: 'login', url: `https://dir${n}.example/login`, username: `orano${n}`, password: `${FAKE_PASSWORD}-${n}`, notes: '' })
    const h1 = await h.call('put_locker_item', h.seller, { job_id, deliverable_id: 'D1', unit_ref: 'listing-1', label: 'dir1 account', secret: login(1) })
    expect(h1.item).toMatchObject({ direction: 'handover', site: 'dir1.example', status: 'locked' })
    expect(h1.item.status_reason).toMatch(/not been delivered/)
    const keys = await h.call('list_encryption_keys', h.seller, { job_id })
    const id2 = newLockerItemId()
    const h2 = await h.call('put_locker_item', h.seller, { job_id, deliverable_id: 'D1', unit_ref: 'listing-2', label: 'dir2 account', kind: 'login', site: 'dir2.example', item_id: id2, ...(await sealForRecipients({ job_id, item_id: id2, direction: 'handover' }, login(2), keys.buyer)) })
    const h4 = await h.call('put_locker_item', h.seller, { job_id, deliverable_id: 'D1', unit_ref: 'listing-4', label: 'dir4 account', secret: login(4) })
    // A label that carries the password is refused (metadata is visible before payment).
    expect((await h.fails('put_locker_item', h.seller, { job_id, deliverable_id: 'D1', unit_ref: 'listing-3', label: `pw ${FAKE_PASSWORD}-1`, secret: login(3) })).code).toBe('invalid_input')
    // In progress: locked for the buyer, and the seller never opens its own handover.
    expect((await h.fails('open_locker_item', h.buyer, { job_id, item_id: h1.item.id })).code).toBe('invalid_state')
    expect((await h.fails('open_locker_item', h.seller, { job_id, item_id: h1.item.id })).code).toBe('forbidden')

    // Delivered, listing-4 fails its checks; nothing captured yet.
    await h.call('submit_delivery', h.seller, { job_id, delivery: { deliverables: [{ deliverable_id: 'D1', units: units(4, (i) => (i === 3 ? { url_live: 'fail' } : {})), note: '' }], note: 'Done' } })
    expect((await item(h, job_id, h1.item.id)).status_reason).toMatch(/opens once that unit is paid/)
    expect((await h.fails('open_locker_item', h.buyer, { job_id, item_id: h1.item.id })).code).toBe('invalid_state')
    expect((await item(h, job_id, h4.item.id)).status_reason).toMatch(/failed its checks/)

    // Paid: the buyer accepts, 3 × $5 is captured.
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    const o1 = await h.call('open_locker_item', h.buyer, { job_id, item_id: h1.item.id })
    expect(o1.secret).toEqual(login(1))
    expect(o1.item.status).toBe('released')
    expect(o1.item.expires_at).toBeTruthy()
    const o2 = await h.call('open_locker_item', h.buyer, { job_id, item_id: id2 })
    expect(await openWithPrivateKey({ job_id, item_id: id2, direction: 'handover' }, o2.ciphertext!, o2.wraps!, [{ kid: buyerKey.kid, privateKey: buyerKey.privateKey }])).toEqual(login(2))
    // The failed unit was never paid: shredded when the job settled, never released.
    const i4 = await item(h, job_id, h4.item.id)
    expect(i4.status).toBe('shredded')
    expect(i4.released_at).toBeNull()
    // The seller cannot take back a paid handover.
    expect((await h.fails('shred_locker_item', h.seller, { job_id, item_id: h1.item.id })).code).toBe('forbidden')
    // Acknowledge ("I changed the password") shreds it.
    const ack = await h.call('shred_locker_item', h.buyer, { job_id, item_id: h1.item.id, acknowledged: true })
    expect(ack.item.status).toBe('shredded')
    expect((await h.fails('open_locker_item', h.buyer, { job_id, item_id: h1.item.id })).code).toBe('invalid_state')
    // 30 days after release: shredded by the scheduler.
    h.clock.advance(31 * DAY)
    await h.tick()
    expect((await item(h, job_id, id2)).status).toBe('shredded')
    expect(h.core.internal.services.d.db.all('SELECT * FROM locker_wraps')).toHaveLength(0)
  })
})

describe('consent receipts (log_action)', () => {
  it('counts against limits; out-of-scope and over-limit actions are rejected and flagged', async () => {
    h = await harness()
    const job_id = await negotiated(h)
    await h.call('put_locker_item', h.buyer, { job_id, access_id: 'A1', label: 'Outreach inbox', value: FAKE_INBOX })
    await sign(h, job_id)
    expect((await h.fails('log_action', h.seller, { job_id, action: 'send_email', target: 'ann@investors.example' })).code).toBe('invalid_state')
    await fund(h, job_id)
    const ok = await h.call('log_action', h.seller, { job_id, action: 'send_email', target: 'ann@investors.example', external_ref: '<m1@x>' })
    expect(ok.usage).toMatchObject({ access_id: 'A1', used_total: 1, max_total: 3, used_today: 1, max_per_day: 2 })
    await h.call('log_action', h.seller, { job_id, action: 'send_email', target: 'bob@investors.example' })
    // Third today: over the daily limit.
    expect((await h.fails('log_action', h.seller, { job_id, action: 'send_email', target: 'cat@investors.example' })).code).toBe('policy_blocked')
    // Outside the targets, and an action nobody consented to.
    expect((await h.fails('log_action', h.seller, { job_id, action: 'send_email', target: 'someone@elsewhere.example' })).code).toBe('policy_blocked')
    expect((await h.fails('log_action', h.seller, { job_id, action: 'create_account', target: 'investors.example' })).code).toBe('policy_blocked')
    h.clock.advance(DAY + 1000)
    await h.call('log_action', h.seller, { job_id, action: 'send_email', target: 'cat@investors.example' })
    // Fourth in total: over max_total.
    expect((await h.fails('log_action', h.seller, { job_id, action: 'send_email', target: 'dan@investors.example' })).code).toBe('policy_blocked')
    const l = await h.call('list_locker_items', h.buyer, { job_id })
    expect(l.actions.filter((a) => a.accepted)).toHaveLength(3)
    expect(l.actions.filter((a) => !a.accepted)).toHaveLength(4)
    expect(l.consent[0].usage).toMatchObject({ used_total: 3, max_total: 3 })
    const msgs = (await h.call('get_messages', h.buyer, { job_id, limit: 200 })).messages
    expect(msgs.filter((m) => /^Integrity:/.test(m.text))).toHaveLength(4)
    // The rejections count as integrity flags on the bot when the job ends.
    await h.call('decline_job', h.seller, { job_id, reason: 'stop' })
    const bot = await h.call('get_bot', h.buyer, { bot_id: h.bots['Directory Blaster'] })
    expect(bot.bot.reputation.integrity_flags).toBeGreaterThanOrEqual(4)
  })
})

describe('redaction guard', () => {
  it('blocks locker values and credential-looking text in messages, inputs and deliveries; never echoes them', async () => {
    h = await harness()
    const job_id = await negotiated(h)
    await h.call('put_locker_item', h.buyer, { job_id, access_id: 'A1', label: 'Outreach inbox', value: FAKE_INBOX })
    const e1 = await h.fails('send_message', h.seller, { job_id, type: 'note', text: `I will use ${FAKE_INBOX} now` })
    expect(e1.code).toBe('invalid_input')
    expect(e1.message + e1.hint).not.toContain(FAKE_INBOX)
    expect((await h.fails('send_message', h.buyer, { job_id, type: 'note', text: `password: ${FAKE_PASSWORD}` })).code).toBe('invalid_input')
    expect((await h.fails('provide_inputs', h.buyer, { job_id, answers: {}, inputs: { password: FAKE_PASSWORD } })).code).toBe('invalid_input')
    // Ordinary words about passwords pass.
    await h.call('send_message', h.buyer, { job_id, type: 'note', text: 'The password is in the locker (A1).' })
    await sign(h, job_id)
    await fund(h, job_id)
    const list = units(4)
    list[0].meta = { note: `login with ${FAKE_INBOX}` } as never
    expect((await h.fails('submit_delivery', h.seller, { job_id, delivery: { deliverables: [{ deliverable_id: 'D1', units: list, note: '' }], note: '' } })).code).toBe('invalid_input')
    const audit = (await h.call('list_locker_items', h.buyer, { job_id })).audit
    expect(audit.filter((a) => a.event === 'blocked').length).toBeGreaterThanOrEqual(2)
  })
})

// ---------- the invariant: no plaintext anywhere ----------

describe('no plaintext anywhere', () => {
  it('the value never reaches the DB file, WAL, events, room, logs or any AI-provider input', async () => {
    const logs: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')))
    const hh = await harness({ dbFile: '', confident: false })
    h = hh
    // A recording AI provider behind the same guard production uses; the real policy gate, copilot and negotiator call it.
    const seen: string[] = []
    const recorder: AiClient = {
      config: h.intel.aiClient.config,
      enabled: true,
      async askJson(c) {
        seen.push(c.system, c.prompt)
        throw new AiUnavailable('recorder')
      },
      async chat(req) {
        seen.push(JSON.stringify(req))
        throw new AiUnavailable('recorder')
      },
    }
    const ai = guardAiClient(recorder)
    const intel = h.intel as unknown as Record<string, unknown>
    intel.policy = createPolicyGate({ ai })
    intel.copilot = createCopilot({ ai })
    const neg = createNegotiator({ ai, now: () => new Date(hh.clock.t) })
    h.intel.setNegotiator(neg)

    const job_id = await negotiated(h)
    await h.call('put_locker_item', h.buyer, { job_id, access_id: 'A1', label: 'Outreach inbox', value: FAKE_INBOX })
    await h.call('put_locker_item', h.buyer, { job_id, access_id: 'A2', label: 'Directory API', secret: { kind: 'api_key', key: FAKE_KEY, notes: '' } })
    await sign(h, job_id)
    // The recorder makes the policy review fail, so the job is restricted: no mandate pays it, the owner approves on PayPal.
    const funded = await h.call('fund_job', h.buyer, { job_id, idempotency_key: `fund-${job_id}` })
    expect(funded.job.state).toBe('AWAITING_APPROVAL')
    expect(funded.job.policy.class).toBe('restricted')
    await h.core.payments.simulatedApprove!('order', funded.approval_url!.split('/').pop()!, true)
    await h.settle()
    const opened = await h.call('open_locker_item', h.seller, { job_id, item_id: (await h.call('list_locker_items', h.seller, { job_id })).items[0].id })
    expect(JSON.stringify(opened)).toContain(FAKE_INBOX) // the one place it may appear: the authorised open
    await h.call('put_locker_item', h.seller, { job_id, deliverable_id: 'D1', unit_ref: 'listing-1', label: 'dir1 account', secret: { kind: 'login', url: 'https://dir1.example', username: 'orano', password: FAKE_PASSWORD, notes: '' } })
    // Leaks attempted through the room are blocked.
    await h.fails('send_message', h.seller, { job_id, type: 'progress', text: `using ${FAKE_KEY}`, percent: 10 })
    await h.call('submit_delivery', h.seller, { job_id, delivery: { deliverables: [{ deliverable_id: 'D1', units: units(4, (i) => (i === 3 ? { url_live: 'fail' } : {})), note: '' }], note: 'Done' } })
    // A dispute runs the negotiator, which calls the (recording) model with the case bundle.
    await h.call('open_dispute', h.buyer, { job_id, reason: 'Listing 4 is not live; the inbox credentials were in the locker as agreed.', claims: ['listing-4 missing'] })
    await h.settle()
    await h.call('draft_job_spec', h.buyer, { bot_id: h.bots['Directory Blaster'], skill_id: 'directory_submission', goal: 'List ORANO on 10 AI directories before launch', quantity: 10 }).catch(() => null)
    await h.settle()
    await h.tick()
    expect(seen.length).toBeGreaterThan(0)

    const db = h.core.internal.services.d.db
    db.raw.exec('PRAGMA wal_checkpoint(FULL)')
    const all = [
      ['ai inputs', seen.join('\n')],
      ['logs', logs.join('\n')],
      ['events', JSON.stringify(db.all('SELECT * FROM events'))],
      ['room', JSON.stringify(db.all('SELECT * FROM messages'))],
      ['jobs', JSON.stringify(db.all('SELECT * FROM jobs'))],
      ['audit', JSON.stringify(db.all('SELECT * FROM locker_audit'))],
      ['artifacts', JSON.stringify(db.all('SELECT * FROM artifacts')) + JSON.stringify(db.all('SELECT * FROM evidence'))],
    ] as const
    const dbFile = join(h.dataDir, 'rentabot.db')
    const files = [dbFile, `${dbFile}-wal`].filter(existsSync).map((f) => [f, readFileSync(f).toString('latin1')] as const)
    for (const v of [FAKE_INBOX, FAKE_KEY, FAKE_PASSWORD]) {
      for (const [where, text] of all) expect(text.includes(v), `${where} contains a locker value`).toBe(false)
      for (const [f, bytes] of files) expect(bytes.includes(v), `${f} contains a locker value`).toBe(false)
    }
  })
})
