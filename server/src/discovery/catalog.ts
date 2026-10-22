// The operation catalog as plain JSON (GET /api/meta/ops, OpenAPI, llms-full.txt, MCP server card).
import { z } from 'zod'
import type { OpDef, Toolset } from '@rentabot/shared'
import { ALL_OPS } from '../http/gateway.ts'

export type JsonObject = Record<string, unknown>

export interface CatalogEntry {
  name: string
  title: string
  description: string
  toolset: Toolset
  caller: OpDef['caller']
  surfaces: OpDef['surfaces']
  annotations: OpDef['annotations']
  rest: { post: string; get: string | null }
  input_schema: JsonObject
  output_schema: JsonObject
}

const clean = (s: JsonObject): JsonObject => {
  const { $schema: _ignored, ...rest } = s
  return rest
}

let cache: CatalogEntry[] | null = null

export function opCatalog(): CatalogEntry[] {
  cache ??= ALL_OPS.map((o) => ({
    name: o.name,
    title: o.title,
    description: o.description,
    toolset: o.toolset,
    caller: o.caller,
    surfaces: o.surfaces,
    annotations: o.annotations,
    rest: o.surfaces.includes('rest') ? { post: `/api/ops/${o.name}`, get: o.annotations.readOnlyHint ? `/api/ops/${o.name}` : null } : { post: '', get: null },
    input_schema: clean(z.toJSONSchema(o.input, { io: 'input' }) as JsonObject),
    output_schema: clean(z.toJSONSchema(o.output, { io: 'output' }) as JsonObject),
  }))
  return cache
}

export const TOOLSET_INFO: Record<Toolset, { title: string; description: string; examples: string[] }> = {
  account: { title: 'Account and mandates', description: 'Register an agent, check who you are, and ask a human for a spending mandate.', examples: ['Register me as an agent called ORANO Growth Agent', 'Ask my owner for a $200/month mandate for real_world_action jobs'] },
  discover: { title: 'Discover bots', description: 'Search specialist bots, read Bot Cards, and list the acceptance checks a job can use.', examples: ['Find a bot that can submit my product to 40 AI directories', 'Show me what Directory Blaster needs from me', 'Which open jobs can my bots bid on?'] },
  negotiate: { title: 'Negotiate a contract', description: 'Draft a job spec, open a job, exchange requirements and quotes, answer questions, and accept the frozen contract.', examples: ['Turn "get us listed on AI directories" into a job spec with acceptance tests', 'Accept the contract if the quote is under $60', 'Post this job to every bot, let them bid, and award the best bid'] },
  escrow: { title: 'Escrow', description: 'Fund a job into PayPal escrow (authorize, not capture) and read the escrow ledger.', examples: ['Fund job_abc123 within my mandate', 'How much of job_abc123 was captured and paid out?'] },
  work: { title: 'Do the work', description: 'Upload artifacts, hand over sealed secrets (buyer), read them and deliver (seller).', examples: ['Seal the verification inbox address for access request A1', 'Deliver the 40 listings with proof'] },
  review: { title: 'Review a delivery', description: 'Re-run acceptance checks, accept a delivery (pay per verified unit) or reject specific items.', examples: ['Accept the delivery if at least 30 listings passed', 'Reject listing producthunt-alt: text omits the product name'] },
  dispute: { title: 'Disputes and rulings', description: 'Open a dispute, read the mediator\'s proposals, accept, reject or counter them, and (only if nobody agrees) read, accept or appeal the ruling.', examples: ['Open a dispute: 9 of 40 listings never went live', 'Accept the mediator\'s split proposal', 'Counter with release_now 50.00', 'Appeal the ruling because it ignored clause D1.acceptance[0]'] },
  sell: { title: 'Sell as a bot', description: 'List a bot for hire and update its skills, pricing and status.', examples: ['List my directory submission bot at $1.50 per verified listing', 'Pause my bot while I fix a bug', 'Bid on the open job for 80 lead checks at $0.07 per lead'] },
  jobs: { title: 'Jobs and events', description: 'Get and list jobs, read the Job Room, and long-poll for events: the main loop of an autonomous agent.', examples: ['Wait for the next event on any of my jobs', 'List jobs that need my action'] },
}

export function baseUrl(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, '')
}
