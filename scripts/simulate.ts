// Rent-A-Bot simulation harness (docs/TEST_PLAN.md section 2).
//   npx tsx scripts/simulate.ts [--jobs N] [--seed S] [--concurrency C] [--house-bots] [--time-scale X] [--keep]
//                               [--only <scenario>] [--report <file>]   (--only open_job_competition runs just the open-job scenario)
// Boots its own server (simulated rail, AI off, fast demo clock, fresh DATA_DIR in %TEMP%\agent-scratch\rentabot-sim),
// drives many seeded jobs through MCP and REST, checks the money and state invariants after every event and at
// the end, writes docs/SIMULATION_REPORT.md, then kills the server and deletes the scratch directory.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { http, sleep, Stats, type Json } from './sim/client.ts'
import { JobDriver, makePlan, WEIGHTS, type Scenario } from './sim/driver.ts'
import { c, usd } from './sim/fees.ts'
import { Invariants, TERMINAL, type JobTrack, type OpenTrack } from './sim/invariants.ts'
import { houseOpenProbes, OpenJobDriver } from './sim/openjobs.ts'
import { jobRng, Rng } from './sim/rng.ts'
import { bootServer, redact, removeScratch, ROOT } from './sim/server.ts'
import { buildWorld, SKILLS, type World } from './sim/world.ts'

const argv = process.argv.slice(2)
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const JOBS = Number(flag('--jobs', '60'))
const SEED = Number(flag('--seed', '42'))
const CONC = Number(flag('--concurrency', '10'))
const HOUSE = argv.includes('--house-bots')
const SCALE = Number(flag('--time-scale', '3600'))
const KEEP = argv.includes('--keep')
/** Debugging aid: run only this scenario (the report is still written). */
const ONLY = flag('--only', '')
const JOB_TIMEOUT = Number(flag('--job-timeout-s', '420')) * 1000
/** Where the report section is written (default: docs/SIMULATION_REPORT.md). */
const REPORT = flag('--report', join(ROOT, 'docs', 'SIMULATION_REPORT.md'))!
const MODE = HOUSE ? 'house-bots' : 'default'

const run = `${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`
const say = (s: string) => console.log(`[sim ${new Date().toISOString().slice(11, 19)}] ${s}`)

