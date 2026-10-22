// Fake Intelligence for core tests: deterministic checks driven by unit metadata, a keyword
// policy gate, a trivial copilot and the REAL negotiator running with the AI off (so proposals, counters and
// recommended rulings come from the same money code production uses, deterministic and offline).
import type { CheckDefinition, JobSpec } from '@rentabot/shared'
import { createAiClient, readAiConfig } from '../../src/intelligence/ai/provider.ts'
import { createNegotiator, type Negotiator } from '../../src/intelligence/negotiation/negotiator.ts'
import { settlementFeesFrom, type SettlementFees } from '../../src/intelligence/negotiation/terms.ts'
import type { CheckImpl, CheckLibrary, Intelligence, MediationBundle, MediatorStep } from '../../src/intelligence/types.ts'

const def = (id: string, per_unit: boolean, delayed = false): CheckDefinition => ({ id, title: id, description: `fake ${id}`, params: {}, per_unit, delayed })

/** Per-unit result = unit.meta[check] ('pass' | 'fail' | 'pending' | 'error' | 'throw'), default pass.
 *  Deliverable-level checks read the first unit's meta, default pass. */
function fakeCheck(id: string, per_unit: boolean, delayed = false): CheckImpl {
  return {
    def: def(id, per_unit, delayed),
    async run(ctx) {
      const meta = (ctx.unit ?? null)?.meta ?? {}
      const want = (meta[id] as string | undefined) ?? 'pass'
      if (want === 'throw') throw new Error('boom')
      const evidence_id = await ctx.saveEvidence(id, `fake ${id} → ${want}`, { unit: ctx.unit?.ref ?? null, attempt: ctx.attempt })
      return { status: want as 'pass', detail: `fake ${id}: ${want}`, evidence_id }
    },
  }
}

export function fakeChecks(): CheckLibrary & { behaviour: Map<string, string> } {
  const map = new Map<string, CheckImpl>()
  for (const c of [fakeCheck('url_live', true, true), fakeCheck('page_mentions', true), fakeCheck('artifact_attached', true), fakeCheck('report_sections_present', false), fakeCheck('json_schema_valid', true)]) map.set(c.def.id, c)
  return {
    behaviour: new Map(),
    list: () => [...map.values()].map((c) => c.def),
    get: (id) => map.get(id),
    register: (impl) => void map.set(impl.def.id, impl),
  }
}

export type MediatorScript = (bundle: MediationBundle, round: number) => MediatorStep | Promise<MediatorStep>

export interface FakeIntelligenceOptions {
  mediator?: MediatorScript
  /** The clock proposals' deadlines are computed from (the test harness clock). */
  now?: () => Date
  /** The core's fee policy ({commission_bps, floor_cents}); default: the production defaults. */
  fees?: { commission_bps: number; floor_cents: number } | SettlementFees
  /**
   * true (default): behave like a confident jury, so a failed negotiation becomes a RULED recommendation with an appeal
   * window. false: keep the AI-off checks-only "a human must confirm" escalation (the recommendation goes straight to the arbiter).
   */
  confident?: boolean
}

export function fakeIntelligence(opts: FakeIntelligenceOptions = {}): Intelligence & {
  setMediator(m: MediatorScript): void
  /** Override any negotiator method for one test (the rest keep running the real code). */
  setNegotiator(o: Partial<Negotiator>): void
  /** Every bundle the negotiator was asked to assess or to propose on. */
  bundles: MediationBundle[]
} {
  let mediator: MediatorScript = opts.mediator ?? (() => ({ kind: 'ask', questions: [] }))
  let over: Partial<Negotiator> = {}
  const bundles: MediationBundle[] = []
  const fees: SettlementFees = opts.fees && 'floor_cents' in opts.fees ? settlementFeesFrom(opts.fees) : (opts.fees as SettlementFees | undefined) ?? settlementFeesFrom({ commission_bps: 1500, floor_cents: 300 })
  const aiClient = createAiClient(readAiConfig({ AI_PROVIDER: 'none' }))
  const real = createNegotiator({ ai: aiClient, fees, ...(opts.now ? { now: opts.now } : {}) })
  const confident = opts.confident ?? true
  const negotiator: Negotiator = {
    async assess(b) {
      bundles.push(b)
      if (over.assess) return over.assess(b)
      const a = await real.assess(b)
      return confident ? { ...a, escalation_reasons: a.escalation_reasons.filter((r) => r !== 'AI is off') } : a
    },
    propose(b, a, history, round) {
      bundles.push(b)
      return (over.propose ?? real.propose)(b, a, history, round)
    },
    evaluateCounter: (b, a, c) => (over.evaluateCounter ?? real.evaluateCounter)(b, a, c),
    finalRecommendation: (b, a, history) => (over.finalRecommendation ?? real.finalRecommendation)(b, a, history),
    termsCtx: (b, a) => (over.termsCtx ?? real.termsCtx)(b, a),
  }
  return {
    ai: { provider: 'none', models: { fast: 'fake', main: 'fake', mediator: 'fake', jury: [] } },
    aiClient,
    checks: fakeChecks(),
    policy: {
      async reviewSpec(spec: JobSpec) {
        return /captcha|fake review/i.test(spec.goal) ? { class: 'blocked', reasons: ['CAPTCHA farming / fake reviews are blocked'] } : { class: 'standard', reasons: [] }
      },
      async reviewBot(bot) {
        return /spam/i.test(bot.description) ? { class: 'blocked', reasons: ['spam'] } : { class: 'standard', reasons: [] }
      },
    },
    copilot: {
      async draft(req) {
        return {
          spec: {
            skill_id: req.skill.id,
            goal: req.goal,
            deliverables: [{ id: 'D1', description: req.goal, quantity: req.quantity ?? 10, acceptance: req.skill.checks.map((check) => ({ check, params: {} })), rubric: '' }],
            deadline: req.deadline ?? '2026-12-01T00:00:00.000Z',
            budget_cap: { value: req.budget_cap ?? '50.00', currency: 'USD' },
            out_of_scope: [],
            context: req.context ?? '',
            context_artifact_ids: [],
          },
          estimate: { value: '15.00', currency: 'USD' },
          warnings: [],
        }
      },
    },
    mediator: {
      async step(bundle, round) {
        return mediator(bundle, round)
      },
    },
    negotiator,
    setMediator(m) {
      mediator = m
    },
    setNegotiator(o) {
      over = o
    },
    bundles,
  }
}
