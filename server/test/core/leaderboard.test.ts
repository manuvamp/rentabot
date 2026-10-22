// get_leaderboard: public seller track records computed from settled jobs and their check results.
import { afterEach, describe, expect, it } from 'vitest'
import { opByName } from '@rentabot/shared'
import { deliver, fundedJob, harness, units, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as unknown as Harness
})

const pub = { kind: 'public' } as const

describe('get_leaderboard', () => {
  it('lists every listed bot with null rates and zero totals before any job', async () => {
    h = await harness()
    await h.call('update_bot', h.seller, { bot_id: h.bots['Landing Page Bot'], patch: { status: 'paused' } })
    const lb = await h.call('get_leaderboard', pub, {})
    expect(lb.payment_rail).toBe('simulated')
    expect(lb.rows.length).toBeGreaterThan(0)
    expect(lb.rows.map((r) => r.rank)).toEqual(lb.rows.map((_, i) => i + 1))
    for (const r of lb.rows) expect(r).toMatchObject({ verified_units: 0, jobs_settled: 0, pass_rate: null, on_time_rate: null, dispute_rate: null, agreement_share: null, released: '0.00' })
    // paused bots are not on the counter, so not on the board
    expect(lb.rows.map((r) => r.name)).not.toContain('Landing Page Bot')
    expect(lb.rows.map((r) => r.name)).toContain('Agent Red Team')
  })

  it('ranks by verified units, with pass rate, on-time rate and released money from the real job', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 40 })
    await deliver(h, job_id, units(40, (i) => (i >= 31 ? { page_mentions: 'fail' } : {})))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()

    const lb = await h.call('get_leaderboard', pub, {})
    expect(lb.rows[0]).toMatchObject({ rank: 1, name: 'Directory Blaster', jobs_settled: 1, jobs_funded: 1, verified_units: 31, units_checked: 40, pass_rate: 0.775, on_time_rate: 1, dispute_rate: 0, disputes: 0, agreement_share: null, released: '46.50' })
    expect(lb.rows.slice(1).every((r) => r.verified_units === 0)).toBe(true)
    // the same number the public stats strip shows
    expect((await h.core.public.stats()).units_verified).toBe(lb.rows.reduce((s, r) => s + r.verified_units, 0))
  })

  it('sorts dispute rate lowest first, bots without data last, and honours limit', async () => {
    h = await harness()
    const clean = await fundedJob(h, { quantity: 10 })
    await deliver(h, clean, units(10))
    await h.call('review_delivery', h.buyer, { job_id: clean, decision: 'accept' })
    await h.settle()

    const disputed = await fundedJob(h, { quantity: 10 })
    await deliver(h, disputed, units(10, (i) => (i >= 8 ? { page_mentions: 'fail' } : {})))
    await h.call('open_dispute', h.buyer, { job_id: disputed, reason: 'Two listings do not mention ORANO.', claims: ['listing-9 and listing-10 fail'] })
    await h.settle()

    const lb = await h.call('get_leaderboard', pub, { sort_by: 'dispute_rate' })
    const db = lb.rows.find((r) => r.name === 'Directory Blaster')!
    expect(db).toMatchObject({ jobs_funded: 2, disputes: 1, dispute_rate: 0.5, settled_by_agreement: 0, agreement_share: 0 })
    expect(lb.rows[0].name).toBe('Directory Blaster') // the only bot with a measurable dispute rate
    const rates = lb.rows.map((r) => r.dispute_rate)
    expect(rates.indexOf(null)).toBeGreaterThan(rates.lastIndexOf(0.5))

    const byUnits = await h.call('get_leaderboard', pub, { sort_by: 'verified_units', limit: 1 })
    expect(byUnits.rows).toHaveLength(1)
    expect(byUnits.rows[0].name).toBe('Directory Blaster')
  })

  it('counts a dispute the parties settled themselves as agreement, and the same bot ranks first on agreement share', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 40 })
    await deliver(h, job_id, units(40, (i) => (i >= 31 ? { page_mentions: 'fail' } : {})))
    await h.call('open_dispute', h.buyer, { job_id, reason: 'Nine listings do not mention ORANO at all.', claims: ['listing-32 to listing-40 fail page_mentions'] })
    await h.settle()
    const med = (await h.call('get_mediation', h.buyer, { job_id })).mediation!
    const split = med.proposals.find((p) => p.kind === 'split' && p.status === 'open')!
    await h.call('respond_to_proposal', h.buyer, { job_id, proposal_id: split.id, answer: 'accept' })
    await h.call('respond_to_proposal', h.seller, { job_id, proposal_id: split.id, answer: 'accept' })
    await h.settle()

    const lb = await h.call('get_leaderboard', pub, { sort_by: 'agreement_share' })
    expect(lb.rows[0]).toMatchObject({ name: 'Directory Blaster', jobs_settled: 1, disputes: 1, settled_by_agreement: 1, agreement_share: 1, dispute_rate: 1, released: '46.50' })
    expect(lb.rows.slice(1).every((r) => r.agreement_share === null)).toBe(true)
  })

  it('is a public read-only MCP tool', async () => {
    expect(opByName.get_leaderboard).toMatchObject({ caller: 'public', annotations: { readOnlyHint: true }, surfaces: ['mcp', 'rest'] })
  })
})
