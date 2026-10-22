// End-to-end job flows on the simulated rail: happy path, approval path, cure, cancellations, timers with a fake clock, idempotency and permissions.
import { afterEach, describe, expect, it } from 'vitest'
import type { SimulatedRail } from '../../src/rails/simulated.ts'
import { policyHold } from '../../src/core/escrow.ts'
import { agreedJob, DAY, deliver, fundedJob, harness, HOUR, quoteFor, requirements, directorySpec, units, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
})

const escrowOf = async (job_id: string) => (await h.call('get_escrow', h.buyer, { job_id })).escrow

describe('happy path (mandate)', () => {
  it('create → requirements → quote → inputs → both accept → fund → deliver → checks → accept → capture + payout + void', async () => {
    h = await harness()
    const job_id = await agreedJob(h, { quantity: 40 })
    const agreed = await h.call('get_job', h.buyer, { job_id })
    expect(agreed.next_actions.map((a) => a.op)).toContain('fund_job')
    expect(agreed.job.contract!.quote.total_max.value).toBe('60.00')

    const funded = await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'fund-happy-1' })
    expect(funded.approval_url).toBeNull()
    expect(funded.job.state).toBe('IN_PROGRESS')
    expect(funded.job.escrow.status).toBe('authorized')
    expect(funded.job.escrow.authorized.value).toBe('60.00')
    expect(funded.job.deadlines.deliver_by).toBe('2026-11-09T10:00:00.000Z')
    await h.settle()
    // the authorization webhook was recorded as a confirmation of the same event
    expect((await escrowOf(job_id)).events.find((e) => e.kind === 'authorized')?.webhook_event).toBe('PAYMENT.AUTHORIZATION.CREATED')

    // 31 of 40 pass (the docs' example)
    const res = await deliver(h, job_id, units(40, (i) => (i >= 31 ? { page_mentions: 'fail' } : {})))
    expect(res.job.state).toBe('DELIVERED')
    expect(res.job.fulfilment[0]).toMatchObject({ expected_units: 40, passed_units: 31, failed_units: 9, earned: { value: '46.50' } })
    expect(res.next_actions.map((a) => a.op)).toEqual(['wait_for_events']) // the seller waits
    const b = await h.call('get_job', h.buyer, { job_id })
    expect(b.next_actions.map((a) => a.op)).toContain('review_delivery')

    const done = await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    expect(done.job.state).toBe('SETTLED')
    await h.settle()
    const e = await escrowOf(job_id)
    expect(e.captured.value).toBe('46.50') // one capture, exactly the verified units
    expect(e.paypal.capture_ids).toHaveLength(1)
    expect(e.voided.value).toBe('13.50') // the rest was never charged
    expect(e.fees.value).toBe('6.98') // 15% of 46.50 = 6.975 → 6.98 (half-up)
    expect(e.paid_out.value).toBe('39.52')
    expect(e.status).toBe('settled')
    // A settled job has no deadline left: the jobs list showed the old delivery deadline (found on production 2026-10-20).
    expect((await h.call('list_jobs', h.buyer, {})).jobs.find((j) => j.id === job_id)?.next_deadline).toBeNull()
    expect(e.events.map((x) => x.kind)).toEqual(expect.arrayContaining(['order_created', 'authorized', 'captured', 'voided', 'payout_sent', 'payout_succeeded']))
    expect(e.events.find((x) => x.kind === 'captured')?.webhook_event).toBe('PAYMENT.CAPTURE.COMPLETED')
    // actual PayPal fees recorded from the (simulated) capture and payout
    const pnl = h.core.internal.services.stats.pnl()
    expect(pnl).toMatchObject({ commission: '6.98', paypal_capture_fees: '2.11', paypal_payout_fees: '0.25', net: '4.62' })

    const msgs = await h.call('get_messages', h.buyer, { job_id, limit: 200 })
    expect(msgs.chain_valid).toBe(true)
    expect(msgs.messages.filter((m) => m.type === 'system').map((m) => m.text).join('\n')).toMatch(/DELIVERED → SETTLED/)

    const stats = await h.core.public.stats()
    expect(stats).toMatchObject({ jobs_settled: 1, released_total: '46.50', voided_total: '13.50', held_now: '0.00', payment_rail: 'simulated' })
    const feed = await h.core.public.feed()
    expect(feed.map((f) => f.text).join('\n')).toMatch(/Directory Blaster: 31\/40 listings verified, \$46\.50 captured/)
    const bot = await h.call('get_bot', h.stranger, { bot_id: h.bots['Directory Blaster'] })
    expect(bot.bot.reputation).toMatchObject({ jobs_completed: 1, on_time_rate: 1, avg_fulfilment: 0.78 })
    expect(stats.bots_listed).toBe(13)
  })

  it('minimum job price: a quote or budget below $5.00 is rejected with the minimum named', async () => {
    h = await harness()
    const job_id = await agreedJob(h, { quantity: 4, stopAt: 'negotiating' })
    const low = await h.fails('send_quote', h.seller, { job_id, quote: quoteFor(4, '1.00') }) // $4.00
    expect(low.code).toBe('invalid_input')
    expect(low.message).toMatch(/below the \$5\.00 minimum job price/)
    expect(low.hint).toMatch(/at least \$5\.00/)
    await h.call('send_quote', h.seller, { job_id, quote: quoteFor(4) }) // $6.00 is fine
    const spec = { ...directorySpec(2), budget_cap: { value: '4.99', currency: 'USD' } }
    const cap = await h.fails('create_job', h.buyer, { bot_id: h.bots['Directory Blaster'], spec, idempotency_key: 'low-budget-1' })
    expect(cap.code).toBe('invalid_input')
    expect(cap.message).toMatch(/budget_cap \$4\.99 is below the \$5\.00 minimum job price/)
  })

  it('fund_job is idempotent: same key → no second order', async () => {
    h = await harness()
    const job_id = await agreedJob(h)
    const a = await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'same-key-123' })
    const b = await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'same-key-123' })
    await h.settle()
    expect(a.job.state).toBe('IN_PROGRESS')
    expect(b.job.escrow.events.filter((e) => e.kind === 'order_created')).toHaveLength(1)
    expect(b.job.escrow.paypal.order_id).toBe(a.job.escrow.paypal.order_id)
    // a different key on a funded job is a state error, not a second charge
    const err = await h.fails('fund_job', h.buyer, { job_id, idempotency_key: 'other-key-456' })
    expect(err.code).toBe('invalid_state')
  })

  it('pending captures are committed only by the webhook, and payouts wait for them', async () => {
    h = await harness({ captureStatus: 'PENDING' })
    const job_id = await fundedJob(h)
    await deliver(h, job_id, units(4))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    const before = (await h.call('get_job', h.buyer, { job_id })).job.escrow
    expect(before.captured.value).toBe('0.00')
    expect(before.events.some((e) => e.kind === 'payout_sent')).toBe(false)
    await h.settle()
    const after = await escrowOf(job_id)
    expect(after.captured.value).toBe('6.00')
    expect(after.paid_out.value).toBe('3.00') // $6.00 − $3.00 floor commission
  })
})

