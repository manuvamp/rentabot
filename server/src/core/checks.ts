// Check runner: runs the contract's acceptance tests on a delivery through the intelligence
// layer's check library, stores every result (with evidence ids and attempt numbers), and
// recomputes fulfilment. A check id the library doesn't know, a crash or a timeout is recorded
// as `error` (which counts as not passed); the runner itself never throws because of a check.
import type { CheckResult } from '@rentabot/shared'
import { json } from '../db/index.ts'
import type { ArtifactStore } from './artifacts.ts'
import type { Domain } from './domain.ts'
import { computeFulfilment, latestResults } from './fulfilment.ts'
import type { JobRecord } from './model.ts'
import { newId } from './util.ts'

const CHECK_TIMEOUT_MS = 30_000
const CONCURRENCY = 8

export class CheckRunner {
  private d: Domain
  private artifacts: ArtifactStore
  constructor(d: Domain, artifacts: ArtifactStore) {
    this.d = d
    this.artifacts = artifacts
  }

  results(job_id: string): CheckResult[] {
    return this.d.db.all<{ data: string }>('SELECT data FROM check_results WHERE job_id = ? ORDER BY attempt, rowid', job_id).map((r) => json<CheckResult>(r.data))
  }
  latest(job_id: string) {
    return latestResults(this.results(job_id))
  }
  private isPerUnit = (id: string) => this.d.intel.checks.get(id)?.def.per_unit ?? true
  isDelayed = (id: string) => this.d.intel.checks.get(id)?.def.delayed ?? false

  /**
   * Run checks on the current delivery. mode 'all' runs everything; 'pending' re-runs only the
   * (deliverable, unit, check) triples whose latest result is pending. Updates rec.fulfilment.
   */
  async run(rec: JobRecord, mode: 'all' | 'pending' = 'all'): Promise<CheckResult[]> {
    const contract = this.d.buildContract(rec)
    if (!contract || !rec.delivery) return []
    const prev = this.latest(rec.id)
    const attempt = this.results(rec.id).reduce((m, r) => Math.max(m, r.attempt), 0) + 1
    type Task = { deliverable_id: string; unit: NonNullable<typeof rec.delivery>['deliverables'][number]['units'][number] | null; test: (typeof contract.spec.deliverables)[number]['acceptance'][number] }
    const tasks: Task[] = []
    for (const d of contract.spec.deliverables) {
      const units = (rec.delivery.deliverables.find((x) => x.deliverable_id === d.id)?.units ?? []).slice(0, d.quantity)
      const seen = new Set<string>()
      for (const test of d.acceptance) {
        const targets = this.isPerUnit(test.check) ? units.filter((u) => !seen.has(`${test.check}|${u.ref}`) && seen.add(`${test.check}|${u.ref}`)) : [null]
        for (const unit of targets) {
          if (mode === 'pending') {
            const last = prev.find((r) => r.deliverable_id === d.id && r.check === test.check && r.unit_ref === (unit?.ref ?? null))
            if (last && last.status !== 'pending') continue
          }
          tasks.push({ deliverable_id: d.id, unit, test })
        }
      }
    }
    const out: CheckResult[] = []
    let i = 0
    const worker = async () => {
      while (i < tasks.length) {
        const t = tasks[i++]
        out.push(await this.runOne(rec, contract, t.deliverable_id, t.unit, t.test, attempt))
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker))
    this.d.db.tx(() => {
      for (const r of out) this.d.db.run('INSERT INTO check_results (id, job_id, attempt, data) VALUES (?, ?, ?, ?)', r.id, rec.id, r.attempt, JSON.stringify(r))
    })
    this.recompute(rec)
    const pass = out.filter((r) => r.status === 'pass').length
    if (out.length)
      this.d.bus.publish('check', rec.id, this.d.audience(rec), `Checks run (attempt ${attempt}): ${pass}/${out.length} passed`, {
        attempt,
        total: out.length,
        passed: pass,
        failed: out.filter((r) => r.status === 'fail' || r.status === 'error').length,
        pending: out.filter((r) => r.status === 'pending').length,
      })
    return out
  }

  /** Passed / failed / pending unit refs per deliverable from the latest results, without touching the record (rejected units count as failed). */
  units(rec: JobRecord): ReturnType<typeof computeFulfilment>['units'] {
    const contract = this.d.buildContract(rec)
    if (!contract) return {}
    const exclude: Record<string, string[]> = {}
    for (const r of rec.review.rejections) exclude[r.deliverable_id] = [...(exclude[r.deliverable_id] ?? []), ...r.unit_refs]
    return computeFulfilment(contract, rec.delivery, this.results(rec.id), { perUnitChecks: this.isPerUnit, excludeUnits: exclude }).units
  }

  /** Recompute fulfilment from the latest results (rejected units of a cure count as failed when asked). */
  recompute(rec: JobRecord, excludeRejected = false) {
    const contract = this.d.buildContract(rec)
    if (!contract) return
    const exclude: Record<string, string[]> = {}
    if (excludeRejected) for (const r of rec.review.rejections) exclude[r.deliverable_id] = [...(exclude[r.deliverable_id] ?? []), ...r.unit_refs]
    const f = computeFulfilment(contract, rec.delivery, this.results(rec.id), { perUnitChecks: this.isPerUnit, excludeUnits: exclude })
    rec.fulfilment = f.fulfilment
    rec.earned_cents = f.earned_cents
    rec.held_pending_cents = f.held_for_pending_cents
    return f
  }

  private async runOne(rec: JobRecord, contract: NonNullable<ReturnType<Domain['buildContract']>>, deliverable_id: string, unit: CheckResultUnit, test: { check: string; params: Record<string, unknown> }, attempt: number): Promise<CheckResult> {
    const base = { id: newId('chk'), job_id: rec.id, deliverable_id, unit_ref: unit?.ref ?? null, check: test.check, attempt }
    const impl = this.d.intel.checks.get(test.check)
    if (!impl) return { ...base, status: 'error', detail: `Check "${test.check}" is not registered in the check library.`, evidence_id: null, ran_at: this.d.nowIso() }
    try {
      const outcome = await Promise.race([
        impl.run({
          job_id: rec.id,
          contract,
          deliverable_id,
          unit,
          test: { check: test.check, params: test.params ?? {} },
          attempt,
          artifact: async (id) => this.artifacts.read(id),
          saveEvidence: async (kind, summary, payload) => this.artifacts.saveEvidence(rec.id, kind, summary, payload),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS / 1000}s`)), CHECK_TIMEOUT_MS).unref?.()),
      ])
      const status = ['pass', 'fail', 'pending', 'error'].includes(outcome?.status) ? outcome.status : 'error'
      return { ...base, status, detail: String(outcome?.detail ?? '').slice(0, 1000), evidence_id: outcome?.evidence_id ?? null, ran_at: this.d.nowIso() }
    } catch (e) {
      return { ...base, status: 'error', detail: `Check crashed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1000), evidence_id: null, ran_at: this.d.nowIso() }
    }
  }
}

type CheckResultUnit = NonNullable<JobRecord['delivery']>['deliverables'][number]['units'][number] | null
