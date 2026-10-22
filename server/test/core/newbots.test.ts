// Operator-declared passports on register_bot / update_bot, and the boot backfill that brings existing databases the new house bots.
import { afterEach, describe, expect, it } from 'vitest'
import type { BotCard } from '@rentabot/shared'
import { backfillHouseBriefs } from '../../src/seed/index.ts'
import { backfillNewBots } from '../../src/seed/newbots-backfill.ts'
import { harness, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.close())

const SKILL = { id: 'tiny_thing', title: 'Tiny', description: 'tiny', needs: {}, delivers: {}, checks: ['artifact_attached'], pricing: { model: 'fixed', currency: 'USD', price: '5.00' }, turnaround: 'PT1H' }
const PASSPORT = {
  models: [{ provider: 'self-hosted', model: 'Qwen3-32B', role: 'writes the summary' }],
  connections: [{ name: 'Hunter.io', kind: 'data_api', owner: 'bot', purpose: 'Finds addresses.', verified: true }],
  tools: [{ name: 'Crawler', description: 'Reads public pages.' }],
  unlocks: ['Reads pages your agent cannot'],
}

describe('third-party passports', () => {
  it('register_bot and update_bot store an operator passport as declared, never verified', async () => {
    h = await harness()
    const reg = await h.call('register_bot', h.stranger, { name: 'Passport Bot', tagline: 'Has a passport', description: 'A helpful bot with a passport.', capability_class: 'compute_media', mode: 'demo', skills: [SKILL], passport: PASSPORT })
    expect(reg.bot.passport).toMatchObject({ models: [{ model: 'Qwen3-32B' }], unlocks: ['Reads pages your agent cannot'] })
    expect(reg.bot.passport?.connections[0]).toMatchObject({ name: 'Hunter.io', verified: false }) // the operator said true; only Rent-A-Bot verifies
    const up = await h.call('update_bot', h.stranger, { bot_id: reg.bot.id, patch: { passport: { ...PASSPORT, connections: [{ ...PASSPORT.connections[0], name: 'Apollo', verified: true }] } } })
    expect(up.bot.passport?.connections).toEqual([expect.objectContaining({ name: 'Apollo', verified: false })])
    const got = await h.call('get_bot', { kind: 'public' }, { bot_id: reg.bot.id })
    expect(got.bot.passport?.connections[0]?.verified).toBe(false)
    // a bot without one still registers
    const plain = await h.call('register_bot', h.stranger, { name: 'Plain Bot', tagline: 'No passport', description: 'A helpful bot.', capability_class: 'compute_media', mode: 'demo', skills: [SKILL] })
    expect(plain.bot.passport).toBeUndefined()
  })
})

describe('new house bots on an existing database', () => {
  it('adds the Landing Page Bot, turns the old Agent Red Team placeholder into the real listing, and delists the retired placeholders', async () => {
    h = await harness()
    const d = h.core.internal.services.d
    const read = (id: string) => JSON.parse(d.db.get<{ data: string }>('SELECT data FROM bots WHERE id = ?', id)!.data) as BotCard
    // Make it look like production before this release.
    const red = read(h.bots['Agent Red Team']!)
    const old = { ...red, status: 'paused', description: 'Attacks your agent with injection suites. Coming soon.', passport: undefined }
    d.db.run('UPDATE bots SET data = ?, status = ? WHERE id = ?', JSON.stringify(old), 'paused', red.id)
    d.db.run('DELETE FROM bots WHERE id = ?', h.bots['Landing Page Bot'])
    const up = { ...red, id: 'bot_upgradebot0000000001', name: 'Upgrade Bot', status: 'paused', description: 'Upgrades. Coming soon.' }
    d.db.run('INSERT INTO bots (id, operator_agent_id, status, data, stats, created_at) VALUES (?, ?, ?, ?, ?, ?)', up.id, up.operator_agent_id, 'paused', JSON.stringify(up), '{}', up.created_at)

    backfillNewBots(h.core.internal.services)
    backfillNewBots(h.core.internal.services) // idempotent

    const after = d.db.all<{ data: string }>('SELECT data FROM bots').map((r) => JSON.parse(r.data) as BotCard)
    const by = (n: string) => after.filter((b) => b.name === n)
    expect(by('Landing Page Bot')).toHaveLength(1)
    expect(by('Landing Page Bot')[0]).toMatchObject({ status: 'listed', capability_class: 'code' })
    expect(by('Agent Red Team')[0]).toMatchObject({ id: red.id, status: 'listed', policy: { requires_scope_proof: true } })
    expect(by('Agent Red Team')[0]!.passport?.unlocks[0]).toMatch(/proof of ownership/)
    expect(by('Agent Red Team')[0]!.skills[0]!.brief?.needs[0]?.label).toBe('Proof you own the target')
    expect(by('Upgrade Bot')[0]!.status).toBe('delisted')
    // an operator pause after the release is respected
    await h.call('update_bot', h.seller, { bot_id: red.id, patch: { status: 'paused' } })
    backfillNewBots(h.core.internal.services)
    expect(read(red.id).status).toBe('paused')
  })
})

