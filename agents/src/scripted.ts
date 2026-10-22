// The ORANO directory job as a deterministic script (no LLM): the reliable demo fallback and the test reference.
// It reads get_job's next_actions and state as the authority, and only spends through fund_job inside the mandate.
//   npm run orano:scripted -w agents -- [--url http://localhost:8790] [--quantity 40] [--budget 70.00] [--timeout-min 30]
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { loadBuyerKey, loadEnv, rentabotUrl } from './env.ts'
import { loadOranoFacts, type OranoFacts } from './facts.ts'
import { callTool, clip, compactArgs, connectBuyer, formatEntry, type Json, type ToolOutcome, type TranscriptEntry } from './mcp.ts'

export const DEFAULT_GOAL = 'Get ORANO listed on 40 AI and productivity directories for under $70 before launch.'
export const CONTACT_EMAIL = 'hello@oranoai.com'
export const FORWARD_SECRET = `forward:${CONTACT_EMAIL}`

export const cents = (v: string) => Math.round(Number(v) * 100)
const usd = (c: number) => (c / 100).toFixed(2)

/** A fact for one input field of the seller's requirements, or undefined when the facts do not cover it. */
export function factFor(key: string, f: OranoFacts): string | undefined {
  const k = key.toLowerCase()
  if (k.includes('email')) return CONTACT_EMAIL
  if (/logo|image|icon|screenshot|founder|phone|address/.test(k)) return undefined
  if (k.includes('tagline') || k === 'summary' || k.includes('short_description')) return f.tagline_60
  if (k.includes('description')) return f.description_300
  if (k.includes('category')) return f.category
  if (k === 'url' || /(^|_)(url|website|homepage|link)$/.test(k)) return f.url
  if (k === 'name' || k === 'product' || k === 'title' || k.includes('product_name')) return f.name
  if (k.includes('platform')) return 'iOS, Android'
  return undefined
}

/** A factual answer to a seller question. Never personal data: the facts block is the whole truth we offer. */
export function answerQuestion(text: string, f: OranoFacts): string {
  const t = text.toLowerCase()
  if (/founder|person|your name|maker|team|owner/.test(t)) return `Please list the product only (${f.name}); no personal names on listings.`
  if (/e-?mail/.test(t)) return CONTACT_EMAIL
  if (/categor/.test(t)) return f.category
  if (/tagline|short description/.test(t)) return f.tagline_60
  if (/description/.test(t)) return f.description_300
  if (/paid|price|fee|budget/.test(t)) return 'Free directories only; no paid placements.'
  if (/url|website|link/.test(t)) return f.url
  return `Please use only the facts in the job context (${f.name}, ${f.url}, ${CONTACT_EMAIL}). Leave out anything not covered there.`
}

/** A required access request we may answer: read-only inbox verification, answered with a forwarding address. */
export const shareableAccess = (a: Json) => a?.kind === 'inbox_verification' && /read[\s-]?only/i.test(String(a?.scope ?? ''))

export interface ScriptedOptions {
  url: string
  key: string
  goal?: string
  quantity?: number
  /** Hard cap on the quote total, e.g. "70.00". */
  budgetCap?: string
  log?: (line: string) => void
  /** Accept when (passed + pending) / expected reaches this; otherwise reject once for a cure. Default 0.9. */
  acceptFraction?: number
  /** wait_for_events long-poll length. */
  waitSeconds?: number
  /** Give up waiting (status 'waiting') after this long. Default 30 minutes. */
  timeoutMs?: number
  facts?: OranoFacts
  client?: Client
}

export interface ScriptedReport {
  status: 'done' | 'needs_human' | 'waiting' | 'declined' | 'blocked' | 'disputed'
  job_id: string | null
  state: string | null
  expected: number
  passed: number
  failed: number
  pending: number
  /** What passing units are worth under the quote. */
  earned: string
  /** Captured from escrow so far. */
  spent: string
  approvalUrl?: string
  notes: string[]
  transcript: TranscriptEntry[]
}

class Stop extends Error {}

