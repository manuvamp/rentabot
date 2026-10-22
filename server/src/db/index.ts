// Storage on node:sqlite (built in, no native deps). Aggregates are JSON columns; the columns next
// to them exist for lookups. Migrations run at boot, in order, once each (tracked in user_version).
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, roles TEXT NOT NULL, act_as TEXT NOT NULL, persona TEXT, created_at TEXT NOT NULL);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, act_as TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, owner_id TEXT, claim_code TEXT UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prefix TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE bots (id TEXT PRIMARY KEY, operator_agent_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, stats TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, buyer_agent_id TEXT NOT NULL, seller_agent_id TEXT NOT NULL, seller_bot_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX jobs_buyer ON jobs(buyer_agent_id);
  CREATE INDEX jobs_seller ON jobs(seller_agent_id);
  CREATE INDEX jobs_state ON jobs(state);
  CREATE TABLE messages (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(job_id, seq));
  CREATE TABLE artifacts (id TEXT PRIMARY KEY, job_id TEXT, data TEXT NOT NULL, path TEXT);
  CREATE TABLE evidence (id TEXT PRIMARY KEY, job_id TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE check_results (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX checks_job ON check_results(job_id, attempt);
  CREATE TABLE mandates (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, data TEXT NOT NULL, setup_token_id TEXT, payment_token_id TEXT, created_at TEXT NOT NULL);
  CREATE TABLE secrets (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, access_id TEXT NOT NULL, label TEXT NOT NULL, sealed TEXT, created_at TEXT NOT NULL, wiped_at TEXT);
  CREATE TABLE idempotency (principal TEXT NOT NULL, op TEXT NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (principal, op, key));
  CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, job_id TEXT, audience TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL, ts TEXT NOT NULL);
  CREATE TABLE paypal_refs (paypal_id TEXT PRIMARY KEY, kind TEXT NOT NULL, job_id TEXT, mandate_id TEXT);
  CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TEXT NOT NULL, result TEXT);
  CREATE TABLE sim_objects (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE feed (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, amount TEXT);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // Open jobs: a buyer's job posted to every matching bot; bids live inside the JSON aggregate.
  `
  CREATE TABLE open_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, buyer_agent_id TEXT NOT NULL, data TEXT NOT NULL, bid_until TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX open_jobs_state ON open_jobs(state);
  CREATE INDEX open_jobs_buyer ON open_jobs(buyer_agent_id);
  `,
  // The credential locker (core/locker.ts, docs/SECURITY.md): public keys, envelope-encrypted items, per-recipient wrapped
  // data keys (deleted on shred), an audit of every put/open/shred and the seller's action receipts.
  `
  CREATE TABLE enc_keys (kid TEXT PRIMARY KEY, agent_id TEXT NOT NULL, jwk TEXT NOT NULL, fingerprint TEXT NOT NULL, label TEXT NOT NULL, custody TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
  CREATE INDEX enc_keys_agent ON enc_keys(agent_id);
  CREATE TABLE locker_items (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, direction TEXT NOT NULL, kind TEXT NOT NULL, protection TEXT NOT NULL, label TEXT NOT NULL, site TEXT NOT NULL, access_id TEXT, access_hash TEXT, deliverable_id TEXT, unit_ref TEXT, from_role TEXT NOT NULL, from_agent TEXT NOT NULL, server_run INTEGER NOT NULL DEFAULT 0, ciphertext TEXT, created_at TEXT NOT NULL, released_at TEXT, expires_at TEXT, shredded_at TEXT, shred_reason TEXT);
  CREATE INDEX locker_items_job ON locker_items(job_id);
  CREATE TABLE locker_wraps (item_id TEXT NOT NULL, kid TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (item_id, kid));
  CREATE TABLE locker_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, item_id TEXT, event TEXT NOT NULL, role TEXT NOT NULL, who TEXT NOT NULL, surface TEXT NOT NULL, detail TEXT NOT NULL, ts TEXT NOT NULL);
  CREATE INDEX locker_audit_job ON locker_audit(job_id);
  CREATE TABLE locker_actions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, access_id TEXT, action TEXT NOT NULL, target TEXT NOT NULL, unit_ref TEXT, external_ref TEXT, count INTEGER NOT NULL, accepted INTEGER NOT NULL, reason TEXT NOT NULL, ts TEXT NOT NULL);
  CREATE INDEX locker_actions_job ON locker_actions(job_id);
  `,
]

export type Row = Record<string, unknown>

export class Db {
  readonly raw: DatabaseSync
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.raw = new DatabaseSync(file)
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }
  private migrate() {
    const v = Number((this.raw.prepare('PRAGMA user_version').get() as Row).user_version)
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i])
        this.raw.exec(`PRAGMA user_version = ${i + 1}`)
      })
    }
  }
  run(sql: string, ...params: unknown[]) {
    return this.raw.prepare(sql).run(...(params as never[]))
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined
  }
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[]
  }
  /** Synchronous transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.depth++
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    } finally {
      this.depth--
    }
  }
  private depth = 0
  /** Drop every row (demo reset); the schema stays. */
  wipe() {
    const tables = this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    this.tx(() => {
      for (const t of tables) this.raw.exec(`DELETE FROM "${t.name}"`)
    })
  }
  kvGet(key: string): string | null {
    return (this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value as string) ?? null
  }
  kvSet(key: string, value: string) {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }
  close() {
    this.raw.close()
  }
}

export const json = <T>(s: unknown): T => JSON.parse(String(s)) as T
