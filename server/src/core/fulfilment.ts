// What the seller earned: latest check results × quote lines. Pure function, unit-tested.
//
// Per deliverable:
//  - per-unit checks run once per delivered unit; deliverable-level checks run once.
//  - a unit passes when every per-unit check passes; fails if any fails or errors (an unknown or
//    crashing check counts against the unit: the buyer never pays for something nothing verified);
//    otherwise pending if any check is still pending (delayed checks such as moderation queues).
//  - a failing deliverable-level check fails every unit; a pending one makes every non-failed unit pending.
//  - units beyond the contracted quantity are ignored (the quote caps the money anyway).
// Earnings:
//  - per_unit line: passed_units × unit_price, capped at max_total.
//  - fixed line: all-or-nothing: full price only when `quantity` units passed and nothing failed or is pending.
//  - `held_for_pending` is what pending units could still earn; it stays authorized until verify_until.
import type { CheckResult, Contract, Delivery, Fulfilment } from '@rentabot/shared'
import { toCents, usd } from './util.ts'

export interface FulfilmentCalc {
  fulfilment: Fulfilment[]
  earned_cents: number
  held_for_pending_cents: number
  /** Per deliverable: unit refs that passed / failed / are pending (after the quantity cap). */
  units: Record<string, { passed: string[]; failed: string[]; pending: string[] }>
}

type UnitStatus = 'pass' | 'fail' | 'pending'

/** Latest result per (deliverable, unit, check). */
export function latestResults(results: CheckResult[]): CheckResult[] {
  const best = new Map<string, CheckResult>()
  for (const r of results) {
    const k = `${r.deliverable_id}|${r.unit_ref ?? ''}|${r.check}`
    const cur = best.get(k)
    if (!cur || r.attempt > cur.attempt || (r.attempt === cur.attempt && r.ran_at >= cur.ran_at)) best.set(k, r)
  }
  return [...best.values()]
}

const combine = (statuses: string[]): UnitStatus => {
  if (statuses.some((s) => s === 'fail' || s === 'error')) return 'fail'
  if (statuses.some((s) => s === 'pending')) return 'pending'
  return 'pass'
}

export function computeFulfilment(
  contract: Contract,
  delivery: Delivery | null,
  results: CheckResult[],
  opts: { perUnitChecks: (checkId: string) => boolean; excludeUnits?: Record<string, string[]> } = { perUnitChecks: () => true },
): FulfilmentCalc {
  const latest = latestResults(results)
  const out: Fulfilment[] = []
  const units: FulfilmentCalc['units'] = {}
  let earned = 0
  let held = 0
  for (const d of contract.spec.deliverables) {
    const line = contract.quote.lines.find((l) => l.deliverable_id === d.id)
    const delivered = delivery?.deliverables.find((x) => x.deliverable_id === d.id)?.units ?? []
    const excluded = new Set(opts.excludeUnits?.[d.id] ?? [])
    const perUnit = d.acceptance.filter((t) => opts.perUnitChecks(t.check))
    const levelTests = d.acceptance.filter((t) => !opts.perUnitChecks(t.check))
    const mine = latest.filter((r) => r.deliverable_id === d.id)
    const statusOf = (unit: string | null, check: string) => mine.find((r) => r.unit_ref === unit && r.check === check)?.status ?? 'pending'

    // A deliverable with no delivery yet: nothing verified, nothing earned.
    const level = delivery ? combine(levelTests.map((t) => statusOf(null, t.check))) : 'fail'
    const u = { passed: [] as string[], failed: [] as string[], pending: [] as string[] }
    const seen = new Set<string>()
    for (const unit of delivered.slice(0, d.quantity)) {
      if (seen.has(unit.ref)) continue // the same unit twice counts once
      seen.add(unit.ref)
      let st: UnitStatus = perUnit.length ? combine(perUnit.map((t) => statusOf(unit.ref, t.check))) : 'pass'
      if (level === 'fail' || excluded.has(unit.ref)) st = 'fail'
      else if (level === 'pending' && st === 'pass') st = 'pending'
      u[st === 'pass' ? 'passed' : st === 'fail' ? 'failed' : 'pending'].push(unit.ref)
    }
    units[d.id] = u
    let lineEarned = 0
    let linePotential = 0
    if (line) {
      const unitPrice = toCents(line.unit_price)
      const cap = toCents(line.max_total)
      if (line.model === 'per_unit') {
        lineEarned = Math.min(u.passed.length * unitPrice, cap)
        linePotential = Math.min((u.passed.length + u.pending.length) * unitPrice, cap)
      } else {
        const full = Math.min(unitPrice, cap)
        const allPass = u.passed.length >= d.quantity && u.failed.length === 0 && u.pending.length === 0
        const couldPass = u.passed.length + u.pending.length >= d.quantity && u.failed.length === 0
        lineEarned = allPass ? full : 0
        linePotential = couldPass ? full : 0
      }
    }
    earned += lineEarned
    held += linePotential - lineEarned
    out.push({
      deliverable_id: d.id,
      expected_units: d.quantity,
      passed_units: u.passed.length,
      pending_units: u.pending.length,
      failed_units: u.failed.length,
      earned: usd(lineEarned),
    })
  }
  // Never more than the contract total.
  const total = toCents(contract.quote.total_max.value)
  if (earned > total) earned = total
  if (earned + held > total) held = total - earned
  return { fulfilment: out, earned_cents: earned, held_for_pending_cents: held, units }
}