describe('failed seller payout', () => {
  // Real sandbox answer when the platform business account sits in a country that cannot send Payouts (2026-10-19):
  // 403 PAYOUT_NOT_AVAILABLE "You live in a country that is not allowed to send this payout."
  it('is retried with a back-off and does not pile up one ledger event per attempt', async () => {
    h = await harness()
    const rail = h.core.internal.rail as SimulatedRail
    const job_id = await fundedJob(h)
    await deliver(h, job_id, units(4))
    rail.failNext = { method: 'payout', issue: 'PAYOUT_NOT_AVAILABLE', status: 403 }
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    const failed = async () => (await escrowOf(job_id)).events.filter((e) => e.kind === 'payout_failed')
    expect(await failed()).toHaveLength(1)
    // ticks inside the back-off window do not call PayPal again (failNext stays armed because it is never consumed)
    rail.failNext = { method: 'payout', issue: 'PAYOUT_NOT_AVAILABLE', status: 403 }
    await h.tick()
    await h.tick()
    expect(rail.failNext).not.toBeNull()
    // after the back-off the retry fails the same way: the existing event is refreshed, not duplicated
    h.clock.advance(31_000)
    await h.tick()
    expect(rail.failNext).toBeNull()
    expect(await failed()).toHaveLength(1)
    // and once PayPal accepts, the seller is paid
    h.clock.advance(31_000)
    await h.tick()
    const e = await escrowOf(job_id)
    expect(e.events.some((x) => x.kind === 'payout_sent')).toBe(true)
    expect(e.paid_out.value).toBe('3.00')
  })
})

