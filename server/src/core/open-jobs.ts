// Open jobs: storage, matching, rendering, award and expiry. A buyer posts a job spec once, matching bots bid with the same
// `requirements` + `quote` they would send in a normal job, and awarding a bid creates a normal job in NEGOTIATING that already
// holds that requirements/quote (so the next steps are the existing accept_contract -> fund_job). No money moves before the
// award: escrow still starts at fund_job, and fees.ts is untouched.
// Everything that changes one open job runs under the lock `open:<id>`; the new job is created inside that lock.
import type { Bid, BotCard, CapabilityClass, JobSpec, NextAction, OpenJob, PolicyClass, Quote, Requirements, TrackRecord } from '@rentabot/shared'
import { json } from '../db/index.ts'
import type { Domain } from './domain.ts'
import { newJobRecord } from './job-factory.ts'
import { leaderboard } from './leaderboard.ts'
import type { JobRecord } from './model.ts'
import type { From } from './room.ts'
import type { Stats } from './stats.ts'
import { OpError } from './types.ts'
import { toCents } from './util.ts'

export type AwardMode = 'manual' | 'lowest_price' | 'best_record'
export type OpenJobState = 'open' | 'awarded' | 'expired'
export type BidStatus = 'active' | 'withdrawn' | 'awarded' | 'declined'

export interface BidRecord {
  id: string
  bot_id: string
  /** The bot operator's agent: it receives this bid's events. */
  agent_id: string
  requirements: Requirements
  quote: Quote
  pitch: string
  status: BidStatus
  created_at: string
  updated_at: string
}

export interface OpenJobRecord {
  id: string
  state: OpenJobState
  title: string
  buyer_agent_id: string
  spec: JobSpec
  category: CapabilityClass | null
  award: AwardMode
  bid_window: string
  bid_until: string
  award_until: string
  policy: { class: PolicyClass; reasons: string[] }
  bids: BidRecord[]
  awarded_bid_id: string | null
  job_id: string | null
  close_reason: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
}

/** A bid window is between 5 minutes and 14 days (before demo scaling). */
export const MIN_BID_WINDOW_MS = 5 * 60_000
export const MAX_BID_WINDOW_MS = 14 * 86_400_000
/** A manual job can still be awarded this long after its bid window closes. */
export const AWARD_GRACE = 'PT24H'

const ZERO_RECORD: TrackRecord = { jobs_settled: 0, jobs_funded: 0, verified_units: 0, units_checked: 0, pass_rate: null, on_time_rate: null, dispute_rate: null, disputes: 0 }

export type Viewer = { kind: 'public' } | { kind: 'owner' } | { kind: 'agents'; agents: Set<string> }

export class OpenJobs {
  private d: Domain
  private stats: Stats
  constructor(d: Domain, stats: Stats) {
    this.d = d
    this.stats = stats
  }

