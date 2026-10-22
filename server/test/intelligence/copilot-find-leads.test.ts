// Spec Copilot: a plain request ("find 20 marketing leads at these 3 companies") becomes a valid find_leads spec for the Lead Verifier.
import { describe, expect, it } from 'vitest'
import { JobSpec } from '@rentabot/shared'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import { registerHouseBotChecks } from '../../src/housebots/checks.ts'
import { createCopilot } from '../../src/intelligence/copilot/copilot.ts'
import { createAiClient, readAiConfig } from '../../src/intelligence/ai/provider.ts'
import { HOUSE_BOTS } from '../../src/seed/bots.ts'

const lib = createCheckLibrary()
registerHouseBotChecks(lib, { allowHosts: [] })
const checks = lib.list()
const off = createCopilot({ ai: createAiClient(readAiConfig({ AI_PROVIDER: 'none' })) })
const skill = HOUSE_BOTS.find((b) => b.name === 'Lead Verifier')!.skills.find((s) => s.id === 'find_leads')!
const GOAL = 'Find 20 marketing leads at acme-corp.com, globex-inc.com and initech-llc.com.'

describe('spec copilot: find_leads', () => {
  it('AI off: 20 leads, the platform\'s lead_verified check, $7.00, and the request (with its domains) in the description', async () => {
    const d = await off.draft({ bot: {} as never, skill, goal: GOAL, quantity: 20, checks })
    expect(() => JobSpec.parse(d.spec)).not.toThrow()
    expect(d.spec.skill_id).toBe('find_leads')
    expect(d.spec.deliverables).toHaveLength(1)
    expect(d.spec.deliverables[0]).toMatchObject({ quantity: 20, acceptance: [{ check: 'lead_verified', params: {} }] })
    expect(d.spec.deliverables[0]!.description).toMatch(/acme-corp\.com, globex-inc\.com and initech-llc\.com/)
    expect(d.estimate.value).toBe('7.00')
    expect(d.spec.budget_cap.value).toBe('7.00')
    expect(d.warnings).toEqual([])
  })

  it('a request below the minimum is raised to 18 leads and says so', async () => {
    const d = await off.draft({ bot: {} as never, skill, goal: 'Find 5 sales leads at acme-corp.com and globex-inc.com.', quantity: 5, checks })
    expect(d.spec.deliverables[0]!.quantity).toBe(18)
    expect(d.estimate.value).toBe('6.30')
    expect(d.warnings.join(' ')).toMatch(/You asked for 5 verified_leads, but this bot takes at least 18 per job/)
  })

  it('AI on: the model\'s draft is kept to the skill\'s one check and the priced quantity', async () => {
    const ai = {
      enabled: true,
      config: { models: { main: 'fake' } },
      askJson: async () => ({ deliverables: [{ id: 'D1', description: '20 verified marketing leads at the three companies', quantity: 20, acceptance: [{ check: 'lead_verified', params: {} }, { check: 'artifact_attached', params: {} }], rubric: '' }], out_of_scope: [], warnings: [] }),
    } as never
    const d = await createCopilot({ ai }).draft({ bot: {} as never, skill, goal: GOAL, quantity: 20, checks })
    expect(d.spec.deliverables[0]!.acceptance.map((t) => t.check)).toEqual(['lead_verified'])
    expect(d.estimate.value).toBe('7.00')
  })
})
