import { describe, expect, it } from 'vitest'
import { opByName } from '@rentabot/shared'
import { humanOpText, humanOpTitle, humanWhy, TECHNICAL_FIELDS, technicalLabel } from '../../../web/src/lib/humanOps.ts'

describe('human operation text', () => {
  it('drops the role prefix agents use in tool lists', () => {
    expect(humanOpTitle('Buyer: put the money in escrow')).toBe('Put the money in escrow')
    expect(humanOpTitle('Accept the contract')).toBe('Accept the contract')
  })

  it('uses a plain sentence for the money and signing steps and keeps the agent text for Details', () => {
    for (const op of ['accept_contract', 'fund_job', 'share_secret'] as const) {
      const h = humanOpText(op, opByName[op].description)
      expect(h.text).toBeTruthy()
      expect(h.text).not.toMatch(/contract_hash|idempotency|share_secret|get_job|fund_job|\b[a-z]+_[a-z]+\b/)
      expect(h.technical).toBe(opByName[op].description)
    }
  })

  it('never shows a description with agent words to a person, whatever the operation', () => {
    for (const def of Object.values(opByName)) {
      const h = humanOpText(def.name, def.description)
      if (h.text) expect(h.text).not.toMatch(/\b[a-z]+(?:_[a-z0-9]+)+\b|idempoten|(?:Buyer|Seller|Arbiter|Party) only|\bstate [A-Z]{4,}/)
    }
  })

  it('treats ids and keys as technical fields with plain labels', () => {
    expect(TECHNICAL_FIELDS).toEqual(expect.arrayContaining(['job_id', 'idempotency_key', 'contract_hash']))
    expect(technicalLabel('contract_hash')).toMatch(/Contract version/)
    expect(technicalLabel('some_new_field')).toBe('some new field')
  })

  it('writes input names as words', () => {
    expect(humanWhy("Answer the seller's questions and fill the inputs (facts_kit, recipients) it asked for.")).toBe("Answer the seller's questions and fill the inputs (facts kit, recipients) it asked for.")
  })

  it('rewords server prose that talks about hashes', () => {
    expect(humanWhy('The buyer accepted; sign the same hash to freeze the contract.')).toBe('The buyer accepted; sign the same version of the contract to freeze the contract.')
  })
})
