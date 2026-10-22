import { afterEach, describe, expect, it } from 'vitest'
import { PERSONAS } from '../../src/sandbox/personas.ts'
import { checkCtx, makeBox, type Box } from './helpers.ts'

let box: Box
afterEach(async () => box?.cleanup())

const FROM = 'founder@oranoai.com'
const send = async (b: Box, to: string, subject: string, text: string) =>
  (await b.app.inject({ method: 'POST', url: '/sandbox/mail/send', payload: { from: FROM, to, subject, text } })).json().message_id as string
const run = (b: Box, check: string, meta: Record<string, unknown> | null, params: Record<string, unknown> = {}) => b.checks.get(check)!.run(checkCtx(check, meta, params))
const persona = (style: string) => PERSONAS.find((p) => p.style === style)!

describe('definitions', () => {
  it('replace the email_delivered stub and add reply_received', async () => {
    box = await makeBox()
    const defs = Object.fromEntries(box.checks.list().map((d) => [d.id, d]))
    expect(defs.email_delivered).toMatchObject({ per_unit: true, delayed: false })
    expect(defs.reply_received).toMatchObject({ per_unit: true, delayed: true })
    expect(defs.email_delivered!.description).toContain('unit.meta.message_id')
    expect(defs.email_delivered!.params).toMatchObject({ type: 'object', additionalProperties: false })
    expect(defs.reply_received!.params).toMatchObject({ type: 'object', properties: { kind: { enum: ['positive', 'any'] } } })
  })
})

describe('email_delivered', () => {
  it('passes for a delivered email to the stated recipient', async () => {
    box = await makeBox()
    const p = persona('no_reply')
    const id = await send(box, p.address, 'Hi', 'Hello')
    const r = await run(box, 'email_delivered', { message_id: id, to: p.address })
    expect(r.status).toBe('pass')
    expect(r.evidence_id).toBe('evd_test')
    // address case and display-name forms are normalised
    expect((await run(box, 'email_delivered', { message_id: id, to: p.address.toUpperCase() })).status).toBe('pass')
    // catch-all addresses are delivered too, and the domain param narrows
    const id2 = await send(box, 'a@b.org', 'Hi', 'Hello')
    expect((await run(box, 'email_delivered', { message_id: id2, to: 'a@b.org' })).status).toBe('pass')
    expect((await run(box, 'email_delivered', { message_id: id2, to: 'a@b.org' }, { recipient_domain: 'demo-vc.sandbox' })).status).toBe('fail')
    expect((await run(box, 'email_delivered', { message_id: id, to: p.address }, { recipient_domain: 'demo-vc.sandbox' })).status).toBe('pass')
  })

  it('fails for bounces, wrong recipients, unknown or missing ids', async () => {
    box = await makeBox()
    const b = persona('bounce')
    const bounced = await send(box, b.address, 'Hi', 'Hello')
    const r = await run(box, 'email_delivered', { message_id: bounced, to: b.address })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('bounced')
    const unknownUser = await send(box, 'ghost@demo-vc.sandbox', 'Hi', 'Hello')
    expect((await run(box, 'email_delivered', { message_id: unknownUser, to: 'ghost@demo-vc.sandbox' })).status).toBe('fail')

    const ok = await send(box, persona('no_reply').address, 'Hi', 'Hello')
    expect((await run(box, 'email_delivered', { message_id: ok, to: persona('positive').address })).detail).toContain('not')
    expect((await run(box, 'email_delivered', { message_id: ok, to: persona('positive').address })).status).toBe('fail')
    expect((await run(box, 'email_delivered', { message_id: '<fake@x>', to: 'a@b.org' })).status).toBe('fail')
    expect((await run(box, 'email_delivered', { to: 'a@b.org' })).detail).toContain('message_id')
    expect((await run(box, 'email_delivered', { message_id: ok })).detail).toContain('unit.meta.to')
    expect((await run(box, 'email_delivered', null)).status).toBe('error')
    // a reply or system mail is not a "sent" email, so it can't be claimed as delivered work
    expect((await run(box, 'email_delivered', { message_id: unknownUser, to: FROM })).status).toBe('fail')
  })

  it('rejects params outside the schema (library guard)', async () => {
    box = await makeBox()
    const r = await run(box, 'email_delivered', { message_id: 'x', to: 'a@b.org' }, { surprise: true })
    expect(r.status).toBe('error')
  })
})

describe('reply_received', () => {
  it('is pending until a positive reply arrives, then passes (delayed check)', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const p = persona('positive')
    const id = await send(box, p.address, `About ${p.keywords[0]}`, `We work on ${p.keywords[0]} and ${p.keywords[1]}.`)
    const meta = { message_id: id, to: p.address }
    const early = await run(box, 'reply_received', meta)
    expect(early.status).toBe('pending')
    box.advanceMinutes(24)
    expect((await run(box, 'reply_received', meta)).status).toBe('pending')
    box.advanceMinutes(70)
    const later = await run(box, 'reply_received', meta)
    expect(later.status).toBe('pass')
    expect(later.detail).toContain(p.address)
    expect(later.evidence_id).toBe('evd_test')
  })

  it('fails on a decline unless kind is any', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const p = persona('polite_decline')
    const id = await send(box, p.address, 'Hello', 'Generic pitch')
    const meta = { message_id: id, to: p.address }
    expect((await run(box, 'reply_received', meta)).status).toBe('pending')
    box.advanceMinutes(60)
    expect((await run(box, 'reply_received', meta)).status).toBe('fail')
    expect((await run(box, 'reply_received', meta, { kind: 'any' })).status).toBe('pass')
  })

  it('stays pending for silent personas, and fails for bounced mail', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const n = persona('no_reply')
    const id = await send(box, n.address, n.keywords[0]!, n.keywords[0]!)
    box.advanceMinutes(10_000)
    expect((await run(box, 'reply_received', { message_id: id, to: n.address })).status).toBe('pending')
    const b = persona('bounce')
    const bid = await send(box, b.address, 'Hi', 'Hello')
    expect((await run(box, 'reply_received', { message_id: bid, to: b.address })).status).toBe('fail')
  })

  it('a reply to someone else’s email does not count', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const p = persona('positive')
    const idA = await send(box, p.address, 'A', `${p.keywords[0]}`)
    const idB = await send(box, persona('no_reply').address, 'B', 'x')
    box.advanceMinutes(100)
    expect((await run(box, 'reply_received', { message_id: idA, to: p.address })).status).toBe('pass')
    expect((await run(box, 'reply_received', { message_id: idB, to: persona('no_reply').address })).status).toBe('pending')
  })
})
