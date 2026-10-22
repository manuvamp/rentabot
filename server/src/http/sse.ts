// GET /api/events/stream: Server-Sent Events from core.events (backlog first, then live; id = cursor).
import type { FastifyInstance } from 'fastify'
import { EventType, type Event } from '@rentabot/shared'
import { OpError, type EventFilter } from '../core/types.ts'
import { resolvePrincipal } from './auth.ts'
import type { Gateway } from './gateway.ts'

const HEARTBEAT_MS = 15_000
const PAGE = 500
const MAX_BACKLOG_PAGES = 20

export function registerSse(app: FastifyInstance, gw: Gateway, opts: { heartbeatMs?: number } = {}): void {
  const core = gw.core
  const open = new Set<() => void>()
  app.addHook('onClose', async () => [...open].forEach((close) => close()))
  app.get('/api/events/stream', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const principal = await resolvePrincipal(core, req.headers)
    gw.limit(principal, req.ip)

    const lastEventId = req.headers['last-event-id']
    const cursorRaw = typeof lastEventId === 'string' && lastEventId !== '' ? lastEventId : q.after_cursor
    const after = cursorRaw === undefined || cursorRaw === '' ? 0 : Number(cursorRaw)
    if (!Number.isInteger(after) || after < 0) throw new OpError('invalid_input', 'after_cursor must be a non-negative integer.', 'Pass the cursor of the last event you processed.')

    let types: Event['type'][] | undefined
    if (q.types) {
      const names = q.types.split(',').map((s) => s.trim()).filter(Boolean)
      const parsed = names.map((n) => EventType.safeParse(n))
      if (parsed.some((p) => !p.success)) throw new OpError('invalid_input', `Unknown event type in types.`, `Use any of: ${EventType.options.join(', ')}.`)
      types = parsed.map((p) => p.data!)
    }
    const base: Omit<EventFilter, 'after_cursor'> = { principal, ...(q.job_id ? { job_id: q.job_id } : {}), ...(types ? { types } : {}) }

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n: connected\n\n')

    let last = after
    let closed = false
    let backlogDone = false
    const buffered: Event[] = []
    const send = (e: Event) => {
      if (closed || e.cursor <= last) return
      last = e.cursor
      res.write(`id: ${e.cursor}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    }

    // Subscribe first so nothing is missed while the backlog loads; dedupe by cursor.
    const unsub = core.events.subscribe(base, (e) => (backlogDone ? send(e) : buffered.push(e)))
    const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), opts.heartbeatMs ?? HEARTBEAT_MS)
    const close = () => {
      if (closed) return
      closed = true
      open.delete(close)
      clearInterval(heartbeat)
      unsub()
      if (!res.writableEnded) res.end()
    }
    open.add(close)
    req.raw.on('close', close)

    try {
      for (let i = 0; i < MAX_BACKLOG_PAGES && !closed; i++) {
        const page = await core.events.list({ ...base, after_cursor: last }, PAGE)
        page.events.forEach(send)
        if (page.events.length < PAGE) break
      }
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'sse backlog failed')
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ code: 'internal', message: 'Backlog unavailable; reconnect with Last-Event-ID.' })}\n\n`)
    }
    backlogDone = true
    buffered.sort((a, b) => a.cursor - b.cursor).forEach(send)
    return reply
  })
}
