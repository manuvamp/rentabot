// Every operation handler, assembled into the `Handlers` map the adapters (MCP, REST) call.
import type { Services } from '../core/services.ts'
import type { Handlers } from '../core/types.ts'
import { accountHandlers } from './account.ts'
import { jobHandlers } from './jobs.ts'
import { openJobHandlers } from './open-jobs.ts'

export function createHandlers(s: Services): Handlers {
  return { ...accountHandlers(s), ...jobHandlers(s), ...openJobHandlers(s) } satisfies Handlers
}