describe('approval path (no usable mandate)', () => {
  it('over the per-job cap → AWAITING_APPROVAL → simulated approve → IN_PROGRESS', async () => {
    h = await harness()
    const job_id = await agreedJob(h, { quantity: 60 }) // $90 > $80 per-job cap
    const r = await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'fund-approval-1' })
    expect(r.job.state).toBe('AWAITING_APPROVAL')
    expect(r.approval_url).toMatch(/^http:\/\/test\.local\/sim\/paypal\/order\//)
    expect(r.job.escrow.events.find((e) => e.kind === 'approval_required')?.note).toMatch(/per-job cap/)
    const orderId = r.approval_url!.split('/').pop()!
    const redirect = await h.core.payments.simulatedApprove!('order', orderId, true)
    expect(redirect.redirect).toBe(`/jobs/${job_id}?paypal=approved`)
    await h.settle()
    const j = await h.call('get_job', h.seller, { job_id })
    expect(j.job.state).toBe('IN_PROGRESS')
    expect(j.job.escrow.authorized.value).toBe('90.00')
    expect(j.job.escrow.events.filter((e) => e.kind === 'authorized')).toHaveLength(1)
  })

  it('a restricted job is never funded by the mandate: approval link with the reason; a standard job still funds by mandate', async () => {
    // Found on production 2026-10-20 (job_mvgm1t51sbfGwFRfJx2W61): the gate said restricted, the mandate paid it with no click.
    h = await harness()
    const d = h.core.internal.services.d
    const job_id = await agreedJob(h, { quantity: 4 }) // $6, well inside the mandate
    const rec = d.load(job_id)
    rec.policy = { class: 'restricted', reasons: ['bulk harvesting of institutional contact emails'] }
    d.save(rec)
    const r = await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'fund-restricted-1' })
    expect(r.job.state).toBe('AWAITING_APPROVAL')
    expect(r.approval_url).toMatch(/^http:\/\/test\.local\/sim\/paypal\/order\//)
    expect((r.notes ?? []).join(' ')).toMatch(/policy review marked this job restricted: bulk harvesting of institutional contact emails; your owner approves it on PayPal/)
    expect(r.job.escrow.events.find((e) => e.kind === 'order_created')?.note).toMatch(/needs a human approval: the policy review marked this job restricted/)
    const room = await h.call('get_messages', h.buyer, { job_id })
    expect(JSON.stringify(room)).toMatch(/AWAITING_APPROVAL: the policy review marked this job restricted: bulk harvesting/)
    const m = (await h.call('get_mandate', h.buyer, {})).mandate!
    expect(m.spent_this_month.value).toBe('0.00')
    // the owner approves on PayPal and the job proceeds
    await h.core.payments.simulatedApprove!('order', r.approval_url!.split('/').pop()!, true)
    await h.settle()
    expect((await h.call('get_job', h.buyer, { job_id })).job.state).toBe('IN_PROGRESS')
    // a standard job with the same mandate still funds without a click
    const std = await agreedJob(h, { quantity: 4 })
    const s2 = await h.call('fund_job', h.buyer, { job_id: std, idempotency_key: 'fund-standard-1' })
    expect(s2.approval_url).toBeNull()
    expect(s2.job.state).toBe('IN_PROGRESS')
    expect(s2.job.escrow.events.find((e) => e.kind === 'order_created')?.note).toMatch(/paid with the spending mandate/)
  })

  it('policyHold: restricted holds, standard and security (scope proof instead) do not', async () => {
    h = await harness()
    expect(policyHold({ policy: { class: 'restricted', reasons: ['x'] }, capability_class: 'reach' })).toMatch(/restricted: x; your owner approves it on PayPal/)
    expect(policyHold({ policy: { class: 'standard', reasons: [] }, capability_class: 'reach' })).toBeNull()
    expect(policyHold({ policy: { class: 'restricted', reasons: ['security work needs scope proof from the buyer'] }, capability_class: 'security' })).toBeNull()
  })

  it('cancel on PayPal → back to AGREED; fund_by expiry → EXPIRED', async () => {
    h = await harness()
    const job_id = await agreedJob(h, { quantity: 60 })
    const r = await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'fund-approval-2' })
    await h.core.payments.simulatedApprove!('order', r.approval_url!.split('/').pop()!, false)
    expect((await h.call('get_job', h.buyer, { job_id })).job.state).toBe('AGREED')
    h.clock.advance(25 * HOUR)
    await h.tick()
    const j = await h.call('get_job', h.buyer, { job_id })
    expect(j.job.state).toBe('EXPIRED')
    expect(j.next_actions).toEqual([])
  })

  it('a new agent requests a mandate; the owner approves it in the vault; funding then needs no click', async () => {
    h = await harness()
    const owner = await h.core.auth.demoSignIn('owner')
    const reg = await h.call('register_agent', { kind: 'public' }, { name: 'Side Agent' })
    const agent = { kind: 'agent' as const, agent_id: reg.agent.id, owner_id: null }
    const m = await h.call('request_mandate', agent, { monthly_cap: '50.00', per_job_cap: '20.00', categories: ['real_world_action'] })
    expect(m.mandate.status).toBe('pending_approval')
    await h.call('claim_agent', owner.principal, { claim_code: reg.claim_code })
    const setup = m.approval_url!.split('/').pop()!
    await h.core.payments.simulatedApprove!('vault', setup, true)
    const g = await h.call('get_mandate', agent, {})
    expect(g.mandate).toMatchObject({ status: 'active', spent_this_month: { value: '0.00' } })
    const c = await h.call('create_job', agent, { bot_id: h.bots['Directory Blaster'], spec: directorySpec(4) })
    const job_id = c.job.id
    await h.call('send_quote', h.seller, { job_id, quote: quoteFor(4) })
    const hash = (await h.call('get_job', agent, { job_id })).job.contract_hash
    await h.call('accept_contract', agent, { job_id, contract_hash: hash })
    await h.call('accept_contract', h.seller, { job_id, contract_hash: hash })
    const f = await h.call('fund_job', agent, { job_id, idempotency_key: 'side-agent-fund' })
    expect(f.job.state).toBe('IN_PROGRESS')
    expect((await h.call('get_mandate', agent, {})).mandate!.spent_this_month.value).toBe('6.00')
  })

  it('an unclaimed agent cannot spend', async () => {
    h = await harness()
    const reg = await h.call('register_agent', { kind: 'public' }, { name: 'Loose Agent' })
    const agent = { kind: 'agent' as const, agent_id: reg.agent.id, owner_id: null }
    const c = await h.call('create_job', agent, { bot_id: h.bots['Directory Blaster'], spec: directorySpec(4) })
    await h.call('send_quote', h.seller, { job_id: c.job.id, quote: quoteFor(4) })
    const hash = (await h.call('get_job', agent, { job_id: c.job.id })).job.contract_hash
    await h.call('accept_contract', agent, { job_id: c.job.id, contract_hash: hash })
    await h.call('accept_contract', h.seller, { job_id: c.job.id, contract_hash: hash })
    expect((await h.fails('fund_job', agent, { job_id: c.job.id, idempotency_key: 'loose-fund-1' })).code).toBe('mandate_required')
  })
})

