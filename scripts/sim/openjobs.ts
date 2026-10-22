// Open jobs (docs/PROTOCOL.md section 7): a buyer posts one spec, several bots bid, the buyer awards one (or the platform does when the
// bid window closes), and the award becomes a normal job that this file hands to JobDriver (accept_contract -> fund -> deliver -> settle).
// The flows (OPEN_CYCLE gives the rotation):
//   manual_award     2-4 bots bid at different prices and turnarounds, the buyer compares them and awards one (cheapest / fastest / best record / ...)
//   auto_lowest      the platform awards the cheapest bid when the window closes (the scheduler tick)
//   auto_record      the platform awards the best verified record when the window closes
//   expire_no_bids   nobody bids: the open job expires and the buyer is told
//   expire_withdrawn every bidder withdraws: same
//   manual_unawarded bids come in, the buyer never awards: it expires after the award grace
// Edge cases at a realistic rate: duplicate bids (sequential and concurrent), a bid after the window, an award twice (same bid: the same job;
// another bid: refused), an award after expiry, a withdrawn bid awarded, two awards racing, invalid quotes, other people's bots, strangers.
// The checks live in invariants.ts (#9); this file drives and records.
import { randomUUID } from 'node:crypto'
import { http, sleep, type Api, type Json, type Res } from './client.ts'
import { acceptance, JobDriver, type Plan } from './driver.ts'
import { c, MIN_SETTLEMENT, usd } from './fees.ts'
import type { Actor, AwardMode, Invariants, JobTrack, OpenBidTrack, OpenTrack } from './invariants.ts'
import type { Rng } from './rng.ts'
import { SKILLS, type World } from './world.ts'

type Bidder = World['bidders'][number]

export type OpenFlow = 'manual_award' | 'auto_lowest' | 'auto_record' | 'expire_no_bids' | 'expire_withdrawn' | 'manual_unawarded'
/**
 * The flows, in rotation by open-job ordinal (not drawn at random, so even the 7 open jobs of a 40-job run include an expiry and both
 * automatic awards): 5 of 12 manual awards, 4 automatic, 3 expiries.
 */
export const OPEN_CYCLE: OpenFlow[] = ['manual_award', 'auto_lowest', 'expire_no_bids', 'auto_record', 'manual_award', 'manual_unawarded', 'auto_lowest', 'manual_award', 'expire_withdrawn', 'auto_record', 'manual_award', 'manual_award']

export interface OpenCtx {
  /** DEMO_TIME_SCALE of the server: bid windows are chosen to last a few real seconds. */
  scale: number
  timeoutMs: number
}

/** Latest event cursor on the server, read through an agent that sees nothing (the cursor still advances past what it cannot see). */
const cursors = new WeakMap<World, number>()
export async function latestCursor(w: World): Promise<number> {
  let cur = cursors.get(w) ?? 0
  for (let i = 0; i < 400; i++) {
    const r = await w.stranger.api.call('wait_for_events', { after_cursor: cur, timeout_seconds: 0, types: ['open_job_closed'] })
    if (!r.ok || r.data.cursor <= cur) break
    cur = r.data.cursor
  }
  cursors.set(w, Math.max(cursors.get(w) ?? 0, cur))
  return cur
}

const days = (iso: string) => Number(/^P(\d+)D$/.exec(iso)?.[1] ?? 99)
const sleepUntil = (ms: number) => sleep(Math.max(0, ms - Date.now()))

interface BidPlan {
  b: Bidder
  bump: number
  turnaround: string
  delay: number
  dup: 'none' | 'seq' | 'conc'
  probe: boolean
  withdraw: 'no' | 'yes' | 'yes_rebid'
}

export class OpenJobDriver {
  readonly o: OpenTrack
  private stub: JobTrack
  private inner: JobDriver | null = null
  private cursor = 0
  private flow: OpenFlow
  private window: string
  private windowMs = 0

  constructor(
    readonly w: World,
    readonly inv: Invariants,
    readonly rng: Rng,
    readonly plan: Plan,
    readonly buyer: Actor,
    readonly idx: number,
    readonly ctx: OpenCtx,
    ordinal: number,
  ) {
    this.flow = OPEN_CYCLE[ordinal % OPEN_CYCLE.length]!
    // A bid names one skill, so an open job has one deliverable (more would need checks of a second skill).
    const d1 = plan.deliverables[0]!
    plan.deliverables.splice(1)
    const total = () => (SKILLS[d1.key].model === 'fixed' ? c(SKILLS[d1.key].price) : c(SKILLS[d1.key].price) * d1.qty)
    while (total() < MIN_SETTLEMENT && SKILLS[d1.key].model === 'per_unit') d1.qty++
    const award: AwardMode = this.flow === 'auto_lowest' ? 'lowest_price' : this.flow === 'auto_record' ? 'best_record' : this.flow === 'expire_no_bids' || this.flow === 'expire_withdrawn' ? rng.pick(['manual', 'lowest_price', 'best_record'] as AwardMode[]) : 'manual'
    // A bid window of about 6-9 real seconds, whatever the time scale.
    const minutes = Math.max(5, Math.min(20_000, Math.round(((rng.int(60, 90) / 10) * ctx.scale) / 60)))
    this.window = `PT${minutes}M`
    this.windowMs = (minutes * 60_000) / ctx.scale
    this.o = {
      id: '',
      idx,
      scenario: 'open_job_competition',
      flow: this.flow,
      trace: [],
      buyer,
      award,
      bid_until: 0,
      award_until: 0,
      budget_cap: 50_000,
      base: 0,
      matching: w.bidders,
      bids: [],
      chosen: null,
      expect: null,
      snapshots: [],
      last: null,
      jobTrack: null,
      notes: [],
      counts: {},
      done: false,
    }
    this.stub = {
      idx,
      id: '',
      scenario: 'open_job_competition',
      buyer,
      seller: { name: 'open-job', agent_id: '', key: '', api: buyer.api, claimed: true } as Actor,
      total: 0,
      trace: this.o.trace,
      fundedVia: null,
      secret: null,
      locker: null,
      releasedAtOpen: null,
      injected: { buyer: false, seller: false },
      override: null,
      buyerAcceptedClean: false,
      disputeOutcome: null,
      outcome: 'unfinished',
      done: false,
      harnessTimeout: false,
      notes: [],
      states: [],
    }
  }

