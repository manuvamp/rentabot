// find_leads on the shelf: the Lead Verifier's second skill and its bot-owned Hunter.io connection are listed only while the server
// has HUNTER_API_KEY, reach an existing production database at boot (backfillHouseBriefs) with no reset, and the platform keeps the
// key out of every prompt, message and delivery.
import { afterEach, describe, expect, it } from 'vitest'
import type { BotCard } from '@rentabot/shared'
import { backfillHouseBriefs } from '../../src/seed/index.ts'
import { authoredCard, HOUSE_BOTS, hunterConfigured } from '../../src/seed/bots.ts'
import { clearPlatformSecrets, registerPlatformSecret, scrubForAi } from '../../src/intelligence/ai/redact-guard.ts'
import { harness, type Harness } from './helpers.ts'

let h: Harness
const oldKey = process.env.HUNTER_API_KEY
const KEY = 'shelftestkey0123456789abcdef0123456789'
afterEach(async () => {
  const open = h
  h = undefined as never
  await open?.close()
  clearPlatformSecrets()
  if (oldKey === undefined) delete process.env.HUNTER_API_KEY
  else process.env.HUNTER_API_KEY = oldKey
})

const lead = (d: { db: { get<T>(sql: string, ...p: unknown[]): T | undefined } }, id: string) => JSON.parse(d.db.get<{ data: string }>('SELECT data FROM bots WHERE id = ?', id)!.data) as BotCard
const FIND = 'find_leads'

describe('find_leads shelf', () => {
  it('without the key the card does not offer the skill or the connection (the shelf stays honest)', async () => {
    delete process.env.HUNTER_API_KEY
    expect(hunterConfigured()).toBe(false)
    h = await harness()
    const card = lead(h.core.internal.services.d, h.bots['Lead Verifier']!)
    expect(card.skills.map((s) => s.id)).toEqual(['verify_leads'])
    expect(card.passport?.connections.map((c) => c.name)).not.toContain('Hunter.io')
    expect(card.passport?.tools.map((t) => t.name)).not.toContain('Lead finder')
    expect(JSON.stringify(card.passport)).not.toMatch(/Hunter/)
    // the code still knows the skill, so the bot can answer if a job for it ever arrives; it declines then (bots/test/lead-finder.test.ts)
    expect(HOUSE_BOTS.find((b) => b.name === 'Lead Verifier')!.skills.map((s) => s.id)).toEqual(['verify_leads', FIND])
  })

  it('with the key a new database lists find_leads with its own brief, and a bot-owned, platform-verified Hunter.io connection', async () => {
    process.env.HUNTER_API_KEY = KEY
    h = await harness()
    const card = lead(h.core.internal.services.d, h.bots['Lead Verifier']!)
    expect(card.skills.map((s) => s.id)).toEqual(['verify_leads', FIND])
    const [verify, find] = card.skills
    expect(find!.pricing).toMatchObject({ model: 'per_unit', price: '0.35', unit: 'verified_lead', min_units: 18, max_units: 100 })
    expect(find!.checks).toEqual(['lead_verified'])
    expect(find!.brief?.needs.map((n) => n.label)).toEqual(['Your target companies', 'How many leads', 'A department or seniority (optional)', 'Role addresses or named people (optional)'])
    expect(find!.brief?.does.map((d) => d.action)).toEqual(['call_api', 'browse', 'call_api'])
    expect(verify!.brief?.needs[0]?.label).toBe('Your lead list (JSONL)')
    const hunter = card.passport!.connections.find((c) => c.name === 'Hunter.io')!
    expect(hunter).toMatchObject({ kind: 'data_api', owner: 'bot', verified: true })
    expect(hunter.purpose).toMatch(/free account: 50 domain searches a month/)
    expect(card.passport!.tools.map((t) => t.name)).toContain('Lead finder')
    // the minimum clears the $5.00 settlement with room for the typical 15% failures: 18 x $0.35 = $6.30, 3 may fail
    expect(18 * 35).toBeGreaterThanOrEqual(500 + Math.ceil(18 * 0.15) * 35)
    // Budget Lead Verifier is untouched
    const budget = lead(h.core.internal.services.d, h.bots['Budget Lead Verifier']!)
    expect(budget.skills.map((s) => s.id)).toEqual(['verify_leads'])
    expect(JSON.stringify(budget.passport)).not.toMatch(/Hunter/)
  })

  it('reaches an existing production database at boot with no reset: id, status and reputation stay, it is idempotent, and it leaves again with the key', async () => {
    delete process.env.HUNTER_API_KEY
    h = await harness() // production before this release: Lead Verifier with only verify_leads and no Hunter connection
    const s = h.core.internal.services
    const d = s.d
    const before = lead(d, h.bots['Lead Verifier']!)
    d.db.run('UPDATE bots SET data = ? WHERE id = ?', JSON.stringify({ ...before, reputation: { ...before.reputation, jobs_completed: 7 }, status: 'paused' }), before.id)

    process.env.HUNTER_API_KEY = KEY // the owner adds the key and restarts
    backfillHouseBriefs(s)
    const after = lead(d, before.id)
    expect(after.skills.map((x) => x.id)).toEqual(['verify_leads', FIND])
    expect(after.passport!.connections.map((c) => c.name)).toContain('Hunter.io')
    expect(after.skills[1]!.brief?.returns[0]?.label).toBe('Verified leads: address, name, role and the page it is on')
    expect(after).toMatchObject({ id: before.id, status: 'paused', reputation: { jobs_completed: 7 } }) // an operator pause and the record survive
    expect(after.description).toMatch(/\$0\.35 a lead, minimum 18/)
    backfillHouseBriefs(s) // idempotent
    expect(lead(d, before.id)).toEqual(after)

    delete process.env.HUNTER_API_KEY // key removed: the shelf stops offering it at the next boot
    backfillHouseBriefs(s)
    const gone = lead(d, before.id)
    expect(gone.skills.map((x) => x.id)).toEqual(['verify_leads'])
    expect(JSON.stringify(gone.passport)).not.toMatch(/Hunter/)
    expect(gone.status).toBe('paused')
    expect(gone.description).not.toMatch(/Hunter/)
  })

  it('authoredCard reads the environment it is given', () => {
    const lv = HOUSE_BOTS.find((b) => b.name === 'Lead Verifier')!
    expect(authoredCard(lv, { HUNTER_API_KEY: '  ' }).skills).toHaveLength(1)
    expect(authoredCard(lv, { HUNTER_API_KEY: KEY }).skills).toHaveLength(2)
    expect(authoredCard(HOUSE_BOTS.find((b) => b.name === 'Directory Blaster')!, {}).skills).toHaveLength(1)
  })
})