describe('negotiation', () => {
  it('a changed contract resets acceptances and stale hashes are refused', async () => {
    h = await harness()
    const job_id = await agreedJob(h, { stopAt: 'negotiating' })
    const v1 = (await h.call('get_job', h.buyer, { job_id })).job
    await h.call('accept_contract', h.seller, { job_id, contract_hash: v1.contract_hash })
    await h.call('send_quote', h.seller, { job_id, quote: quoteFor(4, '1.75') })
    const v2 = (await h.call('get_job', h.buyer, { job_id })).job
    expect(v2.contract_hash).not.toBe(v1.contract_hash)
    expect(v2.contract!.version).toBe(v1.contract!.version + 1)
    expect(v2.accepted_by).toEqual([])
    expect((await h.fails('accept_contract', h.buyer, { job_id, contract_hash: v1.contract_hash })).code).toBe('stale_contract')
    // re-sending identical terms changes nothing
    await h.call('send_quote', h.seller, { job_id, quote: quoteFor(4, '1.75') })
    expect((await h.call('get_job', h.buyer, { job_id })).job.contract_hash).toBe(v2.contract_hash)
  })

  it('rejects inconsistent quotes and blocked specs', async () => {
    h = await harness()
    const job_id = await agreedJob(h, { stopAt: 'negotiating' })
    const bad = { ...quoteFor(4), total_max: { value: '99.00', currency: 'USD' } }
    expect((await h.fails('send_quote', h.seller, { job_id, quote: bad })).code).toBe('invalid_input')
    const blocked = { ...directorySpec(4), goal: 'Solve CAPTCHA farms and post fake reviews for us' }
    expect((await h.fails('create_job', h.buyer, { bot_id: h.bots['Directory Blaster'], spec: blocked })).code).toBe('policy_blocked')
  })

  it('create_job with the same idempotency key returns the same job', async () => {
    h = await harness()
    const a = await h.call('create_job', h.buyer, { bot_id: h.bots['Directory Blaster'], spec: directorySpec(4), idempotency_key: 'create-once-1' })
    const b = await h.call('create_job', h.buyer, { bot_id: h.bots['Directory Blaster'], spec: directorySpec(4), idempotency_key: 'create-once-1' })
    expect(b.job.id).toBe(a.job.id)
    expect((await h.call('list_jobs', h.buyer, {})).jobs).toHaveLength(1)
  })

  it('paused bots cannot be hired', async () => {
    h = await harness()
    await h.call('update_bot', h.seller, { bot_id: h.bots['Landing Page Bot'], patch: { status: 'paused' } })
    const err = await h.fails('create_job', h.buyer, { bot_id: h.bots['Landing Page Bot'], spec: { ...directorySpec(1), skill_id: 'landing_page' } })
    expect(err.code).toBe('invalid_state')
  })
})

