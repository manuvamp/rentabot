import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Ai } from '../src/ai.ts'
import { coldEmailWriter, recipientsOf } from '../src/bots/cold-email-writer.ts'
import { investorOutreach, overlapScore } from '../src/bots/investor-outreach.ts'
import { parseFacts, templateEmail, writeEmail } from '../src/email-writing.ts'
import { lintEmail } from '../src/server-shared.ts'
import { fakeTools, makeJob, makeSpec, NO_AI, passedUnits, runAcceptance, startSandbox, type SandboxBox } from './helpers.ts'
import { PERSONAS } from '../../server/src/sandbox/personas.ts'

const KIT = `Product: ORANO
URL: https://oranoai.com
One-liner: ORANO is an AI productivity companion that saves links, extracts tasks, and exposes an MCP server so agents can work with your saved content.
ORANO is live on iOS and Android. It is built for solo builders who work with AI agents and developer tools. Contact: hello@oranoai.com`

let box: SandboxBox
beforeAll(async () => {
  box = await startSandbox({ timeScale: 0.002 })
})
afterAll(async () => box?.close())

/** A scripted stand-in for the AI: answers are consumed in order, then it repeats the last one. */
function scriptedAi(replies: string[]): Ai & { calls: string[] } {
  const calls: string[] = []
  let i = 0
  return {
    enabled: true,
    calls,
    async complete({ user }) {
      calls.push(user)
      return replies[Math.min(i++, replies.length - 1)]!
    },
  }
}

describe('facts and templates', () => {
  it('parses a facts kit and writes a template email that passes the lint', () => {
    const f = parseFacts(KIT)
    expect(f).toMatchObject({ product: 'ORANO', url: 'https://oranoai.com' })
    for (const kind of ['cold', 'investor'] as const) {
      const t = templateEmail(f, { name: 'Maya Okafor', company: 'Northwind Ventures', angle: 'Developer tools and infrastructure for AI agents.' }, kind)
      const lint = lintEmail({ ...t, company: 'Northwind Ventures' }, { allowCaps: ['ORANO'] })
      expect(lint.violations).toEqual([])
      expect(t.body).toContain('Northwind Ventures')
    }
  })

  it('scores keyword overlap without AI', () => {
    const inv = PERSONAS.find((p) => p.firm === 'Northwind Ventures')!
    expect(overlapScore(KIT, inv).score).toBeGreaterThanOrEqual(4)
    expect(overlapScore(KIT, PERSONAS.find((p) => p.firm === 'Fjordline Partners')!).score).toBe(0)
  })
})

describe('writeEmail (AI with self-lint)', () => {
  const f = parseFacts(KIT)
  const r = { name: 'Priya Raman', company: 'Kiln Seed Fund', angle: 'Marketplaces and two-sided platforms where trust and payments are the product.' }
  const good = JSON.stringify({
    subject: 'agents hiring bots with escrow',
    body: 'Hi Priya,\n\nKiln Seed Fund backs marketplaces where trust and payments are the product, and that is the corner we work in. ORANO is an AI productivity companion that saves links, extracts tasks and exposes an MCP server so agents can work with saved content. It is live on iOS and Android today, built for solo builders who work with AI agents and developer tools, and you can see it at https://oranoai.com.\n\nWould a short note on where it stands be useful to you?\n\nIf it is outside what Kiln Seed Fund covers, please ignore this and I will not follow up.\n\nThe ORANO team',
  })

  it('rewrites when the lint fails, then accepts the clean draft', async () => {
    const bad = JSON.stringify({ subject: 'x'.repeat(80), body: 'Hi {name}, buy now? Really? ACT NOW' })
    const ai = scriptedAi([bad, good])
    const mail = await writeEmail({ ai, facts: f, recipient: r, kind: 'investor' })
    expect(mail).toMatchObject({ ok: true, usedAi: true, rewrites: 1 })
    expect(ai.calls[1]).toContain('FAILED THE LINT') // the violations were fed back to the model
    expect(ai.calls[1]).toContain('subject_length')
    expect(lintEmail({ subject: mail.subject, body: mail.body, company: r.company }).ok).toBe(true)
  })

  it('falls back to the facts-only template after two failed rewrites, never returning a failing email as ok', async () => {
    const ai = scriptedAi([JSON.stringify({ subject: 'ok subject', body: 'too short' })])
    const mail = await writeEmail({ ai, facts: f, recipient: r, kind: 'cold' })
    expect(ai.calls).toHaveLength(3) // first draft + two rewrites
    expect(mail.usedAi).toBe(false)
    expect(mail.ok).toBe(true) // the template passes
    expect(mail.body).toContain('Kiln Seed Fund')
  })

  it('rejects AI drafts that invent numbers or URLs not in the facts', async () => {
    const invented = JSON.stringify({ subject: 'agents hiring bots', body: good.includes('x') ? (JSON.parse(good) as { body: string }).body.replace('live on iOS and Android today', 'used by 48,000 paying customers and funded with $2.5M') : '' })
    const ai = scriptedAi([invented])
    const mail = await writeEmail({ ai, facts: f, recipient: r, kind: 'investor' })
    expect(mail.usedAi).toBe(false)
    expect(mail.body).not.toContain('48,000')
  })

  it('works with no AI at all', async () => {
    const mail = await writeEmail({ ai: NO_AI, facts: f, recipient: r, kind: 'cold' })
    expect(mail).toMatchObject({ ok: true, usedAi: false })
  })
})

