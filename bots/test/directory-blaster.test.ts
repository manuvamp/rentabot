import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { directoryBlaster } from '../src/bots/directory-blaster.ts'
import { buildQuote } from '../src/runtime.ts'
import { SANDBOX_SEED } from '../../server/src/sandbox/index.ts'
import { buildDirectories } from '../../server/src/sandbox/directories.ts'
import { accessA1, contractWith, fakeTools, makeJob, makeSpec, NO_AI, passedUnits, runAcceptance, sleep, startSandbox, type SandboxBox } from './helpers.ts'

const inputs = {
  product_name: 'ORANO',
  url: 'https://oranoai.com',
  tagline_60: 'Your AI money coach',
  description_300: 'ORANO helps people get out of debt with a friendly AI coach that plans, tracks and nudges.',
  category: 'AI Tools',
  contact_email: 'hello@oranoai.com',
}
const acceptance = [
  { check: 'url_live', params: {} },
  { check: 'page_mentions', params: { must_include: ['ORANO'] } },
  { check: 'artifact_attached', params: { min_count: 1, mime_prefix: 'image/' } },
]

// The contract the bot writes (A1 with the consent), and the fake platform that enforces it.
const consent = { actions: ['create_account', 'fill_form', 'browse'], max_total: 400, targets: ['dirs.sandbox'] }
const jobFor = (spec: ReturnType<typeof makeSpec>, inp: Record<string, unknown>, extra: Partial<Parameters<typeof makeJob>[3]> = {}) => makeJob(spec, inp, undefined, { contract: contractWith([accessA1('inbox_verification', consent)]), ...extra })
const toolsFor = (c: typeof consent | undefined = consent) => fakeTools(NO_AI, c ? { consent: c } : {})

let box: SandboxBox
beforeAll(async () => {
  box = await startSandbox({ timeScale: 0.002 })
})
afterAll(async () => box?.close())