describe('permissions', () => {
  it('seller cannot fund, buyer cannot deliver, strangers cannot read', async () => {
    h = await harness()
    const job_id = await agreedJob(h)
    expect((await h.fails('fund_job', h.seller, { job_id, idempotency_key: 'seller-fund-1' })).code).toBe('forbidden')
    expect((await h.fails('get_job', h.stranger, { job_id })).code).toBe('not_found')
    expect((await h.fails('get_messages', h.stranger, { job_id })).code).toBe('not_found')
    expect((await h.fails('get_escrow', h.stranger, { job_id })).code).toBe('not_found')
    await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'buyer-fund-1' })
    const err = await h.fails('submit_delivery', h.buyer, { job_id, delivery: { deliverables: [] } })
    expect(err.code).toBe('forbidden')
    expect(err.next_actions.length).toBeGreaterThan(0)
    // a person acting through their own agent counts as that party
    const owner = await h.core.auth.demoSignIn('owner')
    expect((await h.call('get_job', owner.principal, { job_id })).your_role).toBe('buyer')
    // events: the stranger sees none of this job's events
    const ev = await h.core.events.list({ principal: h.stranger, after_cursor: 0, job_id })
    expect(ev.events).toEqual([])
    const mine = await h.core.events.list({ principal: h.buyer, after_cursor: 0, job_id })
    expect(mine.events.length).toBeGreaterThan(5)
  })

  it('wrong state → invalid_state with next_actions', async () => {
    h = await harness()
    const job_id = await agreedJob(h)
    const err = await h.fails('review_delivery', h.buyer, { job_id, decision: 'accept' })
    expect(err.code).toBe('invalid_state')
    expect(err.next_actions.map((a) => a.op)).toContain('fund_job')
  })
})

describe('secrets', () => {
  it('sealed until funding, seller-only, reads logged, wiped at the end', async () => {
    h = await harness()
    const job_id = await agreedJob(h)
    const s = await h.call('share_secret', h.buyer, { job_id, access_id: 'A1', label: 'verify inbox', value: 'forward-to:secret@example.com' })
    expect(s.sealed_until).toBe('funded')
    expect((await h.fails('get_secret', h.seller, { job_id, secret_id: s.secret_id })).code).toBe('invalid_state')
    await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'secret-fund-1' })
    expect((await h.fails('get_secret', h.buyer, { job_id, secret_id: s.secret_id })).code).toBe('forbidden')
    const got = await h.call('get_secret', h.seller, { job_id, secret_id: s.secret_id })
    expect(got.value).toBe('forward-to:secret@example.com')
    const msgs = (await h.call('get_messages', h.buyer, { job_id, limit: 200 })).messages
    expect(msgs.some((m) => /seller opened locker item "verify inbox"/.test(m.text))).toBe(true)
    expect(JSON.stringify(msgs)).not.toContain('secret@example.com')
    await h.call('decline_job', h.seller, { job_id, reason: 'Cannot do it after all' })
    // Crypto-shredded: ciphertext and every wrapped key gone, metadata kept.
    const db = h.core.internal.services.d.db
    const row = db.get<{ ciphertext: string | null; shredded_at: string | null }>('SELECT ciphertext, shredded_at FROM locker_items WHERE id = ?', s.secret_id)
    expect(row?.ciphertext).toBeNull()
    expect(row?.shredded_at).toBeTruthy()
    expect(db.all('SELECT * FROM locker_wraps WHERE item_id = ?', s.secret_id)).toHaveLength(0)
  })
})

