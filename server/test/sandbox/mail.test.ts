import { afterEach, describe, expect, it } from 'vitest'
import { PERSONAS } from '../../src/sandbox/personas.ts'
import { makeBox, type Box } from './helpers.ts'

let box: Box
afterEach(async () => box?.cleanup())

const send = async (b: Box, body: Record<string, unknown>) => b.app.inject({ method: 'POST', url: '/sandbox/mail/send', payload: body })
const inbox = async (b: Box, address: string) => (await b.app.inject({ url: `/sandbox/mail/messages?address=${encodeURIComponent(address)}` })).json()
const persona = (style: string) => PERSONAS.find((p) => p.style === style)!
const FROM = 'founder@oranoai.com'

describe('investor personas', () => {
  it('lists 25 personas without revealing reply style', async () => {
    box = await makeBox()
    const j = (await box.app.inject({ url: '/sandbox/mail/investors.json' })).json()
    expect(j.count).toBe(25)
    expect(new Set(j.investors.map((i: { email: string }) => i.email)).size).toBe(25)
    for (const i of j.investors) {
      expect(Object.keys(i).sort()).toEqual(['check_size', 'email', 'firm', 'name', 'stage', 'thesis'])
      expect(i.email.endsWith('@demo-vc.sandbox')).toBe(true)
    }
    const styles = PERSONAS.reduce<Record<string, number>>((m, p) => ((m[p.style] = (m[p.style] ?? 0) + 1), m), {})
    expect(styles).toEqual({ positive: 10, polite_decline: 7, no_reply: 5, bounce: 3 })
  })
})

describe('sending', () => {
  it('validates the request', async () => {
    box = await makeBox()
    const r = await send(box, { from: 'nope', to: persona('positive').address, subject: '', text: '' })
    expect(r.statusCode).toBe(400)
    expect(Object.keys(r.json().errors).sort()).toEqual(['from', 'subject', 'text'])
  })

  it('returns an RFC-style message id and stores the message', async () => {
    box = await makeBox()
    const p = persona('no_reply')
    const r = await send(box, { from: FROM, to: p.address, subject: 'Hello', text: 'Hi there' })
    expect(r.statusCode).toBe(201)
    const { message_id, status } = r.json()
    expect(message_id).toMatch(/^<sbx\.\d{6}\.[0-9a-f]{8}@mail\.demo-vc\.sandbox>$/)
    expect(status).toBe('delivered')
    const byId = (await box.app.inject({ url: `/sandbox/mail/message/${encodeURIComponent(message_id)}` })).json()
    expect(byId).toMatchObject({ to: p.address, from: FROM, subject: 'Hello', kind: 'sent', status: 'delivered' })
    const stripped = message_id.slice(1, -1)
    expect((await box.app.inject({ url: `/sandbox/mail/message/${encodeURIComponent(stripped)}` })).statusCode).toBe(200)
    expect((await box.app.inject({ url: '/sandbox/mail/message/nope' })).statusCode).toBe(404)
  })

  it('bounces unknown addresses on demo-vc.sandbox and bounce personas, with a DSN to the sender', async () => {
    box = await makeBox()
    for (const to of ['nobody.here@demo-vc.sandbox', persona('bounce').address]) {
      const r = await send(box, { from: FROM, to, subject: 'Hi', text: 'Hello' })
      expect(r.json().status).toBe('bounced')
      expect(r.json().bounce_reason).toMatch(/^550 /)
    }
    const msgs = (await inbox(box, FROM)).messages
    expect(msgs.filter((m: { kind: string }) => m.kind === 'bounce')).toHaveLength(2)
    expect(msgs.find((m: { kind: string }) => m.kind === 'bounce').from).toBe('mailer-daemon@demo-vc.sandbox')
  })

  it('delivers to any other address through a readable catch-all mailbox', async () => {
    box = await makeBox()
    const r = await send(box, { from: FROM, to: 'partner@example.org', subject: 'Hi', text: 'Hello' })
    expect(r.json().status).toBe('delivered')
    const j = await inbox(box, 'partner@example.org')
    expect(j.count).toBe(1)
    expect(j.messages[0].direction).toBe('in')
  })
})

