// Event log with a global cursor, per-event audience, long-poll waits and push subscriptions.
// Audience: agent ids allowed to see the event, or "public" (marketplace feed, bot listings),
// or "arbiter" (cases for human review). Users see what their agents see.
import type { Event, EventType } from '@rentabot/shared'
import type { EventFilter, Principal } from './types.ts'
import { json, type Db } from '../db/index.ts'

export interface Audience {
  agents: string[]
  public?: boolean
  arbiter?: boolean
}

interface Waiter {
  filter: EventFilter
  resolve: () => void
}

export class EventBus {
  private waiters = new Set<Waiter>()
  private subs = new Set<{ filter: Omit<EventFilter, 'after_cursor'>; fn: (e: Event) => void }>()
  private db: Db
  /** Agent ids a user principal can see through (act_as + owned agents). */
  private agentsOfUser: (userId: string, actAs: string) => string[]
  private now: () => Date
  constructor(db: Db, agentsOfUser: (userId: string, actAs: string) => string[], now: () => Date) {
    this.db = db
    this.agentsOfUser = agentsOfUser
    this.now = now
  }

  publish(type: EventType, job_id: string | null, audience: Audience, summary: string, data: Record<string, unknown>): Event {
    const ts = this.now().toISOString()
    const aud = [...new Set(audience.agents)]
    if (audience.public) aud.push('public')
    if (audience.arbiter) aud.push('arbiter')
    const res = this.db.run('INSERT INTO events (type, job_id, audience, summary, data, ts) VALUES (?, ?, ?, ?, ?, ?)', type, job_id, JSON.stringify(aud), summary.slice(0, 300), JSON.stringify(data), ts)
    const e: Event = { cursor: Number(res.lastInsertRowid), type, job_id, summary: summary.slice(0, 300), data, ts }
    // Notify after the current synchronous work so callers finish their writes first.
    queueMicrotask(() => {
      for (const w of [...this.waiters]) if (this.visible(w.filter, e, aud)) w.resolve()
      for (const s of [...this.subs]) {
        if (!this.visible({ ...s.filter, after_cursor: 0 }, e, aud)) continue
        try {
          s.fn(e)
        } catch {
          /* a broken subscriber must not break publishing */
        }
      }
    })
    return e
  }

  private seeAs(p: Principal): { agents: Set<string>; arbiter: boolean } {
    if (p.kind === 'agent') return { agents: new Set([p.agent_id]), arbiter: false }
    if (p.kind === 'user') return { agents: new Set(this.agentsOfUser(p.user_id, p.act_as)), arbiter: p.roles.includes('arbiter') }
    return { agents: new Set(), arbiter: false }
  }

  private visible(f: EventFilter, e: Event, audience: string[]): boolean {
    if (e.cursor <= f.after_cursor) return false
    if (f.job_id && e.job_id !== f.job_id) return false
    if (f.types?.length && !f.types.includes(e.type)) return false
    if (audience.includes('public')) return true
    const who = this.seeAs(f.principal)
    if (who.arbiter && audience.includes('arbiter')) return true
    return audience.some((a) => who.agents.has(a))
  }

  latestCursor(): number {
    return Number(this.db.get<{ c: number }>('SELECT COALESCE(MAX(cursor), 0) AS c FROM events')?.c ?? 0)
  }

  list(filter: EventFilter, limit = 100): { events: Event[]; cursor: number } {
    const rows = this.db.all<{ cursor: number; type: string; job_id: string | null; audience: string; summary: string; data: string; ts: string }>(
      `SELECT * FROM events WHERE cursor > ? ${filter.job_id ? 'AND job_id = ?' : ''} ORDER BY cursor LIMIT 2000`,
      filter.after_cursor,
      ...(filter.job_id ? [filter.job_id] : []),
    )
    const out: Event[] = []
    let scanned = filter.after_cursor
    for (const r of rows) {
      const e: Event = { cursor: Number(r.cursor), type: r.type as EventType, job_id: r.job_id, summary: r.summary, data: json(r.data), ts: r.ts }
      if (this.visible(filter, e, json(r.audience))) {
        out.push(e)
        if (out.length >= limit) {
          scanned = e.cursor
          return { events: out, cursor: scanned }
        }
      }
      scanned = e.cursor
    }
    // Cursor advances past events the caller can't see, so the next poll doesn't rescan them.
    return { events: out, cursor: Math.max(scanned, filter.after_cursor) }
  }

  async wait(filter: EventFilter, timeoutMs: number, signal?: AbortSignal): Promise<{ events: Event[]; cursor: number; timed_out: boolean }> {
    const first = this.list(filter)
    if (first.events.length || timeoutMs <= 0 || signal?.aborted) return { ...first, timed_out: first.events.length === 0 }
    await new Promise<void>((resolve) => {
      const w: Waiter = { filter, resolve: () => done() }
      const timer = setTimeout(() => done(), timeoutMs)
      const onAbort = () => done()
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.delete(w)
        resolve()
      }
      signal?.addEventListener('abort', onAbort)
      this.waiters.add(w)
    })
    const res = this.list(filter)
    return { ...res, timed_out: res.events.length === 0 }
  }

  subscribe(filter: Omit<EventFilter, 'after_cursor'>, fn: (e: Event) => void): () => void {
    const s = { filter, fn }
    this.subs.add(s)
    return () => this.subs.delete(s)
  }

  close() {
    for (const w of [...this.waiters]) w.resolve()
    this.subs.clear()
  }
}