  get t(): JobTrack {
    return this.inner?.t ?? this.stub
  }

  private log(s: string) {
    this.o.trace.push(`${new Date().toISOString().slice(11, 23)} ${s}`.slice(0, 400))
    if (this.o.trace.length > 160) this.o.trace.splice(0, this.o.trace.length - 160)
  }
  private count(k: string, n = 1) {
    this.o.counts[k] = (this.o.counts[k] ?? 0) + n
  }

  private async do(api: Api, who: string, op: Parameters<Api['call']>[0], args: Record<string, unknown>, expect: string[] = []): Promise<Res> {
    const r = await api.call(op, args)
    this.log(`${who} ${op} -> ${r.ok ? 'ok' : `${r.code}: ${r.message.slice(0, 120)}`}`)
    if (!r.ok && !expect.includes(r.code ?? '')) this.w.stats.unexpected.push({ op, code: r.code ?? '?', message: r.message.slice(0, 200), job: this.o.id })
    return r
  }

  /** A call that must be refused with one of `codes`; success (or another code) is a violation of invariant `inv`. */
  private async expectFail(inv: number, api: Api, who: string, op: Parameters<Api['call']>[0], args: Record<string, unknown>, codes: string[], why: string) {
    const r = await api.call(op, args)
    this.log(`${who} ${op} (expect ${codes.join('|')}) -> ${r.ok ? 'OK (!)' : r.code}`)
    this.count('refusals_checked')
    if (r.ok) this.inv.add(inv, this.o, `${why}: ${who} ${op} succeeded`)
    else if (!codes.includes(r.code ?? '')) this.inv.add(inv, this.o, `${why}: ${who} ${op} returned ${r.code} (${r.message.slice(0, 120)}), expected ${codes.join(' or ')}`)
    return r
  }

  // ---------- spec, requirements, quotes ----------
  private spec() {
    const d = this.plan.deliverables[0]!
    return {
      skill_id: SKILLS[d.key].id,
      goal: `Simulation open job #${this.idx}: ${this.flow.replace(/_/g, ' ')}, ${d.qty} ${d.key} unit(s)`,
      deliverables: [{ id: d.id, description: `Simulation deliverable ${d.id}: ${d.qty} ${d.key} unit(s)`, quantity: d.qty, acceptance: acceptance(d.key), rubric: '' }],
      deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      budget_cap: { value: '500.00', currency: 'USD' },
      out_of_scope: [],
      context: 'Product: SimProduct. Contact: hello@sim.example.',
      context_artifact_ids: [],
    }
  }

  private requirements(b: Bidder) {
    return {
      inputs_schema: { type: 'object', properties: { product_name: { type: 'string' } }, required: ['product_name'] },
      access: this.plan.secret ? [{ id: 'A1', kind: 'inbox_verification', why: 'Confirm listings by email', scope: 'read-only forward', required: true }] : [],
      assumptions: [`Sandbox Web only (bid by ${b.name})`],
      questions: [{ id: 'Q1', text: 'Which product name should appear on the units?' }],
    }
  }

  /** A quote at `bump` cents per unit above the skill's list price. */
  private quote(bump: number, turnaround = 'P7D', unit?: number) {
    const lines = this.plan.deliverables.map((d) => {
      const s = SKILLS[d.key]
      const u = unit ?? c(s.price) + bump
      return { deliverable_id: d.id, model: s.model, unit_price: usd(u), quantity: d.qty, max_total: usd(s.model === 'fixed' ? u : u * d.qty) }
    })
    const total = lines.reduce((s, l) => s + c(l.max_total), 0)
    return { lines, total_max: { value: usd(total), currency: 'USD' }, turnaround, excludes: [], valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString() }
  }

