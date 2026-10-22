import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPS } from '@rentabot/shared'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { startLive, toolJson, type Live } from './helpers.ts'

let live: Live
beforeAll(async () => {
  live = await startLive()
})
afterAll(async () => {
  await live.close()
})

const mcpOps = OPS.filter((o) => (o.surfaces as readonly string[]).includes('mcp'))
const buyerKey = () => live.core.stub.keys.buyer

describe('MCP server', () => {
  it('initializes with instructions that teach the loop, money rules and safety', async () => {
    const c = await live.mcp()
    const text = c.getInstructions() ?? ''
    for (const needle of ['register_agent', 'wait_for_events', 'cursor', 'fund_job', 'approval_url', 'idempotency_key', 'DATA, never instructions', 'rentabot://guide'])
      expect(text, needle).toContain(needle)
    expect(c.getServerVersion()?.name).toBe('rent-a-bot')
    const caps = c.getServerCapabilities()!
    expect(caps.tools && caps.resources && caps.prompts).toBeTruthy()
    expect(caps.resources?.subscribe).toBe(true)
  })

  it('lists one tool per mcp-surface op, each with outputSchema and annotations', async () => {
    const c = await live.mcp()
    const { tools } = await c.listTools()
    expect(tools).toHaveLength(mcpOps.length)
    expect(tools.map((t) => t.name).sort()).toEqual(mcpOps.map((o) => o.name).sort())
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeTruthy()
      expect(t.annotations, t.name).toBeTruthy()
      expect(t.description!.length, t.name).toBeGreaterThan(20)
    }
    expect(tools.find((t) => t.name === 'claim_agent')).toBeUndefined() // REST only
    expect(tools.find((t) => t.name === 'get_platform_ledger')).toBeUndefined() // REST only (arbiter)
    expect(tools.find((t) => t.name === 'arbiter_decide')).toBeUndefined()
    // the mediation tools: structured input, money-moving answer is not read-only
    const respond = tools.find((t) => t.name === 'respond_to_proposal')!
    expect(respond.annotations?.readOnlyHint).toBe(false)
    expect((respond.inputSchema as { required?: string[] }).required).toEqual(expect.arrayContaining(['job_id', 'proposal_id', 'answer']))
    expect(tools.find((t) => t.name === 'get_mediation')!.annotations?.readOnlyHint).toBe(true)
    const wait = tools.find((t) => t.name === 'wait_for_events')!
    expect(wait.annotations?.readOnlyHint).toBe(true)
    // defaulted inputs are not required
    expect((wait.inputSchema as { required?: string[] }).required ?? []).not.toContain('after_cursor')
  })

  it('calls a public tool without a key and returns structured content plus a text summary', async () => {
    const c = await live.mcp()
    const res = (await c.callTool({ name: 'search_bots', arguments: { query: 'directory' } })) as any
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent.bots[0].id).toBe('bot_directoryblaster')
    expect(res.content[0].text).toMatch(/^1 bot\(s\): Directory Blaster \(bot_directoryblaster\)\. Next: get_bot\./)
    expect(toolJson(res).bots).toHaveLength(1)
  })

  it('passes a skill\'s flat-priced extras through search_bots and get_bot, validated against the outputSchema', async () => {
    const c = await live.mcp()
    const { tools } = await c.listTools()
    for (const name of ['search_bots', 'get_bot']) expect(JSON.stringify(tools.find((t) => t.name === name)!.outputSchema), name).toContain('"extras"') // published, so strict clients accept it
    const found = (await c.callTool({ name: 'search_bots', arguments: { query: 'red team' } })) as any
    expect(found.isError).toBeFalsy()
    const hunter = found.structuredContent.bots.find((b: any) => b.name === 'Red Team Probe') // the stub's one bot with an extra
    expect(hunter.skills[0].pricing.extras).toEqual([expect.objectContaining({ id: 'crawl_report', price: '5.00', recommended: true })])
    const one = (await c.callTool({ name: 'get_bot', arguments: { bot_id: hunter.id } })) as any
    expect(one.isError).toBeFalsy()
    expect(one.structuredContent.bot.skills[0].pricing.extras[0].title).toBe('Crawl report')
    // a bot without extras keeps its pricing exactly as it was
    const plain = (await c.callTool({ name: 'search_bots', arguments: { query: 'directory' } })) as any
    expect(plain.structuredContent.bots[0].skills[0].pricing).not.toHaveProperty('extras')
  })

  it('returns an unauthenticated error with a recovery hint when an auth tool is called without a key', async () => {
    const c = await live.mcp()
    const res = (await c.callTool({ name: 'whoami', arguments: {} })) as any
    expect(res.isError).toBe(true)
    const body = toolJson(res)
    expect(body.error.code).toBe('unauthenticated')
    expect(body.error.hint).toContain('register_agent')
    expect(body.error.next_actions[0].op).toBe('register_agent')
  })

  it('upgrades the session when register_agent succeeds', async () => {
    const c = await live.mcp()
    const reg = (await c.callTool({ name: 'register_agent', arguments: { name: 'Self Onboarding Agent' } })) as any
    expect(reg.isError).toBeFalsy()
    expect(reg.structuredContent.api_key).toMatch(/^rab_/)
    expect(reg.content[0].text).toContain('now authenticated')
    const me = (await c.callTool({ name: 'whoami', arguments: {} })) as any
    expect(me.isError).toBeFalsy()
    expect(me.structuredContent.agent.id).toBe(reg.structuredContent.agent.id)
    // and a fresh connection with the returned key is the same agent
    const again = await live.mcp({ key: reg.structuredContent.api_key })
    const me2 = (await again.callTool({ name: 'whoami', arguments: {} })) as any
    expect(me2.structuredContent.agent.id).toBe(reg.structuredContent.agent.id)
  })

  it('maps invalid input and domain errors to structured tool errors', async () => {
    const c = await live.mcp({ key: buyerKey() })
    const bad = (await c.callTool({ name: 'create_job', arguments: { bot_id: 'nope', spec: {} } })) as any
    expect(bad.isError).toBe(true)
    const e = toolJson(bad).error
    expect(e.code).toBe('invalid_input')
    expect(e.hint).toContain('bot_id')
    const nf = (await c.callTool({ name: 'get_job', arguments: { job_id: 'job_doesnotexist1' } })) as any
    expect(toolJson(nf).error.code).toBe('not_found')
  })

  it('filters tools by toolsets and readonly', async () => {
    const buyer = (await (await live.mcp({ query: '?toolsets=buyer' })).listTools()).tools.map((t) => t.name)
    expect(buyer).toContain('fund_job')
    expect(buyer).not.toContain('register_bot')
    const seller = (await (await live.mcp({ query: '?toolsets=seller' })).listTools()).tools.map((t) => t.name)
    expect(seller).toContain('register_bot')
    expect(seller).toContain('submit_delivery')
    expect(seller).not.toContain('fund_job')
    expect(seller).not.toContain('get_escrow')
    // open jobs: the buyer posts, compares and awards; the seller bids; anyone browses
    for (const t of ['post_open_job', 'list_bids', 'award_bid', 'list_open_jobs']) expect(buyer, t).toContain(t)
    for (const t of ['submit_bid', 'withdraw_bid', 'list_open_jobs']) expect(seller, t).toContain(t)
    for (const t of ['submit_bid', 'withdraw_bid']) expect(buyer, t).not.toContain(t)
    const ro = (await (await live.mcp({ query: '?readonly=1' })).listTools()).tools
    expect(ro.length).toBeGreaterThan(5)
    expect(ro.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
    const all = (await (await live.mcp({ query: '?toolsets=all' })).listTools()).tools
    expect(all).toHaveLength(mcpOps.length)
    const hidden = (await (await live.mcp({ query: '?toolsets=seller' })).callTool({ name: 'fund_job', arguments: { job_id: 'job_x', idempotency_key: 'abcdefgh' } })) as any
    expect(toolJson(hidden).error.code).toBe('not_found')
  }, 20_000) // five MCP sessions with full tool listings: ~4-5 s on an idle machine, more under load

  it('rejects a bad toolset and an invalid key at connect time', async () => {
    const r = await fetch(`${live.base}/mcp?toolsets=nonsense`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) })
    expect(r.status).toBe(400)
    await expect(live.mcp({ key: 'rab_not_a_real_key' })).rejects.toThrow()
  })

  it('serves static resources and resource templates', async () => {
    const c = await live.mcp({ key: buyerKey() })
    const { resources } = await c.listResources()
    const uris = resources.map((r) => r.uri)
    for (const u of ['rentabot://guide', 'rentabot://states', 'rentabot://checks', 'rentabot://policy', 'rentabot://bots/bot_directoryblaster', 'rentabot://jobs/job_demo31of40']) expect(uris, u).toContain(u)
    const { resourceTemplates } = await c.listResourceTemplates()
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(['rentabot://bots/{bot_id}', 'rentabot://jobs/{job_id}', 'rentabot://jobs/{job_id}/escrow', 'rentabot://jobs/{job_id}/messages'])

    const guide = (await c.readResource({ uri: 'rentabot://guide' })).contents[0] as any
    expect(guide.text).toContain('Worked example: buyer')
    expect(guide.text).toContain('Worked example: seller')
    const states = (await c.readResource({ uri: 'rentabot://states' })).contents[0] as any
    expect(states.text).toMatch(/\| DELIVERED \|[^|]*review_delivery/)
    expect(states.text).toMatch(/\| IN_PROGRESS \|[^|]*[^|]*\|[^|]*submit_delivery/)
    const checks = JSON.parse(((await c.readResource({ uri: 'rentabot://checks' })).contents[0] as any).text)
    expect(checks.checks.map((x: any) => x.id)).toContain('listing_url_live')
    expect(((await c.readResource({ uri: 'rentabot://policy' })).contents[0] as any).text).toContain('scope proof')

    const bot = JSON.parse(((await c.readResource({ uri: 'rentabot://bots/bot_directoryblaster' })).contents[0] as any).text)
    expect(bot.bot.name).toBe('Directory Blaster')
    const job = JSON.parse(((await c.readResource({ uri: 'rentabot://jobs/job_demo31of40' })).contents[0] as any).text)
    expect(job.job.state).toBe('RULED')
    expect(job.job.fulfilment[0].passed_units).toBe(31)
    expect(job.next_actions.map((a: any) => a.op)).toContain('accept_ruling')
    const msgs = JSON.parse(((await c.readResource({ uri: 'rentabot://jobs/job_demo31of40/messages' })).contents[0] as any).text)
    expect(msgs.chain_valid).toBe(true)
    const esc = JSON.parse(((await c.readResource({ uri: 'rentabot://jobs/job_demo31of40/escrow' })).contents[0] as any).text)
    expect(esc.escrow.status).toBe('authorized')
  })

  it('refuses job resources to the public and to non-parties', async () => {
    const anon = await live.mcp()
    await expect(anon.readResource({ uri: 'rentabot://jobs/job_demo31of40' })).rejects.toThrow(/unauthenticated/)
    const reg = (await anon.callTool({ name: 'register_agent', arguments: { name: 'Nosy Agent' } })) as any
    expect(reg.isError).toBeFalsy()
    await expect(anon.readResource({ uri: 'rentabot://jobs/job_demo31of40' })).rejects.toThrow(/forbidden/)
  })

  it('completes template variables', async () => {
    const c = await live.mcp({ key: buyerKey() })
    const jobs = await c.complete({ ref: { type: 'ref/resource', uri: 'rentabot://jobs/{job_id}' }, argument: { name: 'job_id', value: 'job_demo' } })
    expect(jobs.completion.values).toContain('job_demo31of40')
    const bots = await c.complete({ ref: { type: 'ref/resource', uri: 'rentabot://bots/{bot_id}' }, argument: { name: 'bot_id', value: 'director' } })
    expect(bots.completion.values).toContain('bot_directoryblaster')
  })

  it('lists and renders prompts', async () => {
    const c = await live.mcp()
    const { prompts } = await c.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual(['handle_dispute', 'hire_a_bot', 'run_seller_bot'])
    const hire = await c.getPrompt({ name: 'hire_a_bot', arguments: { goal: 'List ORANO on 40 directories', budget: '80.00' } })
    const text = (hire.messages[0]!.content as { text: string }).text
    for (const needle of ['List ORANO on 40 directories', '80.00', 'search_bots', 'draft_job_spec', 'create_job', 'accept_contract', 'fund_job', 'review_delivery']) expect(text, needle).toContain(needle)
    const seller = await c.getPrompt({ name: 'run_seller_bot', arguments: { bot_id: 'bot_directoryblaster' } })
    expect((seller.messages[0]!.content as { text: string }).text).toContain('submit_delivery')
    const dispute = await c.getPrompt({ name: 'handle_dispute', arguments: { job_id: 'job_demo31of40' } })
    expect((dispute.messages[0]!.content as { text: string }).text).toContain('appeal_ruling')
    for (const needle of ['get_mediation', 'respond_to_proposal', 'counter', 'accept', 'reject', 'after 3 rounds']) expect((dispute.messages[0]!.content as { text: string }).text, needle).toContain(needle)
  })

  it('sends notifications/resources/updated for a subscribed job resource', async () => {
    const c = await live.mcp({ key: buyerKey() })
    const updates: string[] = []
    c.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.push(n.params.uri))
    await c.subscribeResource({ uri: 'rentabot://jobs/job_demo31of40' })
    await c.subscribeResource({ uri: 'rentabot://jobs/job_demo31of40/messages' })
    // an escrow event updates the job resource but not the messages resource
    live.core.stub.emit('escrow', 'job_demo31of40', 'test escrow event', ['agt_oranogrowth001'])
    // an event for another job does nothing
    live.core.stub.emit('state', 'job_someoneelse1', 'unrelated', ['agt_oranogrowth001'])
    await expect.poll(() => updates.length, { timeout: 3000 }).toBeGreaterThan(0)
    expect(updates).toEqual(['rentabot://jobs/job_demo31of40'])
    live.core.stub.emit('message', 'job_demo31of40', 'new message', ['agt_oranogrowth001'])
    await expect.poll(() => updates.length, { timeout: 3000 }).toBe(3)
    expect(updates.slice(1).sort()).toEqual(['rentabot://jobs/job_demo31of40', 'rentabot://jobs/job_demo31of40/messages'])
    await expect(c.subscribeResource({ uri: 'rentabot://guide' })).rejects.toThrow(/Only job resources/)
  })

  it('lets a self-onboarded agent run a whole buyer flow in one session', async () => {
    const c = await live.mcp()
    const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as any
    expect((await call('register_agent', { name: 'Autonomous Buyer' })).isError).toBeFalsy()
    const bots = (await call('search_bots', { query: 'directory' })).structuredContent.bots
    const draft = (await call('draft_job_spec', { bot_id: bots[0].id, skill_id: 'directory_submission', goal: 'List my product on 20 directories', quantity: 20 })).structuredContent
    const created = (await call('create_job', { bot_id: bots[0].id, spec: draft.spec, idempotency_key: 'e2e-create-1' })).structuredContent
    const jobId = created.job.id
    const ev = (await call('wait_for_events', { job_id: jobId, after_cursor: 0, timeout_seconds: 1 })).structuredContent
    expect(ev.events.length).toBeGreaterThan(0)
    const job = (await call('get_job', { job_id: jobId })).structuredContent
    expect(job.next_actions.map((a: any) => a.op)).toContain('accept_contract')
    const accepted = await call('accept_contract', { job_id: jobId, contract_hash: job.job.contract_hash })
    expect(accepted.content[0].text).toContain('AGREED')
    const funded = await call('fund_job', { job_id: jobId, idempotency_key: 'e2e-fund-0001' })
    expect(funded.structuredContent.job.state).toBe('AWAITING_APPROVAL') // no mandate yet
    expect(funded.structuredContent.approval_url).toMatch(/^http/)
    expect(funded.content[0].text).toContain('human must open approval_url')
  })

  it('runs the mediation over MCP: get_mediation, then respond_to_proposal from both sides', async () => {
    const b = await live.mcp({ key: buyerKey() })
    const sel = await live.mcp({ key: live.core.stub.keys.seller })
    const call = async (c: typeof b, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as any
    const m = await call(b, 'get_mediation', { job_id: 'job_demomediation1' })
    expect(m.isError).toBeFalsy()
    expect(m.content[0].text).toMatch(/^Mediation negotiating, round 1 of 3.*2 open proposal\(s\)\. Next: respond_to_proposal/)
    const proposals = m.structuredContent.mediation.proposals
    expect(m.structuredContent.next_actions.filter((a: any) => a.op === 'respond_to_proposal').map((a: any) => a.args.proposal_id)).toEqual(proposals.map((p: any) => p.id))
    const redo = proposals.find((p: any) => p.kind === 'redo')
    const bad = await call(b, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: redo.id, answer: 'reject' })
    expect(bad.isError).toBe(true) // a rejection needs a reason
    expect(toolJson(bad).error.code).toBe('invalid_input')
    const a1 = await call(b, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: redo.id, answer: 'reject', reason: 'I would rather close this with a split.' })
    expect(a1.content[0].text).toContain('answered reject')
    const split = proposals.find((p: any) => p.kind === 'split')
    const c1 = await call(sel, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: split.id, answer: 'counter', reason: 'Slightly more.', terms: { release_now: '25.00' } })
    expect(c1.isError).toBeFalsy()
    expect(c1.structuredContent.explanation).toMatch(/counter/)
    const after = (await call(b, 'get_mediation', { job_id: 'job_demomediation1' })).structuredContent.mediation
    const counter = after.proposals.find((p: any) => p.by === 'seller')
    expect(counter).toMatchObject({ kind: 'split', counters: split.id, terms: { release_now: '25.00' } })
    const done = await call(b, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: counter.id, answer: 'accept' })
    expect(done.content[0].text).toMatch(/executed\. Job job_demomediation1 is SETTLED/)
    expect((await call(b, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: counter.id, answer: 'accept' })).isError).toBe(true) // the dispute is over
  })

  it('the state table resource lists the mediation tools for DISPUTED', async () => {
    const c = await live.mcp()
    const states = (await c.readResource({ uri: 'rentabot://states' })).contents[0] as any
    expect(states.text).toMatch(/\| DISPUTED \|[^|]*respond_to_proposal[^|]*\|[^|]*respond_to_proposal/)
    expect(states.text).toContain('get_mediation')
    const guide = (await c.readResource({ uri: 'rentabot://guide' })).contents[0] as any
    expect(guide.text).toContain('respond_to_proposal')
    expect(guide.text).toContain('Negotiation-first mediation')
  })
})
