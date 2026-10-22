// Opt-in: RUN_LIVE_AI=1 plays the demo negotiation through the configured provider (repo-root .env).
// mediator proposes -> seller counters "release $52.50" -> buyer accepts the redo option -> mediator revises -> both accept.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createAiClient, readAiConfig } from '../../../src/intelligence/ai/provider.ts'
import { createNegotiator, findAgreement } from '../../../src/intelligence/negotiation/negotiator.ts'
import type { Proposal } from '../../../src/intelligence/negotiation/types.ts'
import { demoBundle } from '../fixture.ts'
import { respond } from './helpers.ts'

function loadEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  try {
    const text = readFileSync(fileURLToPath(new URL('../../../../.env', import.meta.url)), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
    }
  } catch {
    /* no .env */
  }
  return env
}

const brief = (p: Proposal) => ({ id: p.id, kind: p.kind, release_now: p.terms.release_now, refund_now: p.terms.refund_now, held: p.preview?.held, redo_units: p.terms.redo?.units.length ?? 0, seller_payout_now: p.preview?.seller_payout_now, commission: p.preview?.platform_commission, rationale: p.rationale })

describe.runIf(process.env.RUN_LIVE_AI === '1')('live negotiation', () => {
  it('demo negotiation reaches agreement', { timeout: 600_000 }, async () => {
    const ai = createAiClient(readAiConfig(loadEnv()))
    expect(ai.enabled).toBe(true)
    const n = createNegotiator({ ai, now: () => new Date('2026-10-28T13:00:00Z') })
    const b = demoBundle()
    const log: Record<string, unknown> = {}
    let t = Date.now()
    const a = await n.assess(b)
    log.assess = { ms: Date.now() - t, fair_range: a.fair_range, verified: a.verified_value, basis: a.basis, jury: a.jury.map((j) => `${j.model} ${j.release_fraction}`), flags: a.integrity_flags.map((f) => `${f.party}: ${f.excerpt.slice(0, 60)}`) }

    t = Date.now()
    const r1 = await n.propose(b, a, [], 1)
    log.round1 = { ms: Date.now() - t, message: r1.message, proposals: r1.proposals.map(brief) }
    expect(r1.proposals.length).toBeGreaterThan(0)
    const redo = r1.proposals.find((p) => p.kind === 'redo') ?? r1.proposals[r1.proposals.length - 1]!
    for (const p of r1.proposals) {
      if (p === redo) respond(p, 'buyer', { answer: 'accept' })
      else respond(p, 'buyer', { answer: 'reject', reason: 'I prefer the redo option.' })
      respond(p, 'seller', { answer: 'counter', terms: { release_now: '52.50' }, reason: 'Four of the failed listings are live; moderation will add the ORANO name within days.' })
    }

    t = Date.now()
    const r2 = await n.propose(b, a, r1.proposals, 2)
    log.round2 = { ms: Date.now() - t, message: r2.message, proposals: r2.proposals.map(brief) }
    expect(r2.proposals.length).toBeGreaterThan(0)
    const pick = r2.proposals[0]!
    respond(pick, 'buyer', { answer: 'accept' })
    respond(pick, 'seller', { answer: 'accept' })
    const history = [...r1.proposals, ...r2.proposals]
    const r3 = await n.propose(b, a, history, 3)
    log.result = { outcome: r3.outcome, agreed: r3.agreed_proposal_id, message: r3.message }
    console.log(JSON.stringify(log, null, 2))
    expect(r3.outcome).toBe('agreed')
    expect(findAgreement(history)?.id).toBe(pick.id)
    const rel = Number(pick.terms.release_now)
    expect(rel).toBeGreaterThanOrEqual(46.5)
    expect(rel).toBeLessThanOrEqual(52.5)
  })
})
