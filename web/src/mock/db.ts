// Shape of the in-browser mock database. Seeded by ./seed.ts, mutated by ./ops-write.ts.
import type { Agent, Artifact, BotCard, CheckDefinition, Job, Mandate, Message, PaymentRailKind } from '../api/types'

export type Persona = 'owner' | 'arbiter' | 'seller'

export interface MockUser {
  id: string
  name: string
  role: Persona
  email: string
  /** agent the persona acts as by default (null for the arbiter) */
  agent_id: string | null
}

export interface Db {
  rail: PaymentRailKind
  users: Record<string, MockUser>
  agents: Record<string, Agent>
  bots: Record<string, BotCard>
  jobs: Record<string, Job>
  /** Job Room per job id, in seq order. */
  messages: Record<string, Message[]>
  artifacts: Record<string, Artifact>
  /** One mandate per agent id (latest). */
  mandates: Record<string, Mandate>
  checks: CheckDefinition[]
  /** claim code -> agent id (agents registered through register_agent that await a human). */
  claims: Record<string, string>
  /** free scratch space for handlers (pending questions, timers, per-job work state) */
  scratch: Record<string, unknown>
}

export const IDS = {
  manu: 'usr_Manu000001',
  arbiter: 'usr_Arbiter0001',
  operator: 'usr_GlobOperator1',
  orano: 'agt_OranoGrowth01',
  glob: 'agt_GlobStudioOps',
  jobA: 'job_DirBlastOrano',
  jobB: 'job_OutreachOrano',
  jobC: 'job_AuditOranoSite',
  jobD: 'job_LeadsCheck0001',
  mandate: 'mdt_OranoGrowth01',
}