describe('cure', () => {
  it('reject → CURE → redeliver → accept pays the fixed units', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 4 })
    await deliver(h, job_id, units(4, (i) => (i === 3 ? { page_mentions: 'fail' } : {})))
    const r = await h.call('review_delivery', h.buyer, { job_id, decision: 'reject', rejections: [{ deliverable_id: 'D1', unit_refs: ['listing-4'], reason: 'Listing 4 does not mention ORANO at all.' }] })
    expect(r.job.state).toBe('CURE')
    expect(r.job.deadlines.cure_until).toBeTruthy()
    const s = await h.call('get_job', h.seller, { job_id })
    expect(s.next_actions.map((a) => a.op)).toContain('submit_delivery')
    await deliver(h, job_id, units(4))
    const done = await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    expect(done.job.state).toBe('SETTLED')
    await h.settle()
    expect((await escrowOf(job_id)).captured.value).toBe('6.00')
  })

  it('a cure redelivery that resends only the fixed unit keeps the units that already passed', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 4 })
    await deliver(h, job_id, units(4, (i) => (i === 3 ? { page_mentions: 'fail' } : {})))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'reject', rejections: [{ deliverable_id: 'D1', unit_refs: ['listing-4'], reason: 'Listing 4 does not mention ORANO at all.' }] })
    await deliver(h, job_id, units(4).slice(3)) // only listing-4, now fixed
    const j = await h.call('get_job', h.buyer, { job_id })
    expect(j.job.fulfilment[0]!.passed_units).toBe(4)
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    expect((await escrowOf(job_id)).captured.value).toBe('6.00')
  })

  it('an empty cure redelivery never wipes units that already passed', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 5 })
    await deliver(h, job_id, units(5, (i) => (i === 4 ? { page_mentions: 'fail' } : {})))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'reject', rejections: [{ deliverable_id: 'D1', unit_refs: ['listing-5'], reason: 'Listing 5 does not mention ORANO at all.' }] })
    await deliver(h, job_id, [])
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    expect((await escrowOf(job_id)).captured.value).toBe('6.00')
  })

  it('cure window ends without redelivery → rejected units are not paid', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 6 })
    await deliver(h, job_id, units(6))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'reject', rejections: [{ deliverable_id: 'D1', unit_refs: ['listing-1', 'listing-2'], reason: 'These two are behind a paywall.' }] })
    h.clock.advance(49 * HOUR)
    await h.tick()
    const j = await h.call('get_job', h.buyer, { job_id })
    expect(j.job.state).toBe('SETTLED')
    expect(j.job.escrow.captured.value).toBe('6.00')
    expect(j.job.escrow.voided.value).toBe('3.00')
  })

  it('a verified total below the $5.00 minimum settlement is voided: nothing is captured, charged or paid', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 4 }) // $6.00 held
    await deliver(h, job_id, units(4))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'reject', rejections: [{ deliverable_id: 'D1', unit_refs: ['listing-1', 'listing-2'], reason: 'These two are behind a paywall.' }] })
    h.clock.advance(49 * HOUR)
    await h.tick()
    await h.settle()
    const j = await h.call('get_job', h.buyer, { job_id })
    expect(j.job.state).toBe('SETTLED')
    expect(j.job.escrow).toMatchObject({ status: 'voided', captured: { value: '0.00' }, voided: { value: '6.00' }, paid_out: { value: '0.00' }, fees: { value: '0.00' } })
    expect(j.job.escrow.paypal.capture_ids).toHaveLength(0)
    const text = (await h.call('get_messages', h.buyer, { job_id, limit: 200 })).messages.map((m) => m.text).join('\n')
    expect(text).toMatch(/Verified \$3\.00 is below the \$5\.00 minimum settlement; the hold was voided and nothing was charged\./)
    expect(h.core.internal.services.stats.pnl()).toMatchObject({ commission: '0.00', paypal_capture_fees: '0.00', paypal_payout_fees: '0.00', net: '0.00' })
  })
})