export async function runScriptedBuyer(opts: ScriptedOptions): Promise<ScriptedReport> {
  const facts = opts.facts ?? loadOranoFacts()
  if (facts.contact_email !== CONTACT_EMAIL) throw new Error(`Facts contact_email must be ${CONTACT_EMAIL}.`)
  const goal = opts.goal ?? DEFAULT_GOAL
  const quantity = opts.quantity ?? 40
  const cap = opts.budgetCap ?? '70.00'
  const acceptFraction = opts.acceptFraction ?? 0.9
  const waitSeconds = opts.waitSeconds ?? 25
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000)
  const log = opts.log ?? ((l: string) => console.log(l))
  const client = opts.client ?? (await connectBuyer(opts.url, opts.key))
  const transcript: TranscriptEntry[] = []
  const notes: string[] = []
  const note = (s: string) => {
    notes.push(s)
    log(`     note: ${s}`)
  }

  const step = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    const out = await callTool(client, name, args, (waitSeconds + 30) * 1000)
    const e: TranscriptEntry = { step: transcript.length + 1, tool: name, args: compactArgs(name, args), ok: out.ok, summary: out.summary }
    transcript.push(e)
    log(formatEntry(e))
    return out
  }
  const must = async (name: string, args: Record<string, unknown>): Promise<Json> => {
    const out = await step(name, args)
    if (!out.ok) throw new Stop(`${name} failed: ${out.summary}`)
    return out.data
  }

  let job: Json = null
  const report = (status: ScriptedReport['status'], extra: Partial<ScriptedReport> = {}): ScriptedReport => {
    const f: Json[] = job?.fulfilment ?? []
    const sum = (k: string) => f.reduce((n, x) => n + (x[k] ?? 0), 0)
    return {
      status,
      job_id: job?.id ?? null,
      state: job?.state ?? null,
      expected: sum('expected_units'),
      passed: sum('passed_units'),
      failed: sum('failed_units'),
      pending: sum('pending_units'),
      earned: usd(f.reduce((n, x) => n + cents(x.earned?.value ?? '0'), 0)),
      spent: job?.escrow?.captured?.value ?? '0.00',
      notes,
      transcript,
      ...extra,
    }
  }

  try {
    // 1. Who am I, and what may I spend?
    const me = await must('whoami', {})
    const m = me.mandate
    if (!m || m.status !== 'active') note('No active mandate: funding will need a human to approve on PayPal.')
    else if (cents(m.per_job_cap.value) < cents(cap)) note(`Mandate per-job cap is $${m.per_job_cap.value}, below the $${cap} budget; a larger quote would need approval.`)

    // 2. Find the directory bot and its skill.
    const found = (await must('search_bots', { query: 'directory' })).bots as Json[]
    const hasSkill = (b: Json) => b.skills?.some((s: Json) => s.id === 'directory_submission')
    const pick = found.find((b) => hasSkill(b) && /directory\s*blaster/i.test(b.name)) ?? found.find(hasSkill)
    if (!pick) throw new Stop('No listed bot offers the directory_submission skill.')
    const bot = (await must('get_bot', { bot_id: pick.id })).bot

    // 3. Spec, checked against the budget before anything is sent.
    const draft = await must('draft_job_spec', { bot_id: bot.id, skill_id: 'directory_submission', goal, quantity, budget_cap: cap, context: facts.text })
    const spec = draft.spec
    if (cents(draft.estimate.value) > cents(cap)) throw new Stop(`Estimate $${draft.estimate.value} is over the $${cap} cap; not creating the job.`)
    for (const w of draft.warnings ?? []) note(`spec warning: ${clip(String(w), 200)}`)

    // 4. Open the job.
    const created = await must('create_job', { bot_id: bot.id, spec, title: `ORANO directory launch (${quantity} listings)`, idempotency_key: `orano-dir-${randomUUID()}` })
    job = created.job
    const jobId: string = job.id

    let cursor = 0
    const shared = new Set<string>()
    const notedGaps = new Set<string>()
    let rejected = false
    let accepted = false
    const wait = async () => {
      if (Date.now() > deadline) throw new Stop('timeout')
      const r = await must('wait_for_events', { job_id: jobId, after_cursor: cursor, timeout_seconds: waitSeconds })
      cursor = Math.max(cursor, r.cursor ?? cursor)
    }

    // 5. The loop: re-read the job, do the one right thing, or wait.
    for (;;) {
      const r = await must('get_job', { job_id: jobId })
      job = r.job
      const c = job.contract
      switch (job.state as string) {
        case 'NEGOTIATING': {
          if (!c?.quote || !c?.requirements) {
            await wait()
            break
          }
          const total = c.quote.total_max.value
          const d0 = spec.deliverables[0]
          const line = c.quote.lines.find((l: Json) => l.deliverable_id === d0.id)
          if (cents(total) > cents(cap)) {
            await must('decline_job', { job_id: jobId, reason: `The quote total $${total} is over our budget cap of $${cap}.` })
            return report('declined', { state: 'CANCELLED' })
          }
          if (!line || line.quantity !== d0.quantity || c.spec.skill_id !== spec.skill_id) {
            await must('decline_job', { job_id: jobId, reason: `The quote does not match our spec (${d0.quantity} units of ${spec.skill_id}).` })
            return report('declined', { state: 'CANCELLED' })
          }
          // Inputs and answers from the facts only.
          const schema = c.requirements.inputs_schema ?? {}
          const required: string[] = schema.required ?? []
          const inputs: Record<string, string> = {}
          for (const k of new Set([...Object.keys(schema.properties ?? {}), ...required])) {
            if (k in (c.inputs ?? {})) continue
            const v = factFor(k, facts)
            if (v !== undefined) inputs[k] = v
            else if (required.includes(k) && !notedGaps.has(k)) {
              notedGaps.add(k)
              note(`Required input "${k}" is not covered by the ORANO facts; left empty.`)
            }
          }
          const answers: Record<string, string> = {}
          for (const q of c.requirements.questions ?? []) if (!(q.id in (c.answers ?? {}))) answers[q.id] = answerQuestion(String(q.text), facts)
          if (Object.keys(inputs).length || Object.keys(answers).length) {
            await must('provide_inputs', { job_id: jobId, inputs, answers })
            break
          }
          // Access: only a read-only inbox verification, answered with a forwarding address. Never a password.
          let blocked = ''
          for (const a of c.requirements.access ?? []) {
            if (!a.required || shared.has(a.id)) continue
            if (!shareableAccess(a)) {
              blocked = `${a.id} (${a.kind}, scope "${a.scope}")`
              break
            }
            await must('share_secret', { job_id: jobId, access_id: a.id, label: 'Verification inbox (forward only)', value: FORWARD_SECRET })
            shared.add(a.id)
          }
          if (blocked) {
            await must('decline_job', { job_id: jobId, reason: `We do not share this access: ${blocked}. Only read-only inbox verification by forwarding.` })
            return report('declined', { state: 'CANCELLED' })
          }
          // Sign the CURRENT hash; a stale_contract error just means re-read and try again.
          if (!job.accepted_by.some((a: Json) => a.role === 'buyer' && a.contract_hash === job.contract_hash)) {
            const out = await step('accept_contract', { job_id: jobId, contract_hash: job.contract_hash })
            if (!out.ok && out.data?.error?.code !== 'stale_contract') throw new Stop(`accept_contract failed: ${out.summary}`)
            break
          }
          await wait()
          break
        }
        case 'AGREED': {
          if (cents(c.quote.total_max.value) > cents(cap)) throw new Stop(`Agreed total $${c.quote.total_max.value} is over the $${cap} cap; not funding.`)
          const out = await must('fund_job', { job_id: jobId, idempotency_key: `fund-${jobId}-v${c.version}` })
          job = out.job
          if (out.approval_url || job.state === 'AWAITING_APPROVAL') return report('needs_human', { approvalUrl: out.approval_url ?? job.escrow?.approval_url ?? undefined })
          break
        }
        case 'AWAITING_APPROVAL':
          return report('needs_human', { approvalUrl: job.escrow?.approval_url ?? undefined })
        case 'IN_PROGRESS':
        case 'BLOCKED':
        case 'CURE':
          await wait()
          break
        case 'DELIVERED': {
          if (accepted) return report('done', { notes: [...notes, 'Accepted; units still pending settle when their delayed checks finish.'] })
          const rc = await must('run_checks', { job_id: jobId })
          const ful: Json[] = rc.fulfilment ?? []
          const expected = ful.reduce((n, f) => n + f.expected_units, 0)
          const okUnits = ful.reduce((n, f) => n + f.passed_units + f.pending_units, 0)
          const ratio = expected ? okUnits / expected : 0
          if (ratio >= acceptFraction || rejected) {
            if (ratio < acceptFraction) note(`After the cure round ${okUnits}/${expected} units pass; accepting pays only those.`)
            await must('review_delivery', { job_id: jobId, decision: 'accept' })
            accepted = true
          } else {
            const rejections = rejectionsFrom(rc.checks ?? [], ful)
            note(`${okUnits}/${expected} units pass (< ${Math.round(acceptFraction * 100)}%): rejecting ${rejections.length} specific item(s) for one cure round.`)
            await must('review_delivery', { job_id: jobId, decision: 'reject', rejections })
            rejected = true
          }
          break
        }
        case 'SETTLED':
          return report('done')
        case 'CANCELLED':
        case 'EXPIRED':
          return report('declined')
        default:
          return report('disputed')
      }
    }
  } catch (err) {
    if (err instanceof Stop && err.message === 'timeout') {
      // Only a cure window that ended with no redelivery justifies a dispute.
      const cureUntil = job?.deadlines?.cure_until ? Date.parse(job.deadlines.cure_until) : NaN
      if (job?.state === 'CURE' && cureUntil < Date.now()) {
        const out = await step('open_dispute', {
          job_id: job.id,
          reason: 'The seller redelivered nothing before the cure window ended after our specific rejection.',
          claims: ['No redelivery during the cure window for the rejected units.'],
        })
        if (out.ok) job = out.data.job
        return report('disputed')
      }
      return report('waiting', { notes: [...notes, `Stopped waiting in state ${job?.state ?? "unknown"}; the job stays open on the server (follow it with get_job or the web app).`] })
    }
    if (err instanceof Stop) {
      note(err.message)
      return report('blocked')
    }
    throw err
  } finally {
    if (!opts.client) await client.close().catch(() => {})
  }
}