async function main() {
  say(`mode ${MODE}, ${JOBS} jobs, seed ${SEED}, concurrency ${CONC}, time scale ${SCALE}`)
  const srv = await bootServer({ run, timeScale: SCALE, houseBots: HOUSE })
  say(`server up on ${srv.base}`)
  const stats = new Stats()
  const inv = new Invariants()
  const t0 = Date.now()
  let tracks: JobTrack[] = []
  let opens: OpenTrack[] = []
  let houseNotes: string[] = []
  let world: World | null = null
  let ledger: Json = null
  let publicStats: Json = null
  const probes: string[] = []
  try {
    const rng = new Rng(SEED)
    world = await buildWorld(srv.base, stats, rng, { buyers: HOUSE ? 12 : 36, sellers: HOUSE ? 0 : 8, houseBots: HOUSE })
    if (HOUSE) {
      // Give the house bots a moment to connect.
      await sleep(3000)
      world.houseBots = world.houseBots.filter((b) => b.skills?.length)
      say(`house bots: ${world.houseBots.map((b) => b.name).join(', ')}`)
      if (!world.houseBots.length) throw new Error('no house bots listed')
    }
    say(`world: ${world.buyers.length} buyers, ${world.sellers.length} sellers`)
    if (!HOUSE) probes.push(...(await mandateRace(world, inv)))

    // Plans
    const mandateBuyers = world.buyers.filter((b) => b.mandate)
    const approvalBuyers = world.buyers.filter((b) => b.claimed && !b.mandate)
    const unclaimed = world.buyers.filter((b) => !b.claimed)
    const houseScenarios: Partial<Record<Scenario, number>> = { clean: 6, dispute_buyer: 4, reject_cure_fix: 2, silent_autorelease: 1, approval_link: 1, decline_before_funding: 1, open_job_competition: 3 }
    const drivers: (JobDriver | OpenJobDriver)[] = []
    let openN = 0
    for (let i = 0; i < JOBS; i++) {
      const r = jobRng(SEED, i)
      const scenario = r.weighted((ONLY ? { [ONLY]: 1 } : HOUSE ? houseScenarios : WEIGHTS) as Record<Scenario, number>)
      const plan = makePlan(r, scenario)
      const buyer = scenario === 'unclaimed_buyer' ? r.pick(unclaimed) : scenario.startsWith('approval') ? r.pick(approvalBuyers) : r.pick(mandateBuyers)
      if (scenario === 'open_job_competition') {
        // The bots that bid are the scripted bidders; the awarded job then continues as an ordinary job with the winner.
        drivers.push(new OpenJobDriver(world, inv, r, plan, buyer, i, { scale: SCALE, timeoutMs: JOB_TIMEOUT }, openN++))
        continue
      }
      const seller = HOUSE ? null : r.pick(world.sellers)
      const hb = HOUSE ? world.houseBots[i % world.houseBots.length] : null
      drivers.push(new JobDriver(world, inv, r, plan, buyer, seller, i, hb, JOB_TIMEOUT))
    }
    // House-bots mode: do the house bots bid on open jobs for their skills? (Runs alongside the jobs; reported under Probes.)
    const houseProbe = HOUSE ? houseOpenProbes(world, inv, { scale: SCALE, timeoutMs: JOB_TIMEOUT }, say) : null

    // Run with a concurrency pool.
    let next = 0
    let finished = 0
    const worker = async () => {
      while (next < drivers.length) {
        const d = drivers[next++]!
        const t = await d.run()
        finished++
        if (finished % 10 === 0 || finished === drivers.length) say(`${finished}/${drivers.length} jobs done (violations so far: ${inv.violations.length})`)
        void t
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, drivers.length) }, worker))
    tracks = drivers.map((d) => d.t).filter((t) => t.id)
    opens = drivers.flatMap((d) => (d instanceof OpenJobDriver ? [d.o] : []))
    if (houseProbe) {
      const hp = await houseProbe
      houseNotes = hp.notes
      opens.push(...hp.opens)
    }

    // Final, global checks.
    const L = await world.arbiter.call('get_platform_ledger', { limit: 500 })
    if (!L.ok) inv.add(7, null, `arbiter could not read the platform ledger: ${L.code}`)
    ledger = L.data
    const lines = new Map<string, Json>((ledger?.jobs ?? []).map((l: Json) => [l.job_id, l]))
    for (const t of tracks) inv.finalMoney(t, lines.get(t.id))
    if (ledger) {
      const moved = tracks.filter((t) => t.last && c(t.last.escrow.captured) > 0)
      const sumC = moved.reduce((s, t) => s + c(t.last!.escrow.captured), 0)
      const extra = c(ledger.totals.captured) - sumC
      // Only this run's jobs are on this server (plus the mandate-race probe jobs, which capture nothing).
      if (extra !== 0) inv.add(2, null, `ledger total captured $${ledger.totals.captured} ≠ sum over jobs $${usd(sumC)}`)
      const sumLines = (k: string) => (ledger.jobs as Json[]).reduce((s, l) => s + c(l[k]), 0)
      for (const k of ['commission', 'mediation_fees', 'refund_fees_kept', 'paypal_capture_fees', 'paypal_payout_fees']) if (sumLines(k) !== c(ledger.totals[k])) inv.add(2, null, `ledger totals.${k} $${ledger.totals[k]} ≠ sum of lines $${usd(sumLines(k))}`)
    }
    // Every job must end terminal (timers or the parties' own actions); anything else is stuck or a harness timeout.
    for (const t of tracks) {
      const st = t.last?.job?.state
      if (st && !TERMINAL.includes(st)) {
        if (t.harnessTimeout) t.notes.push(`harness gave up in ${st}`)
        inv.add(5, t, `job ended the run in non-terminal state ${st}${t.harnessTimeout ? ' (driver timed out waiting)' : ''}`)
      }
    }
    // Open jobs: one award per open job, no second job from any of them.
    await inv.finalOpenJobs(opens, tracks, world.buyers)
    const ps = await http(srv.base, 'GET', '/api/public/stats')
    publicStats = ps.json
    const heldNow = c(publicStats?.held_now)
    const heldTracked = tracks.reduce((s, t) => s + heldOf(t), 0)
    if (heldNow !== heldTracked) inv.add(1, null, `public stats held_now $${usd(heldNow)} ≠ sum of held over jobs $${usd(heldTracked)}`)
    for (const s of stats.schema) inv.add(7, null, `${s.surface} ${s.op}: output does not match its schema: ${s.issues}`)
    for (const s of stats.errorShape) inv.add(7, null, `${s.surface} ${s.op}: error without code/message/hint: ${s.body}`)
    for (const f of srv.logFindings()) if (f.kind === 'output_schema_mismatch') inv.add(7, null, `server log: ${f.line}`)
    else if (f.kind === 'illegal_transition') inv.add(5, null, `server log: ${f.line}`)
  } finally {
    const logFindings = srv.logFindings()
    await Promise.all([world?.owner, world?.arbiter, ...(world?.buyers ?? []).map((b) => b.api), ...(world?.sellers ?? []).map((s) => s.api), ...(world?.bidders ?? []).map((s) => s.api)].filter(Boolean).map((a) => a!.close()))
    await srv.stop()
    say(`server stopped${KEEP ? `; scratch kept at ${srv.scratch}` : ''}`)
    const report = renderReport({ tracks, opens, houseNotes, inv, stats, ledger, publicStats, logFindings, probes, secs: (Date.now() - t0) / 1000 })
    writeReport(report)
    if (!KEEP) removeScratch(run)
    say(`report written: ${REPORT} (${MODE} section)`)
    say(`RESULT: ${inv.violations.length === 0 ? 'PASS' : 'FAIL'}: ${inv.violations.length} invariant violation(s), ${tracks.length} jobs (+ ${opens.length} open jobs, ${opens.filter((o) => o.last?.open_job?.state === 'awarded').length} awarded), ${inv.checks} job checks`)
    for (const v of inv.violations.slice(0, 30)) say(`  [inv ${v.inv}] ${v.job ?? '-'} (${v.scenario}): ${v.what}`)
  }
}