/** The web bots: new house bots, added to an existing production database at boot with their brief and passport. */
const WEB_BOTS: Record<string, { skill: string; checks: string[]; min: number; price: string; mode: string }> = {
  'Deliverability Doctor': { skill: 'deliverability_audit', checks: ['dns_claims_hold', 'artifact_attached'], min: 6, price: '1.25', mode: 'live' },
  'Broken Link Hunter': { skill: 'broken_link_audit', checks: ['broken_link_confirmed', 'report_sections_present'], min: 24, price: '0.25', mode: 'live' },
  'Web Data Extractor': { skill: 'web_extraction', checks: ['page_extraction_verified', 'artifact_attached'], min: 30, price: '0.20', mode: 'live' },
}

describe('web bots on an existing database', () => {
  it('adds each web bot with its brief and passport, keeps them across a second boot, and respects an operator pause', async () => {
    h = await harness()
    const d = h.core.internal.services.d
    const read = (id: string) => JSON.parse(d.db.get<{ data: string }>('SELECT data FROM bots WHERE id = ?', id)!.data) as BotCard
    const names = Object.keys(WEB_BOTS)
    // Production before this release: none of them is there yet.
    for (const n of names) d.db.run('DELETE FROM bots WHERE id = ?', h.bots[n])
    expect(d.db.all<{ data: string }>('SELECT data FROM bots').map((r) => (JSON.parse(r.data) as BotCard).name)).not.toContain(names[0])

    backfillNewBots(h.core.internal.services)
    backfillNewBots(h.core.internal.services) // idempotent
    backfillHouseBriefs(h.core.internal.services)

    const after = d.db.all<{ data: string }>('SELECT data FROM bots').map((r) => JSON.parse(r.data) as BotCard)
    for (const n of names) {
      const rows = after.filter((b) => b.name === n)
      expect(rows).toHaveLength(1)
      const want = WEB_BOTS[n]!
      const bot = rows[0]!
      expect(bot).toMatchObject({ status: 'listed', mode: want.mode, capability_class: 'real_world_action' })
      expect(bot.skills[0]).toMatchObject({ id: want.skill, checks: want.checks, pricing: { model: 'per_unit', price: want.price, min_units: want.min } })
      expect(bot.skills[0]!.brief?.does.length).toBeGreaterThan(0)
      expect(bot.skills[0]!.brief?.returns.length).toBeGreaterThan(0)
      expect(bot.passport?.connections.length).toBeGreaterThan(0)
      expect(bot.passport?.connections.every((c) => c.verified)).toBe(true)
      expect(bot.passport?.runs_on).toBe('rentabot')
      // The minimum number of units clears the $5.00 settlement with room for the typical 15% failures.
      const unit = Math.round(Number(want.price) * 100)
      expect(want.min * unit).toBeGreaterThanOrEqual(500 + Math.ceil(want.min * 0.15) * unit)
    }
    const doctor = after.find((b) => b.name === 'Deliverability Doctor')!
    await h.call('update_bot', h.seller, { bot_id: doctor.id, patch: { status: 'paused' } })
    backfillNewBots(h.core.internal.services)
    backfillHouseBriefs(h.core.internal.services)
    expect(read(doctor.id).status).toBe('paused')
  })
})