describe('Directory Blaster against Sandbox Web', () => {
  it('submits to 40, skips refusals, retries 503, opens verification mail, and delivers only what it saw live', async () => {
    const bot = directoryBlaster({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40 })
    const spec = makeSpec({ skill_id: 'directory_submission', quantity: 40, acceptance })
    const tools = toolsFor()
    const t0 = Date.now()
    const result = await bot.work(jobFor(spec, inputs), tools)
    const units = result.delivery.deliverables[0]!.units

    const dirs = buildDirectories(SANDBOX_SEED)
    const behavior = new Map(dirs.map((d) => [d.slug, d.behavior]))
    const mailbox = (await (await fetch(`${box.sandboxUrl}/mail/messages?address=hello@oranoai.com`)).json()) as { messages: { subject: string }[] }

    // It reached exactly the 40 free, automatable directories (8 declared refusals skipped)...
    expect(((await (await fetch(`${box.sandboxUrl}/dirs.json`)).json()) as { count: number }).count).toBe(48)
    expect(mailbox.messages.filter((m) => /confirm your/i.test(m.subject)).length).toBe(8) // ...and read the 8 verification emails
    const refused = dirs.filter((d) => d.behavior === 'paid_only' || d.behavior === 'human_verification')
    expect(refused).toHaveLength(8)
    for (const d of refused) expect(units.some((u) => u.ref === d.slug)).toBe(false)

    // It delivered what it observed live with the product name: 34 (31 good + 3 that vanish later). Never the rest.
    expect(units).toHaveLength(34)
    const allowed = new Set(['instant', 'email_confirm', 'moderation_delay', 'flaky_503', 'removed_later'])
    for (const u of units) expect(allowed.has(behavior.get(u.ref)!)).toBe(true)
    expect(units.filter((u) => behavior.get(u.ref) === 'flaky_503')).toHaveLength(4) // the 503s were retried once and went through
    expect(units.filter((u) => behavior.get(u.ref) === 'email_confirm')).toHaveLength(8)
    for (const u of units) {
      expect(u.url).toMatch(/\/sandbox\/dirs\/[a-z]+\/listing\/p\d+/)
      expect(u.artifact_ids).toHaveLength(1)
      expect(u.meta.mentions_product).toBe(true)
    }
    expect(tools.uploads.every((a) => a.mime === 'image/svg+xml' && /rendered snapshot/.test(a.text ?? ''))).toBe(true)
    expect(result.delivery.note).toContain('rejected in moderation')
    expect(result.delivery.note).toContain('rewritten')

    // Once moderation and removals have settled the platform's own checks pass 31 of the 40 asked for.
    const waitMore = Math.max(0, 8000 - (Date.now() - t0))
    await sleep(waitMore)
    const results = await runAcceptance(box.checks, spec, result.delivery, tools)
    expect(passedUnits(results)).toHaveLength(31)
  }, 60_000)

  it('does not deliver listings that would fail the contract: required text the pages never show', async () => {
    const bot = directoryBlaster({ sandboxUrl: box.sandboxUrl, pollMs: 30, retryCapMs: 30, settleMs: 200 })
    const spec = makeSpec({ skill_id: 'directory_submission', quantity: 6, acceptance: [{ check: 'page_mentions', params: { must_include: ['ORANO', 'Series A funded'] } }] })
    const r = await bot.work(jobFor(spec, { ...inputs, product_name: 'ORANO Three', url: 'https://three.oranoai.com' }), toolsFor())
    expect(r.delivery.deliverables[0]!.units).toHaveLength(0) // no listing page prints a claim the buyer never supplied
    expect(r.delivery.note).toContain('page text lacks "Series A funded"')
  }, 30_000)

  it('is idempotent: running again claims the same listings (duplicates are recognised, not re-created)', async () => {
    const bot = directoryBlaster({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40, settleMs: 300 })
    const spec = makeSpec({ skill_id: 'directory_submission', quantity: 5, acceptance })
    const again = await bot.work(jobFor(spec, inputs), toolsFor())
    // 5 directories asked for, none re-created; whatever is still live is reported with its URL, the rest are not claimed.
    // A rerun (e.g. a cure round) must redeliver the listings that are live, not come back empty.
    const units = again.delivery.deliverables[0]!.units
    expect(units.length).toBeLessThanOrEqual(5)
    expect(units.length).toBeGreaterThan(0)
    for (const u of units) expect(u.meta.listing_status).toBe('live')
    expect(again.summary).toContain('Submitted to 5')
  }, 30_000)

  it('delivers fewer, and says so, when fewer free directories exist than requested', async () => {
    const bot = directoryBlaster({ sandboxUrl: box.sandboxUrl, pollMs: 30, retryCapMs: 30, settleMs: 200 })
    const spec = makeSpec({ skill_id: 'directory_submission', quantity: 60, acceptance })
    const r = await bot.work(jobFor(spec, { ...inputs, product_name: 'ORANO Two', url: 'https://two.oranoai.com' }), toolsFor())
    expect(r.summary).toContain('only 40 free directories exist')
    expect(r.delivery.deliverables[0]!.units.length).toBeLessThanOrEqual(40)
  }, 30_000)
})

