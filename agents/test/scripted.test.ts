// The scripted buyer end to end on the stub core. The stub seller negotiates by itself; this test delivers as the seller.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startLive, toolJson, type Live } from '../../server/test/adapters/helpers.ts'
import { runScriptedBuyer } from '../src/scripted.ts'

const quiet = () => {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait for the buyer's new job (not the seeded demo job) to reach `state`. */
async function jobIn(live: Live, state: string, timeoutMs = 10_000): Promise<string> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    for (const js of live.core.stub.jobs.values()) if (js.job.id !== 'job_demo31of40' && js.job.state === state) return js.job.id
    await sleep(25)
  }
  throw new Error(`no job reached ${state}`)
}

const units = (n: number, failFrom = n) => Array.from({ length: n }, (_, i) => ({ ref: `dir-${i + 1}`, url: `https://dir${i + 1}.example/orano`, artifact_ids: [], meta: i >= failFrom ? { fail: true } : {} }))

async function deliver(live: Live, jobId: string, list: ReturnType<typeof units>) {
  const seller = await live.mcp({ key: live.core.stub.keys.seller })
  const res = await seller.callTool({ name: 'submit_delivery', arguments: { job_id: jobId, delivery: { deliverables: [{ deliverable_id: 'D1', units: list, note: '' }], note: 'Delivered.' } } })
  expect(res.isError).toBeFalsy()
  return toolJson(res as never)
}

describe('runScriptedBuyer on the stub core', () => {
  let live: Live
  beforeEach(async () => {
    live = await startLive({}, { strictOutput: false }) // the stub core lags the shared schemas while the real core is finished
  })
  afterEach(async () => {
    await live.close()
  })

  it('negotiates, funds inside the mandate, and accepts a delivery that passes', async () => {
    const run = runScriptedBuyer({ url: live.base, key: live.core.stub.keys.buyer, waitSeconds: 1, timeoutMs: 15_000, log: quiet })
    const jobId = await jobIn(live, 'IN_PROGRESS')
    const contract = live.core.stub.jobs.get(jobId)!.job.contract
    expect(contract.inputs).toMatchObject({ product_name: 'ORANO', url: 'https://oranoai.com' })
    expect(contract.answers.Q1).not.toMatch(/manu/i)
    expect(contract.quote.total_max.value).toBe('60.00')
    await deliver(live, jobId, units(40))
    const r = await run
    expect(r.status).toBe('done')
    expect(r.state).toBe('SETTLED')
    expect(r).toMatchObject({ job_id: jobId, expected: 40, passed: 40, failed: 0, earned: '60.00', spent: '60.00' })
    const ops = r.transcript.map((e) => e.tool)
    expect(ops.slice(0, 5)).toEqual(['whoami', 'search_bots', 'get_bot', 'draft_job_spec', 'create_job'])
    for (const op of ['provide_inputs', 'accept_contract', 'fund_job', 'run_checks', 'review_delivery']) expect(ops).toContain(op)
    expect(ops).not.toContain('share_secret') // A1 is optional in the stub
    expect(ops).not.toContain('open_dispute')
  })

  it('rejects specific failing units, allows a cure round, then accepts', async () => {
    const run = runScriptedBuyer({ url: live.base, key: live.core.stub.keys.buyer, waitSeconds: 1, timeoutMs: 15_000, log: quiet })
    const jobId = await jobIn(live, 'IN_PROGRESS')
    await deliver(live, jobId, units(40, 30)) // 30 pass, 10 fail
    await jobIn(live, 'CURE')
    const review = live.core.stub.jobs.get(jobId)!.messages.find((m: { type: string }) => m.type === 'review')
    expect(review.body.decision).toBe('reject')
    const refs = review.body.rejections.flatMap((x: { unit_refs: string[] }) => x.unit_refs)
    expect(refs).toEqual(Array.from({ length: 10 }, (_, i) => `dir-${31 + i}`))
    expect(review.body.rejections[0].reason).toMatch(/dir-31 failed listing_url_live/)
    await deliver(live, jobId, units(40))
    const r = await run
    expect(r.status).toBe('done')
    expect(r).toMatchObject({ state: 'SETTLED', passed: 40, spent: '60.00' })
    expect(r.transcript.filter((e) => e.tool === 'review_delivery')).toHaveLength(2)
  })

  it('stops with the approval URL when the mandate does not cover the job', async () => {
    const r = await runScriptedBuyer({ url: live.base, key: live.core.stub.keys.buyer, quantity: 100, budgetCap: '150.00', waitSeconds: 1, timeoutMs: 10_000, log: quiet })
    expect(r.status).toBe('needs_human')
    expect(r.state).toBe('AWAITING_APPROVAL')
    expect(r.approvalUrl).toMatch(/\/sim\/paypal\/order\//)
  })

  it('declines a job over the budget cap before creating it', async () => {
    const r = await runScriptedBuyer({ url: live.base, key: live.core.stub.keys.buyer, quantity: 60, budgetCap: '70.00', waitSeconds: 1, timeoutMs: 10_000, log: quiet })
    expect(r.status).toBe('blocked')
    expect(r.job_id).toBeNull()
    expect(r.transcript.map((e) => e.tool)).not.toContain('create_job')
  })
})
