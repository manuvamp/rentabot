// Shared by the bots that really act for the buyer (Directory Blaster, Investor Outreach, Account Setup, Application Filler):
//  - strong generated passwords, registered with the log redactor the moment they exist
//  - the buyer's logins from the locker (an inbox's address + app password) and Basic-auth reads of a Sandbox Web mailbox
//  - `log_action` before every real action, stopping cleanly at the consent caps (never provoking policy_blocked on purpose)
//  - the handover of a created account through the locker, tied to its unit
// Values from the locker or generated here never go to a message, a delivery, a prompt or a log line.
import { randomBytes, randomInt } from 'node:crypto'
import type { RealAction } from '@rentabot/shared'
import { http, httpJson, onOrigin } from './common.ts'
import { registerSecret } from './log.ts'
import { RabError, lockerFor } from './rab.ts'
import type { SealedSecret, WorkJob, WorkTools } from './runtime.ts'

const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGIT = '23456789'
const SYMBOL = '!#$%*-_=+?'

/** A unique random password: `len` characters (default 24) with at least two of each class, from the OS random source. */
export function strongPassword(len = 24): string {
  const pick = (set: string) => set[randomInt(set.length)]!
  const chars = [pick(LOWER), pick(LOWER), pick(UPPER), pick(UPPER), pick(DIGIT), pick(DIGIT), pick(SYMBOL), pick(SYMBOL)]
  const all = LOWER + UPPER + DIGIT + SYMBOL
  while (chars.length < len) chars.push(pick(all))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  const pw = chars.join('')
  registerSecret(pw)
  return pw
}

export interface Login {
  url: string
  username: string
  password: string
}

/** The login the buyer put in the locker for an access request, if the answer is a login. */
export function loginFrom(secrets: SealedSecret[], accessId: string): Login | null {
  for (const s of secrets) {
    if (s.access_id !== accessId) continue
    try {
      const v = JSON.parse(s.value) as { kind?: string; url?: unknown; username?: unknown; password?: unknown }
      if (v.kind === 'login' && typeof v.username === 'string' && typeof v.password === 'string' && v.username && v.password) {
        registerSecret(v.password)
        return { url: typeof v.url === 'string' ? v.url : '', username: v.username.trim().toLowerCase(), password: v.password }
      }
    } catch {
      /* not a login */
    }
  }
  return null
}

export const basicHeader = (l: Pick<Login, 'username' | 'password'>) => ({ authorization: `Basic ${Buffer.from(`${l.username}:${l.password}`).toString('base64')}` })

export interface MailMsg {
  message_id: string
  kind: string
  status: string
  from: string
  to: string
  subject: string
  text: string
  in_reply_to: string | null
  reply_kind?: string | null
}

/** Messages of a Sandbox Web mailbox. A registered mailbox answers only to its app password; `denied` says that was the problem. */
export async function readMailbox(sandboxUrl: string, address: string, login: Login | null): Promise<{ messages: MailMsg[]; denied: boolean }> {
  const headers = login && login.username === address.toLowerCase() ? basicHeader(login) : undefined
  const r = await httpJson<{ messages: MailMsg[] }>(`${sandboxUrl.replace(/\/+$/, '')}/mail/messages?address=${encodeURIComponent(address)}`, { headers })
  if (r.status === 401) return { messages: [], denied: true }
  return { messages: r.json?.messages ?? [], denied: false }
}

/** A link in a mail body that stays on this sandbox origin and matches `pattern` (never a link elsewhere). */
export function sandboxLink(text: string, origin: string, pattern: RegExp): string | null {
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    try {
      const u = new URL(m[0])
      if (pattern.test(u.pathname)) return `${origin}${u.pathname}`
    } catch {
      /* skip */
    }
  }
  return null
}

export async function openLink(url: string): Promise<boolean> {
  const r = await http(url)
  return r.status === 200
}

// ---------- consent: log_action before every real action ----------

export interface ActionLogger {
  /** Report the action BEFORE taking it. false = the platform refused it (consent cap, target or window): do not take it. */
  allow(action: RealAction, target: string, extra?: { unit_ref?: string; external_ref?: string; count?: number }): Promise<boolean>
  /** Actions still allowed under the grant, from the consent usage the platform reports (Infinity when it sets no cap). */
  remaining(): number
  /** Why the last refusal happened, for the delivery note. */
  readonly blockedReason: string | null
  readonly accepted: number
}