  // ---------- storage ----------
  tryLoad(id: string): OpenJobRecord | null {
    const r = this.d.db.get<{ data: string }>('SELECT data FROM open_jobs WHERE id = ?', id)
    return r ? json<OpenJobRecord>(r.data) : null
  }
  load(id: string): OpenJobRecord {
    const rec = this.tryLoad(id)
    if (!rec) throw new OpError('not_found', `Open job ${id} not found.`, 'list_open_jobs shows the open jobs.')
    return rec
  }
  save(rec: OpenJobRecord) {
    rec.updated_at = this.d.nowIso()
    this.d.db.run(
      `INSERT INTO open_jobs (id, state, buyer_agent_id, data, bid_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
      rec.id,
      rec.state,
      rec.buyer_agent_id,
      JSON.stringify(rec),
      rec.bid_until,
      rec.created_at,
      rec.updated_at,
    )
  }
  /** Newest first. */
  all(): OpenJobRecord[] {
    return this.d.db.all<{ data: string }>('SELECT data FROM open_jobs ORDER BY created_at DESC, id DESC').map((r) => json<OpenJobRecord>(r.data))
  }

  // ---------- matching ----------
  /** Listed bots that have the job's skill (and category), not operated by the buyer. */
  matchingBots(rec: Pick<OpenJobRecord, 'spec' | 'category' | 'buyer_agent_id'>): BotCard[] {
    return this.d.db
      .all<{ data: string }>("SELECT data FROM bots WHERE status = 'listed' ORDER BY created_at")
      .map((r) => json<BotCard>(r.data))
      .filter((b) => b.skills.some((k) => k.id === rec.spec.skill_id) && (!rec.category || b.capability_class === rec.category) && b.operator_agent_id !== rec.buyer_agent_id)
  }

  /** Is bidding still allowed right now? */
  biddingOpen(rec: OpenJobRecord): boolean {
    return rec.state === 'open' && this.d.nowMs() < Date.parse(rec.bid_until)
  }

  // ---------- track records ----------
  records(): Map<string, TrackRecord> {
    const rows = leaderboard(this.d, 'verified_units', 100_000).rows
    return new Map(
      rows.map((r) => [
        r.bot_id,
        { jobs_settled: r.jobs_settled, jobs_funded: r.jobs_funded, verified_units: r.verified_units, units_checked: r.units_checked, pass_rate: r.pass_rate, on_time_rate: r.on_time_rate, dispute_rate: r.dispute_rate, disputes: r.disputes },
      ]),
    )
  }

  // ---------- rendering ----------
  renderBid(rec: OpenJobRecord, b: BidRecord, records = this.records()): Bid {
    const bot = this.d.bot(b.bot_id)
    const schema = b.requirements.inputs_schema as { properties?: Record<string, unknown>; required?: unknown }
    return {
      id: b.id,
      open_job_id: rec.id,
      bot_id: b.bot_id,
      bot_name: bot?.name ?? b.bot_id,
      bot_tagline: bot?.tagline ?? '',
      status: b.status,
      price: b.quote.total_max,
      turnaround: b.quote.turnaround,
      pitch: b.pitch,
      requirements: b.requirements,
      quote: b.quote,
      requirements_summary: {
        inputs: Object.keys(schema.properties ?? {}),
        required_inputs: Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [],
        access: b.requirements.access.map((a) => ({ id: a.id, kind: a.kind, scope: a.scope, required: a.required })),
        questions: b.requirements.questions.length,
        assumptions: b.requirements.assumptions,
      },
      track_record: records.get(b.bot_id) ?? ZERO_RECORD,
      created_at: b.created_at,
    }
  }

  render(rec: OpenJobRecord, viewer: Viewer): OpenJob {
    const owner = viewer.kind === 'owner'
    const won = rec.awarded_bid_id ? rec.bids.find((b) => b.id === rec.awarded_bid_id) : undefined
    const out: OpenJob = {
      id: rec.id,
      state: rec.state,
      title: rec.title,
      // The private context never leaves the buyer: the board shows the goal, deliverables, checks and budget only.
      spec: owner ? rec.spec : { ...rec.spec, context: '', context_artifact_ids: [] },
      category: rec.category,
      award: rec.award,
      bid_window: rec.bid_window,
      bid_until: rec.bid_until,
      award_until: rec.award_until,
      bids_count: rec.bids.filter((b) => b.status !== 'withdrawn').length,
      matching_bots: this.matchingBots(rec).length,
      awarded_to: won ? { bot_id: won.bot_id, bot_name: this.d.bot(won.bot_id)?.name ?? won.bot_id, price: won.quote.total_max } : null,
      close_reason: rec.close_reason,
      created_at: rec.created_at,
      closed_at: rec.closed_at,
    }
    if (owner) {
      out.policy = rec.policy
      out.awarded_bid_id = rec.awarded_bid_id
      out.job_id = rec.job_id
      out.context = rec.spec.context
      out.context_artifact_ids = rec.spec.context_artifact_ids
    } else if (viewer.kind === 'agents') {
      out.my_bids = rec.bids.filter((b) => viewer.agents.has(b.agent_id)).map((b) => ({ bid_id: b.id, bot_id: b.bot_id, status: b.status }))
    }
    return out
  }

  // ---------- picking ----------
  /** Bids that could be awarded now: standing, quote still valid, bot still listed. */
  awardable(rec: OpenJobRecord): BidRecord[] {
    const now = this.d.nowMs()
    return rec.bids.filter((b) => b.status === 'active' && Date.parse(b.quote.valid_until) >= now && this.d.bot(b.bot_id)?.status === 'listed')
  }

  /** Cheapest first; ties go to the earlier bid. */
  byPrice(bids: BidRecord[]): BidRecord[] {
    return [...bids].sort((a, b) => toCents(a.quote.total_max.value) - toCents(b.quote.total_max.value) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  }

  /** Best verified record first: pass rate, then verified units, then fewer disputes; bots with no record rank after bots with one; price breaks ties. */
  byRecord(bids: BidRecord[], records = this.records()): BidRecord[] {
    const r = (b: BidRecord) => records.get(b.bot_id) ?? ZERO_RECORD
    return [...bids].sort((a, b) => {
      const x = r(a)
      const y = r(b)
      return (
        (y.pass_rate ?? -1) - (x.pass_rate ?? -1) ||
        y.verified_units - x.verified_units ||
        (x.dispute_rate ?? 1) - (y.dispute_rate ?? 1) ||
        toCents(a.quote.total_max.value) - toCents(b.quote.total_max.value) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id)
      )
    })
  }

  // ---------- next actions ----------
  nextActionsForBuyer(rec: OpenJobRecord, cursor = this.d.bus.latestCursor()): NextAction[] {
    if (rec.state === 'awarded') return [{ op: 'get_job', why: 'The award created a normal job: read its contract, answer the seller\'s questions, accept_contract, then fund_job.', args: { job_id: rec.job_id } }]
    if (rec.state === 'expired') {
      return [
        { op: 'post_open_job', why: 'Nobody won: post it again (a higher budget_cap, a longer bid_window or a clearer spec attracts bids).', args: { spec: rec.spec, bid_window: rec.bid_window, award: rec.award, ...(rec.category ? { category: rec.category } : {}) } },
        { op: 'search_bots', why: 'Or hire a specific bot directly with create_job.', args: { skill: rec.spec.skill_id } },
      ]
    }
    const standing = this.awardable(rec).length
    const out: NextAction[] = []
    if (standing) out.push({ op: 'list_bids', why: `${standing} bid(s) so far: compare price, turnaround, requirements and track record, then award_bid.`, args: { open_job_id: rec.id } })
    if (this.biddingOpen(rec)) out.push({ op: 'wait_for_events', why: `Bids are open until ${rec.bid_until}${rec.award === 'manual' ? '; you award one yourself' : `; the platform awards by ${rec.award.replace('_', ' ')} when the window closes`}.`, args: { after_cursor: cursor, types: ['bid_received', 'open_job_closed'] } })
    else if (!standing) out.push({ op: 'wait_for_events', why: 'Waiting for the platform to close the open job.', args: { after_cursor: cursor, types: ['open_job_closed'] } })
    return out
  }

  // ---------- events ----------
  private publish(type: 'open_job_posted' | 'bid_received' | 'bid_awarded' | 'bid_declined' | 'open_job_closed', rec: OpenJobRecord, agents: string[], summary: string, data: Record<string, unknown>, job_id: string | null = null) {
    const uniq = [...new Set(agents)]
    if (!uniq.length) return
    this.d.bus.publish(type, job_id, { agents: uniq }, summary, { open_job_id: rec.id, ...data })
  }

  announcePosted(rec: OpenJobRecord) {
    const bots = this.matchingBots(rec)
    this.publish('open_job_posted', rec, bots.map((b) => b.operator_agent_id), `Open job: ${rec.title} (budget cap $${rec.spec.budget_cap.value}, bids until ${rec.bid_until})`, {
      skill_id: rec.spec.skill_id,
      budget_cap: rec.spec.budget_cap,
      bid_until: rec.bid_until,
      award: rec.award,
    })
    this.stats.feedItem('open_job', `New open job for bots to bid on: ${rec.title.slice(0, 120)} (budget cap $${rec.spec.budget_cap.value})`, toCents(rec.spec.budget_cap.value))
  }

  announceBid(rec: OpenJobRecord, b: BidRecord, status: 'active' | 'withdrawn') {
    const name = this.d.bot(b.bot_id)?.name ?? 'A bot'
    this.publish('bid_received', rec, [rec.buyer_agent_id], status === 'active' ? `${name} bid $${b.quote.total_max.value} on "${rec.title}"` : `${name} withdrew its bid on "${rec.title}"`, {
      bid_id: b.id,
      bot_id: b.bot_id,
      status,
      price: b.quote.total_max,
      turnaround: b.quote.turnaround,
    })
  }

  // ---------- award and expiry (callers hold the lock `open:<id>`) ----------
  private fromParty(agent_id: string, role: 'buyer' | 'seller'): From {
    return { kind: 'agent', id: agent_id, role }
  }

  /** Create the normal job for `bid` and close the open job. Throws an OpError when the bid cannot become a job (nothing is changed then). */
  async awardLocked(rec: OpenJobRecord, bid: BidRecord, how: 'buyer' | 'lowest_price' | 'best_record'): Promise<JobRecord> {
    const d = this.d
    const bot = d.bot(bid.bot_id)
    if (!bot || bot.status !== 'listed') throw new OpError('invalid_state', `${bot?.name ?? 'This bot'} is not taking jobs any more.`, 'Award another bid.')
    if (Date.parse(bid.quote.valid_until) < d.nowMs()) throw new OpError('invalid_state', 'This bid\'s quote has expired.', 'Award another bid, or ask the bot to bid again.')
    const skill = bot.skills.find((k) => k.id === rec.spec.skill_id)
    if (!skill) throw new OpError('invalid_state', `${bot.name} no longer has the ${rec.spec.skill_id} skill.`, 'Award another bid.')
    // The bid was checked against the spec when it came in; the gate runs again with the real bot, as create_job does.
    const verdict = await d.intel.policy.reviewSpec(rec.spec, bot)
    if (verdict.class === 'blocked') throw new OpError('policy_blocked', `The policy gate blocked this job with ${bot.name}: ${verdict.reasons.join('; ') || 'not allowed'}.`, 'Award another bid, or remove the blocked activity from the spec.')

    const job = newJobRecord(d, { buyer_agent_id: rec.buyer_agent_id, bot, skill, spec: rec.spec, title: rec.title, verdict })
    job.origin = { open_job_id: rec.id, bid_id: bid.id }
    // The bid's requirements and quote become the contract's: version bumps once, the hash exists, nobody has signed yet.
    d.amend(job, () => {
      job.requirements = bid.requirements
      job.quote = bid.quote
    })
    d.save(job)
    const buyer = this.fromParty(rec.buyer_agent_id, 'buyer')
    const seller = this.fromParty(bid.agent_id, 'seller')
    const others = rec.bids.filter((b) => b.id !== bid.id && b.status === 'active')
    d.post(job, buyer, 'job_spec', rec.spec.goal, { spec: rec.spec, bot_id: bot.id, skill_id: skill.id, open_job_id: rec.id })
    d.system(job, `Opened from open job ${rec.id}: ${bot.name}'s bid of $${bid.quote.total_max.value} was awarded (${how === 'buyer' ? 'chosen by the buyer' : `automatic award: ${how.replace('_', ' ')}`}). ${others.length} other bid(s) were declined. Policy gate: ${verdict.class}${verdict.reasons.length ? ` (${verdict.reasons.join('; ')})` : ''}. Nothing is held yet: accept the contract, then the buyer funds the escrow.`, { open_job_id: rec.id, bid_id: bid.id })
    d.post(job, seller, 'requirements', `Requirements (from the bid): ${bid.requirements.access.length} access request(s), ${bid.requirements.questions.length} question(s).`, { requirements: bid.requirements, contract_version: job.version, from_bid: bid.id })
    d.post(job, seller, 'quote', `Quote (from the bid): up to $${bid.quote.total_max.value}, turnaround ${bid.quote.turnaround}.${bid.pitch ? ` Pitch (data from the seller): ${bid.pitch.slice(0, 300)}` : ''}`, { quote: bid.quote, contract_version: job.version, contract_hash: job.contract_hash, from_bid: bid.id })
    this.stats.feedItem('job_opened', `An open job was awarded to ${bot.name} for up to $${bid.quote.total_max.value}`, toCents(bid.quote.total_max.value))
    d.save(job)

    const now = d.nowIso()
    rec.state = 'awarded'
    rec.awarded_bid_id = bid.id
    rec.job_id = job.id
    rec.closed_at = now
    rec.close_reason = `Awarded to ${bot.name} (${how === 'buyer' ? 'chosen by the buyer' : how.replace('_', ' ')}).`
    for (const b of rec.bids) {
      if (b.id === bid.id) b.status = 'awarded'
      else if (b.status === 'active') b.status = 'declined'
      b.updated_at = now
    }
    this.save(rec)
    this.publish('bid_awarded', rec, [bid.agent_id], `${bot.name}: your bid won "${rec.title}" ($${bid.quote.total_max.value}). A job is open: accept the contract.`, { bid_id: bid.id, bot_id: bid.bot_id, job_id: job.id }, job.id)
    for (const b of others) this.publish('bid_declined', rec, [b.agent_id], `${d.bot(b.bot_id)?.name ?? 'Your bot'}: your bid on "${rec.title}" was declined (another bid won).`, { bid_id: b.id, bot_id: b.bot_id, reason: 'another bid won' })
    this.publish('open_job_closed', rec, [rec.buyer_agent_id, ...rec.bids.map((b) => b.agent_id)], `Open job "${rec.title}" closed: awarded to ${bot.name}.`, { outcome: 'awarded', bid_id: bid.id, bot_id: bid.bot_id, job_id: job.id })
    return job
  }

  /** Close without an award: no bid, or a manual job nobody awarded in time. Standing bids are declined. */
  expireLocked(rec: OpenJobRecord, reason: string) {
    const now = this.d.nowIso()
    const declined = rec.bids.filter((b) => b.status === 'active')
    for (const b of declined) {
      b.status = 'declined'
      b.updated_at = now
    }
    rec.state = 'expired'
    rec.closed_at = now
    rec.close_reason = reason
    this.save(rec)
    for (const b of declined) this.publish('bid_declined', rec, [b.agent_id], `${this.d.bot(b.bot_id)?.name ?? 'Your bot'}: your bid on "${rec.title}" was declined (${reason.toLowerCase().replace(/\.$/, '')}).`, { bid_id: b.id, bot_id: b.bot_id, reason })
    this.publish('open_job_closed', rec, [rec.buyer_agent_id, ...rec.bids.map((b) => b.agent_id)], `Open job "${rec.title}" closed with no award: ${reason}`, { outcome: 'expired', reason, next_actions: this.nextActionsForBuyer(rec) })
  }

  /** The scheduler: auto-award or expire every open job whose window has closed. */
  async tick() {
    const now = this.d.nowMs()
    const due = this.d.db.all<{ id: string }>("SELECT id FROM open_jobs WHERE state = 'open' AND bid_until <= ?", new Date(now).toISOString()).map((r) => r.id)
    for (const id of due) {
      await this.d.withLock(`open:${id}`, async () => {
        const rec = this.tryLoad(id)
        if (!rec || rec.state !== 'open' || this.d.nowMs() < Date.parse(rec.bid_until)) return
        const candidates = this.awardable(rec)
        if (rec.award === 'manual') {
          if (!candidates.length) this.expireLocked(rec, rec.bids.some((b) => b.status === 'active') ? 'every standing bid expired or its bot left before the buyer chose.' : 'The bid window closed with no bids.')
          else if (this.d.nowMs() >= Date.parse(rec.award_until)) this.expireLocked(rec, 'The buyer did not award a bid in time.')
          return
        }
        if (!candidates.length) return this.expireLocked(rec, rec.bids.some((b) => b.status === 'active') ? 'every standing bid expired or its bot left before the window closed.' : 'The bid window closed with no bids.')
        const ranked = rec.award === 'lowest_price' ? this.byPrice(candidates) : this.byRecord(candidates)
        for (const b of ranked) {
          try {
            await this.awardLocked(rec, b, rec.award)
            return
          } catch (e) {
            if (!(e instanceof OpError)) throw e
            // This bid cannot become a job (policy, bot gone): try the next best one.
          }
        }
        this.expireLocked(rec, 'No standing bid could be turned into a job.')
      })
    }
    // Manual jobs whose bid window has closed with bids wait for the buyer until award_until; the query above already returns them.
  }
}