describe('house-bot pricing backfill', () => {
  it('moves existing Lead Verifier listings to the new minimums with no reset, keeping id, status and reputation, and is idempotent', async () => {
    h = await harness()
    const d = h.core.internal.services.d
    const read = (id: string) => JSON.parse(d.db.get<{ data: string }>('SELECT data FROM bots WHERE id = ?', id)!.data) as BotCard
    const write = (b: BotCard) => d.db.run('UPDATE bots SET data = ? WHERE id = ?', JSON.stringify(b), b.id)
    const lv = read(h.bots['Lead Verifier']!)
    const budget = read(h.bots['Budget Lead Verifier']!)
    expect(lv.skills[0]!.pricing).toMatchObject({ price: '0.10', min_units: 60 })
    expect(budget.skills[0]!.pricing).toMatchObject({ price: '0.07', min_units: 90 })
    expect(read(h.bots['Investor Outreach Bot']!).skills[0]!.pricing).toMatchObject({ price: '2.00', min_units: 3 })
    // 12 x $0.50 = $6.00: a couple of emails can fail lint and the job still clears the $5.00 minimum settlement.
    expect(read(h.bots['Cold Email Writer']!).skills[0]!.pricing).toMatchObject({ price: '0.50', min_units: 12 })
    // Production before this release: minimums 50 and 80, and a reputation that must survive.
    write({ ...lv, reputation: { ...lv.reputation, jobs_completed: 3 }, skills: [{ ...lv.skills[0]!, pricing: { ...lv.skills[0]!.pricing, min_units: 50 } }] })
    const io = read(h.bots['Investor Outreach Bot']!)
    write({ ...io, skills: [{ ...io.skills[0]!, pricing: { ...io.skills[0]!.pricing, min_units: 10 } }] })
    write({ ...budget, skills: [{ ...budget.skills[0]!, pricing: { ...budget.skills[0]!.pricing, min_units: 80 } }] })
    expect(read(lv.id).skills[0]!.pricing.min_units).toBe(50)

    backfillHouseBriefs(h.core.internal.services)
    backfillHouseBriefs(h.core.internal.services)

    expect(read(lv.id)).toMatchObject({ id: lv.id, status: 'listed', reputation: { jobs_completed: 3 } })
    expect(read(lv.id).skills[0]!.pricing.min_units).toBe(60)
    expect(read(lv.id).description).toMatch(/Minimum 60 leads/)
    expect(read(budget.id).skills[0]!.pricing).toMatchObject({ price: '0.07', min_units: 90 })
    expect(read(io.id).skills[0]!.pricing.min_units).toBe(3) // the copilot raises every ask to min_units, so 10 made a 3-fit ask impossible
    // The minimum clears the $5.00 settlement with room: 60 x $0.10 = $6.00 and 90 x $0.07 = $6.30.
    expect(60 * 10).toBeGreaterThanOrEqual(500 + 5 * 10)
    expect(90 * 7).toBeGreaterThanOrEqual(500 + 5 * 7)
  })

  it('gives the live Broken Link Hunter its crawl report extra with no reset, keeping id, status and reputation, and is idempotent', async () => {
    h = await harness()
    const d = h.core.internal.services.d
    const read = (id: string) => JSON.parse(d.db.get<{ data: string }>('SELECT data FROM bots WHERE id = ?', id)!.data) as BotCard
    const hunter = read(h.bots['Broken Link Hunter']!)
    expect(hunter.skills[0]!.pricing.extras).toEqual([expect.objectContaining({ id: 'crawl_report', price: '5.00', recommended: true })])
    // Production before this release: the skill has no extras, and the bot has earned a reputation.
    const { extras: _gone, ...old } = hunter.skills[0]!.pricing
    d.db.run('UPDATE bots SET data = ? WHERE id = ?', JSON.stringify({ ...hunter, reputation: { ...hunter.reputation, jobs_completed: 2 }, skills: [{ ...hunter.skills[0]!, pricing: old }] }), hunter.id)
    expect(read(hunter.id).skills[0]!.pricing.extras).toBeUndefined()

    backfillHouseBriefs(h.core.internal.services)
    backfillHouseBriefs(h.core.internal.services)

    expect(read(hunter.id)).toMatchObject({ id: hunter.id, status: 'listed', reputation: { jobs_completed: 2 } })
    expect(read(hunter.id).skills[0]!.pricing).toMatchObject({ price: '0.25', min_units: 24, extras: [{ id: 'crawl_report', price: '5.00', checks: ['report_sections_present'], recommended: true }] })
  })
})
