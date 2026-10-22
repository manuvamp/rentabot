// The Job Room: append-only, hash-chained messages.
// hash = sha256(canonical JSON of the message without `hash`); prev_hash = the previous message's hash.
// Editing or deleting any stored message breaks every hash after it, which chainValid detects. The one exception is a message the
// platform marked `redacted` (personal data removed after posting, scripts/redact-job.ts): its link is still checked, its content no
// longer can be, and the marker stays on it for everyone to see.
import type { Message, MessageType, Role } from '@rentabot/shared'
import { json, type Db } from '../db/index.ts'
import { hashCanonical, newId } from './util.ts'

export type From = Message['from']
export const PLATFORM: From = { kind: 'platform', id: 'platform', role: 'platform' }
export const MEDIATOR: From = { kind: 'mediator', id: 'mediator', role: 'mediator' }

export function messageHash(m: Omit<Message, 'hash'> | Message): string {
  const { hash: _drop, ...rest } = m as Message
  return hashCanonical(rest)
}

export function chainValid(messages: Message[]): boolean {
  let prev: string | null = null
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.seq !== i || m.prev_hash !== prev || (!m.redacted && messageHash(m) !== m.hash)) return false
    prev = m.hash
  }
  return true
}

export class Room {
  private db: Db
  private now: () => Date
  constructor(db: Db, now: () => Date) {
    this.db = db
    this.now = now
  }

  post(job_id: string, from: From, type: MessageType, text: string, body: Record<string, unknown> = {}, artifact_ids: string[] = []): Message {
    return this.db.tx(() => {
      const last = this.db.get<{ seq: number; data: string }>('SELECT seq, data FROM messages WHERE job_id = ? ORDER BY seq DESC LIMIT 1', job_id)
      const seq = last ? Number(last.seq) + 1 : 0
      const prev_hash = last ? json<Message>(last.data).hash : null
      const draft: Omit<Message, 'hash'> = {
        id: newId('msg'),
        job_id,
        seq,
        from,
        type,
        text: text.slice(0, 8000),
        body,
        artifact_ids,
        prev_hash,
        ts: this.now().toISOString(),
      }
      const msg: Message = { ...draft, hash: messageHash(draft) }
      this.db.run('INSERT INTO messages (id, job_id, seq, data) VALUES (?, ?, ?, ?)', msg.id, job_id, seq, JSON.stringify(msg))
      return msg
    })
  }

  list(job_id: string, after_seq = -1, limit = 10_000): Message[] {
    return this.db.all<{ data: string }>('SELECT data FROM messages WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?', job_id, after_seq, limit).map((r) => json<Message>(r.data))
  }

  count(job_id: string): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE job_id = ?', job_id)?.n ?? 0)
  }

  valid(job_id: string): boolean {
    return chainValid(this.list(job_id))
  }
}

export const partyFrom = (kind: 'agent' | 'user', id: string, role: Role): From => ({ kind, id, role })
