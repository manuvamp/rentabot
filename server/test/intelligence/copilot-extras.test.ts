// Spec Copilot and skill extras: a flat-priced extra deliverable the skill declares (pricing.extras) is counted in the money
// estimate and the budget cap when the draft carries it, never when it does not (Broken Link Hunter, found on production 2026-10-20).
import { describe, expect, it } from 'vitest'
import { BotCard, JobSpec, Skill, SkillPricing } from '@rentabot/shared'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import { registerHouseBotChecks } from '../../src/housebots/checks.ts'
import { createCopilot } from '../../src/intelligence/copilot/copilot.ts'
import { createAiClient, readAiConfig } from '../../src/intelligence/ai/provider.ts'
import { HOUSE_BOTS } from '../../src/seed/bots.ts'

const lib = createCheckLibrary()
registerHouseBotChecks(lib, { allowHosts: [] }) // adds broken_link_confirmed, as on the server
const checks = lib.list()
const off = createCopilot({ ai: createAiClient(readAiConfig({ AI_PROVIDER: 'none' })) })
const hunter = HOUSE_BOTS.find((b) => b.name === 'Broken Link Hunter')!.skills[0]!
const GOAL = 'Find the broken links on https://rentabot.tech/sandbox/site/ so we can fix them.'
const without = (s: Skill): Skill => ({ ...s, pricing: { ...s.pricing, extras: undefined } })
const notRecommended = (s: Skill): Skill => ({ ...s, pricing: { ...s.pricing, extras: s.pricing.extras!.map((x) => ({ ...x, recommended: false })) } })

/** A model that answers like the production one: the links, and the crawl report as D2 with a quantity of its own. */
function fakeAi(deliverables: unknown[], warnings: string[] = []) {
  return {
    enabled: true,
    config: { models: { main: 'fake' } },
    askJson: async () => ({ deliverables, out_of_scope: [], warnings }),
  } as never
}
const LINKS = { id: 'D1', description: '24 broken links', quantity: 24, acceptance: [{ check: 'broken_link_confirmed', params: {} }], rubric: '' }
const REPORT = { id: 'D2', description: 'The crawl report', quantity: 3, acceptance: [{ check: 'report_sections_present', params: { headings: ['Summary', 'Findings'] } }], rubric: '' }

