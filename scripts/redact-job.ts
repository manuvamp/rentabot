// Remove personal data from one job after the fact: the named email addresses, and the pages that carried them (a staff page's
// URL can name its owner), from the job record, its Job Room messages and its check evidence. Nothing is deleted: each unit,
// message and evidence record keeps its place. A changed message is marked `redacted` (shown on the message; the chain check
// then verifies its link but not its content, see server/src/core/room.ts), so the removal is visible, never silent.
//
//   npx tsx scripts/redact-job.ts --job <job_id> --addresses <file: one address per line> --reason "<one sentence>" [--db <file>] [--dry-run]
//
// The addresses come from a file so they never sit in shell history or the process list. Run it where the database is (on the VM:
// --db /var/lib/rentabot/rentabot.db as the service user). It prints counts only, never an address.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Message } from '@rentabot/shared'
import { chainValid } from '../server/src/core/room.ts'

const { values: arg } = parseArgs({
  options: { job: { type: 'string' }, addresses: { type: 'string' }, reason: { type: 'string' }, db: { type: 'string', default: 'data/rentabot.db' }, 'dry-run': { type: 'boolean', default: false } },
})
if (!arg.job || !arg.addresses || !arg.reason) throw new Error('usage: --job <job_id> --addresses <file> --reason "<sentence>" [--db <file>] [--dry-run]')
const JOB = arg.job
const REASON = arg.reason.slice(0, 300)
const REMOVED = '[removed for privacy]'
const now = new Date().toISOString()

const addresses = new Set(readFileSync(arg.addresses, 'utf8').split(/\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@')))
if (!addresses.size) throw new Error('no addresses in the file')
const db = new DatabaseSync(arg.db)
db.exec('PRAGMA busy_timeout = 5000') // the server may be writing at the same moment
const row = db.prepare('SELECT data FROM jobs WHERE id = ?').get(JOB) as { data: string } | undefined
if (!row) throw new Error(`no job ${JOB}`)

type Obj = Record<string, unknown>
const isObj = (o: unknown): o is Obj => !!o && typeof o === 'object' && !Array.isArray(o)
const lower = (v: unknown) => String(v ?? '').toLowerCase()

// 1) The pages that carried a removed address: from every delivered unit and every evidence record, before anything changes.
const pages = new Set<string>()
const addPage = (u: unknown) => {
  if (typeof u === 'string' && /^https?:\/\//i.test(u)) pages.add(u)
}
const collect = (o: unknown): void => {
  if (Array.isArray(o)) return o.forEach(collect)
  if (!isObj(o)) return
  if (Array.isArray(o.units)) for (const u of o.units) if (isObj(u) && isObj(u.meta) && addresses.has(lower(u.meta.to))) (addPage(u.url), addPage(u.meta.email_source_url))
  Object.values(o).forEach(collect)
}
const jobData = JSON.parse(row.data) as unknown
collect(jobData)
const messages = (db.prepare('SELECT id, data FROM messages WHERE job_id = ? ORDER BY seq').all(JOB) as { id: string; data: string }[]).map((r) => ({ id: r.id, m: JSON.parse(r.data) as Message }))
messages.forEach((x) => collect(x.m))
const evidence = db.prepare('SELECT id, summary, payload FROM evidence WHERE job_id = ?').all(JOB) as { id: string; summary: string; payload: string }[]
const evHit = evidence.filter((e) => addresses.has(lower((JSON.parse(e.payload) as Obj).to)))
for (const e of evHit) {
  const p = JSON.parse(e.payload) as Obj
  addPage(p.email_source_url)
  if (isObj(p.page)) {
    addPage(p.page.final_url)
    for (const h of Array.isArray(p.page.hops) ? p.page.hops : []) if (isObj(h)) (addPage(h.url), addPage(h.location))
  }
}

// 2) Scrub: a removed unit keeps its ref and company but loses the address, the page and the person's details.
const scrubText = (s: string): string => {
  let out = s
  for (const p of [...pages].sort((a, b) => b.length - a.length)) out = out.split(p).join(REMOVED)
  for (const a of addresses) out = out.replace(new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), REMOVED)
  return out
}
const scrub = (o: unknown): unknown => {
  if (typeof o === 'string') return scrubText(o)
  if (Array.isArray(o)) return o.map(scrub)
  if (!isObj(o)) return o
  if (Array.isArray(o.units)) {
    o = {
      ...o,
      units: o.units.map((u) => {
        if (!isObj(u) || !isObj(u.meta) || !addresses.has(lower(u.meta.to))) return u
        const { url: _url, ...rest } = u
        return { ...rest, meta: { company: u.meta.company, domain: u.meta.domain, to: REMOVED, removed: { at: now, reason: REASON } } }
      }),
    }
  }
  return Object.fromEntries(Object.entries(o as Obj).map(([k, v]) => [k, scrub(v)]))
}
const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)

const newJob = scrub(jobData)
const newMessages = messages.map((x) => {
  const m = scrub(x.m) as Message
  return { id: x.id, changed: changed(x.m, m), m: changed(x.m, m) ? { ...m, redacted: { at: now, reason: REASON } } : x.m }
})
const newEvidence = evHit.map((e) => {
  const p = JSON.parse(e.payload) as Obj
  const page = isObj(p.page) ? { known: p.page.known, found: p.page.found, status: p.page.status, how: p.page.how } : p.page
  return { id: e.id, summary: scrubText(e.summary), payload: JSON.stringify({ ...(scrub({ ...p, page }) as Obj), to: REMOVED, email_source_url: REMOVED, removed: { at: now, reason: REASON } }) }
})

const units = (o: unknown): Obj[] => (isObj(o) && isObj(o.delivery) && Array.isArray(o.delivery.deliverables) ? o.delivery.deliverables.flatMap((d) => (isObj(d) && Array.isArray(d.units) ? (d.units as Obj[]) : [])) : [])
const removedUnits = units(newJob).filter((u) => isObj(u.meta) && u.meta.to === REMOVED).length
console.log(`job ${JOB}: ${addresses.size} addresses, ${pages.size} pages; units removed ${removedUnits} of ${units(newJob).length}; messages changed ${newMessages.filter((x) => x.changed).length}; evidence changed ${newEvidence.length}`)
if (!chainValid(newMessages.map((x) => x.m))) throw new Error('the chain would not verify after the change: nothing written')

// 3) Write, then prove nothing is left anywhere in the database.
if (arg['dry-run']) {
  console.log('dry run: nothing written')
} else {
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE jobs SET data = ? WHERE id = ?').run(JSON.stringify(newJob), JOB)
    for (const x of newMessages) if (x.changed) db.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify(x.m), x.id)
    for (const e of newEvidence) db.prepare('UPDATE evidence SET summary = ?, payload = ? WHERE id = ?').run(e.summary, e.payload, e.id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  console.log('written')
}
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
let left = 0
for (const t of tables) {
  const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string }[]).filter((c) => /TEXT/i.test(c.type)).map((c) => c.name)
  for (const c of cols) for (const needle of [...addresses, ...pages]) left += Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE instr(lower(${c}), ?) > 0`).get(needle.toLowerCase()) as { n: number }).n)
}
console.log(`left in the database: ${left} occurrence(s)${arg['dry-run'] ? ' (before the change)' : ''}`)
if (!arg['dry-run'] && left) process.exitCode = 1