  // ---------- the run ----------
  async run(): Promise<JobTrack> {
    try {
      const awarded = await this.toClose()
      if (awarded) await this.handoff(awarded)
    } catch (e) {
      this.log(`driver crashed: ${e instanceof Error ? e.stack?.slice(0, 300) : String(e)}`)
      this.inv.add(9, this.o, `open-job driver crashed: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.o.done = true
    this.stub.done = true
    return this.t
  }

  /** The awarded job continues as any job: accept_contract (both), fund_job, delivery, checks, settlement. */
  private async handoff(a: { job_id: string; bid_id: string }) {
    const win = this.o.bids.find((b) => b.bid_id === a.bid_id)
    if (!win) {
      this.inv.add(9, this.o, `the awarded bid ${a.bid_id} is not one the simulator placed`)
      return
    }
    this.inner = new JobDriver(this.w, this.inv, this.rng, this.plan, this.buyer, win.seller as Bidder, this.idx, null, this.ctx.timeoutMs, a.job_id)
    this.inner.t.trace.push(...this.o.trace.slice(-50))
    this.o.jobTrack = this.inner.t
    await this.inner.run()
    await this.inv.checkOpenJob(this.o, { final: true })
  }

  private async toClose(): Promise<{ job_id: string; bid_id: string } | null> {
    const { w, o, rng, buyer, plan } = this
    const spec = this.spec()
    o.budget_cap = c(spec.budget_cap.value)
    o.base = await latestCursor(w)
    this.cursor = o.base
    const key = `sim-open-${this.idx}-${randomUUID()}`
    const body = { spec, title: `Sim #${this.idx} open job ${this.flow}`, bid_window: this.window, award: o.award, idempotency_key: key }
    const t0 = Date.now()
    const post = await this.do(buyer.api, 'buyer', 'post_open_job', body)
    const t1 = Date.now()
    if (!post.ok) {
      this.inv.add(9, o, `a valid post_open_job was refused: ${post.code} ${post.message.slice(0, 160)}`)
      return null
    }
    const oj = post.data.open_job
    o.id = oj.id
    o.bid_until = Date.parse(oj.bid_until)
    o.award_until = Date.parse(oj.award_until)
    this.checkPost(oj, t0, t1)
    if (rng.chance(0.15)) {
      const again = await this.do(buyer.api, 'buyer', 'post_open_job', body)
      this.count('post_replays')
      if (again.ok && again.data.open_job.id !== o.id) this.inv.add(8, o, `post_open_job replay with the same idempotency_key opened a second open job ${again.data.open_job.id}`)
      if (!again.ok) this.inv.add(8, o, `post_open_job replay with the same idempotency_key failed: ${again.code}`)
    }
    await this.privacyProbes(oj)

    // The bots bid.
    const bidders = this.pickBidders()
    this.count('bidders', bidders.length)
    await Promise.all(bidders.map((p) => this.bid(p)))
    const standing = o.bids.filter((b) => !b.withdrawn)
    // With a standing bid the job is awarded (by the buyer, or by the platform at the close); manual_unawarded is the buyer never choosing.
    o.expect = this.flow !== 'manual_unawarded' && standing.length ? 'awarded' : 'expired'
    await this.inv.checkOpenJob(o)

    let award: { job_id: string; bid_id: string } | null = null
    if (o.award === 'manual' && this.flow === 'manual_award' && standing.length) award = await this.manualAward()
    else award = await this.waitForClose()
    if (!award) {
      await this.afterExpiry()
      await this.inv.checkOpenJob(o, { final: true })
      await this.inv.checkOpenEvents(o, w.stranger.api)
      return null
    }
    // The award is done: how it was done, who was told, and the same award again.
    await this.afterAward(award)
    await this.inv.checkOpenEvents(o, w.stranger.api)
    void plan
    return award
  }

  private checkPost(oj: Json, t0: number, t1: number) {
    const { o } = this
    const bad = (what: string) => this.inv.add(9, o, `post_open_job result: ${what}`)
    if (oj.state !== 'open') bad(`state ${oj.state}, expected open`)
    if (oj.bids_count !== 0) bad(`${oj.bids_count} bids on a new job`)
    if (oj.award !== o.award) bad(`award ${oj.award} ≠ requested ${o.award}`)
    if (oj.bid_window !== this.window) bad(`bid_window ${oj.bid_window} ≠ requested ${this.window}`)
    if (oj.awarded_to || oj.job_id || oj.awarded_bid_id) bad('a new job already has an award')
    if (oj.matching_bots !== this.w.bidders.length) bad(`matching_bots ${oj.matching_bots} ≠ ${this.w.bidders.length} listed bots with the skill`)
    if (oj.spec.context !== 'Product: SimProduct. Contact: hello@sim.example.') bad('the owner does not get its own context back')
    // The window and the award grace are scaled by the demo clock.
    const slack = 1500
    if (o.bid_until < t0 + this.windowMs - slack || o.bid_until > t1 + this.windowMs + slack) bad(`bid_until ${oj.bid_until} is not ${this.window} / ${this.ctx.scale} (${Math.round(this.windowMs)} ms) after posting`)
    const grace = 86_400_000 / this.ctx.scale
    const wantAward = o.award === 'manual' ? o.bid_until + grace : o.bid_until
    if (Math.abs(o.award_until - wantAward) > slack) bad(`award_until ${oj.award_until} is not ${o.award === 'manual' ? 'bid_until + 24 h (scaled)' : 'bid_until'}`)
  }

  /** No private data is published; strangers cannot see bids or award. */
  private async privacyProbes(oj: Json) {
    const { o, w } = this
    const pub = await http(w.base, 'POST', '/api/ops/list_open_jobs', { body: { open_job_id: o.id } })
    const row = pub.json?.open_jobs?.[0]
    this.count('privacy_probes')
    if (pub.status !== 200 || !row) this.inv.add(6, o, `the public board does not show open job ${o.id} (HTTP ${pub.status})`)
    else {
      if (JSON.stringify(row).includes('hello@sim.example') || row.spec.context !== '' || (row.spec.context_artifact_ids ?? []).length) this.inv.add(6, o, 'the public board shows the buyer\'s private spec.context')
      for (const k of ['job_id', 'awarded_bid_id', 'policy', 'my_bids', 'context']) if (row[k] !== undefined) this.inv.add(6, o, `the public board shows the owner-only field ${k}`)
    }
    const st = this.w.stranger.api
    const sv = await st.call('list_open_jobs', { open_job_id: o.id })
    const srow = sv.ok ? sv.data.open_jobs[0] : null
    if (srow && (srow.spec.context !== '' || srow.job_id !== undefined || srow.policy !== undefined)) this.inv.add(6, o, 'a stranger\'s view of the open job shows owner-only data')
    await this.expectFail(6, st, 'stranger', 'list_bids', { open_job_id: o.id }, ['forbidden'], 'a stranger read the bids')
    const b0 = this.w.bidders[0]!
    await this.expectFail(6, b0.api, 'seller', 'list_bids', { open_job_id: o.id }, ['forbidden'], 'a bidder read the bids')
    void oj
  }

  // ---------- the bots ----------
  private pickBidders(): BidPlan[] {
    const { rng, flow } = this
    const n = flow === 'expire_no_bids' ? 0 : flow === 'manual_unawarded' ? rng.int(1, 3) : flow === 'expire_withdrawn' ? rng.int(1, 2) : rng.int(2, Math.min(4, this.w.bidders.length))
    const pool = [...this.w.bidders]
    const chosen: Bidder[] = []
    while (chosen.length < n && pool.length) chosen.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]!)
    const bumps = [0, 5, 10, 15, 20, 30, 40, 50, 60, 75]
    const used: number[] = []
    const plans: BidPlan[] = chosen.map((b, i) => {
      let bump = rng.pick(bumps)
      if (!(i > 0 && rng.chance(0.15))) while (used.includes(bump)) bump = rng.pick(bumps) // sometimes a tie
      used.push(bump)
      return {
        b,
        bump,
        turnaround: rng.pick(['P2D', 'P3D', 'P5D', 'P7D']),
        delay: rng.int(0, 400),
        dup: rng.weighted({ none: 14, seq: 2, conc: 2 }),
        probe: rng.chance(0.2),
        withdraw: flow === 'expire_withdrawn' ? 'yes' : rng.weighted({ no: 20, yes: 2, yes_rebid: 1 }),
      }
    })
    // An extra bot that bids and takes the bid back (it never wins).
    if (plans.length && flow !== 'expire_withdrawn' && flow !== 'expire_no_bids' && rng.chance(0.2) && pool.length) {
      plans.push({ b: pool.splice(rng.int(0, pool.length - 1), 1)[0]!, bump: rng.pick(bumps), turnaround: 'P3D', delay: rng.int(0, 300), dup: 'none', probe: false, withdraw: 'yes' })
    }
    return plans
  }

