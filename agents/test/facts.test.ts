import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FACTS_PATH, loadOranoFacts, parseFacts } from '../src/facts.ts'
import { answerQuestion, factFor } from '../src/scripted.ts'

describe('ORANO facts', () => {
  const f = loadOranoFacts()

  it('has the listing fields within their limits', () => {
    expect(f.name).toBe('ORANO')
    expect(f.url).toBe('https://oranoai.com')
    expect(f.contact_email).toBe('hello@oranoai.com')
    expect(f.tagline_60.length).toBeGreaterThan(10)
    expect(f.tagline_60.length).toBeLessThanOrEqual(60)
    expect(f.description_300.length).toBeGreaterThan(50)
    expect(f.description_300.length).toBeLessThanOrEqual(300)
    expect(f.category).toBeTruthy()
    expect(f.text).toContain('hello@oranoai.com')
    expect(f.text.length).toBeLessThan(8000) // fits draft_job_spec context
  })

  it('carries nothing confidential or unverifiable', () => {
    const raw = readFileSync(FACTS_PATH, 'utf8').toLowerCase()
    for (const word of ['valuation', 'raise', 'raising', 'investor', 'funding', 'revenue', 'burn', 'cap table', 'phone', 'date of birth', 'address', 'infotik', 'launched in july', 'bali', '@gmail'])
      expect(raw, word).not.toContain(word)
    expect(raw.match(/https?:\/\/[^\s)]+/g)?.every((u) => u.startsWith('https://oranoai.com'))).toBe(true)
  })

  it('rejects over-long copy', () => {
    const long = 'x'.repeat(61)
    expect(() => parseFacts(`---\nname: A\nurl: u\ncategory: c\ncontact_email: e\ntagline_60: ${long}\ndescription_300: d\n---\nbody`)).toThrow(/60/)
  })

  it('maps seller inputs and questions to facts only', () => {
    expect(factFor('product_name', f)).toBe('ORANO')
    expect(factFor('url', f)).toBe('https://oranoai.com')
    expect(factFor('contact_email', f)).toBe('hello@oranoai.com')
    expect(factFor('tagline_60', f)).toBe(f.tagline_60)
    expect(factFor('logo', f)).toBeUndefined()
    expect(factFor('founder_phone', f)).toBeUndefined()
    expect(answerQuestion('Which founder name should appear on listings?', f)).not.toMatch(/manu/i)
    expect(answerQuestion('What email should directories use?', f)).toBe('hello@oranoai.com')
  })
})
