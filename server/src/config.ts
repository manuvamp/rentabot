// Environment config. Reads `.env` at the repo root and `server/.env` (real env vars win), then
// derives the payment rail: PayPal credentials present → PayPal (sandbox unless PAYPAL_ENV=live),
// otherwise the simulated rail, which is labelled "simulated" everywhere.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FeePolicy } from './core/fees.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Minimal .env loader (KEY=value lines) so the project runs without extra dependencies.
for (const file of [join(ROOT, '.env'), join(ROOT, 'server', '.env')]) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const value = m[2].replace(/^["']|["']$/g, '')
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

const env = (key: string, fallback = '') => process.env[key]?.trim() || fallback
const num = (key: string, fallback: number) => {
  const n = Number(env(key, String(fallback)))
  return Number.isFinite(n) ? n : fallback
}

export type RailChoice = 'paypal_sandbox' | 'paypal_live' | 'simulated'

export interface AppConfig {
  port: number
  publicUrl: string
  dataDir: string
  demoMode: boolean
  /** Timers (contract durations, mediator answer windows) run this many times faster in demo mode. */
  demoTimeScale: number
  paypal: {
    clientId: string
    clientSecret: string
    webhookId: string
    env: 'sandbox' | 'live'
    /** PAYPAL_API_BASE: alternative API origin (egress proxy). Empty = the official URL for `env`. */
    apiBase?: string
    /** PAYPAL_EGRESS_SECRET: sent as `x-egress-key` on every PayPal request when set. */
    egressSecret?: string
  }
  /** Forced rail; by default derived from PayPal credentials. */
  rail: RailChoice
  /** Fee policy for fees.ts (commission, floor, minimum settlement, estimated PayPal costs). */
  fees: FeePolicy
  mediationFlat: string
  appealBond: string
  /** How long each mediation round stays open for answers (ISO duration; scaled by DEMO_TIME_SCALE in demo mode). */
  mediationRound: string
  /** Shortest real time an open job takes bids, however fast the demo clock runs (ms; 0 turns the floor off, as the simulator does). */
  bidWindowFloorMs: number
  /** Webhook fallback: a capture or payout still unconfirmed after this many seconds (scaled in demo mode) is looked up on PayPal. */
  reconcileAfterSeconds: number
  /** 32-byte key (hex) for AES-256-GCM sealing of job secrets. */
  sealKey: string
  /** Retired SEAL_KEYs (SEAL_KEYS_OLD, comma-separated): locker items sealed under them are re-wrapped under sealKey at boot. */
  sealKeysOld: string[]
  /** Scheduler tick; 0 disables the interval (tests tick by hand). */
  tickMs: number
}

const cents = (v: string) => Math.round(Number(v) * 100)
const money = (key: string, fallback: string) => {
  const v = env(key, fallback)
  return /^\d{1,7}(\.\d{1,2})?$/.test(v) ? Number(v).toFixed(2) : fallback
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const paypal = {
    clientId: env('PAYPAL_CLIENT_ID'),
    clientSecret: env('PAYPAL_CLIENT_SECRET'),
    webhookId: env('PAYPAL_WEBHOOK_ID'),
    env: (env('PAYPAL_ENV', 'sandbox') === 'live' ? 'live' : 'sandbox') as 'sandbox' | 'live',
    apiBase: env('PAYPAL_API_BASE').replace(/\/+$/, ''),
    egressSecret: env('PAYPAL_EGRESS_SECRET'),
    ...overrides.paypal,
  }
  const port = num('PORT', 8790)
  const base: AppConfig = {
    port,
    publicUrl: env('PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
    dataDir: resolve(ROOT, env('DATA_DIR', 'data')),
    demoMode: ['1', 'true', 'yes'].includes(env('DEMO_MODE', '1').toLowerCase()),
    demoTimeScale: Math.max(1, num('DEMO_TIME_SCALE', 1)),
    paypal,
    rail: paypal.clientId && paypal.clientSecret ? (paypal.env === 'live' ? 'paypal_live' : 'paypal_sandbox') : 'simulated',
    fees: {
      commission_bps: Math.max(0, Math.min(10_000, Math.round(num('PLATFORM_COMMISSION_PCT', 0.15) * 10_000))),
      floor_cents: cents(money('PLATFORM_FEE_FLOOR', '3.00')),
      min_settlement_cents: cents(money('MIN_SETTLEMENT', '5.00')),
      extra_settlement_cents: cents(money('EXTRA_SETTLEMENT_FEE', '1.00')),
      paypal_capture_bps: Math.round(num('PAYPAL_CAPTURE_PCT', 0.0349) * 10_000),
      paypal_capture_fixed_cents: cents(money('PAYPAL_CAPTURE_FIXED', '0.49')),
      paypal_payout_cents: cents(money('PAYPAL_PAYOUT_FEE', '0.25')),
    },
    mediationFlat: money('MEDIATION_FLAT', '1.00'),
    appealBond: money('APPEAL_BOND', '5.00'),
    mediationRound: /^P(?=\d|T\d)(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/.test(env('MEDIATION_ROUND', 'PT2H')) ? env('MEDIATION_ROUND', 'PT2H') : 'PT2H',
    bidWindowFloorMs: Math.max(0, num('BID_WINDOW_FLOOR_MS', 300_000)),
    reconcileAfterSeconds: Math.max(0, num('RECONCILE_AFTER_SECONDS', 60)),
    sealKey: env('SEAL_KEY'),
    sealKeysOld: env('SEAL_KEYS_OLD').split(',').map((k) => k.trim()).filter(Boolean),
    tickMs: num('TICK_MS', 3000),
  }
  const cfg: AppConfig = { ...base, ...overrides, paypal, fees: { ...base.fees, ...overrides.fees } }
  if (!overrides.rail && cfg.rail !== 'simulated' && !(paypal.clientId && paypal.clientSecret)) cfg.rail = 'simulated'
  cfg.sealKey = resolveSealKey(cfg.sealKey, cfg.dataDir)
  return cfg
}

/** "Log in with PayPal" (OAuth 2.0 authorization code against PayPal's Identity API). See docs/API.md "Accounts". */
export interface PayPalLoginConfig {
  enabled: boolean
  clientId: string
  clientSecret: string
  /** Where the browser is sent to consent: https://www.sandbox.paypal.com/connect (live: www.paypal.com). */
  authorizeUrl: string
  /** Token + userinfo origin. Defaults to PAYPAL_API_BASE (the egress proxy), else the official API for the env. */
  apiBase: string
  egressSecret: string
  scopes: string
  redirectUri: string
  /** HMAC key for the OAuth state. Empty: a random key per process (a restart only fails logins in flight). */
  stateSecret: string
}

export function loadPayPalLoginConfig(publicUrl: string): PayPalLoginConfig {
  const live = env('PAYPAL_LOGIN_ENV', env('PAYPAL_ENV', 'sandbox')) === 'live'
  const clientId = env('PAYPAL_LOGIN_CLIENT_ID', env('PAYPAL_CLIENT_ID'))
  const clientSecret = env('PAYPAL_LOGIN_CLIENT_SECRET', env('PAYPAL_CLIENT_SECRET'))
  const switchedOff = ['0', 'false', 'off', 'no'].includes(env('PAYPAL_LOGIN', 'on').toLowerCase())
  return {
    enabled: !switchedOff && !!clientId && !!clientSecret,
    clientId,
    clientSecret,
    authorizeUrl: env('PAYPAL_LOGIN_AUTHORIZE_URL', live ? 'https://www.paypal.com/connect' : 'https://www.sandbox.paypal.com/connect'),
    apiBase: env('PAYPAL_LOGIN_API_BASE', env('PAYPAL_API_BASE', live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')).replace(/\/+$/, ''),
    egressSecret: env('PAYPAL_EGRESS_SECRET'),
    scopes: env('PAYPAL_LOGIN_SCOPES', 'openid profile email https://uri.paypal.com/services/paypalattributes'),
    redirectUri: env('PAYPAL_LOGIN_REDIRECT_URI', `${publicUrl.replace(/\/+$/, '')}/api/auth/paypal/callback`),
    stateSecret: env('SESSION_SECRET'),
  }
}

/** SEAL_KEY from env (64 hex chars or any string, hashed to 32 bytes later), else one persisted in DATA_DIR. */
function resolveSealKey(fromEnv: string, dataDir: string): string {
  if (fromEnv) return fromEnv
  const file = join(dataDir, 'seal.key')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(dirname(file), { recursive: true })
  const key = randomBytes(32).toString('hex')
  writeFileSync(file, key + '\n', { mode: 0o600 })
  return key
}

/** Scale a duration for demo mode (60 → an hour passes in a minute). */
export const scaleMs = (cfg: Pick<AppConfig, 'demoMode' | 'demoTimeScale'>, ms: number) =>
  cfg.demoMode && cfg.demoTimeScale > 1 ? Math.round(ms / cfg.demoTimeScale) : ms
