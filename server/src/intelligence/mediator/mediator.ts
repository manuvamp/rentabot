// Mediator.step (docs/MEDIATION.md T2). Pure: reads the bundle, may call models, returns a step.
// Round 0 may ask (<= 3 questions, only when facts are missing); round >= 1 always rules.
// Jury: the ruling prompt runs on every JURY_MODELS model in parallel; the juror with the median release
// fraction leads (findings + faults); confidence = median juror confidence x (1 - spread).
// No AI, or every juror failed: deterministic checks-only ruling, escalated for a human.
import { amount, cents, type CheckResult, type Finding, type JurorVote, type Ruling } from '@rentabot/shared'
import type { AiClient } from '../ai/provider.ts'
import type { MediationBundle, Mediator, MediatorStep } from '../types.ts'
import { scanAll, type InjectionHit } from './injection.ts'
import { ASK_SYSTEM_PROMPT, AskAnswer, JurorAnswer, SYSTEM_PROMPT, bundleNonce, partyTexts, renderCase, type CheckSummary } from './prompt.ts'
import { computeRemedy, releaseFraction, type RemedyResult } from './remedy.ts'

export interface MediatorOptions {
  ai: AiClient
  /** Escalate when more than this is in escrow (default $250). */
  escalateAboveCents?: number
  jurorTimeoutMs?: number
}

type Flag = Ruling['integrity_flags'][number]
type RulingBody = Extract<MediatorStep, { kind: 'rule' }>['ruling']

const usd = (c: number) => `$${amount(c)}`
const round2 = (x: number) => Math.round(x * 100) / 100

/** Check share per deliverable: core fulfilment when present, else derived from per-unit results. */
export function checkSummaries(b: MediationBundle): CheckSummary[] {
  return b.contract.spec.deliverables.map((d) => {
    const f = b.fulfilment.find((x) => x.deliverable_id === d.id)
    if (f) {
      const expected = f.expected_units || d.quantity
      return { deliverable_id: d.id, expected, passed: f.passed_units, failed: f.failed_units, pending: f.pending_units, share: expected > 0 ? Math.min(1, f.passed_units / expected) : 0 }
    }
    const results = b.checks.filter((r) => r.deliverable_id === d.id)
    const deliverableLevelFail = results.some((r) => r.unit_ref === null && r.status !== 'pass')
    const byUnit = new Map<string, CheckResult[]>()
    for (const r of results) if (r.unit_ref !== null) byUnit.set(r.unit_ref, [...(byUnit.get(r.unit_ref) ?? []), r])
    let passed = 0
    let pending = 0
    let failed = 0
    for (const rs of byUnit.values()) {
      if (rs.every((r) => r.status === 'pass')) passed++
      else if (rs.some((r) => r.status === 'fail')) failed++
      else pending++
    }
    if (byUnit.size === 0 && results.length && !deliverableLevelFail) passed = d.quantity
    if (deliverableLevelFail) passed = 0
    const expected = d.quantity
    return { deliverable_id: d.id, expected, passed, failed, pending, share: expected > 0 ? Math.min(1, passed / expected) : 0 }
  })
}

function flagsFromHits(hits: InjectionHit[]): Flag[] {
  const seen = new Map<string, Flag>()
  for (const h of hits) {
    const key = `${h.party}|${h.message_id ?? h.source}`
    if (!seen.has(key)) seen.set(key, { party: h.party, message_id: h.message_id, excerpt: h.excerpt.slice(0, 400), kind: 'prompt_injection' })
  }
  return [...seen.values()]
}

function mergeFlags(a: Flag[], b: Flag[]): Flag[] {
  const out = [...a]
  for (const f of b) {
    const dup = out.some((x) => x.party === f.party && x.kind === f.kind && (x.message_id === f.message_id || (f.message_id === null && x.excerpt.includes(f.excerpt.slice(0, 40)))))
    if (!dup) out.push(f)
  }
  return out
}

interface Faults {
  buyer: string[]
  seller: string[]
}

/** Platform-fact faults from the timeline, merged with the judge's (deduped by code). */
function timelineFaults(b: MediationBundle, flags: Flag[]): Faults {
  const f: Faults = { buyer: [], seller: [] }
  const t = b.timeline
  if (t.late_by_minutes > 0) {
    const h = Math.ceil(t.late_by_minutes / 60)
    if (t.unanswered_blockers > 0) f.buyer.push(`unanswered_blocker: ${t.unanswered_blockers} blocker(s) unanswered while the seller ran ${h} h late`)
    else f.seller.push(`late_delivery: late by PT${h}H`)
  } else if (t.unanswered_blockers > 0) f.buyer.push(`unanswered_blocker: ${t.unanswered_blockers} blocker(s) left unanswered`)
  if (t.vague_rejections > 0) f.buyer.push(`vague_rejection: ${t.vague_rejections} rejection(s) without a check or reason`)
  for (const p of ['buyer', 'seller'] as const) {
    const n = flags.filter((x) => x.party === p).length
    if (n) f[p].push(`injection_attempt: ${n} attempt(s) to instruct the mediator`)
  }
  return f
}