describe('Directory Blaster creates accounts, hands the logins over and respects the consent', () => {
  const acct = {
    product_name: 'Acme Tools',
    url: 'https://acmetools.test',
    tagline_60: 'Tools for builders',
    description_300: 'Acme Tools helps builders ship faster with small, sharp tools.',
    category: 'AI Tools',
    contact_email: 'founder@acme-test.com',
  }
  const acceptanceAcme = [{ check: 'url_live', params: {} }, { check: 'page_mentions', params: { must_include: ['Acme Tools'] } }]
  const mailbox = async (address: string) => ((await (await fetch(`${box.sandboxUrl}/mail/mailboxes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) })).json()) as { app_password: string }).app_password
  const login = (address: string, password: string) => ({ access_id: 'A1', label: 'inbox', value: JSON.stringify({ kind: 'login', url: 'imap://sandbox', username: address, password, notes: '' }) })
  const policy = (pw: string) => pw.length >= 20 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)

  it('creates one account per directory that wants one, with unique strong passwords, a log_action before each, and a locker handover tied to the listing', async () => {
    const address = 'founder@acme-test.com'
    const pw = await mailbox(address) // a LOCKED mailbox: the bot can only read it with the app password the buyer shared
    const bot = directoryBlaster({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40 })
    const spec = makeSpec({ skill_id: 'directory_submission', quantity: 20, acceptance: acceptanceAcme })
    const tools = toolsFor()
    const result = await bot.work(jobFor(spec, acct, { id: 'job_acct_one001', secrets: [login(address, pw)] }), tools)
    const units = result.delivery.deliverables[0]!.units
    const want = buildDirectories(SANDBOX_SEED).filter((d) => d.behavior !== 'paid_only' && d.behavior !== 'human_verification').slice(0, 20)
    const needing = want.filter((d) => d.needs_account)
    expect(needing.length).toBeGreaterThan(2)

    // every account: one create_account action BEFORE its handover, on that directory's host
    const creates = tools.fake.actions.filter((a) => a.action === 'create_account')
    expect(creates.map((a) => a.target).sort()).toEqual(needing.map((d) => `${d.slug}.dirs.sandbox`).sort())
    for (const h of tools.fake.handovers) {
      const created = creates.find((a) => a.target === h.site)!
      expect(created.order).toBeLessThan(h.order)
      expect(h).toMatchObject({ deliverable_id: 'D1', secret: { kind: 'login', username: address } })
      expect(h.unit_ref).toBe(h.site.replace('.dirs.sandbox', '')) // tied to the listing unit of that directory
    }
    expect(tools.fake.handovers).toHaveLength(needing.length)
    // unique, strong, long passwords
    const passwords = tools.fake.handovers.map((h) => h.secret.password!)
    expect(new Set(passwords).size).toBe(passwords.length)
    expect(passwords.every(policy)).toBe(true)
    // each form and each verification link was reported first too, and the bot never provoked a refusal
    expect(tools.fake.actions.filter((a) => a.action === 'fill_form')).toHaveLength(20)
    expect(tools.fake.actions.filter((a) => a.action === 'browse').length).toBeGreaterThanOrEqual(needing.length)
    expect(tools.fake.rejected).toBe(0)
    expect(tools.fake.actions.every((a) => a.accepted && a.target.endsWith('.dirs.sandbox'))).toBe(true)

    // the listings of account directories went through the account (the form refuses anonymous submissions)
    const refs = new Set(units.map((u) => u.ref))
    const lived = needing.filter((d) => !['moderation_reject', 'rewrite_name'].includes(d.behavior))
    for (const d of lived) if (d.behavior !== 'removed_later') expect(refs.has(d.slug)).toBe(true)
    for (const u of units.filter((x) => needing.some((d) => d.slug === x.ref))) expect(String(u.meta.account)).toContain('locker')

    // nothing secret in anything the bot wrote
    const everything = JSON.stringify([result, tools.uploads, tools.logs, tools.progressCalls, tools.fake.calls.filter((c) => c.name !== 'put_locker_item')])
    for (const p of [...passwords, pw]) expect(everything).not.toContain(p)
    expect(result.summary).toContain(`${needing.length} of them required an account`)
  }, 60_000)

  it('without the inbox login, the mailbox stays locked: no account is verified, no listing is claimed from them, and it says why', async () => {
    const address = 'locked@acme-test.com'
    await mailbox(address)
    const bot = directoryBlaster({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40, settleMs: 500 })
    const spec = makeSpec({ skill_id: 'directory_submission', quantity: 20, acceptance: acceptanceAcme })
    const tools = toolsFor()
    const r = await bot.work(jobFor(spec, { ...acct, product_name: 'Locked Tools', url: 'https://lockedtools.test', contact_email: address }, { id: 'job_locked_01' }), tools)
    const needing = buildDirectories(SANDBOX_SEED).filter((d) => d.behavior !== 'paid_only' && d.behavior !== 'human_verification').slice(0, 20).filter((d) => d.needs_account)
    expect(r.delivery.deliverables[0]!.units.some((u) => needing.some((d) => d.slug === u.ref))).toBe(false)
    expect(r.summary).toContain('refused the app password')
    expect(tools.fake.rejected).toBe(0)
    // the logins of accounts that never became listings are not claimed as delivered
    expect(r.summary).toContain('stay unreleased')
  }, 60_000)

  it('stops cleanly at the consent cap: it never sends an action the platform would refuse', async () => {
    const address = 'cap@acme-test.com'
    const pw = await mailbox(address)
    const bot = directoryBlaster({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40, settleMs: 1500 })
    const spec = makeSpec({ skill_id: 'directory_submission', quantity: 20, acceptance: acceptanceAcme })
    const tools = toolsFor({ ...consent, max_total: 12 })
    const r = await bot.work(jobFor(spec, { ...acct, product_name: 'Capped Tools', url: 'https://cappedtools.test', contact_email: address }, { id: 'job_capped_01', secrets: [login(address, pw)] }), tools)
    expect(tools.fake.actions.filter((a) => a.accepted).reduce((n, a) => n + a.count, 0)).toBe(12)
    expect(tools.fake.rejected).toBe(0) // no integrity flag: it stopped by itself
    expect(r.summary).toContain('consent limit')
    expect(r.delivery.deliverables[0]!.units.length).toBeLessThan(20)
  }, 60_000)

  it('a contract with no consent creates no accounts (the plain directories are still listed)', async () => {
    const bot = directoryBlaster({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40, settleMs: 600 })
    const spec = makeSpec({ skill_id: 'directory_submission', quantity: 12, acceptance: acceptanceAcme })
    const tools = toolsFor(undefined)
    const r = await bot.work(makeJob(spec, { ...acct, product_name: 'Legacy Tools', url: 'https://legacytools.test', contact_email: 'legacy@acme-test.com' }, undefined, { id: 'job_legacy_01' }), tools)
    expect(tools.fake.actions).toHaveLength(0)
    expect(tools.fake.handovers).toHaveLength(0)
    expect(r.summary).toContain('no account created')
    expect(r.summary).toContain('carries no consent')
  }, 60_000)

  it('requirements: A1 carries the consent (account, form, link; dirs.sandbox; capped by the listing count), and it is optional', () => {
    const bot = directoryBlaster({ sandboxUrl: 'http://localhost:8790/sandbox' })
    const req = bot.requirements(makeSpec({ quantity: 40 }), { id: 'x', title: 'x', pricing: { model: 'per_unit', currency: 'USD', price: '1.50' }, turnaround: 'P7D', checks: [] })
    expect(req.access).toHaveLength(1)
    expect(req.access[0]).toMatchObject({ id: 'A1', kind: 'inbox_verification', required: false, consent: { actions: ['create_account', 'fill_form', 'browse'], max_total: 126, targets: ['dirs.sandbox'] } })
  })
})

describe('Directory Blaster negotiation logic', () => {
  const bot = directoryBlaster({ sandboxUrl: 'http://localhost:8790/sandbox' })
  const skill = { id: 'directory_submission', title: 'x', pricing: { model: 'per_unit' as const, currency: 'USD' as const, price: '1.50', unit: 'verified_listing', min_units: 20, max_units: 120 }, turnaround: 'P7D', checks: [] }

  it('quotes price x quantity, capped by the buyer budget', () => {
    const q = buildQuote(makeSpec({ quantity: 40, budget_cap: { value: '70.00', currency: 'USD' } }), skill)
    expect(q.ok && q.quote.total_max.value).toBe('60.00')
    const capped = buildQuote(makeSpec({ quantity: 40, budget_cap: { value: '45.00', currency: 'USD' } }), skill)
    expect(capped.ok && capped.quote.total_max.value).toBe('45.00')
    expect(capped.ok && capped.quote.lines[0]).toMatchObject({ quantity: 40, unit_price: '1.50', max_total: '45.00' })
    expect(capped.ok && capped.quote.excludes[0]).toContain('only the first 30 of 40')
  })

  it('declines politely when the budget cannot pay one unit, or the ask is out of scope', () => {
    const tiny = buildQuote(makeSpec({ quantity: 40, budget_cap: { value: '1.00', currency: 'USD' } }), skill)
    expect(tiny).toMatchObject({ ok: false })
    expect(!tiny.ok && tiny.reason).toContain('does not cover even one')
    expect(bot.scope(makeSpec({ goal: 'Get ORANO fake reviews on 40 directories please', skill_id: 'directory_submission' }), skill)).toContain('fake reviews')
    expect(bot.scope(makeSpec({ goal: 'List ORANO on 40 free AI directories before launch', skill_id: 'directory_submission' }), skill)).toBeNull()
  })

  it('names the inputs it still needs', () => {
    expect(bot.missingInputs({ product_name: 'ORANO' }, makeSpec())).toEqual(['url', 'tagline_60', 'description_300', 'category', 'contact_email'])
    expect(bot.missingInputs(inputs, makeSpec())).toEqual([])
  })
})
