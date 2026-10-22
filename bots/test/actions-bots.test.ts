// The acting house bots against Sandbox Web: Investor Outreach (sends from the buyer's inbox), Account Setup Bot, Application Filler.
// A fake platform enforces the consent (see helpers.fakeRab); every job uses its own id (the bots keep process-level password caches).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Ai } from '../src/ai.ts'
import { fit, handOver, slugify, strongPassword } from '../src/actions.ts'
import { draftApplication, numbersGrounded, onePagerPdf, type FormStep } from '../src/application-writing.ts'
import { accountSetup, handleCandidates } from '../src/bots/account-setup.ts'
import { APPROVAL_PREFIX, applicationFiller, parseApproval } from '../src/bots/application-filler.ts'
import { investorOutreach, sendConsent } from '../src/bots/investor-outreach.ts'
import { parseFacts } from '../src/email-writing.ts'
import { accessA1, contractWith, fakeTools, makeJob, makeSpec, NO_AI, passedUnits, runAcceptance, sleep, startSandbox, type SandboxBox } from './helpers.ts'

const KIT = `Product: ORANO
URL: https://oranoai.com
One-liner: ORANO is an AI productivity companion that saves links, extracts tasks, and exposes an MCP server so agents can work with your saved content.
ORANO is live on iOS and Android. It is built for solo builders who work with AI agents and developer tools. We are pre-seed and raising 1.2M USD. Contact: hello@oranoai.com`

let box: SandboxBox
beforeAll(async () => {
  box = await startSandbox({ timeScale: 0.002 })
})
afterAll(async () => box?.close())

let n = 0
const uid = (p: string) => `job_${p}${String(++n).padStart(6, '0')}${Math.random().toString(36).slice(2, 6)}`