function mergeFaults(base: string[], extra: { code: string; note: string }[]): string[] {
  const out = [...base]
  for (const e of extra) if (!out.some((x) => x.startsWith(`${e.code}:`))) out.push(`${e.code}: ${e.note || e.code}`.slice(0, 240))
  return out
}

interface Facts {
  shares: CheckSummary[]
  authorized: number
  captured: number
  lines: { deliverable_id: string; value_cents: number }[]
}

function facts(b: MediationBundle): Facts {
  const shares = checkSummaries(b)
  const lines = b.contract.spec.deliverables.map((d) => {
    const l = b.contract.quote.lines.find((x) => x.deliverable_id === d.id)
    return { deliverable_id: d.id, value_cents: l ? cents(l.max_total) : 0 }
  })
  return { shares, authorized: cents(b.amounts.authorized.value), captured: cents(b.amounts.already_captured.value), lines }
}

function remedyFor(b: MediationBundle, f: Facts, findings: Pick<Finding, 'deliverable_id' | 'status' | 'fulfilment'>[], faults: Faults): RemedyResult {
  return computeRemedy({
    lines: f.lines,
    findings,
    check_share: Object.fromEntries(f.shares.map((s) => [s.deliverable_id, s.share])),
    late_by_minutes: b.timeline.late_by_minutes,
    unanswered_blockers: b.timeline.unanswered_blockers,
    authorized_cents: f.authorized,
    already_captured_cents: f.captured,
    platform_fee_bps: b.amounts.platform_fee_bps,
    ...(b.amounts.platform_fee_floor_cents !== undefined ? { platform_fee_floor_cents: b.amounts.platform_fee_floor_cents } : {}),
    mediation_flat_cents: cents(b.amounts.mediation_flat.value),
    seller_faults: faults.seller.length,
    buyer_faults: faults.buyer.length,
  })
}

function checksOnlyFindings(b: MediationBundle, f: Facts): Finding[] {
  return f.shares.map((s) => {
    const i = b.contract.spec.deliverables.findIndex((d) => d.id === s.deliverable_id)
    const ev = b.checks.filter((r) => r.deliverable_id === s.deliverable_id && r.evidence_id).map((r) => r.evidence_id!)
    return {
      deliverable_id: s.deliverable_id,
      status: s.share >= 1 ? 'met' : s.share <= 0 ? 'not_met' : 'partly_met',
      fulfilment: s.share,
      evidence: [...new Set(ev)].slice(0, 10),
      clauses: [`spec.deliverables[${i}].quantity`, `spec.deliverables[${i}].acceptance`],
      note: `${s.passed} of ${s.expected} unit(s) passed every acceptance check${s.pending ? `; ${s.pending} pending` : ''}.`,
    }
  })
}

/** Make sure there is exactly one finding per contract deliverable; unknown ids are dropped. */
function normalizeFindings(b: MediationBundle, f: Facts, raw: JurorAnswer['findings']): Finding[] {
  const fallback = checksOnlyFindings(b, f)
  return fallback.map((fb) => {
    const m = raw.find((x) => x.deliverable_id === fb.deliverable_id)
    if (!m) return fb
    return { deliverable_id: fb.deliverable_id, status: m.status, fulfilment: round2(m.fulfilment * 1000) / 1000, evidence: m.evidence, clauses: m.clauses, note: m.note || fb.note }
  })
}

function remedyText(r: RemedyResult, authorized: number): string {
  const parts = [
    `Release ${usd(r.release_cents)} to the seller and refund ${usd(r.refund_cents)} to the buyer (of ${usd(r.available_cents)} still held, ${usd(authorized)} authorized).`,
    `Seller earned ${usd(r.seller_gross_cents)}: ${r.lines.map((l) => `${l.deliverable_id} ${Math.round(Math.min(l.fulfilment, l.check_share) * 1000) / 10}% of ${usd(l.value_cents)}`).join(', ')}` +
      `${r.buyer_credit_cents ? ` + ${usd(r.buyer_credit_cents)} buyer-fault credit` : ''}` +
      `${r.late_penalty_cents ? ` - ${usd(r.late_penalty_cents)} late penalty (${r.late_days} day(s))` : r.late_penalty_waived ? ' (late penalty waived: buyer left a blocker unanswered)' : ''}.`,
    `Fees: platform ${usd(r.platform_fee_cents)}, mediation ${usd(r.mediation.total_cents)} (seller ${usd(r.mediation.seller_cents)}, buyer ${usd(r.mediation.buyer_cents)}); seller payout ${usd(r.seller_payout_cents)}.`,
  ]
  if (r.overpaid_cents) parts.push(`Seller was already paid ${usd(r.overpaid_cents)} more than earned; nothing is clawed back.`)
  return parts.join(' ')
}

