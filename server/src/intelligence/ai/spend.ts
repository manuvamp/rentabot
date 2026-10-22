// Hard cap on real-money model spend. Every paid call is priced from the usage the API returns and
// added to a ledger persisted in DATA_DIR/ai-spend.json (per calendar month). Once the month's total
// reaches AI_SPEND_CAP_USD, paid calls throw AiUnavailable and every feature falls back to its
// deterministic path (checks-only rulings, template specs, policy review by a human).
// Calls through the local dev proxy are not billed to us and are not counted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** USD per million tokens, Anthropic first-party rates (cached 2026-10-06). Unknown models price as Opus. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
}
const FALLBACK_PRICE = PRICES['claude-opus-5-5']!

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export function priceUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? FALLBACK_PRICE
  const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1
  return (input * p.input + u.output_tokens * p.output) / 1_000_000
}

interface LedgerFile {
  month: string
  usd: number
  calls: number
  by_model: Record<string, { calls: number; usd: number }>
}

export class SpendLedger {
  readonly capUsd: number
  private readonly file: string | null
  private state: LedgerFile

  constructor(opts: { capUsd: number; file: string | null }) {
    this.capUsd = opts.capUsd
    this.file = opts.file
    this.state = this.load()
  }

  private month() {
    return new Date().toISOString().slice(0, 7)
  }

  private load(): LedgerFile {
    const empty = { month: this.month(), usd: 0, calls: 0, by_model: {} }
    if (!this.file || !existsSync(this.file)) return empty
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile
      return s.month === this.month() ? s : empty
    } catch {
      return empty
    }
  }

  /** Throws when the cap is reached. Call before every paid request. */
  assertBudget(): void {
    if (this.state.month !== this.month()) this.state = { month: this.month(), usd: 0, calls: 0, by_model: {} }
    if (this.state.usd >= this.capUsd) {
      throw new SpendCapReached(`AI spend cap reached: $${this.state.usd.toFixed(2)} of $${this.capUsd.toFixed(2)} this month`)
    }
  }

  record(model: string, usage: Usage): number {
    const usd = priceUsd(model, usage)
    this.state.usd += usd
    this.state.calls += 1
    const m = (this.state.by_model[model] ??= { calls: 0, usd: 0 })
    m.calls += 1
    m.usd += usd
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    }
    return usd
  }

  snapshot() {
    return { ...this.state, cap_usd: this.capUsd }
  }
}

export class SpendCapReached extends Error {}