describe('spec copilot: skill extras', () => {
  it('Broken Link Hunter declares the crawl report as a recommended $5.00 extra', () => {
    expect(hunter.pricing.extras).toEqual([expect.objectContaining({ id: 'crawl_report', price: '5.00', recommended: true, checks: ['report_sections_present'] })])
  })

  it('AI off: the default draft carries the recommended extra, and estimate and cap include its price', async () => {
    const d = await off.draft({ bot: {} as never, skill: hunter, goal: GOAL, checks })
    expect(() => JobSpec.parse(d.spec)).not.toThrow()
    expect(d.spec.deliverables.map((x) => x.id)).toEqual(['D1', 'D2'])
    expect(d.spec.deliverables[0]!.quantity).toBe(24)
    expect(d.spec.deliverables[1]).toMatchObject({ quantity: 1, acceptance: [{ check: 'report_sections_present', params: { headings: ['Summary', 'Findings'] } }] })
    expect(d.estimate.value).toBe('11.00') // 24 x $0.25 + $5.00
    expect(d.spec.budget_cap.value).toBe('11.00')
    expect(d.warnings.join(' ')).toMatch(/D2 \(Crawl report\) is a flat \$5\.00 extra/)
  })

  it('AI on: the model\'s D2 is the extra (forced to one unit), priced on top, with no "included in that price" warning', async () => {
    const copilot = createCopilot({ ai: fakeAi([LINKS, REPORT]) })
    const d = await copilot.draft({ bot: {} as never, skill: hunter, goal: GOAL, checks })
    expect(d.spec.deliverables.map((x) => [x.id, x.quantity])).toEqual([['D1', 24], ['D2', 1]])
    expect(d.estimate.value).toBe('11.00')
    expect(d.spec.budget_cap.value).toBe('11.00')
    expect(d.warnings.join(' ')).not.toMatch(/included in that price/)
    expect(d.warnings.join(' ')).not.toMatch(/Only D1 is priced per unit/)
  })

  it('AI on: a recommended extra the model left out is added; a deliverable that is not the extra still rides along in the unit price', async () => {
    const copilot = createCopilot({ ai: fakeAi([LINKS]) })
    const d = await copilot.draft({ bot: {} as never, skill: hunter, goal: GOAL, checks })
    expect(d.spec.deliverables.map((x) => x.id)).toEqual(['D1', 'D2'])
    expect(d.estimate.value).toBe('11.00')
    const other = { id: 'D2', description: 'A second batch of links', quantity: 5, acceptance: [{ check: 'broken_link_confirmed', params: {} }], rubric: '' }
    const e = await createCopilot({ ai: fakeAi([LINKS, other]) }).draft({ bot: {} as never, skill: hunter, goal: GOAL, checks })
    expect(e.spec.deliverables.map((x) => x.id)).toEqual(['D1', 'D2', 'D3'])
    expect(e.warnings.join(' ')).toMatch(/Only D1 is priced per unit; D2 is included in that price/)
    expect(e.estimate.value).toBe('11.00')
  })

  it('a buyer cap below the estimate is still warned about, now against the estimate that includes the extra', async () => {
    const d = await off.draft({ bot: {} as never, skill: hunter, goal: GOAL, budget_cap: '8.00', checks })
    expect(d.spec.budget_cap.value).toBe('8.00')
    expect(d.warnings.join(' ')).toMatch(/Budget cap \$8\.00 is below the estimate \$11\.00/)
  })

  it('when the draft does not carry the extra, nothing about the money changes', async () => {
    // not recommended, AI off: the template has no D2
    const a = await off.draft({ bot: {} as never, skill: notRecommended(hunter), goal: GOAL, checks })
    expect(a.spec.deliverables.map((x) => x.id)).toEqual(['D1'])
    expect(a.estimate.value).toBe('6.00')
    expect(a.spec.budget_cap.value).toBe('6.00')
    expect(a.warnings.join(' ')).not.toMatch(/flat/)
    // not recommended, AI on, the model wrote only D1
    const b = await createCopilot({ ai: fakeAi([LINKS]) }).draft({ bot: {} as never, skill: notRecommended(hunter), goal: GOAL, checks })
    expect(b.spec.deliverables.map((x) => x.id)).toEqual(['D1'])
    expect(b.estimate.value).toBe('6.00')
    // a skill without extras behaves as before, with the original warning wording
    const c = await createCopilot({ ai: fakeAi([LINKS, REPORT]) }).draft({ bot: {} as never, skill: without(hunter), goal: GOAL, checks })
    expect(c.estimate.value).toBe('6.00')
    expect(c.warnings.join(' ')).toContain('Only D1 is priced per unit; other deliverables are included in that price.')
    expect(c.spec.deliverables[1]!.quantity).toBe(3)
  })

  it('a not-recommended extra the model did write is still counted, because the draft carries it', async () => {
    const d = await createCopilot({ ai: fakeAi([LINKS, REPORT]) }).draft({ bot: {} as never, skill: notRecommended(hunter), goal: GOAL, checks })
    expect(d.estimate.value).toBe('11.00')
    expect(d.spec.deliverables[1]!.quantity).toBe(1)
  })

  it('tells the model about the extras in its prompt', async () => {
    let prompt = ''
    const ai = { enabled: true, config: { models: { main: 'fake' } }, askJson: async (o: { prompt: string }) => ((prompt = o.prompt), { deliverables: [LINKS], out_of_scope: [], warnings: [] }) } as never
    await createCopilot({ ai }).draft({ bot: {} as never, skill: hunter, goal: GOAL, checks })
    expect(prompt).toMatch(/flat-priced extras .*Crawl report \$5\.00 \(recommended\)/)
  })
})

describe('skill extras in the protocol', () => {
  const pricing = { model: 'per_unit', currency: 'USD', price: '0.25', unit: 'verified_broken_link', min_units: 24, extras: [{ id: 'crawl_report', title: 'Crawl report', price: '5.00', checks: ['report_sections_present'], recommended: true }] }

  it('round-trips with the field, and a pricing without it is unchanged', () => {
    expect(SkillPricing.parse(pricing)).toEqual(pricing)
    const { extras: _x, ...plain } = pricing
    expect(SkillPricing.parse(plain)).toEqual(plain)
    expect(JSON.parse(JSON.stringify(SkillPricing.parse(pricing)))).toEqual(pricing)
  })

  it('rejects a malformed extra', () => {
    expect(SkillPricing.safeParse({ ...pricing, extras: [{ id: 'x', title: 'T', price: '5', checks: ['a'] }] }).success).toBe(false) // price needs 2 places, id too short
    expect(SkillPricing.safeParse({ ...pricing, extras: [{ id: 'crawl_report', title: 'T', price: '5.00', checks: [] }] }).success).toBe(false)
  })

  it('the Broken Link Hunter card and its skill keep the extra through BotCard and Skill parsing', () => {
    const bot = HOUSE_BOTS.find((b) => b.name === 'Broken Link Hunter')!
    const card = BotCard.parse({ ...bot, id: 'bot_abcdef12', operator_agent_id: 'agt_abcdef12', reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null }, created_at: new Date().toISOString() })
    expect(card.skills[0]!.pricing.extras?.[0]?.price).toBe('5.00')
    expect(Skill.parse(JSON.parse(JSON.stringify(card.skills[0]))).pricing.extras).toEqual(bot.skills[0]!.pricing.extras)
  })
})
