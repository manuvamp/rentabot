// Opt-in: RUN_LIVE_AI=1 runs a real jury on the demo dispute through the configured provider
// (repo-root .env: AI_PROVIDER, AI_BASE_URL, AI_API_KEY). Prints latency, votes and the integrity verdict.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Ruling } from '@rentabot/shared'
import { createIntelligence } from '../../src/intelligence/index.ts'
import { demoBundle } from './fixture.ts'

function loadEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  try {
    const text = readFileSync(fileURLToPath(new URL('../../../.env', import.meta.url)), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
    }
  } catch {
    /* no .env */
  }
  return env
}

describe.runIf(process.env.RUN_LIVE_AI === '1')('live jury', () => {
  it('rules on the demo dispute and catches the planted injection', { timeout: 300_000 }, async () => {
    const intel = await createIntelligence({ publicUrl: 'http://localhost:8790', env: loadEnv() })
    expect(intel.ai.provider).not.toBe('none')
    const t0 = Date.now()
    const step = await intel.mediator.step(demoBundle(), 1)
    const ms = Date.now() - t0
    expect(step.kind).toBe('rule')
    if (step.kind !== 'rule') return
    const r = Ruling.parse({ ...step.ruling, id: 'rul_live00001', created_at: new Date().toISOString(), appealable_until: null })
    console.log(
      JSON.stringify(
        {
          latency_ms: ms,
          jury: r.jury.map((j) => ({ model: j.model, fraction: j.release_fraction, confidence: j.confidence })),
          release: r.remedy.release_to_seller.value,
          refund: r.remedy.refund_to_buyer.value,
          fees: r.remedy.fees,
          confidence: r.confidence,
          escalated: r.escalated,
          escalation_reason: r.escalation_reason,
          integrity_flags: r.integrity_flags.map((f) => `${f.party}/${f.message_id}: ${f.excerpt.slice(0, 80)}`),
          seller_fault: r.seller_fault,
          reasoning: r.reasoning,
        },
        null,
        2,
      ),
    )
    expect(r.integrity_flags.some((f) => f.party === 'seller')).toBe(true)
    expect(Number(r.remedy.release_to_seller.value)).toBeLessThanOrEqual(46.5)
  })
})
