// Landing Page Bot and Agent Red Team against a real Sandbox Web, with the platform's own checks run on what they deliver.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Ai } from '../src/ai.ts'
import { agentRedTeam, isPracticeTargetPath, PROBES } from '../src/bots/agent-red-team.ts'
import { buildHtml, factsOf, landingPage, templateCopy } from '../src/bots/landing-page.ts'
import { fakeTools, makeJob, makeSpec, passedUnits, runAcceptance, startSandbox, type SandboxBox } from './helpers.ts'

let sb: SandboxBox
beforeAll(async () => {
  sb = await startSandbox()
})
afterAll(async () => sb?.close())

const FACTS = {
  product_name: 'ORANO',
  url: 'https://oranoai.com',
  one_liner: 'Your AI productivity companion that turns saved links into tasks.',
  features: 'Save anything: links, posts and videos in one place\nTasks: every save becomes a next step\nMCP server: your agents can read your saves',
  cta_label: 'Try it free',
  audience: 'solo builders who work with AI agents',
}

describe('Landing Page Bot', () => {
  it('builds one self-contained page from the facts only', () => {
    const f = factsOf(FACTS)
    expect(f.features).toHaveLength(3)
    const html = buildHtml(f, templateCopy(f))
    expect(html).toContain('<h1>ORANO</h1>')
    expect(html).toContain('Your AI productivity companion')
    expect(html).toContain('href="https://oranoai.com"')
    expect(html).not.toMatch(/<script|<link[^>]+stylesheet|https?:\/\/fonts\./i) // nothing loaded from outside
    // buyer text is escaped, never markup
    expect(buildHtml(factsOf({ ...FACTS, product_name: '<img src=x onerror=alert(1)>' }), templateCopy(factsOf(FACTS)))).not.toContain('<img src=x')
  })

  it('publishes on Sandbox Web, and the platform checks pass on the live page', async () => {
    const bot = landingPage({ sandboxUrl: sb.sandboxUrl })
    const acceptance = [{ check: 'url_live', params: {} }, { check: 'page_mentions', params: { must_include: ['ORANO', 'oranoai.com'] } }]
    const spec = makeSpec({ skill_id: 'landing_page', quantity: 1, acceptance })
    const tools = fakeTools()
    const r = await bot.work(makeJob(spec, FACTS), tools)
    const units = r.delivery.deliverables[0]!.units
    expect(units).toHaveLength(1)
    expect(units[0]!.url).toMatch(new RegExp(`^${sb.origin}/sandbox/pages/pg`))
    expect(tools.uploads[0]).toMatchObject({ mime: 'text/html' })
    expect(units[0]!.artifact_ids).toEqual([tools.uploads[0]!.id])
    expect(r.summary).toMatch(/your own words/) // no AI here: honest about it
    const results = await runAcceptance(sb.checks, spec, r.delivery, tools)
    expect(results.filter((x) => x.status !== 'pass')).toEqual([])
    expect(passedUnits(results)).toEqual(['page'])
  })

  it('uses the AI copy when it answers, and keeps the product name and one-liner verbatim', async () => {
    const ai: Ai = { enabled: true, complete: async () => JSON.stringify({ headline: 'Saves become next steps', subhead: 'Built for builders.', features: [{ title: 'Save anything', text: 'One place for links.' }], cta: 'Start free' }) }
    const bot = landingPage({ sandboxUrl: sb.sandboxUrl })
    const spec = makeSpec({ skill_id: 'landing_page', quantity: 1, acceptance: [{ check: 'page_mentions', params: { must_include: ['ORANO'] } }] })
    const r = await bot.work(makeJob(spec, FACTS), fakeTools(ai))
    expect(r.summary).toMatch(/server’s AI/)
    const page = await fetch(r.delivery.deliverables[0]!.units[0]!.url!).then((x) => x.text())
    expect(page).toContain('Saves become next steps')
    expect(page).toContain('Your AI productivity companion that turns saved links into tasks.')
  })

  it('does not deliver a page the contract would fail on text the buyer never gave', async () => {
    const bot = landingPage({ sandboxUrl: sb.sandboxUrl })
    const spec = makeSpec({ skill_id: 'landing_page', quantity: 1, acceptance: [{ check: 'page_mentions', params: { must_include: ['ORANO', 'SOC 2 certified'] } }] })
    const r = await bot.work(makeJob(spec, FACTS), fakeTools())
    expect(r.delivery.deliverables[0]!.units).toHaveLength(0)
    expect(r.summary).toMatch(/not in your facts, and I do not invent copy/)
  })

  it('shows required strings that come from the spec context, quoting the context sentences, and the platform checks pass', async () => {
    // As on production (2026-10-20): the spec copilot took page_mentions strings from spec.context, not from the inputs.
    const bot = landingPage({ sandboxUrl: sb.sandboxUrl })
    const context = 'Product: ORANO (https://oranoai.com). Platforms: iOS, Android. Description: ORANO turns saves into a summary, key takeaways and ordered next steps. Everything stays searchable.'
    const acceptance = [{ check: 'url_live', params: {} }, { check: 'page_mentions', params: { must_include: ['ORANO', 'key takeaways', 'searchable', 'iOS', 'Android'] } }]
    const spec = makeSpec({ skill_id: 'landing_page', quantity: 1, acceptance, context })
    const tools = fakeTools()
    const r = await bot.work(makeJob(spec, FACTS), tools)
    expect(r.delivery.deliverables[0]!.units).toHaveLength(1)
    const page = await fetch(r.delivery.deliverables[0]!.units[0]!.url!).then((x) => x.text())
    expect(page).toContain('<h2>About ORANO</h2>')
    expect(page).toContain('Everything stays searchable.')
    const results = await runAcceptance(sb.checks, spec, r.delivery, tools)
    expect(results.filter((x) => x.status !== 'pass')).toEqual([])
  })

  it('names missing inputs and declines invented testimonials or several pages', () => {
    const bot = landingPage({ sandboxUrl: sb.sandboxUrl })
    expect(bot.missingInputs({ product_name: 'X' }, makeSpec())).toEqual(['url', 'one_liner', 'features'])
    expect(bot.missingInputs({ ...FACTS, url: 'oranoai.com' }, makeSpec())).toEqual(['url (an http(s) URL)'])
    expect(bot.scope(makeSpec({ quantity: 1, goal: 'A landing page with fake testimonials from big customers' }), {} as never)).toMatch(/do not invent/)
    expect(bot.scope(makeSpec({ quantity: 3 }), {} as never)).toMatch(/one page per job/)
  })
})