describe('timers', () => {
  it('review window expiry auto-releases what passed', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 5 })
    await deliver(h, job_id, units(5, (i) => (i === 0 ? { artifact_attached: 'error' } : {})))
    h.clock.advance(71 * HOUR)
    await h.tick()
    expect((await h.call('get_job', h.buyer, { job_id })).job.state).toBe('DELIVERED')
    h.clock.advance(2 * HOUR)
    await h.tick()
    const j = await h.call('get_job', h.buyer, { job_id })
    expect(j.job.state).toBe('SETTLED')
    expect(j.job.escrow.captured.value).toBe('6.00')
  })

  it('delayed checks: verified part settles once it reaches the minimum, the pending share waits for verify_window', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 12 }) // $18.00
    await deliver(h, job_id, units(12, (i) => (i >= 6 ? { url_live: 'pending' } : {})))
    const a = await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    expect(a.job.state).toBe('DELIVERED') // 6 units still pending
    await h.settle()
    let e = await escrowOf(job_id)
    expect(e.captured.value).toBe('9.00') // interim settlement: verified 6 × $1.50 and pending 6 × $1.50 both ≥ $5.00
    expect(e.status).toBe('partially_captured')
    expect(e.fees.value).toBe('3.00')
    // moderation finished: four of the six went live
    const rec = h.core.internal.services.d.load(job_id)
    rec.delivery!.deliverables[0].units.forEach((u, i) => (u.meta = i >= 6 ? { url_live: i < 10 ? 'pass' : 'fail' } : {}))
    h.core.internal.services.d.save(rec)
    h.clock.advance(15 * DAY)
    await h.tick()
    await h.settle()
    e = await escrowOf(job_id)
    expect((await h.call('get_job', h.buyer, { job_id })).job.state).toBe('SETTLED')
    expect(e.captured.value).toBe('15.00')
    expect(e.voided.value).toBe('3.00')
    expect(e.paypal.capture_ids).toHaveLength(2)
    // commission on the cumulative $15.00 over 2 settlements: max($3.00 + $1.00, 15% = $2.25) = $4.00; the tail paid $1.00 of it
    expect(e.fees.value).toBe('4.00')
    expect(e.paid_out.value).toBe('11.00')
  })

  it('delayed checks: after an interim settlement, a tail below the minimum is voided, not captured', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 12 }) // $18.00
    await deliver(h, job_id, units(12, (i) => (i >= 6 ? { url_live: 'pending' } : {})))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    expect((await escrowOf(job_id)).captured.value).toBe('9.00')
    const rec = h.core.internal.services.d.load(job_id)
    rec.delivery!.deliverables[0].units.forEach((u, i) => (u.meta = i >= 6 ? { url_live: i < 8 ? 'pass' : 'fail' } : {}))
    h.core.internal.services.d.save(rec)
    h.clock.advance(15 * DAY)
    await h.tick()
    await h.settle()
    const e = await escrowOf(job_id)
    // the verified $3.00 tail would be a sub-$5.00 capture: voided with the rest; one settlement, plain $3.00 commission
    expect(e).toMatchObject({ status: 'settled', captured: { value: '9.00' }, voided: { value: '9.00' }, fees: { value: '3.00' }, paid_out: { value: '6.00' } })
    expect(e.paypal.capture_ids).toHaveLength(1)
    const text = (await h.call('get_messages', h.buyer, { job_id, limit: 200 })).messages.map((m) => m.text).join('\n')
    expect(text).toMatch(/remaining verified \$3\.00 is below the \$5\.00 minimum settlement/)
  })

  it('delayed checks: a unit still pending when the verify window ends is not paid, and the job settles (transient check outcomes are safe)', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 10 }) // $15.00
    await deliver(h, job_id, units(10, (i) => (i >= 7 ? { url_live: 'pending' } : {})))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    h.clock.advance(15 * DAY) // verify window over; the re-run still says pending (e.g. the site keeps answering 429)
    await h.tick()
    await h.settle()
    expect((await h.call('get_job', h.buyer, { job_id })).job.state).toBe('SETTLED')
    expect(await escrowOf(job_id)).toMatchObject({ status: 'settled', captured: { value: '10.50' }, voided: { value: '4.50' }, paid_out: { value: '7.50' } })
  })

  it('delayed checks: no interim settlement when the pending part is below the minimum; one capture at the end', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 10 }) // $15.00
    await deliver(h, job_id, units(10, (i) => (i >= 7 ? { url_live: 'pending' } : {})))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    let e = await escrowOf(job_id)
    expect(e.captured.value).toBe('0.00') // 7 verified ($10.50) but only $4.50 pending: one settlement at the end
    expect(e.status).toBe('authorized')
    const rec = h.core.internal.services.d.load(job_id)
    rec.delivery!.deliverables[0].units.forEach((u, i) => (u.meta = i >= 7 ? { url_live: i < 9 ? 'pass' : 'fail' } : {}))
    h.core.internal.services.d.save(rec)
    h.clock.advance(15 * DAY)
    await h.tick()
    await h.settle()
    e = await escrowOf(job_id)
    expect(e).toMatchObject({ captured: { value: '13.50' }, voided: { value: '1.50' }, fees: { value: '3.00' }, paid_out: { value: '10.50' } })
    expect(e.paypal.capture_ids).toHaveLength(1)
  })

  it('reauthorizes when the honor period ends while the job is open', async () => {
    h = await harness()
    const job_id = await fundedJob(h)
    h.clock.advance(3 * DAY + HOUR)
    await h.tick()
    const e = await escrowOf(job_id)
    expect(e.events.some((x) => x.kind === 'reauthorized' && x.amount?.value === '6.00')).toBe(true)
    // capture still works on the new authorization
    await deliver(h, job_id, units(4))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    expect((await escrowOf(job_id)).captured.value).toBe('6.00')
  })

  it('buyer can cancel after a missed deadline; the authorization is voided', async () => {
    h = await harness()
    const job_id = await fundedJob(h)
    expect((await h.fails('decline_job', h.buyer, { job_id, reason: 'too slow' })).code).toBe('invalid_state')
    h.clock.advance(8 * DAY)
    const j = await h.call('get_job', h.buyer, { job_id })
    expect(j.next_actions.map((a) => a.op)).toContain('decline_job')
    const r = await h.call('decline_job', h.buyer, { job_id, reason: 'Missed the deadline' })
    expect(r.job.state).toBe('CANCELLED')
    expect(r.job.escrow).toMatchObject({ status: 'voided', voided: { value: '6.00' }, captured: { value: '0.00' } })
  })

  it('blocker pauses the deadline and unblock moves it', async () => {
    h = await harness()
    const job_id = await fundedJob(h)
    const due = (await h.call('get_job', h.buyer, { job_id })).job.deadlines.deliver_by!
    await h.call('send_message', h.seller, { job_id, type: 'blocker', text: 'Need the logo file.' })
    h.clock.advance(5 * HOUR)
    const u = await h.call('send_message', h.buyer, { job_id, type: 'unblock', text: 'Logo uploaded.' })
    expect(u.job.state).toBe('IN_PROGRESS')
    expect(Date.parse(u.job.deadlines.deliver_by!) - Date.parse(due)).toBe(5 * HOUR)
  })

  it('demo time scale shortens contract timers', async () => {
    h = await harness({ config: { demoMode: true, demoTimeScale: 60 } })
    const job_id = await fundedJob(h)
    await deliver(h, job_id, units(4))
    h.clock.advance(73 * 60_000) // 72 h / 60 = 72 min
    await h.tick()
    expect((await h.call('get_job', h.buyer, { job_id })).job.state).toBe('SETTLED')
  })
})