  /** The bot learns of the job from its events, looks at the board, bids, and maybe withdraws. */
  private async awaitPosted(b: Bidder): Promise<boolean> {
    const { o } = this
    let after = o.base
    const until = Math.min(o.bid_until, Date.now() + 6000)
    for (;;) {
      const r = await b.api.call('wait_for_events', { after_cursor: after, timeout_seconds: 2, types: ['open_job_posted'] })
      if (r.ok) {
        if (r.data.events.some((e: Json) => e.data?.open_job_id === o.id)) return true
        after = r.data.cursor
      }
      if (Date.now() > until) return false
    }
  }

  private async bid(p: BidPlan): Promise<void> {
    const { o, rng } = this
    const b = p.b
    await sleep(p.delay)
    const saw = await this.awaitPosted(b)
    if (!saw) {
      if (Date.now() < o.bid_until - 500) this.inv.add(9, o, `${b.name} (a listed bot with the skill) never received open_job_posted while the window was open`)
      else o.notes.push(`${b.name} saw the job too late to bid (load)`)
      return
    }
    this.count('posted_seen')
    if (Date.now() > o.bid_until - 400) {
      o.notes.push(`${b.name} saw the job too late to bid (load)`)
      return
    }
    const board = await b.api.call('list_open_jobs', { open_job_id: o.id, for_my_bots: true })
    if (board.ok && Date.now() < o.bid_until - 400) {
      if (!board.data.open_jobs.some((x: Json) => x.id === o.id)) this.inv.add(9, o, `list_open_jobs for_my_bots=true hides open job ${o.id} from ${b.name}, which has the skill and has not bid`)
      else if ((board.data.open_jobs[0].my_bids ?? []).length) this.inv.add(9, o, `${b.name} has not bid yet but list_open_jobs shows my_bids`)
    }
    if (p.probe) await this.invalidBids(p)

    const make = (bump: number) => ({ open_job_id: o.id, bot_id: b.bot_id, requirements: this.requirements(b), quote: this.quote(bump, p.turnaround), pitch: `${b.name}: ${p.turnaround} turnaround, verified before delivery.` })
    const first = make(p.bump)
    let r: Res
    if (p.dup === 'conc') {
      const rs = await Promise.all([b.api.call('submit_bid', first), b.api.call('submit_bid', first)])
      this.log(`${b.name} submit_bid x2 concurrent -> ${rs.map((x) => (x.ok ? 'ok' : x.code)).join(',')}`)
      this.count('dup_bids_concurrent')
      const oks = rs.filter((x) => x.ok)
      if (oks.length > 1) this.inv.add(9, o, `${b.name}'s two concurrent identical bids were both accepted (one standing bid per bot per open job)`)
      for (const x of rs) if (!x.ok && x.code !== 'invalid_state') this.inv.add(9, o, `the losing concurrent duplicate bid returned ${x.code}, expected invalid_state`)
      r = oks[0] ?? rs[0]!
    } else r = await this.do(b.api, b.name, 'submit_bid', first, ['invalid_state'])
    if (!r.ok) {
      if (r.code === 'invalid_state' && Date.now() >= o.bid_until - 100) o.notes.push(`${b.name}'s bid arrived after the window (load)`)
      else if (!(p.dup === 'conc' && r.code === 'invalid_state' && o.bids.some((x) => x.bot_id === b.bot_id))) this.inv.add(9, o, `a valid bid from ${b.name} was refused: ${r.code} ${r.message.slice(0, 140)}`)
      return
    }
    const tb = this.record(r, b, first)
    if (p.dup === 'seq') {
      this.count('dup_bids')
      await this.expectFail(9, b.api, b.name, 'submit_bid', make(p.bump + 5), ['invalid_state'], 'a second standing bid from the same bot was accepted')
    }
    if (tb && p.withdraw !== 'no') {
      await sleep(rng.int(50, 400))
      await this.withdraw(b, tb)
      if (p.withdraw === 'yes_rebid' && Date.now() < o.bid_until - 400) {
        this.count('rebids')
        const again = make(p.bump + 10)
        const r2 = await this.do(b.api, b.name, 'submit_bid', again, ['invalid_state'])
        if (r2.ok) this.record(r2, b, again)
        else if (!(r2.code === 'invalid_state' && Date.now() >= o.bid_until - 100)) this.inv.add(9, o, `${b.name} could not bid again after withdrawing: ${r2.code} ${r2.message.slice(0, 120)}`)
      }
    }
  }