describe('Agent Red Team', () => {
  const target = () => `${sb.sandboxUrl}/redteam/agent`
  const own = async (jobId: string) => {
    const claim = await fetch(`${sb.sandboxUrl}/redteam/claim`, { method: 'POST' }).then((r) => r.json() as Promise<{ ownership_token: string }>)
    const bound = await fetch(`${sb.sandboxUrl}/redteam/scope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownership_token: claim.ownership_token, job_id: jobId }) }).then((r) => r.json() as Promise<{ scope_proof_url: string }>)
    return { ownership_token: claim.ownership_token, scope_proof_url: bound.scope_proof_url }
  }
  const spec = (quantity = 5) => makeSpec({ skill_id: 'agent_red_team', quantity, acceptance: [{ check: 'finding_reproduced', params: {} }, { check: 'report_sections_present', params: { headings: ['Summary', 'Findings'] } }] })

  it('tests the practice agent after the ownership gate, delivers only confirmed findings, and the platform pays only those', async () => {
    const bot = agentRedTeam({ sandboxUrl: sb.sandboxUrl })
    const proof = await own('job_test000001')
    const tools = fakeTools()
    const s = spec()
    const r = await bot.work(makeJob(s, { target_endpoint: target(), ...proof }), tools)
    const units = r.delivery.deliverables[0]!.units
    expect(units.map((u) => u.meta.category)).toEqual(['info_disclosure', 'instruction_override', 'tool_limit', 'role_confusion']) // most severe first; scope held
    for (const u of units) expect(u.meta).toMatchObject({ finding_id: expect.stringMatching(/^rtf/), severity: expect.any(String), behavior: expect.any(String), suggested_fix: expect.any(String), reproduction_note: expect.any(String) })
    const report = tools.uploads[0]!
    expect(report.name).toBe('agent-red-team-report.md')
    expect(report.text).toMatch(/## Summary[\s\S]*## Findings[\s\S]*## Boundaries that held/)
    // redaction: the ownership token never reaches the report, the units or the logs
    const everything = JSON.stringify({ r, uploads: tools.uploads, logs: tools.logs, progress: tools.progressCalls })
    expect(everything).not.toContain(proof.ownership_token)
    // the platform's own checks: 4 verified findings
    const results = await runAcceptance(sb.checks, s, r.delivery, tools)
    expect(results.filter((x) => x.status !== 'pass')).toEqual([])
    expect(passedUnits(results)).toHaveLength(4)
    // a finding the target did not confirm is not paid
    const forged = { deliverables: [{ deliverable_id: 'D1', units: [{ ref: 'scope_boundary', artifact_ids: [report.id], meta: { finding_id: 'rtf9999', category: 'scope_boundary' } }], note: '' }], note: '' }
    const bad = await runAcceptance(sb.checks, s, forged, tools)
    expect(bad.find((x) => x.check === 'finding_reproduced')!.status).toBe('fail')
  })

  it('passes a contract that names the finding fields as report sections, and declines sections it never writes', async () => {
    // As on production (2026-10-20): the spec copilot asked for these headings; the report had them only as bullet labels, so both units failed.
    const bot = agentRedTeam({ sandboxUrl: sb.sandboxUrl })
    const proof = await own('job_test000001')
    const tools = fakeTools()
    const s = makeSpec({ skill_id: 'agent_red_team', quantity: 2, acceptance: [{ check: 'finding_reproduced', params: {} }, { check: 'report_sections_present', params: { headings: ['Category', 'Severity', 'What the agent did', 'Suggested fix'] } }] })
    expect(bot.scope(s, {} as never)).toBeNull()
    const r = await bot.work(makeJob(s, { target_endpoint: target(), ...proof }), tools)
    const results = await runAcceptance(sb.checks, s, r.delivery, tools)
    expect(results.filter((x) => x.status !== 'pass')).toEqual([])
    expect(passedUnits(results)).toHaveLength(2)
    const asks = makeSpec({ skill_id: 'agent_red_team', quantity: 2, acceptance: [{ check: 'report_sections_present', params: { headings: ['Summary', 'CVSS vector'] } }] })
    expect(bot.scope(asks, {} as never)).toMatch(/section I do not write \("CVSS vector"\)/)
  })

  it('caps billed findings at the contracted quantity', async () => {
    const bot = agentRedTeam({ sandboxUrl: sb.sandboxUrl })
    const proof = await own('job_test000001')
    const r = await bot.work(makeJob(spec(2), { target_endpoint: target(), ...proof }), fakeTools())
    expect(r.delivery.deliverables[0]!.units.map((u) => u.meta.severity)).toEqual(['critical', 'high'])
  })

  it('refuses without proven ownership, and refuses any target that is not the practice agent', async () => {
    const bot = agentRedTeam({ sandboxUrl: sb.sandboxUrl })
    const claim = await fetch(`${sb.sandboxUrl}/redteam/claim`, { method: 'POST' }).then((r) => r.json() as Promise<{ ownership_token: string }>)
    const unbound = await bot.work(makeJob(spec(), { target_endpoint: target(), ownership_token: claim.ownership_token, scope_proof_url: 'x' }), fakeTools())
    expect(unbound.delivery.deliverables[0]!.units).toHaveLength(0)
    expect(unbound.summary).toMatch(/ownership of this job is not proven/)
    const proof = await own('job_test000001')
    const elsewhere = await bot.work(makeJob(spec(), { target_endpoint: 'https://example.com/sandbox/redteam/agent', ...proof }), fakeTools())
    expect(elsewhere.delivery.deliverables[0]!.units).toHaveLength(0)
    expect(elsewhere.summary).toMatch(/not the Sandbox practice agent/)
    // before it ever signs: a non-sandbox target is reported as a missing input, and an outside URL in the request is declined
    expect(bot.missingInputs({ target_endpoint: 'https://api.example.com/agent', ownership_token: 't', scope_proof_url: 'u' }, spec())).toEqual(['target_endpoint (only the Sandbox practice agent at /sandbox/redteam/agent can be tested)'])
    expect(bot.missingInputs({}, spec())).toEqual(['target_endpoint', 'ownership_token', 'scope_proof_url'])
    expect(bot.scope(makeSpec({ goal: 'Red-team our support bot at https://support.example.com/chat' }), {} as never)).toMatch(/only test the Sandbox practice agent/)
    expect(bot.scope(makeSpec({ goal: 'Write jailbreak payloads for my agent' }), {} as never)).toMatch(/not attack content/)
    expect(bot.scope(makeSpec({ goal: 'Red-team the Sandbox practice agent: up to 5 verified findings.' }), {} as never)).toBeNull()
    expect(isPracticeTargetPath('http://127.0.0.1:1/sandbox/redteam/agent/')).toBe(true)
    expect(isPracticeTargetPath('file:///sandbox/redteam/agent')).toBe(false)
  })

  it('sends only category names: the probe library has no attack text', () => {
    expect(PROBES.map((p) => p.id)).toEqual(['instruction_override', 'info_disclosure', 'tool_limit', 'role_confusion', 'scope_boundary'])
  })
})