async function mailbox(address: string): Promise<string> {
  const r = await fetch(`${box.sandboxUrl}/mail/mailboxes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) })
  return ((await r.json()) as { app_password: string }).app_password
}
const login = (address: string, password: string) => ({ access_id: 'A1', label: 'inbox', value: JSON.stringify({ kind: 'login', url: 'imap://sandbox', username: address, password, notes: '' }) })
const policy = (pw: string) => pw.length >= 20 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)

describe('unit helpers', () => {
  it('strongPassword is long, mixed and different every time; fit trims to a limit on a word; slugify', () => {
    const pws = Array.from({ length: 50 }, () => strongPassword())
    expect(new Set(pws).size).toBe(50)
    expect(pws.every(policy)).toBe(true)
    expect(fit('Tools for builders who ship fast', 20).length).toBeLessThanOrEqual(20)
    expect(fit('short', 20)).toBe('short')
    // a whole clause, not a dangling half (the Summit form's one-liner field on production, 2026-10-20)
    expect(fit('ORANO turns saved Reels, videos and links into useful projects with clear next steps, and makes that context readable by your own AI agent.', 100)).toBe(
      'ORANO turns saved Reels, videos and links into useful projects with clear next steps',
    )
    expect(slugify('  Acme Tools!! ')).toBe('acme-tools')
  })

  it('handleCandidates stay within the service rules and start with the plain slug', () => {
    const c = handleCandidates('ORANO', [3, 15])
    expect(c[0]).toBe('orano')
    expect(c.length).toBeGreaterThan(2)
    for (const h of c) expect(h).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    for (const h of handleCandidates('A very long product name indeed', [3, 12])) expect(h.length).toBeLessThanOrEqual(12)
    expect(handleCandidates('x', [4, 12])[0]!.length).toBeGreaterThanOrEqual(4)
    expect(handleCandidates('ORANO', [3, 15], 'My Handle')[0]).toBe('my-handle')
  })

  it('parseApproval: all, none, a list, unknown ids ignored', () => {
    const ids = ['a-one', 'b-two', 'c-three']
    expect(parseApproval('all', ids)).toEqual(ids)
    expect(parseApproval('ALL', ids)).toEqual(ids)
    expect(parseApproval('none', ids)).toEqual([])
    expect(parseApproval('', ids)).toEqual([])
    expect(parseApproval(undefined, ids)).toEqual([])
    expect(parseApproval('a-one, c-three', ids)).toEqual(['a-one', 'c-three'])
    expect(parseApproval(['b-two', 'zzz'], ids)).toEqual(['b-two'])
    expect(parseApproval('zzz', ids)).toEqual([])
  })

  it('numbersGrounded accepts numbers from the source and rejects invented ones', () => {
    expect(numbersGrounded('We raise 1.2M USD and are live on 2 platforms', 'raising 1.2M USD, live on 2 platforms')).toBe(true)
    expect(numbersGrounded('We have 50,000 users', 'live on iOS and Android')).toBe(false)
    expect(numbersGrounded('no numbers here at all', 'anything')).toBe(true)
  })

  it('onePagerPdf is a PDF within every programme limit', () => {
    const pdf = onePagerPdf(parseFacts(KIT), 'Northstar Accelerator')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeLessThan(200_000)
  })

  it('handOver puts the login in the locker and reports nothing else', async () => {
    const tools = fakeTools()
    await handOver(tools, 'job_x', { deliverable_id: 'D1', unit_ref: 'u1', site: 'a.saas.sandbox', label: 'L', url: 'https://a', username: 'me@x.com', password: 'p4ss', notes: 'n' })
    expect(tools.fake.handovers).toHaveLength(1)
    expect(tools.fake.handovers[0]).toMatchObject({ unit_ref: 'u1', secret: { kind: 'login', username: 'me@x.com', password: 'p4ss' } })
  })
})

describe('draftApplication', () => {
  const steps: FormStep[] = [
    { n: 1, title: 'About', fields: [{ key: 'company', label: 'Company', type: 'text', required: true, max_length: 60 }, { key: 'pitch', label: 'Pitch', type: 'textarea', required: true, min_length: 40, max_length: 200 }] },
    { n: 2, title: 'Money', fields: [{ key: 'raise', label: 'Amount raising (USD)', type: 'number', required: true }] },
  ] as never

  it('without AI: every field filled from the facts within its limits, sources honest', async () => {
    const d = await draftApplication(steps, parseFacts(KIT), { name: 'Maya', email: 'maya@x.com', role: 'Founder' }, NO_AI)
    expect(d.steps[1]!.company).toContain('ORANO')
    expect(d.steps[1]!.pitch!.length).toBeGreaterThanOrEqual(40)
    expect(d.steps[1]!.pitch!.length).toBeLessThanOrEqual(200)
    expect(Object.keys(d.steps)).toEqual(['1', '2'])
  })

  it('AI answers with an invented number are replaced by a grounded template answer', async () => {
    const ai: Ai = { enabled: true, complete: async () => JSON.stringify({ company: 'ORANO', pitch: 'ORANO has 90,000 paying users and grew 400% last quarter, so it is clearly a winner.' }) }
    const d = await draftApplication(steps, parseFacts(KIT), { name: 'Maya', email: 'maya@x.com', role: 'Founder' }, ai)
    expect(JSON.stringify(d.steps)).not.toContain('90,000')
    expect(JSON.stringify(d.steps)).not.toContain('400%')
  })
})

describe('Investor Outreach Bot sends from the buyer inbox', () => {
  const spec = (q: number) => makeSpec({ skill_id: 'investor_outreach', quantity: q, acceptance: [{ check: 'email_delivered', params: { via: 'smtp_auth' } }] })
  const consentFor = (q: number) => sendConsent(q, new Date(Date.now() + 86_400_000).toISOString())
  const jobWith = (q: number, extra: Record<string, unknown> = {}, id = uid('io')) => ({ ...makeJob(spec(q), { facts_kit: KIT }, undefined, { id, contract: contractWith([accessA1('inbox_send', consentFor(q))]), ...extra }) })

  it('sends with the mailbox app password, logs each send first with its message id, passes the smtp_auth check', async () => {
    const address = `founder-${uid('a')}@oranoai.com`.toLowerCase()
    const pw = await mailbox(address)
    const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
    const tools = fakeTools(NO_AI, { consent: consentFor(4) })
    const job = jobWith(4, { secrets: [login(address, pw)] })
    const r = await bot.work(job, tools)
    const units = r.delivery.deliverables[0]!.units
    expect(units.length).toBeGreaterThanOrEqual(2)
    expect(tools.fake.rejected).toBe(0)
    const sends = tools.fake.actions.filter((a) => a.action === 'send_email')
    expect(sends).toHaveLength(units.length)
    for (const u of units) {
      const a = sends.find((x) => x.external_ref === u.meta.message_id)!
      expect(a).toBeTruthy()
      expect(a.target).toBe(u.meta.to)
      expect(u.meta.from).toBe(address)
    }
    // all logs came before the corresponding send reached the sandbox: nothing is logged after the last unit's mail (order is only on the platform side)
    expect(passedUnits(await runAcceptance(box.checks, spec(4), r.delivery, tools))).toHaveLength(units.length)
    // the buyer's app password is nowhere in what the bot wrote
    expect(JSON.stringify([r, tools.uploads, tools.logs, tools.progressCalls])).not.toContain(pw)
  }, 60_000)

  it('stops by itself at the consent cap (no refused action, so no integrity flag) and says so', async () => {
    const address = `capped-${uid('b')}@oranoai.com`.toLowerCase()
    const pw = await mailbox(address)
    const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
    const cap = { ...consentFor(6), max_total: 2, max_per_day: 2 }
    const tools = fakeTools(NO_AI, { consent: cap })
    const job = { ...jobWith(6, { secrets: [login(address, pw)] }), contract: contractWith([accessA1('inbox_send', cap)]) }
    const r = await bot.work(job, tools)
    expect(r.delivery.deliverables[0]!.units.length).toBeLessThanOrEqual(2)
    expect(tools.fake.rejected).toBe(0)
    expect(r.summary).toMatch(/consent|limit/i)
  }, 60_000)

  it('asks for the login when the contract has the inbox access but the locker holds nothing, and when the password is wrong', async () => {
    const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
    await expect(bot.work(jobWith(3), fakeTools(NO_AI, { consent: consentFor(3) }))).rejects.toMatchObject({ missing: [expect.stringContaining('A1')] })
    const address = `wrong-${uid('c')}@oranoai.com`.toLowerCase()
    await mailbox(address)
    const tools = fakeTools(NO_AI, { consent: consentFor(3) })
    await expect(bot.work(jobWith(3, { secrets: [login(address, 'abcd-abcd-abcd-abcd')] }), tools)).rejects.toMatchObject({ missing: [expect.stringContaining('A1')] })
    expect(tools.fake.rejected).toBe(0)
  }, 60_000)

  it('requirements: A1 inbox_send is REQUIRED and carries a send-only consent on the investor domain', () => {
    const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
    const req = bot.requirements(spec(20), { id: 'x', title: 'x', pricing: { model: 'per_unit', currency: 'USD', price: '2' }, turnaround: 'P1D', checks: [] })
    expect(req.access[0]).toMatchObject({ id: 'A1', kind: 'inbox_send', required: true, consent: { actions: ['send_email'], targets: ['demo-vc.sandbox'] } })
    expect(req.access[0]!.consent!.max_total).toBeGreaterThanOrEqual(20)
    expect(req.access[0]!.consent!.max_total).toBeLessThanOrEqual(200)
  })
})

describe('Account Setup Bot', () => {
  const contact = (id: string) => `owner-${id}@oranoai.com`.toLowerCase()
  const inputs = (id: string, over: Record<string, unknown> = {}) => ({
    product_name: 'ORANO',
    url: 'https://oranoai.com',
    tagline_60: 'Your AI productivity companion',
    description_300: 'ORANO saves links, extracts tasks and exposes an MCP server so agents can work with your saved content.',
    contact_email: contact(id),
    logo_url: 'https://oranoai.com/logo.png',
    ...over,
  })
  const consent = { actions: ['create_account', 'fill_form', 'browse'], max_total: 40, targets: ['saas.sandbox'] }
  const spec = makeSpec({ skill_id: 'account_setup', quantity: 5, acceptance: [{ check: 'url_live', params: {} }, { check: 'page_mentions', params: { must_include: ['ORANO'] } }] })
  const jobFor = (id: string, secrets: ReturnType<typeof login>[], c: typeof consent | null = consent, over: Record<string, unknown> = {}) =>
    makeJob(spec, inputs(id, over), undefined, { id: `job_as${id}`, secrets, ...(c ? { contract: contractWith([accessA1('inbox_verification', c)]) } : {}) })

  it('opens five accounts, hands each login over with a unique strong password, and every live profile passes the platform checks', async () => {
    const id = uid('s1')
    const pw = await mailbox(contact(id))
    const bot = accountSetup({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40, settleMs: 8000 })
    const tools = fakeTools(NO_AI, { consent })
    const r = await bot.work(jobFor(id, [login(contact(id), pw)]), tools)
    const units = r.delivery.deliverables[0]!.units
    expect(units.map((u) => u.ref).sort()).toEqual(['chirpbook', 'inkletter', 'pulsemetrics', 'statusbeacon', 'townsquare'])
    expect(tools.fake.rejected).toBe(0)
    // one handover per service, tied to its unit, created after its create_account action
    expect(tools.fake.handovers).toHaveLength(5)
    const passwords = tools.fake.handovers.map((h) => h.secret.password!)
    expect(new Set(passwords).size).toBe(5)
    expect(passwords.every(policy)).toBe(true)
    for (const h of tools.fake.handovers) {
      expect(h.secret.username).toBe(contact(id))
      const created = tools.fake.actions.find((a) => a.action === 'create_account' && a.target === h.site)!
      expect(created.order).toBeLessThan(h.order)
    }
    // the squatted handle ('orano' on the social and forum services) forced a variant, which the handover notes carry
    const chirp = tools.fake.handovers.find((h) => h.unit_ref === 'chirpbook')!
    expect(chirp.secret.notes).toMatch(/@(?!orano\b)[a-z0-9-]+/)
    // acceptance: url_live and page_mentions per unit
    const res = await runAcceptance(box.checks, spec, r.delivery, tools)
    expect(passedUnits(res)).toHaveLength(5)
    // no password in anything but the locker
    expect(JSON.stringify([r, tools.uploads, tools.logs, tools.progressCalls, tools.fake.calls.filter((c) => c.name !== 'put_locker_item'), tools.fake.room])).not.toContain(pw)
    for (const p of passwords) expect(JSON.stringify([r, tools.uploads, tools.fake.room])).not.toContain(p)
    expect(tools.fake.actions.every((a) => a.target.endsWith('.saas.sandbox'))).toBe(true)
  }, 90_000)

  it('without the inbox login the accounts are created and handed over but nothing is verified or delivered', async () => {
    const id = uid('s2')
    await mailbox(contact(id))
    const bot = accountSetup({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40, settleMs: 800 })
    const tools = fakeTools(NO_AI, { consent })
    const r = await bot.work(jobFor(id, []), tools)
    expect(r.delivery.deliverables[0]!.units).toHaveLength(0)
    expect(tools.fake.rejected).toBe(0)
    expect(r.summary).toMatch(/app password|inbox|verification/i)
  }, 60_000)

  it('a contract with no consent creates no accounts', async () => {
    const id = uid('s3')
    const bot = accountSetup({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40, settleMs: 500 })
    const tools = fakeTools(NO_AI)
    const r = await bot.work(jobFor(id, [], null), tools)
    expect(tools.fake.actions).toHaveLength(0)
    expect(tools.fake.handovers).toHaveLength(0)
    expect(r.delivery.deliverables[0]!.units).toHaveLength(0)
  }, 60_000)

  it('stops cleanly at the consent cap without a refused action', async () => {
    const id = uid('s4')
    const pw = await mailbox(contact(id))
    const bot = accountSetup({ sandboxUrl: box.sandboxUrl, pollMs: 40, retryCapMs: 40, settleMs: 3000 })
    const cap = { ...consent, max_total: 7 }
    const tools = fakeTools(NO_AI, { consent: cap })
    const r = await bot.work(jobFor(id, [login(contact(id), pw)], cap), tools)
    expect(tools.fake.rejected).toBe(0)
    expect(tools.fake.actions.filter((a) => a.accepted).reduce((s, a) => s + a.count, 0)).toBeLessThanOrEqual(7)
    expect(r.delivery.deliverables[0]!.units.length).toBeLessThan(5)
    expect(r.summary).toMatch(/consent|limit/i)
  }, 90_000)

  it('requirements: A1 inbox_verification, optional, create/fill/browse on saas.sandbox; missing inputs named', () => {
    const bot = accountSetup({ sandboxUrl: box.sandboxUrl })
    const req = bot.requirements(spec, { id: 'x', title: 'x', pricing: { model: 'per_unit', currency: 'USD', price: '1.25' }, turnaround: 'PT2H', checks: [] })
    expect(req.access[0]).toMatchObject({ id: 'A1', kind: 'inbox_verification', required: false, consent: { actions: ['create_account', 'fill_form', 'browse'], targets: ['saas.sandbox'] } })
    expect(bot.missingInputs({ product_name: 'x' }, spec)).toEqual(expect.arrayContaining(['url', 'contact_email', 'logo_url']))
  })
})

describe('Application Filler', () => {
  const consent = { actions: ['fill_form'], max_total: 40, targets: ['apps.sandbox'] }
  const spec = makeSpec({ skill_id: 'application_filling', quantity: 3, acceptance: [{ check: 'application_confirmed', params: { must_include: ['ORANO'] } }, { check: 'url_live', params: {} }, { check: 'page_mentions', params: { must_include: ['ORANO'] } }] })
  const inputs = (id: string) => ({ facts_kit: KIT, applicant_name: 'Maya Okafor', applicant_email: `maya-${id}@oranoai.com`.toLowerCase(), amount_usd: 50000 })
  const jobFor = (id: string, c: typeof consent | null = consent, extra: Record<string, unknown> = {}) =>
    makeJob(spec, inputs(id), undefined, { id: `job_af${id}`, ...(c ? { contract: contractWith([accessA1('inbox_verification', c)]) } : {}), ...extra })
  const bot = () => applicationFiller({ sandboxUrl: box.sandboxUrl, pollMs: 30, approvalWaitMs: 15_000 })
  const blocker = (t: ReturnType<typeof fakeTools>) => t.fake.room.find((m) => m.type === 'blocker')

  async function untilBlocked(t: ReturnType<typeof fakeTools>) {
    for (let i = 0; i < 400 && !blocker(t); i++) await sleep(25)
    expect(blocker(t)).toBeTruthy()
  }

  it('fills the forms, posts one approval blocker with a preview per form, submits nothing until the buyer approves', async () => {
    const id = uid('f1')
    const tools = fakeTools(NO_AI, { consent })
    const run = bot().work(jobFor(id), tools)
    await untilBlocked(tools)
    const b = blocker(tools)!
    expect(b.text.startsWith(APPROVAL_PREFIX)).toBe(true)
    const lines = b.text.split('\n').filter((l) => /^- [a-z0-9-]+: /.test(l))
    expect(lines).toHaveLength(3)
    expect(lines.every((l) => /preview: https?:\/\//.test(l))).toBe(true)
    expect(b.artifact_ids.length).toBe(3)
    expect(tools.fake.state).toBe('BLOCKED')
    // only fill_form actions so far (no submit yet): one per form
    expect(tools.fake.actions.filter((a) => a.accepted)).toHaveLength(3)
    // the draft pages exist but there is no confirmation id anywhere yet
    await sleep(150)
    expect(tools.fake.actions.filter((a) => a.accepted)).toHaveLength(3)
    tools.fake.buyerInputs({ approved_applications: 'all' })
    const r = await run
    const units = r.delivery.deliverables[0]!.units
    expect(units).toHaveLength(3)
    expect(tools.fake.state).toBe('IN_PROGRESS')
    expect(tools.fake.rejected).toBe(0)
    expect(tools.fake.actions.filter((a) => a.accepted)).toHaveLength(6) // 3 fills + 3 submits
    for (const u of units) expect(u.meta.confirmation_id).toMatch(/^[A-Z]{2,4}-\d{2}-[A-Z0-9]{6}$/)
    const res = await runAcceptance(box.checks, spec, r.delivery, tools)
    expect(passedUnits(res)).toHaveLength(3)
  }, 90_000)

  it('an approval that predates the preview does not count; approving a subset submits only that subset', async () => {
    const id = uid('f2')
    const tools = fakeTools(NO_AI, { consent })
    tools.fake.buyerInputs({ approved_applications: 'all' }) // an earlier answer, before any preview exists
    const run = bot().work(jobFor(id), tools)
    await untilBlocked(tools)
    await sleep(200)
    expect(tools.fake.actions.filter((a) => a.accepted)).toHaveLength(3) // still waiting: nothing submitted
    const ids = blocker(tools)!.text.split('\n').filter((l) => /^- [a-z0-9-]+: /.test(l)).map((l) => l.slice(2).split(':')[0]!)
    tools.fake.buyerInputs({ approved_applications: ids.slice(0, 2).join(', ') })
    const r = await run
    const units = r.delivery.deliverables[0]!.units
    expect(units.map((u) => u.ref).sort()).toEqual(ids.slice(0, 2).sort())
    expect(r.summary).toContain('Left as drafts, not submitted')
    expect(tools.fake.rejected).toBe(0)
  }, 90_000)

  it('"none" submits nothing and delivers nothing', async () => {
    const id = uid('f3')
    const tools = fakeTools(NO_AI, { consent })
    const run = bot().work(jobFor(id), tools)
    await untilBlocked(tools)
    tools.fake.buyerInputs({ approved_applications: 'none' })
    const r = await run
    expect(r.delivery.deliverables[0]!.units).toHaveLength(0)
    expect(tools.fake.actions.filter((a) => a.accepted)).toHaveLength(3)
    expect(r.summary).toMatch(/No application was approved/)
  }, 60_000)

  it('without a consent in the contract it fills nothing', async () => {
    const tools = fakeTools(NO_AI)
    const r = await bot().work(jobFor(uid('f4'), null), tools)
    expect(tools.fake.actions).toHaveLength(0)
    expect(blocker(tools)).toBeUndefined()
    expect(r.delivery.deliverables[0]!.units).toHaveLength(0)
  }, 60_000)

  it('stops at the consent cap: forms past it are not filled and the platform refuses nothing', async () => {
    const cap = { ...consent, max_total: 2 }
    const tools = fakeTools(NO_AI, { consent: cap })
    const run = bot().work(jobFor(uid('f5'), cap), tools)
    await untilBlocked(tools)
    tools.fake.buyerInputs({ approved_applications: 'all' })
    const r = await run
    expect(tools.fake.rejected).toBe(0)
    expect(r.delivery.deliverables[0]!.units.length).toBeLessThanOrEqual(1)
    expect(r.summary).toMatch(/consent|Not filled|not submitted/i)
  }, 90_000)

  it('requirements and inputs: the approval path is stated, the facts and applicant are required', () => {
    const b = bot()
    const req = b.requirements(spec, { id: 'x', title: 'x', pricing: { model: 'per_unit', currency: 'USD', price: '4' }, turnaround: 'P1D', checks: [] })
    expect(req.assumptions.join(' ')).toMatch(/approved_applications/)
    expect(req.access[0]).toMatchObject({ id: 'A1', kind: 'inbox_verification', required: false, consent: { actions: ['fill_form'], targets: ['apps.sandbox'] } })
    expect(b.missingInputs({}, spec)).toEqual(['facts_kit', 'applicant_name', 'applicant_email'])
    expect(b.clarify!('do you submit before I approve?', spec, {} as never)).toMatch(/approved_applications/)
  })
})