  private record(r: Res, b: Bidder, sent: { quote: Json; requirements: Json }): OpenBidTrack | null {
    const { o } = this
    const bid = r.data.bid
    const bad = (what: string) => this.inv.add(9, o, `submit_bid result: ${what}`)
    if (bid.status !== 'active') bad(`new bid is ${bid.status}`)
    if (bid.open_job_id !== o.id || bid.bot_id !== b.bot_id) bad('bid names another open job or bot')
    if (c(bid.price.value) !== c(sent.quote.total_max.value)) bad(`price $${bid.price.value} ≠ quote total $${sent.quote.total_max.value}`)
    if (!r.data.open_job.my_bids?.some((x: Json) => x.bid_id === bid.id && x.status === 'active')) bad('open_job.my_bids does not list the new bid')
    const tb: OpenBidTrack = { bid_id: bid.id, bot_id: b.bot_id, seller: b, price: c(sent.quote.total_max.value), quote: sent.quote, requirements: sent.requirements, withdrawn: false, at: Date.now() }
    this.o.bids.push(tb)
    this.count('bids')
    return tb
  }

  private async withdraw(b: Bidder, tb: OpenBidTrack) {
    const { o, rng } = this
    const r = await this.do(b.api, b.name, 'withdraw_bid', { open_job_id: o.id, bid_id: tb.bid_id }, ['invalid_state'])
    if (!r.ok) {
      if (r.code === 'invalid_state' && Date.now() >= o.bid_until) return
      this.inv.add(9, o, `withdraw_bid on a standing bid failed: ${r.code} ${r.message.slice(0, 120)}`)
      return
    }
    tb.withdrawn = true
    this.count('withdrawn')
    if (r.data.bid.status !== 'withdrawn') this.inv.add(9, o, `withdraw_bid left the bid ${r.data.bid.status}`)
    if (rng.chance(0.5)) {
      // Withdrawing again is harmless (idempotent) and must not announce a second time.
      const again = await this.do(b.api, b.name, 'withdraw_bid', { open_job_id: o.id, bid_id: tb.bid_id })
      if (again.ok && again.data.bid.status !== 'withdrawn') this.inv.add(9, o, 'a repeated withdraw_bid changed the bid')
    }
    // Someone else's bid cannot be withdrawn.
    const other = this.w.bidders.find((x) => x.agent_id !== b.agent_id)
    if (other && rng.chance(0.3)) await this.expectFail(9, other.api, other.name, 'withdraw_bid', { open_job_id: o.id, bid_id: tb.bid_id }, ['not_found', 'forbidden'], 'a bot withdrew another bot\'s bid')
  }

  /** Quotes and callers the server must refuse. */
  private async invalidBids(p: BidPlan) {
    const { o, rng } = this
    const b = p.b
    const base = { open_job_id: o.id, bot_id: b.bot_id, requirements: this.requirements(b), pitch: 'probe' }
    const over = this.quote(0, 'P7D', 60_000)
    const tiny = this.quote(0, 'P7D', 1)
    const past = { ...this.quote(p.bump, 'P7D'), valid_until: new Date(Date.now() - 3600_000).toISOString() }
    const q = this.quote(p.bump, 'P7D')
    const skew = { ...q, total_max: { value: usd(c(q.total_max.value) + 1), currency: 'USD' } }
    const other = this.w.bidders.find((x) => x.agent_id !== b.agent_id)
    const cases: [string, () => Promise<unknown>][] = [
      ['over budget cap', () => this.expectFail(9, b.api, b.name, 'submit_bid', { ...base, quote: over }, ['invalid_input'], 'a bid above the budget cap was accepted')],
      ['below the minimum job price', () => this.expectFail(9, b.api, b.name, 'submit_bid', { ...base, quote: tiny }, ['invalid_input'], 'a bid below $5.00 was accepted')],
      ['valid_until before award_until', () => this.expectFail(9, b.api, b.name, 'submit_bid', { ...base, quote: past }, ['invalid_input'], 'a bid whose quote lapses before the award was accepted')],
      ['total_max ≠ sum of lines', () => this.expectFail(9, b.api, b.name, 'submit_bid', { ...base, quote: skew }, ['invalid_input'], 'a bid whose total is not the sum of its lines was accepted')],
      ['bidding with another agent\'s bot', () => (other ? this.expectFail(9, b.api, b.name, 'submit_bid', { ...base, bot_id: other.bot_id, quote: q }, ['forbidden'], 'an agent bid with a bot it does not operate') : Promise.resolve())],
      ['a stranger bidding with someone\'s bot', () => this.expectFail(9, this.w.stranger.api, 'stranger', 'submit_bid', { ...base, quote: q }, ['forbidden'], 'a stranger bid with a bot it does not operate')],
    ]
    const k = rng.int(2, 3)
    for (let i = 0; i < k; i++) {
      const [name, fn] = cases.splice(rng.int(0, cases.length - 1), 1)[0]!
      this.count('invalid_bids_refused')
      this.log(`probe: ${name}`)
      await fn()
    }
  }

