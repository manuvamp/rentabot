// In-browser event bus: stands in for GET /api/events/stream and wait_for_events in mock mode.
import type { Event } from '../api/types'

type Listener = (e: Event) => void
const listeners = new Set<{ jobId: string | null; fn: Listener }>()
const log: Event[] = []
let cursor = 100

export function emit(type: Event['type'], jobId: string | null, summary: string, data: Record<string, unknown> = {}): Event {
  const ev: Event = { cursor: ++cursor, type, job_id: jobId as Event['job_id'], summary, data, ts: new Date().toISOString() }
  log.push(ev)
  if (log.length > 500) log.shift()
  // listeners are notified asynchronously so handlers finish writing state first
  queueMicrotask(() => {
    for (const l of listeners) if (l.jobId === null || l.jobId === jobId) l.fn(ev)
  })
  return ev
}

export function subscribe(jobId: string | null, fn: Listener): () => void {
  const l = { jobId, fn }
  listeners.add(l)
  return () => listeners.delete(l)
}

export const eventLog = () => log
export const currentCursor = () => cursor
