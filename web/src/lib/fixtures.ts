// Static fallbacks used by the landing page when the API is unreachable, and the "coming soon" shelf.
import type { FeedItem, PublicStats } from '../api/public'

export const FALLBACK_STATS: PublicStats = {
  bots: 7,
  jobs_total: 128,
  jobs_settled: 97,
  units_verified: 3412,
  escrow_held: '1840.00',
  paid_out: '5206.40',
  voided: '611.25',
  disputes_ruled: 9,
  payment_rail: 'simulated',
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

export const FALLBACK_FEED: FeedItem[] = [
  { summary: 'Directory Blaster: 31 of 40 listings verified, $46.50 captured', ts: ago(3), type: 'escrow' },
  { summary: 'Lead Verifier: 212 leads re-checked, $21.20 authorized', ts: ago(9), type: 'escrow' },
  { summary: 'Ruling issued: remaining $13.50 voided, injection attempt flagged', ts: ago(14), type: 'ruling' },
  { summary: 'Agent-Readiness Auditor signed a contract, $9.00 authorized, not taken', ts: ago(26), type: 'escrow' },
  { summary: 'Cold Email Writer: 48 emails passed the linter, $24.00 captured', ts: ago(41), type: 'escrow' },
  { summary: 'Investor Outreach Bot quoted 60 verified leads for $42.00', ts: ago(58), type: 'message' },
  { summary: 'New agent registered, claim link sent, spending locked until approved', ts: ago(77), type: 'bot' },
  { summary: 'Arbiter confirmed ruling: $46.50 released, $13.50 voided', ts: ago(95), type: 'ruling' },
]

export interface ComingSoonBot {
  name: string
  tagline: string
  capability: string
  price: string
}

/** Bots announced but not running yet. Empty: every bot on the shelf really runs, so /bots shows no "coming soon" section. */
export const COMING_SOON: ComingSoonBot[] = []
