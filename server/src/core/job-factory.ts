// The one place a fresh job record is built: create_job (the buyer picked a bot) and award_bid (the buyer picked a bid) both use it,
// so a job that starts from an open job carries exactly the same contract terms and fee policy as a directly hired one.
import { Timers, type BotCard, type JobSpec, type PolicyClass, type Skill } from '@rentabot/shared'
import type { Domain } from './domain.ts'
import { newEscrow, type JobRecord } from './model.ts'
import { newId, toAmount } from './util.ts'

export function newJobRecord(d: Domain, a: { buyer_agent_id: string; bot: BotCard; skill: Skill; spec: JobSpec; title: string; verdict: { class: PolicyClass; reasons: string[] } }): JobRecord {
  const { bot, skill } = a
  const now = d.nowIso()
  return {
    id: newId('job'),
    state: 'NEGOTIATING',
    title: a.title.slice(0, 140),
    buyer_agent_id: a.buyer_agent_id,
    seller_bot_id: bot.id,
    seller_agent_id: bot.operator_agent_id,
    skill_id: skill.id,
    capability_class: bot.capability_class,
    requires_scope_proof: bot.policy.requires_scope_proof || bot.capability_class === 'security',
    spec: a.spec,
    requirements: null,
    quote: null,
    answers: {},
    inputs: {},
    timers: Timers.parse({ verify_window: skill.verify_window }),
    fees: { platform_bps: d.cfg.fees.commission_bps, mediation_flat: d.cfg.mediationFlat, floor: toAmount(d.cfg.fees.floor_cents), min_settlement: toAmount(d.cfg.fees.min_settlement_cents) },
    amendments: [],
    agreement: null,
    version: 1,
    contract_hash: null,
    accepted_by: [],
    agreed_hash: null,
    escrow: newEscrow(d.rail.kind),
    delivery: null,
    delivered_at: null,
    delivery_count: 0,
    fulfilment: [],
    earned_cents: 0,
    held_pending_cents: 0,
    review: { accepted: false, accepted_at: null, rejections: [] },
    ruling: null,
    ruling_accepted_by: [],
    mediation: null,
    appeal: null,
    deadlines: { fund_by: null, deliver_by: null, review_until: null, cure_until: null, appeal_until: null, verify_until: null },
    blocked_since: null,
    policy: a.verdict,
    req: {},
    on_time: null,
    settled_at: null,
    created_at: now,
    updated_at: now,
  }
}
