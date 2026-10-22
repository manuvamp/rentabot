// Helpers every handler uses: resolve the caller, load + lock the job, check the state table,
// idempotency, bot summaries.
import { BotSummary, type BotCard, type NextAction, type Role } from '@rentabot/shared'
import type { Actor } from '../core/domain.ts'
import { check, nextActions, type JobOp } from '../core/machine.ts'
import type { JobRecord } from '../core/model.ts'
import type { Services } from '../core/services.ts'
import { OpError, type OpContext } from '../core/types.ts'

export interface JobCall {
  rec: JobRecord
  role: Role
  actor: Actor
}

/** Load the job under its lock, resolve the caller's role and enforce the state table. */
export async function withJob<T>(s: Services, ctx: OpContext, job_id: string, op: JobOp, fn: (c: JobCall) => Promise<T>): Promise<T> {
  const actor = s.d.actor(ctx.principal)
  return s.d.withLock(job_id, async () => {
    const rec = s.d.load(job_id)
    const role = s.d.roleIn(rec, actor)
    // Strangers learn nothing, not even that the job exists.
    if (!role) throw new OpError('not_found', `Job ${job_id} not found.`, 'Check the job_id; list_jobs shows the jobs you are part of.')
    const view = s.d.view(rec)
    const v = check(op, view, role)
    if (!v.ok) {
      const next: NextAction[] = nextActions(view, role)
      throw new OpError(v.code, v.reason, v.code === 'forbidden' ? `Only another party can do this; you are the ${role}.` : `The job is ${rec.state}. Call get_job and pick one of next_actions.`, next)
    }
    return fn({ rec, role, actor })
  })
}

/** Store and replay results by (principal, op, key). */
export async function idempotent<T>(s: Services, actor: Actor, op: string, key: string | undefined, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
  if (!key) return { result: await fn(), replayed: false }
  const row = s.d.db.get<{ result: string }>('SELECT result FROM idempotency WHERE principal = ? AND op = ? AND key = ?', actor.key, op, key)
  if (row) return { result: JSON.parse(row.result) as T, replayed: true }
  const result = await fn()
  s.d.db.run('INSERT OR IGNORE INTO idempotency (principal, op, key, result, created_at) VALUES (?, ?, ?, ?, ?)', actor.key, op, key, JSON.stringify(result), s.d.nowIso())
  return { result, replayed: false }
}

export function botSummary(b: BotCard): BotSummary {
  return BotSummary.parse({
    id: b.id,
    name: b.name,
    tagline: b.tagline,
    capability_class: b.capability_class,
    mode: b.mode,
    reputation: b.reputation,
    passport: b.passport,
    skills: b.skills.map((k) => ({ id: k.id, title: k.title, pricing: k.pricing, turnaround: k.turnaround, checks: k.checks, brief: k.brief })),
  })
}

export function result(s: Services, rec: JobRecord, role: Role) {
  return s.d.result(rec, role)
}
