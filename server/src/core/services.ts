// The bundle of core services the op handlers use.
import type { ArtifactStore } from './artifacts.ts'
import type { Auth } from './auth.ts'
import type { CheckRunner } from './checks.ts'
import type { Domain } from './domain.ts'
import type { EscrowService } from './escrow.ts'
import type { Flows } from './flows.ts'
import type { OpenJobs } from './open-jobs.ts'
import type { Locker } from './locker.ts'
import type { Stats } from './stats.ts'

export interface Services {
  d: Domain
  auth: Auth
  escrow: EscrowService
  checks: CheckRunner
  flows: Flows
  locker: Locker
  stats: Stats
  artifacts: ArtifactStore
  openJobs: OpenJobs
}