/** Specific rejections: one per failing unit (its checks and details), plus any units never delivered. */
export interface Rejection {
  deliverable_id: string
  unit_refs: string[]
  check?: string
  reason: string
}

export function rejectionsFrom(checks: Json[], fulfilment: Json[]): Rejection[] {
  const byUnit = new Map<string, Json[]>()
  for (const c of checks) {
    if (c.status !== 'fail' && c.status !== 'error') continue
    const k = `${c.deliverable_id}\u0000${c.unit_ref ?? ''}`
    byUnit.set(k, [...(byUnit.get(k) ?? []), c])
  }
  const out: Rejection[] = [...byUnit.entries()].slice(0, 100).map(([k, cs]) => {
    const [deliverable_id, ref] = k.split('\u0000') as [string, string]
    return {
      deliverable_id,
      unit_refs: ref ? [ref] : [],
      check: cs[0].check as string,
      reason: clip(`${ref || 'Deliverable'} failed ${cs.map((c) => `${c.check} (${c.detail || c.status})`).join(', ')}. Please fix or replace this listing.`, 1000),
    }
  })
  for (const f of fulfilment) {
    const seen = new Set(checks.filter((c) => c.deliverable_id === f.deliverable_id).map((c) => c.unit_ref))
    const missing = f.expected_units - seen.size
    if (missing > 0) out.push({ deliverable_id: f.deliverable_id, unit_refs: [], reason: `Only ${seen.size} of ${f.expected_units} units were delivered; ${missing} are missing.` })
  }
  return out
}

export function printReport(r: ScriptedReport, log: (l: string) => void = console.log) {
  log('\n=== ORANO directory job (scripted) ===')
  log(`status ${r.status}   job ${r.job_id ?? '-'}   state ${r.state ?? '-'}`)
  log(`units: ${r.passed} passed, ${r.failed} failed, ${r.pending} pending of ${r.expected} expected`)
  log(`earned by the seller under the quote: $${r.earned}   captured from escrow: $${r.spent}`)
  if (r.approvalUrl) log(`\nHUMAN APPROVAL NEEDED: open ${r.approvalUrl}`)
  for (const n of r.notes) log(`- ${n}`)
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const env = loadEnv()
  try {
    const r = await runScriptedBuyer({ url: flag('--url') ?? rentabotUrl(env), key: loadBuyerKey(env), quantity: flag('--quantity') ? Number(flag('--quantity')) : undefined, budgetCap: flag('--budget'), timeoutMs: flag('--timeout-min') ? Number(flag('--timeout-min')) * 60_000 : undefined })
    printReport(r)
    process.exitCode = r.status === 'done' ? 0 : r.status === 'needs_human' ? 2 : 1
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
