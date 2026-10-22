// Entry point of the AI and verification layer. The core calls only what `Intelligence` exposes.
import type { Intelligence } from './types.ts'
import { createAiClient, readAiConfig, type AiClient } from './ai/provider.ts'
import { guardAiClient } from './ai/redact-guard.ts'
import { createCheckLibrary } from './checks/library.ts'
import { createCopilot } from './copilot/copilot.ts'
import { createMediator } from './mediator/mediator.ts'
import { createNegotiator } from './negotiation/negotiator.ts'
import type { SettlementFees } from './negotiation/terms.ts'
import { createPolicyGate } from './policy/gate.ts'

export async function createIntelligence(opts: {
  publicUrl: string
  allowHosts?: string[]
  env?: NodeJS.ProcessEnv
  /** The core's fee policy (settlementFeesFrom(config.fees)), so proposals and rulings use the commission rule the payout uses. */
  fees?: SettlementFees
  /** Inject the model client (tests: a recorder). It is wrapped by the credential guard like the real one. */
  aiClient?: AiClient
}): Promise<Intelligence> {
  const env = opts.env ?? process.env
  const config = readAiConfig(env)
  // Every model call passes the credential guard: locker values and credential-looking strings never reach a provider.
  const ai = guardAiClient(opts.aiClient ?? createAiClient(config))
  // The server's own host:port (Sandbox Web) is always reachable by checks; nothing else private is.
  const allowHosts = [...(opts.allowHosts ?? [])]
  try {
    const u = new URL(opts.publicUrl)
    allowHosts.push(`${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`)
  } catch {
    /* no public URL: no extra host */
  }
  const escalate = Number(env.MEDIATION_ESCALATE_ABOVE_CENTS)
  const escalateAboveCents = Number.isFinite(escalate) && escalate > 0 ? escalate : undefined
  return {
    ai: { provider: config.provider, models: config.models },
    // The one capped client (spend ledger): the in-process house bots reuse it instead of calling a model themselves.
    aiClient: ai,
    checks: createCheckLibrary({ allowHosts }),
    policy: createPolicyGate({ ai }),
    copilot: createCopilot({ ai }),
    mediator: createMediator({ ai, escalateAboveCents }),
    negotiator: createNegotiator({
      ai,
      juryModels: config.models.jury,
      mediatorModel: config.models.mediator,
      ...(opts.fees ? { fees: opts.fees } : {}),
      ...(escalateAboveCents !== undefined ? { escalateAboveCents } : {}),
    }),
  }
}

export { computeRemedy } from './mediator/remedy.ts'
export { createNegotiator, findAgreement, roundComplete, makeCounterProposal } from './negotiation/negotiator.ts'
export { settlementFeesFrom, SETTLEMENT_FEES, commissionCents } from './negotiation/terms.ts'
export { scanText, scanAll } from './mediator/injection.ts'
export { safeFetch, isBlockedIp, assertFetchableUrl } from './checks/safe-fetch.ts'