describe('Investor Outreach Bot against Sandbox Web', () => {
  it('sends personalised emails to fitting investors, passes email_delivered and the lint, and skips bounces', async () => {
    const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
    const spec = makeSpec({ skill_id: 'investor_outreach', quantity: 6, acceptance: [{ check: 'email_delivered', params: {} }, { check: 'email_lint', params: { allow_caps: ['ORANO'] } }, { check: 'artifact_attached', params: { min_count: 1 } }] })
    const tools = fakeTools()
    const r = await bot.work(makeJob(spec, { facts_kit: KIT, stage: 'pre-seed', sectors: ['AI', 'developer tools'] }), tools)
    const units = r.delivery.deliverables[0]!.units
    expect(units.length).toBeGreaterThanOrEqual(4)
    expect(units.length).toBeLessThanOrEqual(6)

    const results = await runAcceptance(box.checks, spec, r.delivery, tools)
    expect(passedUnits(results)).toHaveLength(units.length) // delivered, lint-clean, with an artifact: all of them

    // Personal: each email names the firm and engages with that firm's own thesis, never a placeholder.
    for (const u of units) {
      const p = PERSONAS.find((x) => x.address === u.meta.to)!
      expect(p).toBeTruthy()
      expect(p.style).not.toBe('bounce') // a bounced send is replaced, never delivered
      expect(String(u.meta.body)).toContain(p.firm)
      expect(String(u.meta.body).toLowerCase()).toContain(p.thesis.toLowerCase().replace(/\.$/, '').slice(0, 25))
      expect(String(u.meta.body)).not.toMatch(/[{}[\]]/)
      expect(Number(u.meta.fit_score)).toBeGreaterThanOrEqual(2) // keyword-overlap bar (no AI in this test)
    }
    // Messages really are in the sandbox mailbox, from the address in the facts kit.
    const sent = (await (await fetch(`${box.sandboxUrl}/mail/messages?address=hello@oranoai.com`)).json()) as { messages: { kind: string; message_id: string; to: string }[] }
    for (const u of units) expect(sent.messages.some((m) => m.kind === 'sent' && m.message_id === u.meta.message_id && m.to === u.meta.to)).toBe(true)
    expect(r.delivery.note).toContain('Every message_id is the one I put on the email and the sandbox mail system confirmed')
  }, 30_000)

  it('uses the AI for fit scoring and writing when available, and still lints', async () => {
    const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
    const target = PERSONAS.find((p) => p.firm === 'Jade Gate Ventures')!
    const ai: Ai = {
      enabled: true,
      async complete({ system, user }) {
        if (/rate how well/i.test(system)) return JSON.stringify({ scores: PERSONAS.map((p) => ({ email: p.address, score: p.address === target.address ? 9 : 1, reason: p.address === target.address ? 'agentic commerce matches' : 'weak' })) })
        return JSON.stringify({
          subject: 'agents that hire bots, with escrow',
          body: `Hi Mei,\n\nJade Gate Ventures backs agentic commerce: AI agents that buy, pay and negotiate for people and businesses. We work on the same idea from the supply side. ORANO is an AI productivity companion that saves links, extracts tasks and exposes an MCP server so agents can work with saved content, and it is live on iOS and Android today. I can share a short note on where the product stands if that helps you judge the fit.\n\nWould that be useful to you?\n\nIf it is outside what you cover, please ignore this and I will not follow up.\n\nThe ORANO team`,
        })
      },
    }
    const spec = makeSpec({ skill_id: 'investor_outreach', quantity: 3, acceptance: [{ check: 'email_delivered', params: {} }] })
    const r = await bot.work(makeJob(spec, { facts_kit: KIT, from_email: 'hello@oranoai.com' }), fakeTools(ai))
    const units = r.delivery.deliverables[0]!.units
    expect(units).toHaveLength(1) // only one investor scored >= 5, and the bot says why it sent fewer
    expect(units[0]!.meta).toMatchObject({ to: target.address, written_by: 'ai', fit_score: 9 })
    expect(r.delivery.note).toContain('only 1 investors fit')
  }, 30_000)

  it('a redelivery (cure round) reuses the emails it already sent instead of mailing investors twice', async () => {
    const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
    const spec = makeSpec({ skill_id: 'investor_outreach', quantity: 3, acceptance: [{ check: 'email_delivered', params: {} }] })
    const inputs = { facts_kit: KIT.replace('hello@oranoai.com', 'cure@oranoai.com') }
    const count = async () => ((await (await fetch(`${box.sandboxUrl}/mail/messages`)).json()) as { count: number }).count
    const first = await bot.work(makeJob(spec, inputs), fakeTools())
    const mailCount = await count()
    const again = await bot.work({ ...makeJob(spec, inputs), cure: [{ reason: 'one bounced', unit_refs: [] }] }, fakeTools())
    const ids = (r: typeof first) => r.delivery.deliverables[0]!.units.map((u) => u.meta.message_id)
    expect(ids(again)).toEqual(ids(first))
    expect(await count()).toBe(mailCount) // nothing was sent the second time
    expect(again.delivery.deliverables[0]!.units[0]!.meta.written_by).toContain('earlier attempt')
  }, 30_000)

  describe('checks fit before quoting', () => {
    const skill = { id: 'investor_outreach', title: 'Investor outreach', pricing: { model: 'per_unit' as const, currency: 'USD' as const, price: '2.00', unit: 'sent_email', min_units: 10, max_units: 200 }, turnaround: 'P5D', checks: ['email_delivered'] }
    const fitting = () => PERSONAS.filter((p) => overlapScore(KIT, p).score >= 2).length
    const ask = (q: number, over: Record<string, unknown> = {}) => makeSpec({ skill_id: 'investor_outreach', quantity: q, context: KIT, acceptance: [{ check: 'email_delivered', params: {} }], ...over })

    it('quotes up to the number of investors that fit, with the count in the quote notes', async () => {
      const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
      const n = fitting()
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThan(PERSONAS.length)
      const q = await bot.quote(ask(n), skill, { inputs: {}, ai: NO_AI })
      if (!q.ok) throw new Error(q.reason)
      expect(q.quote.total_max.value).toBe((n * 2).toFixed(2))
      expect(q.quote.excludes.join(' ')).toContain(`Checked before quoting: ${n} of ${PERSONAS.length} investors fit`)
    })

    it('declines a quantity it cannot fill, saying how many fit (the 10-asked, 3-fit dispute on production)', async () => {
      const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
      const n = fitting()
      const q = await bot.quote(ask(n + 3), skill, { inputs: {}, ai: NO_AI })
      expect(q.ok).toBe(false)
      const reason = q.ok ? '' : q.reason
      expect(reason).toContain(`only ${n} of the ${PERSONAS.length} investors`)
      expect(reason).toContain(`you asked for ${n + 3}`)
      expect(reason).toContain(`up to ${n} emails`)
      // a narrower description fits fewer investors, so the same quantity is declined too
      const narrow = await bot.quote(ask(n, { context: 'Product: ORANO. We build developer tools for AI agents.' }), skill, { inputs: {}, ai: NO_AI })
      expect(narrow.ok).toBe(false)
    })

    it('declines with a clear reason when too few fit to reach the $5.00 minimum job price', async () => {
      const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
      // The AI rates only two investors as a fit: 2 x $2.00 = $4.00.
      const two = new Set(PERSONAS.slice(0, 2).map((p) => p.address))
      const ai: Ai = { enabled: true, complete: async () => JSON.stringify({ scores: PERSONAS.map((p) => ({ email: p.address, score: two.has(p.address) ? 9 : 1, reason: 'x' })) }) }
      const q = await bot.quote(ask(10), skill, { inputs: {}, ai })
      expect(q.ok).toBe(false)
      const reason = q.ok ? '' : q.reason
      expect(reason).toContain('only 2 of the 25 investors')
      expect(reason).toMatch(/below the platform's \$5\.00 minimum job price/)
    })

    it('uses the facts kit the buyer posts later, and the AI scorer when it is on', async () => {
      const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
      const bare = makeSpec({ skill_id: 'investor_outreach', quantity: 4, acceptance: [{ check: 'email_delivered', params: {} }] })
      // No facts anywhere yet: it can only bound the quantity by the directory, says so, and refuses more than the directory lists.
      const unknown = await bot.quote(bare, skill, { inputs: {}, ai: NO_AI })
      if (!unknown.ok) throw new Error(unknown.reason)
      expect(unknown.quote.excludes.join(' ')).toContain('could not check fit yet')
      expect((await bot.quote({ ...bare, deliverables: [{ ...bare.deliverables[0]!, quantity: 30 }] }, skill, { inputs: {}, ai: NO_AI })).ok).toBe(false)
      // Once the kit is in the room the same ask is checked against it: a kit that fits nobody is declined.
      const nofit = await bot.quote(bare, skill, { inputs: { facts_kit: 'We sell garden furniture.' }, ai: NO_AI })
      expect(nofit.ok).toBe(false)
      // AI scoring: only the one investor it rates 9 fits, so 3 asked is declined and 1 is below the minimum job price.
      const target = PERSONAS.find((p) => p.firm === 'Jade Gate Ventures')!
      const ai: Ai = { enabled: true, complete: async () => JSON.stringify({ scores: PERSONAS.map((p) => ({ email: p.address, score: p.address === target.address ? 9 : 1, reason: 'x' })) }) }
      const viaAi = await bot.quote(ask(3), skill, { inputs: {}, ai })
      expect(viaAi.ok).toBe(false)
      expect(viaAi.ok ? '' : viaAi.reason).toContain('only 1 of the 25 investors')
    })
  })

  it('asks for what it needs instead of guessing', async () => {
    const bot = investorOutreach({ sandboxUrl: box.sandboxUrl })
    expect(bot.missingInputs({}, makeSpec())).toEqual(['facts_kit'])
    const spec = makeSpec({ skill_id: 'investor_outreach', quantity: 2 })
    await expect(bot.work(makeJob(spec, { facts_kit: 'Product: ORANO. We build things.' }), fakeTools())).rejects.toMatchObject({ missing: ['from_email'] })
  })
})

describe('Cold Email Writer', () => {
  const recipients = [
    { name: 'Maya Okafor', company: 'Northwind Ventures', angle: 'Developer tools and infrastructure for AI agents.' },
    { name: 'Hana Sato', company: 'Origami Ventures', angle: 'Creative tools and generative media.', email: 'hana@origami.example' },
    { company: 'Lattice Harbor Capital', angle: 'Vertical SaaS for regulated industries.' },
  ]

  it('writes one lint-clean email per recipient, passing the platform email_lint, and never sends', async () => {
    const bot = coldEmailWriter()
    const spec = makeSpec({ skill_id: 'write_cold_emails', quantity: 3, acceptance: [{ check: 'email_lint', params: { allow_caps: ['ORANO'] } }] })
    const tools = fakeTools()
    const count = async () => ((await (await fetch(`${box.sandboxUrl}/mail/messages`)).json()) as { count: number }).count
    const before = await count()
    const r = await bot.work(makeJob(spec, { facts_kit: KIT, recipients }), tools)
    const units = r.delivery.deliverables[0]!.units
    expect(units).toHaveLength(3)
    expect(units.map((u) => u.meta.company)).toEqual(['Northwind Ventures', 'Origami Ventures', 'Lattice Harbor Capital'])
    expect(units[1]!.meta.to).toBe('hana@origami.example')
    expect(passedUnits(await runAcceptance(box.checks, spec, r.delivery, tools))).toHaveLength(3)
    expect(r.delivery.note).toContain('I did not send anything')
    expect(await count()).toBe(before) // nothing went out
  })

  it('leaves out an email it cannot make pass, and says so', async () => {
    const bot = coldEmailWriter()
    const spec = makeSpec({ skill_id: 'write_cold_emails', quantity: 2 })
    // A company name that can never appear in the template without breaking the lint (a placeholder-like name).
    const r = await bot.work(makeJob(spec, { facts_kit: KIT, recipients: [{ company: '[Acme]', angle: 'x' }, recipients[0]] }), fakeTools())
    expect(r.delivery.deliverables[0]!.units).toHaveLength(1)
    expect(r.delivery.note).toContain('Left out')
    expect(r.delivery.note).toContain('[Acme]')
  })

  it('reads recipients as an array or a JSON string, and names missing inputs', () => {
    expect(recipientsOf({ recipients: JSON.stringify(recipients) })).toHaveLength(3)
    expect(recipientsOf({ recipients: 'nope' })).toEqual([])
    const bot = coldEmailWriter()
    expect(bot.missingInputs({}, makeSpec())).toEqual(['facts_kit', 'recipients'])
    expect(bot.scope(makeSpec({ goal: 'Write and then send the emails to all of them please' }), {} as never)).toContain('never send')
  })
})
