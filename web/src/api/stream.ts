import { MOCK } from './client'
import type { Event, EventType } from './types'

/**
 * Every SSE event name the server can send. Typed as a Record over the shared EventType enum so adding an
 * event type there is a compile error here until the browser listens for it (zod itself stays out of the bundle).
 */
const EVENT_NAMES: Record<EventType, true> = {
  message: true, state: true, escrow: true, check: true, ruling: true, secret: true, bot: true, mandate: true,
  open_job_posted: true, bid_received: true, bid_awarded: true, bid_declined: true, open_job_closed: true,
}

/**
 * Open the live event stream (SSE). Returns a close function.
 * EventSource reconnects by itself; the cursor is tracked so a manual reconnect resumes where it left off.
 */
export function openEventStream(opts: { jobId?: string; afterCursor?: number }, onEvent: (e: Event) => void, onStatus?: (live: boolean) => void): () => void {
  if (MOCK) {
    let closed = false
    let off: (() => void) | undefined
    void import('../mock/bus').then((bus) => {
      if (closed) return
      onStatus?.(true)
      off = bus.subscribe(opts.jobId ?? null, onEvent)
    })
    return () => {
      closed = true
      off?.()
    }
  }
  let cursor = opts.afterCursor ?? 0
  const q = new URLSearchParams()
  if (opts.jobId) q.set('job_id', opts.jobId)
  q.set('after_cursor', String(cursor))
  const es = new EventSource(`/api/events/stream?${q}`, { withCredentials: true })
  const handle = (m: MessageEvent) => {
    try {
      const ev = JSON.parse(m.data) as Event
      if (typeof ev.cursor === 'number') cursor = Math.max(cursor, ev.cursor)
      onEvent(ev)
    } catch {
      /* keepalive frames and non-JSON data */
    }
  }
  es.onopen = () => onStatus?.(true)
  es.onerror = () => onStatus?.(false)
  es.onmessage = handle
  for (const t of Object.keys(EVENT_NAMES)) es.addEventListener(t, handle as EventListener)
  return () => es.close()
}
