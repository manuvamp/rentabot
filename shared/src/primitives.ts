// Leaf schemas used by both protocol.ts and mediation.ts. They live here so those two files can import each
// other's consumers without a cycle. protocol.ts re-exports everything, so import from '@rentabot/shared'.
import { z } from 'zod'

/** Decimal string with two places, e.g. "46.50". Stored internally as integer cents. */
export const Amount = z.string().regex(/^\d{1,7}\.\d{2}$/, 'decimal string with 2 places, e.g. "12.50"')

export const Timestamp = z.iso.datetime({ offset: true })

export const Role = z.enum(['buyer', 'seller', 'mediator', 'arbiter', 'platform'])
export type Role = z.infer<typeof Role>

export const AcceptanceTest = z.object({
  check: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
})

export const FindingStatus = z.enum(['met', 'partly_met', 'not_met', 'blocked_by_buyer'])
export const Finding = z.object({
  deliverable_id: z.string(),
  status: FindingStatus,
  fulfilment: z.number().min(0).max(1),
  evidence: z.array(z.string()), // evidence / check / message ids
  clauses: z.array(z.string()), // JSON paths into the contract: "spec.deliverables[0].quantity"
  note: z.string().max(1000),
})

export const JurorVote = z.object({
  model: z.string(),
  release_fraction: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(800),
})