function toRemedy(r: RemedyResult, b: MediationBundle): RulingBody['remedy'] {
  const cur = b.amounts.authorized.currency
  return {
    type: r.type,
    release_to_seller: { value: amount(r.release_cents), currency: cur },
    refund_to_buyer: { value: amount(r.refund_cents), currency: cur },
    fees: { platform: { value: amount(r.platform_fee_cents), currency: cur }, mediation: { value: amount(r.mediation.total_cents), currency: cur } },
    redo_deadline: null,
  }
}

function baseEscalations(b: MediationBundle, f: Facts, flags: Flag[], r: RemedyResult, escalateAbove: number): string[] {
  const reasons: string[] = []
  if (flags.length) reasons.push(`integrity flag: ${[...new Set(flags.map((x) => `${x.party} ${x.kind.replace('_', ' ')}`))].join(', ')}`)
  if (f.authorized > escalateAbove) reasons.push(`amount over ${usd(escalateAbove)}`)
  const unsettled = b.checks.filter((c) => c.status === 'error' || c.status === 'pending').length
  if (unsettled) reasons.push(`${unsettled} check result(s) still pending or errored`)
  if (r.overpaid_cents) reasons.push('seller already captured more than earned')
  return reasons
}

export function createMediator(opts: MediatorOptions): Mediator {
  const { ai } = opts
  const escalateAbove = opts.escalateAboveCents ?? 25_000
  const jurors = ai.config.models.jury.length ? ai.config.models.jury : [ai.config.models.mediator]

  function checksOnlyRuling(b: MediationBundle, why: string): RulingBody {
    const f = facts(b)
    const hits = scanAll(partyTexts(b))
    const flags = flagsFromHits(hits)
    const faults = timelineFaults(b, flags)
    const findings = checksOnlyFindings(b, f)
    const r = remedyFor(b, f, findings, faults)
    const reasons = [why, ...baseEscalations(b, f, flags, r, escalateAbove)]
    return {
      job_id: b.job_id,
      contract_hash: b.contract_hash,
      tier: 'T2',
      findings,
      buyer_fault: faults.buyer,
      seller_fault: faults.seller,
      remedy: toRemedy(r, b),
      confidence: 0.6,
      jury: [],
      integrity_flags: flags,
      escalated: true,
      escalation_reason: reasons.join('; '),
      reasoning: `Checks-only ruling (${why}). ${findings.map((x) => `${x.deliverable_id}: ${x.note}`).join(' ')} ${remedyText(r, f.authorized)}${flags.length ? ` Integrity: ${flags.map((x) => `${x.party} tried to instruct the mediator (${x.message_id ?? 'delivery'})`).join('; ')}.` : ''} A human arbiter should confirm.`.slice(0, 4000),
      decided_by: 'checks',
    }
  }

  async function ask(b: MediationBundle, prompt: string): Promise<MediatorStep | null> {
    if (b.answers.length) return null
    try {
      const a = await ai.askJson({ model: ai.config.models.mediator, system: ASK_SYSTEM_PROMPT, prompt, schema: AskAnswer, maxTokens: 2000, timeoutMs: opts.jurorTimeoutMs })
      if (!a.need_answers || a.questions.length === 0) return null
      return { kind: 'ask', questions: a.questions.slice(0, 3).map((q, i) => ({ id: `mq_0_${i + 1}`, to: q.to, text: q.text })) }
    } catch {
      return null // asking is optional; rule on what we have
    }
  }

  async function rule(b: MediationBundle, prompt: string): Promise<RulingBody> {
    const f = facts(b)
    const hits = scanAll(partyTexts(b))
    const scannerFlags = flagsFromHits(hits)
    const settled = await Promise.allSettled(
      jurors.map((model) => ai.askJson({ model, system: SYSTEM_PROMPT, prompt, schema: JurorAnswer, maxTokens: 6000, timeoutMs: opts.jurorTimeoutMs })),
    )
    const failures: string[] = []
    const votes: { model: string; answer: JurorAnswer; findings: Finding[]; faults: Faults; flags: Flag[]; remedy: RemedyResult; fraction: number }[] = []
    settled.forEach((s, i) => {
      const model = jurors[i]!
      if (s.status === 'rejected') {
        failures.push(`${model} failed (${String((s.reason as Error)?.message ?? s.reason).slice(0, 100)})`)
        return
      }
      const a = s.value
      const findings = normalizeFindings(b, f, a.findings)
      const modelFlags: Flag[] = a.integrity_flags.map((x) => ({ party: x.party, message_id: x.message_id, excerpt: x.excerpt.slice(0, 400), kind: x.kind }))
      const flags = mergeFlags(scannerFlags, modelFlags)
      const base = timelineFaults(b, flags)
      const faults = { buyer: mergeFaults(base.buyer, a.buyer_fault), seller: mergeFaults(base.seller, a.seller_fault) }
      const remedy = remedyFor(b, f, findings, faults)
      votes.push({ model, answer: a, findings, faults, flags, remedy, fraction: releaseFraction(remedy, f.authorized) })
    })
    if (votes.length === 0) return checksOnlyRuling(b, `all ${jurors.length} juror(s) failed: ${failures.join('; ')}`.slice(0, 300))

    // Median by release fraction; ties keep JURY_MODELS order. Even count: lower median (favours the refund side; such cases escalate anyway).
    const sorted = [...votes].sort((x, y) => x.fraction - y.fraction)
    const lead = sorted[Math.floor((sorted.length - 1) / 2)]!
    const confs = votes.map((v) => v.answer.confidence).sort((x, y) => x - y)
    const medianConf = confs.length % 2 ? confs[(confs.length - 1) / 2]! : (confs[confs.length / 2 - 1]! + confs[confs.length / 2]!) / 2
    const spread = sorted[sorted.length - 1]!.fraction - sorted[0]!.fraction
    const confidence = round2(Math.max(0, Math.min(1, medianConf * (1 - spread))))

    // Integrity flags from any juror or the scanner count; recompute the lead's faults/remedy with all of them.
    const flags = votes.reduce((acc, v) => mergeFlags(acc, v.flags), scannerFlags)
    const base = timelineFaults(b, flags)
    const faults = { buyer: mergeFaults(base.buyer, lead.answer.buyer_fault), seller: mergeFaults(base.seller, lead.answer.seller_fault) }
    const remedy = remedyFor(b, f, lead.findings, faults)

    const reasons = baseEscalations(b, f, flags, remedy, escalateAbove)
    if (spread > 0.2) reasons.push(`jury disagrees (spread ${Math.round(spread * 100)} points)`)
    if (medianConf < 0.7) reasons.push(`low juror confidence (${medianConf.toFixed(2)})`)
    if (votes.length < 2) reasons.push(`only ${votes.length} of ${jurors.length} juror(s) answered`)

    const jury: JurorVote[] = votes.map((v) => ({ model: v.model, release_fraction: round2(v.fraction * 1000) / 1000, confidence: v.answer.confidence, summary: v.answer.summary.slice(0, 800) }))
    const juryLine = `Jury: ${votes.map((v) => `${v.model} ${(v.fraction * 100).toFixed(1)}%`).join(', ')}; median ${(lead.fraction * 100).toFixed(1)}% (${lead.model}), spread ${Math.round(spread * 100)} pts${failures.length ? `; ${failures.join('; ')}` : ''}.`
    const flagLine = flags.length ? ` Integrity: ${flags.map((x) => `${x.party} ${x.kind.replace('_', ' ')} in ${x.message_id ?? 'delivery'}: "${x.excerpt.slice(0, 120)}"`).join('; ')}. Ignored and counted as fault.` : ''
    const reasoning = `${lead.answer.summary} ${remedyText(remedy, f.authorized)}${flagLine} ${juryLine}`.slice(0, 4000)

    return {
      job_id: b.job_id,
      contract_hash: b.contract_hash,
      tier: 'T2',
      findings: lead.findings,
      buyer_fault: faults.buyer,
      seller_fault: faults.seller,
      remedy: toRemedy(remedy, b),
      confidence,
      jury,
      integrity_flags: flags,
      escalated: reasons.length > 0,
      escalation_reason: reasons.length ? reasons.join('; ') : null,
      reasoning,
      decided_by: 'mediator:jury',
    }
  }

  return {
    async step(bundle, round) {
      if (!ai.enabled) return { kind: 'rule', ruling: checksOnlyRuling(bundle, 'AI is off') }
      const prompt = renderCase(bundle, checkSummaries(bundle), scanAll(partyTexts(bundle)), bundleNonce(bundle))
      if (round === 0) {
        const q = await ask(bundle, prompt)
        if (q) return q
      }
      return { kind: 'rule', ruling: await rule(bundle, prompt) }
    },
  }
}