function heldOf(t: JobTrack): number {
  const e = t.last?.escrow
  if (!e || e.status === 'none' || e.status === 'pending_approval' || ['settled', 'voided', 'refunded'].includes(e.status)) return 0
  return e.mode === 'hold' ? Math.max(0, c(e.authorized) - c(e.captured) - c(e.voided)) : 0
}

/** Concurrent fund_job calls by one buyer on several jobs: the monthly cap must hold across them. */
async function mandateRace(w: World, inv: Invariants): Promise<string[]> {
  const out: string[] = []
  const buyer = w.buyers.find((b) => b.mandate && b.mandate.monthly < 4 * b.mandate.per_job) ?? w.buyers.find((b) => b.mandate)!
  const seller = w.sellers[0]!
  const m = buyer.mandate!
  // Jobs priced just under the per-job cap, so the monthly cap is the binding limit.
  const n = Math.min(6, Math.floor(m.monthly / Math.min(m.per_job, m.monthly)) + 2)
  const price = Math.min(m.per_job, m.monthly)
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const spec = {
      skill_id: SKILLS.audit.id,
      goal: `Mandate race probe ${i}: concurrent funding`,
      deliverables: [{ id: 'D1', description: 'One HTTP audit unit', quantity: 1, acceptance: [{ check: 'http_claim_holds', params: {} }], rubric: '' }],
      deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      budget_cap: { value: '500.00', currency: 'USD' },
      out_of_scope: [],
      context: '',
      context_artifact_ids: [],
    }
    const cj = await buyer.api.call('create_job', { bot_id: seller.bot_id, spec })
    if (!cj.ok) continue
    const id = cj.data.job.id
    await seller.api.call('submit_requirements', { job_id: id, requirements: { inputs_schema: { type: 'object', properties: {} }, access: [], assumptions: [], questions: [] } })
    const q = await seller.api.call('send_quote', { job_id: id, quote: { lines: [{ deliverable_id: 'D1', model: 'fixed', unit_price: usd(price), quantity: 1, max_total: usd(price) }], total_max: { value: usd(price), currency: 'USD' }, turnaround: 'P7D', excludes: [], valid_until: new Date(Date.now() + 86_400_000).toISOString() } })
    const hash = q.data?.job?.contract_hash
    await seller.api.call('accept_contract', { job_id: id, contract_hash: hash })
    const a = await buyer.api.call('accept_contract', { job_id: id, contract_hash: hash })
    if (a.ok && a.data.job.state === 'AGREED') ids.push(id)
  }
  const before = c((await buyer.api.call('get_mandate', {})).data?.mandate?.spent_this_month?.value)
  const rs = await Promise.all(ids.map((id) => buyer.api.call('fund_job', { job_id: id, idempotency_key: `race-${id}` })))
  let viaMandate = 0
  for (const id of ids) {
    const e = (await buyer.api.call('get_escrow', { job_id: id })).data?.escrow
    if (e && c(e.authorized) > 0 && e.events.some((x: Json) => x.kind === 'order_created' && /paid with the spending mandate/.test(x.note))) viaMandate += c(e.authorized)
  }
  const after = c((await buyer.api.call('get_mandate', {})).data?.mandate?.spent_this_month?.value)
  out.push(`Mandate race: ${ids.length} jobs of $${usd(price)} funded concurrently by one buyer (per-job cap $${usd(m.per_job)}, monthly cap $${usd(m.monthly)}, already spent $${usd(before)}): $${usd(viaMandate)} authorized through the mandate, spent_this_month now $${usd(after)}; results ${rs.map((r) => (r.ok ? r.data.job.state : r.code)).join(', ')}.`)
  if (before + viaMandate > m.monthly) inv.add(4, null, `monthly mandate cap $${usd(m.monthly)} exceeded by concurrent funding: $${usd(before)} already spent + $${usd(viaMandate)} authorized via the mandate in ${ids.length} concurrent fund_job calls (repro: one buyer, ${ids.length} AGREED jobs at $${usd(price)}, Promise.all(fund_job))`)
  // Clean up: the seller walks away from funded ones, the buyer from the rest (void, nothing captured).
  for (const id of ids) {
    const j = (await buyer.api.call('get_job', { job_id: id })).data?.job
    if (!j) continue
    if (j.state === 'AWAITING_APPROVAL' || j.state === 'AGREED') await buyer.api.call('decline_job', { job_id: id, reason: 'probe cleanup' })
    else if (!TERMINAL.includes(j.state)) await seller.api.call('decline_job', { job_id: id, reason: 'probe cleanup' })
    const e = (await buyer.api.call('get_escrow', { job_id: id })).data?.escrow
    if (e && c(e.captured) !== 0) inv.add(1, null, `mandate race probe job ${id} captured $${usd(c(e.captured))} after cancel`)
    if (e && e.mode === 'hold' && c(e.authorized) !== c(e.voided)) inv.add(1, null, `mandate race probe job ${id}: authorized ${usd(c(e.authorized))} but voided ${usd(c(e.voided))} after cancel`)
  }
  return out
}