describe('events', () => {
  it('wait resolves on a new event and times out otherwise', async () => {
    h = await harness()
    const job_id = await agreedJob(h, { stopAt: 'negotiating' })
    const cursor = h.core.events.latestCursor()
    const quiet = await h.call('wait_for_events', h.buyer, { job_id, after_cursor: cursor, timeout_seconds: 0 })
    expect(quiet).toMatchObject({ events: [], timed_out: true })
    const waiting = h.core.events.wait({ principal: h.buyer, after_cursor: cursor, job_id }, 5000)
    await h.call('send_message', h.seller, { job_id, type: 'note', text: 'Starting soon.' })
    const got = await waiting
    expect(got.timed_out).toBe(false)
    expect(got.events[0].type).toBe('message')
    const ac = new AbortController()
    const aborted = h.core.events.wait({ principal: h.buyer, after_cursor: h.core.events.latestCursor(), job_id }, 5000, ac.signal)
    ac.abort()
    expect((await aborted).timed_out).toBe(true)
  })

  it('the seller sees new job specs for its bots', async () => {
    h = await harness()
    const seen: string[] = []
    const off = h.core.events.subscribe({ principal: h.seller }, (e) => seen.push(e.type))
    await h.call('create_job', h.buyer, { bot_id: h.bots['Directory Blaster'], spec: directorySpec(4) })
    await new Promise((r) => setTimeout(r, 0))
    off()
    expect(seen).toContain('message')
  })
})

describe('scope proof for security jobs', () => {
  it('funding requires a scope file that contains the job id', async () => {
    let body = 'nothing here'
    h = await harness({ fetch: (async () => new Response(body, { status: 200 })) as typeof fetch })
    const d = h.core.internal.services.d
    d.db.run("UPDATE bots SET status = 'listed' WHERE id = ?", h.bots['Agent Red Team'])
    const bot = d.bot(h.bots['Agent Red Team'])!
    d.db.run('UPDATE bots SET data = ? WHERE id = ?', JSON.stringify({ ...bot, status: 'listed', capability_class: 'code' }), bot.id)
    const spec = { ...directorySpec(1), skill_id: 'agent_red_team', deliverables: [{ id: 'D1', description: 'Red-team report', quantity: 1, acceptance: [{ check: 'report_sections_present', params: {} }], rubric: '' }] }
    const c = await h.call('create_job', h.buyer, { bot_id: bot.id, spec })
    const job_id = c.job.id
    // make the job a security job regardless of the patched class
    const rec = d.load(job_id)
    rec.requires_scope_proof = true
    rec.capability_class = 'code'
    d.save(rec)
    await h.call('send_quote', h.seller, { job_id, quote: { lines: [{ deliverable_id: 'D1', model: 'fixed', unit_price: '40.00', quantity: 1, max_total: '40.00' }], total_max: { value: '40.00', currency: 'USD' }, turnaround: 'P2D', excludes: [], valid_until: '2026-12-31T00:00:00.000Z' } })
    await h.call('provide_inputs', h.buyer, { job_id, inputs: { scope_proof_url: 'https://orano.example/.well-known/rentabot-scope.txt' } })
    const hash = (await h.call('get_job', h.buyer, { job_id })).job.contract_hash
    await h.call('accept_contract', h.buyer, { job_id, contract_hash: hash })
    await h.call('accept_contract', h.seller, { job_id, contract_hash: hash })
    const err = await h.fails('fund_job', h.buyer, { job_id, idempotency_key: 'scope-fund-1' })
    expect(err.message).toMatch(/does not contain the job id/)
    body = `rentabot-scope: ${job_id}`
    const ok = await h.call('fund_job', h.buyer, { job_id, idempotency_key: 'scope-fund-2' })
    expect(ok.job.state).toBe('IN_PROGRESS')
  })
})

describe('requirements helpers', () => {
  it('next_actions tell the buyer what is missing', async () => {
    h = await harness()
    const c = await h.call('create_job', h.buyer, { bot_id: h.bots['Directory Blaster'], spec: directorySpec(4) })
    await h.call('submit_requirements', h.seller, { job_id: c.job.id, requirements })
    const j = await h.call('get_job', h.buyer, { job_id: c.job.id })
    const pi = j.next_actions.find((a) => a.op === 'provide_inputs')!
    expect(pi.why).toMatch(/Q1/)
    expect(pi.why).toMatch(/tagline_60/)
  })
})
