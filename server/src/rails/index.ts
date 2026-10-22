// Picks the payment rail from config: PayPal credentials present → PayPal REST (sandbox unless
// PAYPAL_ENV=live); otherwise the simulated rail.
import type { AppConfig } from '../config.ts'
import type { Db } from '../db/index.ts'
import { createPayPalRail } from './paypal.ts'
import { SimulatedRail, type SimulatedRailOptions } from './simulated.ts'
import type { PaymentRail } from './types.ts'

export function createRail(cfg: AppConfig, db: Db, now: () => Date, authorizationValidityMs: number, sim: Partial<SimulatedRailOptions> = {}): PaymentRail {
  if (cfg.rail !== 'simulated' && cfg.paypal.clientId && cfg.paypal.clientSecret) {
    return createPayPalRail({
      clientId: cfg.paypal.clientId,
      clientSecret: cfg.paypal.clientSecret,
      webhookId: cfg.paypal.webhookId,
      env: cfg.rail === 'paypal_live' ? 'live' : 'sandbox',
      apiBase: cfg.paypal.apiBase,
      egressSecret: cfg.paypal.egressSecret,
    })
  }
  return new SimulatedRail({ db, publicUrl: cfg.publicUrl, now, authorizationValidityMs, fees: cfg.fees, ...sim })
}

export type { PaymentRail } from './types.ts'
export { SimulatedRail } from './simulated.ts'