  // ---------- the buyer ----------
  private async manualAward(): Promise<{ job_id: string; bid_id: string } | null> {
    const { o, rng, buyer } = this
    const lb = await this.inv.checkOpenJob(o)
    if (!lb) return null
    const active: Json[] = lb.bids.filter((b: Json) => b.status === 'active')
    if (!active.length) return this.waitForClose()
    // Awarding a bid that was withdrawn is refused.
    const wd = o.bids.find((b) => b.withdrawn)
    if (wd && rng.chance(0.7)) {
      await this.expectFail(9, buyer.api, 'buyer', 'award_bid', { open_job_id: o.id, bid_id: wd.bid_id }, ['invalid_state'], 'a withdrawn bid was awarded')
      this.count('withdrawn_award_refused')
    }
    // Sometimes the buyer takes its time: after the window, inside the 24 h award grace (a late bid is refused, the buyer can still award).
    if (rng.chance(0.2)) {
      await sleepUntil(o.bid_until + 150)
      this.count('award_after_window')
      await this.lateBid()
    }
    const fastest = [...active].sort((a, b) => days(a.turnaround) - days(b.turnaround) || c(a.price.value) - c(b.price.value))[0]!
    const cheapest = [...active].sort((a, b) => c(a.price.value) - c(b.price.value))[0]!
    const dearest = [...active].sort((a, b) => c(b.price.value) - c(a.price.value))[0]!
    const bestRec = active.find((b) => b.id === lb.recommended.best_record) ?? cheapest
    const pick: Json = rng.pick([cheapest, cheapest, fastest, dearest, bestRec, rng.pick(active)])
    let winner: Json = pick
    if (active.length >= 2 && rng.chance(0.2)) {
      // Two awards racing: exactly one bid wins, the other call is refused.
      const other = rng.pick(active.filter((b) => b.id !== pick.id))
      const rs = await Promise.all([buyer.api.call('award_bid', { open_job_id: o.id, bid_id: pick.id }), buyer.api.call('award_bid', { open_job_id: o.id, bid_id: other.id })])
      this.log(`buyer award_bid x2 racing (${pick.id.slice(-4)} / ${other.id.slice(-4)}) -> ${rs.map((x) => (x.ok ? 'ok' : x.code)).join(',')}`)
      this.count('award_races')
      const oks = rs.filter((x) => x.ok)
      if (oks.length !== 1) this.inv.add(9, o, `two racing award_bid calls for different bids: ${oks.length} succeeded, expected exactly 1`)
      if (rs.some((x) => !x.ok && x.code !== 'invalid_state')) this.inv.add(9, o, `the losing racing award_bid returned ${rs.find((x) => !x.ok && x.code !== 'invalid_state')?.code}, expected invalid_state`)
      const ok = oks[0]
      if (!ok) return null
      winner = ok === rs[0] ? pick : other
      o.chosen = winner.id
      return { job_id: ok.data.job.id, bid_id: winner.id }
    }
    o.chosen = winner.id
    const r = await this.do(buyer.api, 'buyer', 'award_bid', { open_job_id: o.id, bid_id: winner.id }, ['invalid_state'])
    if (!r.ok) {
      this.inv.add(9, o, `award_bid on a standing bid was refused: ${r.code} ${r.message.slice(0, 140)}`)
      return null
    }
    this.checkAwardResult(r, winner.id)
    return { job_id: r.data.job.id, bid_id: winner.id }
  }

  private checkAwardResult(r: Res, bid_id: string) {
    const { o } = this
    const bad = (what: string) => this.inv.add(9, o, `award_bid result: ${what}`)
    const job = r.data.job
    if (r.data.open_job.state !== 'awarded' || r.data.open_job.job_id !== job.id || r.data.open_job.awarded_bid_id !== bid_id) bad(`open_job is ${r.data.open_job.state} / job ${r.data.open_job.job_id} / bid ${r.data.open_job.awarded_bid_id}`)
    if (job.origin?.open_job_id !== o.id || job.origin?.bid_id !== bid_id) bad(`job.origin ${JSON.stringify(job.origin ?? null)} does not point back`)
    if (job.state !== 'NEGOTIATING') bad(`the new job is ${job.state}, expected NEGOTIATING`)
    if (job.escrow.status !== 'none' || c(job.escrow.authorized) !== 0) bad(`the new job already has escrow (${job.escrow.status}, authorized $${job.escrow.authorized?.value ?? job.escrow.authorized})`)
    if (r.data.your_role !== 'buyer') bad(`your_role ${r.data.your_role}`)
  }

