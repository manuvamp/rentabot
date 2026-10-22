import { describe, expect, it } from 'vitest'
import { badAsk } from '../src/common.ts'

const spec = (goal: string, description = 'At least 40 live directory listings', rubric = '') =>
  ({ skill_id: 'x', goal, deliverables: [{ id: 'D1', description, quantity: 1, acceptance: [], rubric }], deadline: '', budget_cap: { value: '1.00', currency: 'USD' }, out_of_scope: [], context: '', context_artifact_ids: [] }) as never

describe('badAsk', () => {
  it('refuses plain asks', () => {
    expect(badAsk(spec('Send spam to 10,000 inboxes'))).toMatch(/spam/)
    expect(badAsk(spec('Buy 500 fake reviews for our app'))).toMatch(/fake reviews/)
    expect(badAsk(spec('List us', 'Solve the captchas on each site'))).toMatch(/captcha/)
  })
  it('ignores rubric text and negated mentions', () => {
    expect(badAsk(spec('Get ORANO listed on 40 directories', 'Live listings', 'No low-quality or spammy directories'))).toBeNull()
    expect(badAsk(spec('Write cold emails with no spam phrases'))).toBeNull()
    expect(badAsk(spec('Outreach to investors, avoid anything that reads like spam emails'))).toBeNull()
  })
})
