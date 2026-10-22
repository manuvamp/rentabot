// Remaining operations, webhooks, demo reset, seed contents.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deliver, fundedJob, harness, units, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
})

describe('account, discovery and selling ops', () => {
  it('search_bots without a limit returns every listed house bot, and total says when a limit cut some off', async () => {
    h = await harness()
    const all = await h.call('search_bots', { kind: 'public' }, {})
    expect(all.bots.length).toBe(13) // the default limit (25) no longer hides the newest bots from agents
    expect(all.total).toBe(13)
    const few = await h.call('search_bots', { kind: 'public' }, { limit: 3 })
    expect(few.bots.length).toBe(3)
    expect(few.total).toBe(13)
  })

  it('whoami, search, get_bot, list_checks, draft_job_spec, register/update bot, upload, list_jobs', async () => {
    h = await harness()
    const me = await h.call('whoami', h.buyer, {})
    expect(me).toMatchObject({ agent: { name: 'ORANO Growth Agent', claimed: true }, mandate: { status: 'active', per_job_cap: { value: '80.00' } }, payment_rail: 'simulated' })
    const sel = await h.call('whoami', h.seller, {})
    expect(sel.bots.map((b) => b.name)).toContain('Lead Verifier')
    const found = await h.call('search_bots', { kind: 'public' }, { query: 'directories' })
    expect(found.bots[0].name).toBe('Directory Blaster')
    expect((await h.call('search_bots', { kind: 'public' }, { mode: 'live' })).bots.map((b) => b.name).sort()).toEqual(['Agent-Readiness Auditor', 'Broken Link Hunter', 'Budget Lead Verifier', 'Cold Email Writer', 'Deliverability Doctor', 'Lead Verifier', 'Web Data Extractor'])
    const red = (await h.call('search_bots', { kind: 'public' }, { query: 'red team' })).bots
    expect(red.map((b) => b.name)).toEqual(['Agent Red Team']) // listed, scope-proof gated
    expect(red[0]?.passport?.unlocks[0]).toMatch(/proof of ownership/)
    expect((await h.call('list_checks', { kind: 'public' }, {})).checks.length).toBeGreaterThan(0)
    const draft = await h.call('draft_job_spec', h.buyer, { bot_id: h.bots['Directory Blaster'], skill_id: 'directory_submission', goal: 'List ORANO on AI directories', quantity: 20 })
    expect(draft.policy.class).toBe('standard')
    const bot = await h.call('register_bot', h.stranger, {
      name: 'Tiny Bot',
      tagline: 'Does tiny things',
      description: 'A tiny helpful bot.',
      capability_class: 'compute_media',
      mode: 'demo',
      skills: [{ id: 'tiny_thing', title: 'Tiny', description: 'tiny', needs: {}, delivers: {}, checks: ['artifact_attached'], pricing: { model: 'fixed', currency: 'USD', price: '5.00' }, turnaround: 'PT1H' }],
    })
    expect(bot.bot.status).toBe('listed')
    expect((await h.fails('update_bot', h.buyer, { bot_id: bot.bot.id, patch: { status: 'paused' } })).code).toBe('forbidden')
    const up = await h.call('update_bot', h.stranger, { bot_id: bot.bot.id, patch: { status: 'paused', tagline: 'Paused for now' } })
    expect(up.bot).toMatchObject({ status: 'paused', tagline: 'Paused for now' })
    const spam = await h.fails('register_bot', h.stranger, { name: 'Spam', tagline: 't', description: 'mass spam sender', capability_class: 'reach', mode: 'demo', skills: bot.bot.skills })
    expect(spam.code).toBe('policy_blocked')
    const art = await h.call('upload_artifact', h.buyer, { name: 'facts.txt', text: 'ORANO facts' })
    expect(art.artifact).toMatchObject({ bytes: 11, mime: 'text/plain' })
    const bytes = await h.core.artifacts.read(art.artifact.id, h.buyer)
    expect(Buffer.from(bytes!.bytes).toString()).toBe('ORANO facts')
    expect(await h.core.artifacts.read(art.artifact.id, h.seller)).toBeNull() // not a party, not the uploader
    const job_id = await fundedJob(h)
    const jobs = await h.call('list_jobs', h.seller, { needs_action: true })
    expect(jobs.jobs.map((j) => j.id)).toContain(job_id)
    expect((await h.call('list_jobs', h.buyer, { role: 'buyer' })).jobs[0]).toMatchObject({ id: job_id, held: { value: '6.00' }, your_role: 'buyer' })
  })

  it('run_checks, add_statement, decline in negotiation', async () => {
    h = await harness()
    const job_id = await fundedJob(h)
    await deliver(h, job_id, units(4, (i) => (i === 0 ? { url_live: 'throw' } : {})))
    const rc = await h.call('run_checks', h.seller, { job_id })
    expect(rc.checks.find((c) => c.unit_ref === 'listing-1' && c.check === 'url_live')).toMatchObject({ status: 'error', attempt: 2 })
    expect(rc.fulfilment[0].passed_units).toBe(3)
    await h.call('open_dispute', h.seller, { job_id, reason: 'Listing one check crashed, not my fault.', claims: ['listing-1 is live'] })
    const st = await h.call('add_statement', h.seller, { job_id, text: 'Here is my evidence.' })
    expect(st.job.state).toBe('DISPUTED')
  })
})