  /** The automatic modes (and a manual job nobody awards): wait for open_job_closed, like a buyer would. */
  private async waitForClose(): Promise<{ job_id: string; bid_id: string } | null> {
    const { o, buyer } = this
    const due = o.award === 'manual' && o.bids.some((b) => !b.withdrawn) ? o.award_until : o.bid_until
    if (o.award !== 'manual' && o.bids.some((b) => !b.withdrawn)) {
      // Around the close: reads of the standing bids and their track records every ~100 ms (best_record is judged against them, since
      // the records move while other jobs settle). The first one also runs the full open-job check.
      await sleepUntil(o.bid_until - 1200)
      await this.inv.checkOpenJob(o)
      while (Date.now() < o.bid_until + 600) {
        const st = await this.inv.snapshot(o)
        if (st && st !== 'open') break
        await sleep(60)
      }
    }
    const until = due + 15_000
    let closed = false
    while (!closed && Date.now() < until) {
      const r = await buyer.api.call('wait_for_events', { after_cursor: this.cursor, timeout_seconds: 3, types: ['open_job_closed'] })
      if (r.ok) {
        this.cursor = Math.max(this.cursor, r.data.cursor)
        closed = r.data.events.some((e: Json) => e.data?.open_job_id === o.id)
      } else await sleep(500)
      if (!closed) {
        const v = await buyer.api.call('list_open_jobs', { open_job_id: o.id, mine: true, status: 'all' })
        if (v.ok && v.data.open_jobs[0]?.state !== 'open') closed = true // closed without an event: the events check reports that
      }
    }
    // A late bid after the close (a few of them).
    if (this.rng.chance(0.3)) {
      await this.lateBid()
      this.count('late_bids')
    }
    const lb = await this.inv.checkOpenJob(o)
    const oj = lb?.open_job
    if (oj?.state === 'awarded' && oj.job_id) return { job_id: oj.job_id, bid_id: oj.awarded_bid_id }
    return null
  }

  private async lateBid() {
    const { o, rng } = this
    const b = rng.pick(this.w.bidders)
    this.count('late_bid_attempts')
    await this.expectFail(9, b.api, b.name, 'submit_bid', { open_job_id: o.id, bot_id: b.bot_id, requirements: this.requirements(b), quote: this.quote(rng.pick([0, 10, 20])), pitch: 'late' }, ['invalid_state'], 'a bid after the bid window closed was accepted')
  }

  /** After an award: the same award again is idempotent, another bid is refused. */
  private async afterAward(a: { job_id: string; bid_id: string }) {
    const { o, buyer, rng } = this
    const lb = await this.inv.checkOpenJob(o, { justAwarded: true })
    if (!lb) return
    const losers: Json[] = lb.bids.filter((b: Json) => b.id !== a.bid_id)
    if (rng.chance(0.6)) {
      const again = await this.do(buyer.api, 'buyer', 'award_bid', { open_job_id: o.id, bid_id: a.bid_id })
      this.count('award_again')
      if (!again.ok) this.inv.add(9, o, `award_bid again with the same bid was refused (${again.code}), it must return the same job`)
      else if (again.data.job.id !== a.job_id) this.inv.add(9, o, `award_bid again with the same bid returned job ${again.data.job.id}, expected ${a.job_id} (a second job was created)`)
    }
    if (losers.length && rng.chance(0.6)) {
      const other = rng.pick(losers)
      await this.expectFail(9, buyer.api, 'buyer', 'award_bid', { open_job_id: o.id, bid_id: other.id }, ['invalid_state'], 'a second bid was awarded on an awarded open job')
      this.count('award_other_refused')
    }
    // A bidder cannot award, withdraw after the award, or bid.
    const b = rng.pick(this.w.bidders)
    await this.expectFail(6, b.api, b.name, 'award_bid', { open_job_id: o.id, bid_id: a.bid_id }, ['forbidden'], 'a bidder awarded a bid on someone else\'s open job')
    await this.lateAfterClose()
  }

  private async lateAfterClose() {
    if (this.rng.chance(0.3)) {
      await this.lateBid()
      this.count('late_bids')
    }
  }

