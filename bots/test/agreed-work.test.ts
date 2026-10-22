// What the bots can do when mediation ends in a redo / substitute agreement (SellerBot.canAgree + work(job.agreement)).
import { describe, expect, it } from 'vitest'
import type { Delivery } from '@rentabot/shared'
import { coldEmailWriter } from '../src/bots/cold-email-writer.ts'
import { leadVerifier } from '../src/bots/lead-verifier.ts'
import { auditor } from '../src/bots/auditor.ts'
import type { AgreedWork } from '../src/negotiate.ts'
import { restrictToAgreement } from '../src/negotiate.ts'
import { fakeTools, makeJob, makeSpec } from './helpers.ts'

const KIT = 'Product: ORANO\nURL: https://oranoai.com\nOne-liner: ORANO is an AI productivity companion that saves links, extracts tasks and exposes an MCP server for agents.\nORANO is live on iOS and Android. Contact: hello@oranoai.com'
const companies = ['Northwind Ventures', 'Origami Ventures', 'Kiln Seed Fund', 'Copper Lane Partners', 'Fjord Capital', 'Meridian Seed']
const recipients = companies.map((company) => ({ company, angle: 'Developer tools and infrastructure for AI agents.' }))
const deadline = new Date(Date.now() + 48 * 3_600_000).toISOString()
const offer = (kind: 'redo' | 'substitute', units: string[]): AgreedWork => ({ kind, deliverable_id: 'D1', units, instruction: 'Do it again.', deadline })

describe('cold email writer: agreed redo and substitute', () => {
  const bot = coldEmailWriter()
  const spec = makeSpec({ skill_id: 'write_cold_emails', quantity: 4 })
  const first = (): Delivery => ({ note: '', deliverables: [{ deliverable_id: 'D1', note: '', units: companies.slice(0, 4).map((company, i) => ({ ref: `email-${i + 1}`, artifact_ids: [], meta: { company } })) }] })

  it('can redo emails it delivered and write to further recipients; not to units it never delivered or to a missing deliverable', async () => {
    const job = { ...makeJob(spec, { facts_kit: KIT, recipients }), previous: first() }
    expect(await bot.canAgree!(offer('redo', ['email-2', 'email-3']), job)).toBe(true)
    expect(await bot.canAgree!(offer('redo', ['D1:email-1']), job)).toBe(true)
    expect(await bot.canAgree!(offer('redo', ['email-9']), job)).toBe(false) // never delivered
    expect(await bot.canAgree!({ ...offer('redo', ['email-1']), deliverable_id: 'D2' }, job)).toBe(false)
    expect(await bot.canAgree!(offer('substitute', ['new-1', 'new-2']), job)).toBe(true) // 6 recipients, 4 used
    expect(await bot.canAgree!(offer('substitute', ['new-1', 'new-2', 'new-3']), job)).toBe(false)
  })

  it('redoes exactly the named emails, under the same refs, for the same recipients', async () => {
    const job = { ...makeJob(spec, { facts_kit: KIT, recipients }), previous: first(), agreement: offer('redo', ['email-2', 'email-4']) }
    const res = await bot.work(job, fakeTools())
    const units = restrictToAgreement(res.delivery, job.agreement!).deliverables[0]!.units
    expect(units.map((u) => [u.ref, u.meta.company])).toEqual([['email-2', 'Origami Ventures'], ['email-4', 'Copper Lane Partners']])
    expect(units.every((u) => u.meta.lint === 'passed')).toBe(true)
  })

  it('writes a substitute to the next recipients under new refs', async () => {
    const job = { ...makeJob(spec, { facts_kit: KIT, recipients }), previous: first(), agreement: offer('substitute', ['new-1', 'new-2']) }
    const res = await bot.work(job, fakeTools())
    const units = restrictToAgreement(res.delivery, job.agreement!).deliverables[0]!.units
    expect(units.map((u) => [u.ref, u.meta.company])).toEqual([['email-5', 'Fjord Capital'], ['email-6', 'Meridian Seed']])
  })
})

describe('lead verifier: agreed redo and substitute', () => {
  const bot = leadVerifier()
  const spec = makeSpec({ skill_id: 'verify_leads', quantity: 3 })
  const rows = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ to: `a${i + 1}@lead-x.com`, company: `Co ${i + 1}`, email_source_url: 'https://example.invalid/team' })).join('\n')

  it('can re-check leads inside its list and verify further leads; not leads it was never given', async () => {
    const job = makeJob(spec, { leads_jsonl: rows(5) })
    expect(await bot.canAgree!(offer('redo', ['lead-1', 'lead-3']), job)).toBe(true)
    expect(await bot.canAgree!(offer('redo', ['lead-4']), job)).toBe(false) // beyond the 3 requested
    expect(await bot.canAgree!(offer('redo', ['dir-1']), job)).toBe(false)
    expect(await bot.canAgree!(offer('substitute', ['new-1', 'new-2']), job)).toBe(true)
    expect(await bot.canAgree!(offer('substitute', ['new-1', 'new-2', 'new-3']), job)).toBe(false)
  })
})

describe('bots without agreed-work support', () => {
  it('have no canAgree, so the runtime never lets them accept a redo or substitute', () => {
    expect(auditor().canAgree).toBeUndefined()
  })
})
