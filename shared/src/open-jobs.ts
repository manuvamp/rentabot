// Open jobs: a buyer posts one job spec to every matching bot, bots bid, the buyer awards one bid and it
// continues as a normal job (docs/PROTOCOL.md section 7). The operations live in ops.ts; the shapes are here.
import { z } from 'zod'
import { CapabilityClass, Duration, Id, JobSpec, Money, PolicyClass, Quote, Requirements, Timestamp } from './protocol.ts'

/** How the open job is awarded: the buyer picks, or the platform picks when the bid window closes. */
export const AwardMode = z.enum(['manual', 'lowest_price', 'best_record'])
export type AwardMode = z.infer<typeof AwardMode>

export const OpenJobState = z.enum([
  'open', // bids are being collected (manual jobs stay open for the award until award_until)
  'awarded', // a bid won and a normal job exists (job_id)
  'expired', // the window closed with no bid, or a manual job was never awarded
])
export type OpenJobState = z.infer<typeof OpenJobState>

export const BidStatus = z.enum(['active', 'withdrawn', 'awarded', 'declined'])
export type BidStatus = z.infer<typeof BidStatus>

/** A bot's record on the platform, from the same numbers as get_leaderboard. Rates are null until the bot has the jobs to measure them. */
export const TrackRecord = z.object({
  jobs_settled: z.int().nonnegative(),
  jobs_funded: z.int().nonnegative(),
  verified_units: z.int().nonnegative(),
  units_checked: z.int().nonnegative(),
  pass_rate: z.number().min(0).max(1).nullable(),
  on_time_rate: z.number().min(0).max(1).nullable(),
  dispute_rate: z.number().min(0).max(1).nullable(),
  disputes: z.int().nonnegative(),
})
export type TrackRecord = z.infer<typeof TrackRecord>

export const RequirementsSummary = z.object({
  /** Names of the inputs the bot asks the buyer for (properties of inputs_schema). */
  inputs: z.array(z.string()),
  required_inputs: z.array(z.string()),
  access: z.array(z.object({ id: z.string(), kind: z.string(), scope: z.string(), required: z.boolean() })),
  questions: z.int().nonnegative(),
  assumptions: z.array(z.string()),
})
export type RequirementsSummary = z.infer<typeof RequirementsSummary>

export const Bid = z.object({
  id: Id.bid,
  open_job_id: Id.open_job,
  bot_id: Id.bot,
  bot_name: z.string(),
  bot_tagline: z.string(),
  status: BidStatus,
  /** quote.total_max: what escrow would hold. */
  price: Money,
  turnaround: Duration,
  pitch: z.string().max(500),
  requirements: Requirements,
  quote: Quote,
  requirements_summary: RequirementsSummary,
  track_record: TrackRecord,
  created_at: Timestamp,
})
export type Bid = z.infer<typeof Bid>

export const OpenJob = z.object({
  id: Id.open_job,
  state: OpenJobState,
  title: z.string().max(140),
  /** The buyer's spec. In every view except the buyer's own, `context` and `context_artifact_ids` are blanked: no private data is published. */
  spec: JobSpec,
  category: CapabilityClass.nullable(),
  award: AwardMode,
  bid_window: Duration,
  /** Bids are accepted until this time. */
  bid_until: Timestamp,
  /** Last moment a manual job can still be awarded (auto modes award at bid_until). */
  award_until: Timestamp,
  /** Bids currently standing (not withdrawn). */
  bids_count: z.int().nonnegative(),
  /** Listed bots that have the spec's skill and could bid. */
  matching_bots: z.int().nonnegative(),
  awarded_to: z.object({ bot_id: Id.bot, bot_name: z.string(), price: Money }).nullable(),
  close_reason: z.string().nullable(),
  created_at: Timestamp,
  closed_at: Timestamp.nullable(),
  // ---- the buyer's own view only ----
  policy: z.object({ class: PolicyClass, reasons: z.array(z.string()) }).optional(),
  awarded_bid_id: Id.bid.nullable().optional(),
  /** The normal job the award created. */
  job_id: Id.job.nullable().optional(),
  context: z.string().optional(),
  context_artifact_ids: z.array(Id.artifact).optional(),
  // ---- a signed-in seller's view: the caller's own bids on this job ----
  my_bids: z.array(z.object({ bid_id: Id.bid, bot_id: Id.bot, status: BidStatus })).optional(),
})
export type OpenJob = z.infer<typeof OpenJob>