  /** The open job expired: the buyer was told, awarding is refused, and no job exists. */
  private async afterExpiry() {
    const { o, buyer, rng } = this
    const lb = o.last
    if (!lb) return
    this.count('expired')
    const real = o.bids[0]?.bid_id
    const fake = `bid_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    if (rng.chance(0.8)) {
      await this.expectFail(9, buyer.api, 'buyer', 'award_bid', { open_job_id: o.id, bid_id: real ?? fake }, ['invalid_state'], 'a bid was awarded on an expired open job')
      this.count('award_after_expiry')
    }
    if (lb.open_job.state === 'expired') await this.lateAfterClose()
  }
}

// ---------- house bots (--house-bots): do they bid? ----------

/**
 * House-bots mode has no scripted sellers with the house bots' skills, so this posts one open job per distinct house-bot skill, gives the
 * house bots the whole bid window to answer, and reports who bid. If any did, the cheapest bid is awarded (the award checks run on a real
 * house bot's bid) and the job is declined before funding; otherwise the job must simply expire.
 */
export async function houseOpenProbes(w: World, inv: Invariants, ctx: OpenCtx, say: (s: string) => void): Promise<{ notes: string[]; opens: OpenTrack[] }> {
  const notes: string[] = []
  const opens: OpenTrack[] = []
  const bySkill = new Map<string, Json[]>()
  for (const b of w.houseBots) {
    if (b.capability_class === 'security' || b.policy?.requires_scope_proof) continue
    for (const k of b.skills ?? []) bySkill.set(k.id, [...(bySkill.get(k.id) ?? []), b])
  }
  const buyers = w.buyers.filter((b) => b.mandate)
  const entries = [...bySkill.entries()].slice(0, Math.min(8, buyers.length))
  if (!entries.length) return { notes: ['No house bot with an open-job-eligible skill is listed: the house-bot probe was skipped.'], opens }
  const minutes = Math.max(5, Math.round((12 * ctx.scale) / 60))
  await Promise.all(
    entries.map(async ([skill_id, bots], i) => {
      const buyer = buyers[i]!
      const bot = bots[0]!
      const sk = bot.skills.find((k: Json) => k.id === skill_id)
      const log: string[] = []
      const o: OpenTrack = {
        id: '', idx: -1 - i, scenario: 'open_job_competition', flow: 'house_probe', trace: log, buyer, award: 'manual', bid_until: 0, award_until: 0, budget_cap: 20_000, base: 0, matching: [], bids: [], chosen: null,
        expect: null, snapshots: [], last: null, jobTrack: null, notes: [], counts: {}, done: false, external: true, matchingCount: bots.length,
      }
      const d = await buyer.api.call('draft_job_spec', { bot_id: bot.id, skill_id, goal: `Simulation: ${sk.title} for SimProduct, a payments tool for software builders (hello@oranoai.com).`, quantity: sk.pricing.model === 'per_unit' ? Math.max(sk.pricing.min_units ?? 1, 3) : undefined, budget_cap: '200.00', context: 'Product: SimProduct (https://example.com). Contact: hello@oranoai.com. Category: developer tools.' })
      if (!d.ok) {
        notes.push(`${bot.name} (${skill_id}): draft_job_spec failed (${d.code}); skipped.`)
        return
      }
      o.base = await latestCursor(w)
      o.budget_cap = c(d.data.spec.budget_cap.value)
      const post = await buyer.api.call('post_open_job', { spec: d.data.spec, title: `Sim house probe ${skill_id}`, bid_window: `PT${minutes}M`, award: 'manual', idempotency_key: `sim-house-${skill_id}-${randomUUID()}` })
      if (!post.ok) {
        // A refusal is itself information (policy gate, no eligible bot); it is not an invariant violation.
        notes.push(`${bot.name} (${skill_id}): post_open_job refused: ${post.code} ${post.message.slice(0, 140)}`)
        return
      }
      o.id = post.data.open_job.id
      o.bid_until = Date.parse(post.data.open_job.bid_until)
      o.award_until = Date.parse(post.data.open_job.award_until)
      if (post.data.open_job.matching_bots !== bots.length) inv.add(9, o, `matching_bots ${post.data.open_job.matching_bots} ≠ ${bots.length} house bot(s) with the skill ${skill_id}`)
      opens.push(o)
      await sleepUntil(o.bid_until + 200)
      const lb = await buyer.api.call('list_bids', { open_job_id: o.id })
      const bids: Json[] = lb.ok ? lb.data.bids : []
      for (const b of bids) o.bids.push({ bid_id: b.id, bot_id: b.bot_id, seller: buyer, price: c(b.price.value), quote: b.quote, requirements: b.requirements, withdrawn: b.status === 'withdrawn', at: Date.parse(b.created_at) })
      const names = bids.map((b) => `${b.bot_name} $${b.price.value} ${b.quote.turnaround}`)
      await inv.checkOpenJob(o)
      const standing = bids.filter((b) => b.status === 'active')
      if (!standing.length) {
        o.expect = 'expired'
        for (let n = 0; n < 40 && (await buyer.api.call('list_open_jobs', { open_job_id: o.id, mine: true, status: 'all' })).data?.open_jobs?.[0]?.state === 'open'; n++) await sleep(300)
        await inv.checkOpenJob(o, { final: true })
        await inv.checkOpenEvents(o, w.stranger.api)
        notes.push(`${skill_id}: ${bots.map((b) => b.name).join(', ')} did not bid within the ${Math.round((minutes * 60) / ctx.scale)} s window; the open job ${o.last?.open_job?.state === 'expired' ? 'expired and the buyer was notified' : `is ${o.last?.open_job?.state}`}.`)
        return
      }
      o.expect = 'awarded'
      const pick = [...standing].sort((a, b) => c(a.price.value) - c(b.price.value))[0]!
      o.chosen = pick.id
      const r = await buyer.api.call('award_bid', { open_job_id: o.id, bid_id: pick.id })
      if (!r.ok) {
        inv.add(9, o, `award_bid on a house bot's bid was refused: ${r.code} ${r.message.slice(0, 140)}`)
        return
      }
      await inv.checkOpenJob(o, { justAwarded: true })
      const dec = await buyer.api.call('decline_job', { job_id: r.data.job.id, reason: 'Simulation: house-bot open-job probe, nothing to buy.' })
      const g = await buyer.api.call('get_job', { job_id: r.data.job.id })
      await inv.checkOpenJob(o, { final: true })
      await inv.checkOpenEvents(o, w.stranger.api)
      notes.push(`${skill_id}: ${standing.length} house bid(s) (${names.join('; ')}); the cheapest was awarded and the job ${dec.ok ? 'declined before funding' : `could not be declined (${dec.code})`} -> ${g.data?.job?.state ?? '?'}.`)
    }),
  )
  say(`house open-job probes: ${notes.length} result(s)`)
  return { notes, opens }
}
