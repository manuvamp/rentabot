// In-memory sandbox state with a JSON snapshot in dataDir/sandbox.json. Everything time-dependent is
// stored as absolute millisecond timestamps and evaluated lazily against the clock, so a fake clock
// in tests (or a timeScale in demos) never needs timers.
import fs from 'node:fs'
import path from 'node:path'

export type Clock = () => number

export interface Submission {
  id: string
  slug: string
  created_at: number
  name: string
  url: string
  tagline: string
  description: string
  category: string
  contact_email: string
  logo_url: string | null
  screenshot_url: string | null
  /** Email-verification token (email_confirm directories only). */
  token: string | null
  verified_at: number | null
  /** What a name-rewriting directory actually published. */
  rewritten: { name: string; tagline: string; description: string } | null
  /** The directory account that submitted it (directories that require one). */
  account_id?: string | null
}

/** An account on a sandbox directory or SaaS service. The password is only ever stored as a salted hash. */
export interface Account {
  id: string
  /** "dir:<slug>" or "saas:<slug>" */
  scope: string
  email: string
  display_name: string
  handle: string | null
  salt: string
  hash: string
  verify_token: string
  verified_at: number | null
  created_at: number
}

/** The public profile of a SaaS account. */
export interface Profile {
  id: string
  service: string
  account_id: string
  handle: string
  display_name: string
  bio: string
  logo_url: string
  link: string
  created_at: number
  updated_at: number
  /** When the profile first went live (moderated services publish it later); null while it has no content. */
  live_at: number | null
}

export interface AppPassword {
  id: string
  label: string
  salt: string
  hash: string
  created_at: number
  revoked_at: number | null
}

/** A buyer mailbox that issues app passwords; SMTP-style sends and reads of it need one. */
export interface Mailbox {
  address: string
  label: string
  created_at: number
  passwords: AppPassword[]
}

/** A multi-step application on the fake accelerator / grant / launch-directory sites. */
export interface Application {
  id: string
  program: string
  email: string
  applicant_name: string
  created_at: number
  /** Saved answers by step number. */
  steps: Record<string, Record<string, string>>
  completed: number[]
  files: Record<string, { filename: string; mime: string; bytes: number; sha256: string }>
  submitted_at: number | null
  confirmation_id: string | null
}

export type MailKind = 'sent' | 'reply' | 'bounce' | 'system'

export interface MailMessage {
  message_id: string
  from: string
  to: string
  subject: string
  text: string
  /** When the message was (or will be) delivered. Messages with visible_at > now are invisible. */
  sent_at: number
  visible_at: number
  kind: MailKind
  status: 'delivered' | 'bounced'
  bounce_reason: string | null
  in_reply_to: string | null
  /** For persona replies: the sentiment. */
  reply_kind: 'positive' | 'decline' | null
  persona_id: string | null
  /** How a sent message was submitted: with a mailbox's app password (SMTP-style), or through the open test API. */
  via?: 'smtp_auth' | 'open'
}

export interface SandboxData {
  version: 1
  seed: string
  seq: number
  mail_seq: number
  submissions: Submission[]
  attempts: Record<string, number>
  mail: MailMessage[]
  mailboxes: Mailbox[]
  accounts: Account[]
  /** Session token -> account id. */
  sessions: Record<string, string>
  profiles: Profile[]
  applications: Application[]
  /** Landing pages published on the page host (pages.ts). Kept across restarts so a delivered URL keeps serving its page. */
  pages?: { id: string; slug: string; title: string; html: string; published_at: number }[]
  page_seq?: number
  /** The red-team practice agent's ownership claims and finding log (redteam.ts), kept so checks re-run after a restart still see them. */
  redteam?: { seq: number; claims: { ownership_token: string; created_at: number; job_ids: string[] }[]; findings: { finding_id: string; job_id: string; category: string; severity: 'low' | 'medium' | 'high' | 'critical'; reproduced: boolean; at: number }[] }
}

export interface Store {
  data: SandboxData
  /** Schedule a snapshot write (debounced). */
  save(): void
  /** Write the snapshot now. */
  flush(): void
  /** Wipe all state and write an empty snapshot. */
  reset(): void
}

const fresh = (seed: string): SandboxData => ({ version: 1, seed, seq: 0, mail_seq: 0, submissions: [], attempts: {}, mail: [], mailboxes: [], accounts: [], sessions: {}, profiles: [], applications: [], pages: [], page_seq: 0, redteam: { seq: 0, claims: [], findings: [] } })

export function createStore(dataDir: string, seed: string): Store {
  const file = path.join(dataDir, 'sandbox.json')
  let data = fresh(seed)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SandboxData
    // Snapshots from before mailboxes, accounts and applications existed load with those parts empty.
    if (raw && raw.version === 1 && raw.seed === seed && Array.isArray(raw.submissions) && Array.isArray(raw.mail)) data = { ...fresh(seed), ...raw }
  } catch {
    // no snapshot yet, or unreadable: start empty
  }
  let timer: NodeJS.Timeout | null = null
  const store: Store = {
    data,
    save() {
      if (timer) return
      timer = setTimeout(() => store.flush(), 250)
      timer.unref()
    },
    flush() {
      if (timer) clearTimeout(timer)
      timer = null
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(store.data))
      } catch {
        // a failed snapshot must never break a demo; state stays in memory
      }
    },
    reset() {
      // mutate in place so every module holding store.data keeps a live reference
      for (const k of Object.keys(store.data)) delete (store.data as unknown as Record<string, unknown>)[k]
      Object.assign(store.data, fresh(seed))
      store.flush()
    },
  }
  return store
}