// ---------- report ----------
interface ReportIn {
  tracks: JobTrack[]
  opens: OpenTrack[]
  houseNotes: string[]
  inv: Invariants
  stats: Stats
  ledger: Json
  publicStats: Json
  logFindings: { kind: string; line: string }[]
  probes: string[]
  secs: number
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

function renderReport(r: ReportIn): string {
  const { tracks, inv, stats } = r
  const L: string[] = []
  const count = <T,>(xs: T[], f: (x: T) => string) => {
    const m = new Map<string, number>()
    for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const money = (k: string) => tracks.reduce((s, t) => s + c(t.last?.escrow?.[k]), 0)
  const lt = r.ledger?.totals
  L.push(`<!-- mode:${MODE} -->`)
  L.push(`## ${MODE === 'default' ? 'Default mode (the simulator plays buyers and sellers)' : 'House-bots mode (the real house bots sell, the simulator buys)'}`)
  L.push('')
  L.push(`Run: ${new Date().toISOString()} · \`npx tsx scripts/simulate.ts --jobs ${JOBS} --seed ${SEED} --concurrency ${CONC}${HOUSE ? ' --house-bots' : ''}${SCALE !== 3600 ? ` --time-scale ${SCALE}` : ''}\` · ${r.secs.toFixed(0)} s wall clock · demo time ×${SCALE} · simulated rail · AI_PROVIDER=none`)
  L.push('')
  L.push(`**Result: ${inv.violations.length === 0 ? 'PASS' : 'FAIL'}**: ${inv.violations.length} invariant violation(s) across ${tracks.length} jobs and ${inv.checks} per-event job checks; ${stats.calls.rest} REST + ${stats.calls.mcp} MCP calls.`)
  L.push('')
  L.push('### Jobs by outcome')
  L.push('')
  L.push('| final state | jobs |')
  L.push('|---|---|')
  for (const [k, v] of count(tracks, (t) => t.last?.job?.state ?? 'unread')) L.push(`| ${k} | ${v} |`)
  L.push('')
  L.push('| scenario | jobs | final states |')
  L.push('|---|---|---|')
  for (const [k, v] of count(tracks, (t) => t.scenario)) {
    const st = count(tracks.filter((t) => t.scenario === k), (t) => t.last?.job?.state ?? '?').map(([s, n]) => `${s} ${n}`).join(', ')
    L.push(`| ${k} | ${v} | ${st} |`)
  }
  L.push('')
  if (r.opens.length) {
    const sim = r.opens.filter((o) => !o.external)
    const sum = (k: string) => sim.reduce((s, o) => s + (o.counts[k] ?? 0), 0)
    const st = (o: OpenTrack) => o.last?.open_job?.state ?? 'unread'
    L.push(`### Open jobs (${r.opens.length})`)
    L.push('')
    L.push('| flow | award | open jobs | awarded | expired | bids | awarded jobs settled / cancelled |')
    L.push('|---|---|---|---|---|---|---|')
    for (const [flow, n] of count(sim, (o) => `${o.flow}|${o.award}`)) {
      const [f, a] = flow.split('|')
      const os = sim.filter((o) => o.flow === f && o.award === a)
      const jobs = os.map((o) => o.jobTrack?.last?.job?.state).filter(Boolean)
      L.push(`| ${f} | ${a} | ${n} | ${os.filter((o) => st(o) === 'awarded').length} | ${os.filter((o) => st(o) === 'expired').length} | ${os.reduce((s, o) => s + o.bids.length, 0)} | ${jobs.filter((s) => s === 'SETTLED').length} / ${jobs.filter((s) => s === 'CANCELLED').length} |`)
    }
    L.push('')
    L.push(`Bids placed ${sum('bids')} (${sum('withdrawn')} withdrawn, ${sum('rebids')} re-bids), by ${sum('bidders')} bidding bots; ${sum('posted_seen')} bots saw open_job_posted and bid from the event. Edge cases exercised: duplicate bid sequential ${sum('dup_bids')} / concurrent ${sum('dup_bids_concurrent')}, bid after the window ${sum('late_bid_attempts')}, invalid or unauthorized bids refused ${sum('invalid_bids_refused')}, withdrawn bid awarded ${sum('withdrawn_award_refused')}, award twice (same bid, same job) ${sum('award_again')}, award a second bid refused ${sum('award_other_refused')}, racing awards ${sum('award_races')}, award after the bid window (manual grace) ${sum('award_after_window')}, award after expiry refused ${sum('award_after_expiry')}, post_open_job replays ${sum('post_replays')}, privacy probes ${sum('privacy_probes')}; ${sum('refusals_checked')} refusals checked in all.`)
    const late = sim.flatMap((o) => o.notes.map((n) => `${o.id}: ${n}`))
    if (late.length) L.push(`\nHarness notes (load, not platform): ${late.length}, e.g. ${redact(late[0]!)}`)
    L.push('')
  }
  const disputes = tracks.filter((t) => t.last?.job?.mediation)
  L.push(`### Disputes (${disputes.length})`)
  L.push('')
  L.push('| settled by | jobs |')
  L.push('|---|---|')
  for (const [k, v] of count(disputes, (t) => t.disputeOutcome ?? `unresolved (${t.last?.job?.state})`)) L.push(`| ${k} | ${v} |`)
  const kinds = count(disputes.filter((t) => t.last?.job?.mediation?.agreed_proposal_id), (t) => t.last!.job.mediation.proposals.find((p: Json) => p.id === t.last!.job.mediation.agreed_proposal_id)?.kind ?? '?')
  if (kinds.length) L.push(`\nAgreed proposal kinds: ${kinds.map(([k, v]) => `${k} ${v}`).join(', ')}. Rounds used: ${count(disputes, (t) => String(t.last?.job?.mediation?.round ?? 0)).map(([k, v]) => `${k} round(s): ${v}`).join(', ')}. Integrity flags raised on ${disputes.filter((t) => t.last?.job?.mediation?.assessment?.integrity_flags?.length).length} disputes (manipulation attempts sent: ${disputes.filter((t) => t.injected.buyer || t.injected.seller).length}).`)
  L.push('')
  L.push('### Money')
  L.push('')
  L.push('| | amount |')
  L.push('|---|---|')
  L.push(`| authorized | $${usd(money('authorized'))} |`)
  L.push(`| captured | $${usd(money('captured'))} |`)
  L.push(`| voided | $${usd(money('voided'))} |`)
  L.push(`| refunded | $${usd(money('refunded'))} |`)
  L.push(`| paid out to sellers | $${usd(money('paid_out'))} |`)
  if (lt) {
    L.push(`| platform commission | $${lt.commission} |`)
    L.push(`| mediation fees | $${lt.mediation_fees} |`)
    L.push(`| refund fees kept (capture-and-hold) | $${lt.refund_fees_kept ?? '0.00'} |`)
    L.push(`| PayPal capture fees (simulated actuals) | $${lt.paypal_capture_fees} |`)
    L.push(`| PayPal payout fees (simulated actuals) | $${lt.paypal_payout_fees} |`)
    L.push(`| **platform net** | **$${lt.net}** |`)
  }
  const funded = tracks.filter((t) => t.fundedVia)
  L.push('')
  L.push(`Funding: ${count(funded, (t) => t.fundedVia!).map(([k, v]) => `${k} ${v}`).join(', ')}; escrow modes: ${count(tracks.filter((t) => c(t.last?.escrow?.authorized) > 0), (t) => t.last!.escrow.mode).map(([k, v]) => `${k} ${v}`).join(', ')}; reauthorizations: ${tracks.filter((t) => t.last?.escrow?.events?.some((e: Json) => e.kind === 'reauthorized')).length} jobs. Captures per job (jobs that captured): ${count(tracks.filter((t) => c(t.last?.escrow?.captured) > 0), (t) => String((t.last!.escrow.events as Json[]).filter((e) => e.kind === 'captured' && e.amount).length)).map(([k, v]) => `${k} capture(s): ${v}`).join(', ') || 'none'}; captures under $5.00: ${tracks.reduce((s, t) => s + ((t.last?.escrow?.events ?? []) as Json[]).filter((e) => e.kind === 'captured' && e.amount && c(e.amount.value) < 500).length, 0)}. Voided below the $5.00 minimum settlement: ${tracks.filter((t) => (t.last?.messages ?? []).some((m: Json) => m.type === 'system' && /below the \$\d+\.\d\d minimum settlement/.test(String(m.text)))).length} jobs. Lowest platform net on a job that captured: $${(() => { const nets = ((r.ledger?.jobs ?? []) as Json[]).filter((l) => c(l.captured) > 0).map((l) => Math.round(Number(l.net) * 100)); return nets.length ? usd(Math.min(...nets)) : '-' })()}.`)
  if (r.publicStats) L.push(`\nPublic stats after the run: held_now $${r.publicStats.held_now ?? '?'}.`)
  L.push('')
  L.push(`### Invariant violations (${inv.violations.length})`)
  L.push('')
  if (!inv.violations.length) L.push('None. Every per-event and end-of-run check held.')
  const byInv = count(inv.violations, (v) => String(v.inv))
  if (byInv.length) L.push(`By invariant: ${byInv.map(([k, v]) => `#${k}: ${v}`).join(', ')}.`)
  for (const v of inv.violations.slice(0, 40)) {
    L.push('')
    L.push(`- **#${v.inv}** \`${v.job ?? 'global'}\` (${v.scenario}): ${redact(v.what)}`)
    if (v.trace.length) {
      L.push('  <details><summary>reproduction trace</summary>')
      L.push('')
      L.push('  ```')
      for (const s of v.trace.slice(-40)) L.push(`  ${redact(s)}`)
      L.push('  ```')
      L.push('  </details>')
    }
  }
  if (inv.violations.length > 40) L.push(`\n…and ${inv.violations.length - 40} more.`)
  L.push('')
  L.push('### Latency per operation (ms)')
  L.push('')
  L.push('| operation | calls | p50 | p95 |')
  L.push('|---|---|---|---|')
  for (const [op, xs] of [...stats.lat.entries()].sort((a, b) => b[1].length - a[1].length)) L.push(`| ${op} | ${xs.length} | ${pct(xs, 50).toFixed(0)} | ${pct(xs, 95).toFixed(0)} |`)
  L.push('')
  L.push('### Errors by code')
  L.push('')
  L.push('All error responses, expected ones included (probes that must fail, stale hashes, etc.).')
  L.push('')
  L.push('| code | count |')
  L.push('|---|---|')
  for (const [k, v] of [...stats.errors.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`)
  L.push(`\nRate-limited responses retried: ${stats.rateLimited}. Transport failures: ${stats.transport.length}.`)
  const unexp = count(stats.unexpected, (u) => `${u.op}: ${u.code}`)
  L.push('')
  L.push(`### Unexpected errors and flaky behaviour`)
  L.push('')
  if (!unexp.length && !stats.transport.length) L.push('None.')
  for (const [k, v] of unexp.slice(0, 25)) {
    const ex = stats.unexpected.find((u) => `${u.op}: ${u.code}` === k)!
    L.push(`- ${k} ×${v}, e.g. \`${ex.job ?? ''}\`: ${redact(ex.message)}`)
  }
  for (const t of stats.transport.slice(0, 5)) L.push(`- transport (${t.surface} ${t.op}): ${redact(t.message)}`)
  const notes = tracks.flatMap((t) => t.notes.map((n) => `${t.id} (${t.scenario}): ${n}`))
  const noteKinds = count(notes, (n) => n.replace(/^job_\w+ /, '').replace(/\d+/g, 'N'))
  for (const [k, v] of noteKinds.slice(0, 15)) {
    const ex = notes.find((n) => n.replace(/^job_\w+ /, '').replace(/\d+/g, 'N') === k)
    L.push(`- ${redact(k.replace(/^\([^)]*\): /, ''))} ×${v}; e.g. ${redact(ex ?? '')}`)
  }
  const timeouts = tracks.filter((t) => t.harnessTimeout)
  if (timeouts.length) L.push(`- harness timeouts: ${timeouts.length} job(s): ${timeouts.slice(0, 8).map((t) => `${t.id} (${t.scenario}, ${t.last?.job?.state})`).join(', ')}`)
  const lf = count(r.logFindings, (f) => f.kind)
  if (lf.length) {
    L.push('')
    L.push(`Server log: ${lf.map(([k, v]) => `${k} ×${v}`).join(', ')}.`)
    for (const f of r.logFindings.slice(0, 8)) L.push(`- \`${f.line.slice(0, 300)}\``)
  }
  if (r.probes.length || r.houseNotes.length) {
    L.push('')
    L.push('### Probes')
    L.push('')
    for (const p of r.probes) L.push(`- ${p}`)
    for (const p of r.houseNotes) L.push(`- House-bot open job: ${redact(p)}`)
  }
  L.push(`<!-- /mode:${MODE} -->`)
  return L.join('\n')
}

function writeReport(section: string) {
  const file = REPORT
  const header = `# Simulation report

Generated by \`scripts/simulate.ts\` (docs/TEST_PLAN.md section 2). Results only; no keys, cookies or secrets.
Invariants: (1) money conservation, (2) fee split, payouts and platform margin, (3) every capture backed by checks,
an agreement or a ruling, (4) mandate caps and unclaimed agents, (5) room chain, state table, no stuck timers,
(6) secrets and non-party access, (7) output schemas and error shape, (8) idempotency,
(9) open jobs: one award per awarded job, losing bids declined, no escrow before the award, the awarded job holds the winning bid's
quote, expiry leaves no job, automatic award picks the cheapest / best record, withdrawn bids never win, who is told what.
`
  let body = existsSync(file) ? readFileSync(file, 'utf8') : header
  if (!body.startsWith('# Simulation report')) body = header
  const re = new RegExp(`<!-- mode:${MODE} -->[\\s\\S]*?<!-- /mode:${MODE} -->`)
  body = re.test(body) ? body.replace(re, section) : `${body.trimEnd()}\n\n${section}\n`
  writeFileSync(file, body)
}

await main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
