import { describe, expect, it } from 'vitest'
import { jobTitleFrom } from '../../../web/src/lib/jobTitle.ts'

describe('jobTitleFrom', () => {
  it('takes the first sentence of a goal', () => {
    expect(jobTitleFrom('Get my product listed on 40 AI directories before launch. Use the facts kit.')).toBe('Get my product listed on 40 AI directories before launch')
  })
  it('collapses whitespace and lines, and is empty for nothing', () => {
    expect(jobTitleFrom('  Write 10\n\n partnership   emails  ')).toBe('Write 10 partnership emails')
    expect(jobTitleFrom('   ')).toBe('')
    expect(jobTitleFrom(undefined)).toBe('')
  })
  it('cuts a long goal at a word boundary under the limit', () => {
    const t = jobTitleFrom('Verify every one of the eighty security contact addresses that we collected from public security.txt files across many companies', 60)
    expect(t.length).toBeLessThanOrEqual(60)
    expect(t).toBe('Verify every one of the eighty security contact addresses')
  })
  it('keeps short abbreviations-like starts whole (needs 12 characters before a stop)', () => {
    expect(jobTitleFrom('Fix it. Then ship the whole release to everyone')).toBe('Fix it. Then ship the whole release to everyone')
  })
})