describe('the platform keeps the Hunter key out of prompts, messages and deliveries', () => {
  it('scrubs it from any AI prompt and refuses a message, delivery or input that carries it', async () => {
    h = await harness()
    registerPlatformSecret(KEY)
    expect(scrubForAi(`call it with X-API-KEY ${KEY} please`)).not.toContain(KEY)
    expect(scrubForAi(`call it with X-API-KEY ${KEY} please`)).toContain('[withheld: credential]')
    const spec = {
      skill_id: 'verify_leads',
      goal: 'Verify these leads honestly.',
      deliverables: [{ id: 'D1', description: 'Verdicts', quantity: 60, acceptance: [{ check: 'lead_verified', params: {} }], rubric: '' }],
      deadline: new Date(h.clock.t + 7 * 86_400_000).toISOString(),
      budget_cap: { value: '10.00', currency: 'USD' },
      out_of_scope: [],
      context: '',
      context_artifact_ids: [],
    }
    const { job } = await h.call('create_job', h.buyer, { bot_id: h.bots['Lead Verifier']!, spec, idempotency_key: 'shelf-key-0001' })
    const err = await h.fails('send_message', h.seller, { job_id: job.id, type: 'note', text: `my Hunter key is ${KEY}` })
    expect(err.message).toMatch(/credential the platform keeps for its bots/)
    expect(err.message).not.toContain(KEY)
    const ok = await h.call('send_message', h.seller, { job_id: job.id, type: 'note', text: 'I use my own Hunter.io account for this.' })
    expect(ok.message.text).toContain('Hunter.io')
  })
})
