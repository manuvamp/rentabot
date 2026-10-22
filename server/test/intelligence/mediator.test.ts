import { describe, expect, it } from 'vitest'
import { Ruling } from '@rentabot/shared'
import { createMediator } from '../../src/intelligence/mediator/mediator.ts'
import { readAiConfig, type AiClient, type JsonCall } from '../../src/intelligence/ai/provider.ts'
import { demoBundle } from './fixture.ts'

const juror = (fulfilment: number, confidence = 0.9, flags: unknown[] = []) => ({
  findings: [{ deliverable_id: 'D1', status: 'partly_met', fulfilment, evidence: ['ev_live1x'], clauses: ['spec.deliverables[0].quantity'], note: 'n' }],
  buyer_fault: [],
  seller_fault: [{ code: 'unverified_units', note: '9 units failed checks' }],
  integrity_flags: flags,
  confidence,
  summary: `fulfilment ${fulfilment}`,
})

function fakeAi(answers: Record<string, unknown | Error>, ask: unknown = { need_answers: false, questions: [] }): AiClient & { calls: string[] } {
  const config = readAiConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://x', JURY_MODELS: 'm1,m2,m3', AI_MODEL_MEDIATOR: 'boss' })
  const calls: string[] = []
  return {
    config,
    enabled: true,
    calls,
    async askJson<T>(call: JsonCall<T>): Promise<T> {
      calls.push(call.model)
      const a = call.model === 'boss' ? ask : answers[call.model]
      if (a instanceof Error) throw a
      return call.schema.parse(a)
    },
  }
}

const full = (r: Awaited<ReturnType<ReturnType<typeof createMediator>['step']>>) => {
  if (r.kind !== 'rule') throw new Error('expected rule')
  return Ruling.parse({ ...r.ruling, id: 'rul_test0001', created_at: '2026-10-19T00:00:00Z', appealable_until: null })
}

describe('mediator', () => {
  it('jury: median fraction, capped by checks, injection caught by the scanner', async () => {
    const ai = fakeAi({ m1: juror(0.775), m2: juror(1), m3: juror(0.7) })
    const r = full(await createMediator({ ai }).step(demoBundle(), 1))
    expect(r.jury.map((j) => j.release_fraction)).toEqual([0.775, 0.775, 0.7])
    expect(r.remedy.release_to_seller.value).toBe('46.50') // m1 is the median juror
    expect(r.remedy.refund_to_buyer.value).toBe('13.50')
    expect(r.remedy.fees.mediation.value).toBe('1.00')
    expect(r.integrity_flags.some((f) => f.party === 'seller' && f.kind === 'prompt_injection')).toBe(true)
    expect(r.seller_fault.join(' ')).toMatch(/injection_attempt/)
    expect(r.escalated).toBe(true)
    expect(r.escalation_reason).toMatch(/integrity flag/)
    expect(r.decided_by).toBe('mediator:jury')
    expect(r.reasoning).toMatch(/\$46\.50/)
  })

  it('escalates on spread > 0.20 and low confidence', async () => {
    const b = demoBundle({ delivery: null, messages: [] })
    const r = full(await createMediator({ ai: fakeAi({ m1: juror(0.1, 0.6), m2: juror(0.775, 0.6), m3: juror(0.5, 0.6) }) }).step(b, 1))
    expect(r.escalation_reason).toMatch(/spread/)
    expect(r.escalation_reason).toMatch(/confidence/)
  })

  it('clean case does not escalate', async () => {
    const b = demoBundle({ delivery: null, messages: [] })
    const r = full(await createMediator({ ai: fakeAi({ m1: juror(0.775), m2: juror(0.775), m3: juror(0.775) }) }).step(b, 1))
    expect(r.escalated).toBe(false)
    expect(r.confidence).toBe(0.9)
  })

  it('proceeds when some jurors fail, falls back to checks when all fail', async () => {
    const b = demoBundle({ delivery: null, messages: [] })
    const some = full(await createMediator({ ai: fakeAi({ m1: new Error('timeout'), m2: juror(0.775), m3: juror(0.775) }) }).step(b, 1))
    expect(some.jury).toHaveLength(2)
    expect(some.reasoning).toMatch(/m1 failed/)
    const none = full(await createMediator({ ai: fakeAi({ m1: new Error('x'), m2: new Error('y'), m3: new Error('z') }) }).step(b, 1))
    expect(none.decided_by).toBe('checks')
    expect(none.confidence).toBe(0.6)
    expect(none.escalated).toBe(true)
    // No fault found by checks alone: $1.00 mediation fee split evenly, the buyer's $0.50 is captured too.
    expect(none.remedy.release_to_seller.value).toBe('47.00')
    expect(none.remedy.refund_to_buyer.value).toBe('13.00')
  })

  it('AI off: deterministic checks-only ruling', async () => {
    const ai = { ...fakeAi({}), enabled: false }
    const r = full(await createMediator({ ai }).step(demoBundle(), 0))
    expect(r.decided_by).toBe('checks')
    expect(r.integrity_flags.length).toBeGreaterThan(0)
    expect(Number(r.remedy.release_to_seller.value) + Number(r.remedy.refund_to_buyer.value)).toBe(60)
  })

  it('round 0 may ask (max 3), round 1 always rules', async () => {
    const ask = { need_answers: true, questions: [{ to: 'seller', text: 'Which 9 directories failed and why?' }] }
    const ai = fakeAi({ m1: juror(0.775), m2: juror(0.775), m3: juror(0.775) }, ask)
    const m = createMediator({ ai })
    const s0 = await m.step(demoBundle(), 0)
    expect(s0.kind).toBe('ask')
    if (s0.kind === 'ask') expect(s0.questions[0]).toMatchObject({ to: 'seller' })
    expect((await m.step(demoBundle(), 1)).kind).toBe('rule')
  })
})
