// Shared test helpers: fixed clock, AI-off client, fake AI, random bundles, response helpers.
import type { CheckResult } from '@rentabot/shared'
import { createAiClient, readAiConfig, type AiClient, type JsonCall } from '../../../src/intelligence/ai/provider.ts'
import type { MediationBundle } from '../../../src/intelligence/types.ts'
import type { Proposal, ProposalResponse } from '../../../src/intelligence/negotiation/types.ts'
import { demoBundle, demoContract } from '../fixture.ts'

export const NOW = new Date('2026-10-28T13:00:00Z')
export const now = () => NOW

export const aiOff = (): AiClient => createAiClient(readAiConfig({ AI_PROVIDER: 'none' }))

export function fakeAi(answer: (call: JsonCall<unknown>) => unknown): AiClient & { calls: string[] } {
  const config = readAiConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://x', JURY_MODELS: 'm1,m2,m3', AI_MODEL_MEDIATOR: 'boss' })
  const calls: string[] = []
  return {
    config,
    enabled: true,
    calls,
    async askJson<T>(call: JsonCall<T>): Promise<T> {
      calls.push(call.model)
      const a = answer(call as JsonCall<unknown>)
      if (a instanceof Error) throw a
      return call.schema.parse(a)
    },
  }
}

export const juror = (fulfilment: number) => ({
  findings: [{ deliverable_id: 'D1', status: 'partly_met', fulfilment, evidence: [], clauses: ['spec.deliverables[0].quantity'], note: 'n' }],
  buyer_fault: [],
  seller_fault: [{ code: 'unverified_units', note: '9 units failed checks' }],
  integrity_flags: [],
  confidence: 0.9,
  summary: `fulfilment ${fulfilment}`,
})

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
const amt = (c: number) => (c / 100).toFixed(2)

/** Random single-deliverable dispute: units pass / partly pass / fail / pend at random; random captured. */
export function randomBundle(r: () => number): MediationBundle {
  const q = int(r, 1, 60)
  const price = int(r, 50, 5000)
  const total = q * price
  const delivered = int(r, 0, q)
  const c = demoContract()
  c.spec.deliverables[0]!.quantity = q
  c.spec.budget_cap = { value: amt(total), currency: 'USD' }
  c.quote.lines = [{ deliverable_id: 'D1', model: 'per_unit', unit_price: amt(price), quantity: q, max_total: amt(total) }]
  c.quote.total_max = { value: amt(total), currency: 'USD' }
  const ts = '2026-10-28T12:00:00Z'
  const units = Array.from({ length: delivered }, (_, i) => ({ ref: `u-${i + 1}`, url: `https://x${i}.example.com`, artifact_ids: [], meta: {} }))
  const checks: CheckResult[] = []
  let passed = 0
  units.forEach((u, i) => {
    const kind = int(r, 0, 3) // 0 pass, 1 partial, 2 fail, 3 pending
    if (kind === 0) passed++
    const s1 = kind === 0 || kind === 1 ? 'pass' : kind === 2 ? 'fail' : 'pending'
    const s2 = kind === 0 ? 'pass' : kind === 3 ? 'pending' : 'fail'
    checks.push({ id: `chk_a${i}xxxx`, job_id: 'job_demo0001', deliverable_id: 'D1', unit_ref: u.ref, check: 'url_live', status: s1, detail: s1, evidence_id: null, attempt: 1, ran_at: ts })
    checks.push({ id: `chk_b${i}xxxx`, job_id: 'job_demo0001', deliverable_id: 'D1', unit_ref: u.ref, check: 'page_mentions', status: s2, detail: s2, evidence_id: null, attempt: 1, ran_at: ts })
  })
  const verified = Math.round((passed / q) * total)
  const captured = r() < 0.5 ? 0 : int(r, 0, r() < 0.8 ? verified : total)
  return demoBundle({
    contract: c,
    checks,
    fulfilment: [],
    delivery: { deliverables: [{ deliverable_id: 'D1', units, note: '' }], note: 'done' },
    amounts: { authorized: { value: amt(total), currency: 'USD' }, already_captured: { value: amt(captured), currency: 'USD' }, platform_fee_bps: 500, mediation_flat: { value: '1.00', currency: 'USD' } },
  })
}

export function respond(p: Proposal, party: 'buyer' | 'seller', r: Partial<ProposalResponse> & { answer: ProposalResponse['answer'] }): void {
  p.responses[party] = { reason: '', terms: null, message_id: null, ...r }
}