describe('webhooks and demo', () => {
  it('drops duplicate deliveries and refuses unsigned external webhooks on the simulated rail', async () => {
    h = await harness()
    const job_id = await fundedJob(h)
    const auth = (await h.call('get_escrow', h.buyer, { job_id })).escrow.paypal.authorization_id
    const body = JSON.stringify({ id: 'WH-DUP-1', event_type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: auth, status: 'CREATED', amount: { value: '6.00' } } })
    expect((await h.core.internal.ingestWebhook(body)).accepted).toBe(true)
    expect((await h.core.internal.ingestWebhook(body)).note).toMatch(/duplicate/)
    expect((await h.core.payments.handleWebhook({}, body)).accepted).toBe(false)
  })

  it('seeds demo keys and the bot lineup; reset re-seeds', async () => {
    h = await harness({ config: { demoMode: true } })
    const keys = JSON.parse(readFileSync(join(h.dataDir, 'demo-keys.json'), 'utf8'))
    expect(keys.orano_growth_agent.api_key).toMatch(/^rab_test_/)
    expect(await h.core.auth.agentFromApiKey(keys.glob_studio_bots.api_key)).toMatchObject({ agent_id: keys.glob_studio_bots.agent_id })
    expect(await h.core.auth.agentFromApiKey('rab_test_wrongwrongwrongwrong')).toBeNull()
    const d = h.core.internal.services.d
    const status = Object.fromEntries(d.db.all<{ data: string }>('SELECT data FROM bots').map((r) => JSON.parse(r.data)).map((b) => [b.name, `${b.status}/${b.mode}`]))
    expect(status).toEqual({
      'Directory Blaster': 'listed/demo',
      'Investor Outreach Bot': 'listed/demo',
      'Account Setup Bot': 'listed/demo',
      'Application Filler': 'listed/demo',
      'Lead Verifier': 'listed/live',
      'Budget Lead Verifier': 'listed/live',
      'Agent-Readiness Auditor': 'listed/live',
      'Cold Email Writer': 'listed/live',
      'Agent Red Team': 'listed/demo',
      'Landing Page Bot': 'listed/demo',
      'Deliverability Doctor': 'listed/live',
      'Broken Link Hunter': 'listed/live',
      'Web Data Extractor': 'listed/live',
    })
    await fundedJob(h)
    await h.core.demo!.reset()
    expect((await h.core.public.stats()).jobs_total).toBe(0)
    const fresh = JSON.parse(readFileSync(join(h.dataDir, 'demo-keys.json'), 'utf8'))
    expect(fresh.orano_growth_agent.api_key).not.toBe(keys.orano_growth_agent.api_key)
    expect(await h.core.auth.agentFromApiKey(keys.orano_growth_agent.api_key)).toBeNull()
    const s = await h.core.auth.demoSignIn('seller')
    expect(await h.core.auth.userFromSession(s.token)).toMatchObject({ name: 'Glob Studio', act_as: fresh.glob_studio_bots.agent_id })
  })
})