describe('persona replies', () => {
  it('positive persona replies positively only to a personalised email, after the scaled delay', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const p = persona('positive')
    const kw = p.keywords[0]!
    const r = await send(box, { from: FROM, to: p.address, subject: `About ${kw}`, text: `We build tools for ${kw}, which matches your thesis.` })
    const id = r.json().message_id
    expect((await inbox(box, FROM)).messages.filter((m: { kind: string }) => m.kind === 'reply')).toHaveLength(0)
    box.advanceMinutes(24) // positive replies take 25-90 nominal minutes
    expect((await inbox(box, FROM)).messages.filter((m: { kind: string }) => m.kind === 'reply')).toHaveLength(0)
    box.advanceMinutes(70)
    const replies = (await inbox(box, FROM)).messages.filter((m: { kind: string }) => m.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ from: p.address, to: FROM, in_reply_to: id, reply_kind: 'positive' })
    expect(replies[0].subject).toBe(`Re: About ${kw}`)
  })

  it('positive persona declines a generic email', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const p = persona('positive')
    await send(box, { from: FROM, to: p.address, subject: 'Quick intro', text: 'We are a startup and would love to chat about our company.' })
    box.advanceMinutes(100)
    const replies = (await inbox(box, FROM)).messages.filter((m: { kind: string }) => m.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0].reply_kind).toBe('decline')
  })

  it('polite_decline persona declines even a personalised email; no_reply persona stays silent', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const d = persona('polite_decline')
    const n = persona('no_reply')
    await send(box, { from: FROM, to: d.address, subject: d.keywords[0]!, text: `${d.keywords[0]} ${d.keywords[1]}` })
    await send(box, { from: FROM, to: n.address, subject: n.keywords[0]!, text: n.keywords[0]! })
    box.advanceMinutes(200)
    const replies = (await inbox(box, FROM)).messages.filter((m: { kind: string }) => m.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ from: d.address, reply_kind: 'decline' })
  })

  it('keyword match is case-insensitive and on word boundaries', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const p = persona('positive') // Maya, keyword "agents"
    await send(box, { from: FROM, to: p.address, subject: 'x', text: 'We made AGENTS-SDK' })
    await send(box, { from: FROM, to: p.address, subject: 'y', text: 'We sell reagentsX' })
    box.advanceMinutes(100)
    const kinds = (await inbox(box, FROM)).messages.filter((m: { kind: string }) => m.kind === 'reply').map((m: { reply_kind: string }) => m.reply_kind)
    expect(kinds.sort()).toEqual(['decline', 'positive'])
  })

  it('is deterministic: the same email gets the same delay', async () => {
    const delays: number[] = []
    for (let i = 0; i < 2; i++) {
      box = await makeBox({ timeScale: 0.01 })
      const p = persona('positive')
      await send(box, { from: FROM, to: p.address, subject: p.keywords[0]!, text: p.keywords[0]! })
      let n = 0
      while ((await inbox(box, FROM)).messages.every((m: { kind: string }) => m.kind !== 'reply') && n < 200) {
        box.advanceMinutes(1)
        n++
      }
      delays.push(n)
      await box.cleanup()
    }
    expect(delays[0]).toBe(delays[1])
    expect(delays[0]).toBeGreaterThanOrEqual(25)
    expect(delays[0]).toBeLessThanOrEqual(90)
  })
})

describe('viewer', () => {
  it('renders a mailbox list, message list and a message', async () => {
    box = await makeBox()
    const p = persona('no_reply')
    const id = (await send(box, { from: FROM, to: p.address, subject: 'Pitch <b>deck</b>', text: 'Line one\nLine two' })).json().message_id
    const home = (await box.app.inject({ url: '/sandbox/mail' })).body
    expect(home).toContain('Sandbox Mail')
    expect(home).toContain(p.name)
    expect(home).toContain('SANDBOX WEB')
    const one = (await box.app.inject({ url: `/sandbox/mail?address=${encodeURIComponent(p.address)}&id=${encodeURIComponent(id)}` })).body
    expect(one).toContain('Line one')
    expect(one).toContain('Pitch &lt;b&gt;deck&lt;/b&gt;') // escaped
    expect(one).not.toContain('<b>deck</b>')
  })
})