/**
 * log_action for one access grant. It reads the grant's usage first and stops itself at the caps: it never sends an action it knows
 * would be refused, so no integrity flag is provoked. If the platform still refuses, the grant counts as exhausted.
 */
export async function actionLogger(tools: WorkTools, jobId: string, accessId: string): Promise<ActionLogger> {
  let left = Infinity
  try {
    const r = await tools.rab.call<{ consent: { access_id: string; usage: { used_total: number; max_total: number | null; used_today: number; max_per_day: number | null } | null }[] }>('list_locker_items', { job_id: jobId })
    const u = r.consent.find((c) => c.access_id === accessId)?.usage
    if (u) {
      const total = u.max_total === null ? Infinity : u.max_total - u.used_total
      const day = u.max_per_day === null ? Infinity : u.max_per_day - u.used_today
      left = Math.max(0, Math.min(total, day))
    }
  } catch {
    /* log_action itself enforces the caps */
  }
  const state = { blocked: null as string | null, accepted: 0 }
  return {
    remaining: () => (state.blocked ? 0 : left),
    get blockedReason() {
      return state.blocked
    },
    get accepted() {
      return state.accepted
    },
    async allow(action, target, extra = {}) {
      const count = extra.count ?? 1
      if (state.blocked) return false
      if (left < count) {
        state.blocked = 'the consent limit is reached'
        return false
      }
      try {
        const r = await tools.rab.call<{ usage?: { used_total: number; max_total: number | null; used_today: number; max_per_day: number | null } }>('log_action', {
          job_id: jobId,
          action,
          target,
          access_id: accessId,
          count,
          ...(extra.unit_ref ? { unit_ref: extra.unit_ref } : {}),
          ...(extra.external_ref ? { external_ref: extra.external_ref } : {}),
        })
        state.accepted += count
        if (r.usage) {
          const total = r.usage.max_total === null ? Infinity : r.usage.max_total - r.usage.used_total
          const day = r.usage.max_per_day === null ? Infinity : r.usage.max_per_day - r.usage.used_today
          left = Math.max(0, Math.min(total, day))
        } else left = Math.max(0, left - count)
        return true
      } catch (e) {
        if (e instanceof RabError && e.code === 'policy_blocked') {
          state.blocked = e.message.replace(/^Not allowed by the buyer's consent: /, '').slice(0, 200)
          return false
        }
        throw e
      }
    },
  }
}

// ---------- handing over what the bot created ----------

export interface Handover {
  deliverable_id: string
  unit_ref: string
  /** Host the account is for, e.g. "toolhatch.dirs.sandbox". */
  site: string
  label: string
  /** The login page. */
  url: string
  username: string
  password: string
  notes?: string
}

/** Put the new account's login in the job locker for the buyer, tied to its unit. End-to-end for the buyer's keys, else sealed. */
export async function handOver(tools: WorkTools, jobId: string, h: Handover): Promise<void> {
  registerSecret(h.password)
  await lockerFor(tools.rab).put({
    job_id: jobId,
    deliverable_id: h.deliverable_id,
    unit_ref: h.unit_ref,
    label: h.label.slice(0, 80),
    site: h.site,
    secret: { kind: 'login', url: h.url, username: h.username, password: h.password, notes: h.notes ?? '' },
  })
}

/** Unit refs that already have a handover in the locker (a retry must not hand over twice). */
export async function handedOverRefs(tools: WorkTools, jobId: string): Promise<Set<string>> {
  try {
    const r = await tools.rab.call<{ items: { direction: string; unit_ref: string | null; status: string }[] }>('list_locker_items', { job_id: jobId })
    return new Set(r.items.filter((i) => i.direction === 'handover' && i.status !== 'shredded' && i.unit_ref).map((i) => i.unit_ref!))
  } catch {
    return new Set()
  }
}

/** Fit text into `max` characters without cutting a word (no ellipsis: some services reject them). */
export function fit(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sentence = cut.match(/^(.*[.!?])\s/)?.[1]
  if (sentence && sentence.length >= max * 0.5) return sentence
  // Next best: end on a whole clause (a cut like ", and makes" reads as a broken sentence on a form).
  const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' – '), cut.lastIndexOf(' — '))
  if (clause >= max * 0.6) return cut.slice(0, clause).trim()
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:-]+$/, '')
}

export const slugify = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export { onOrigin, randomBytes }
export type { WorkJob }
