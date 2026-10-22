// Sandbox Web, the parts bots really act on: directory accounts, mailboxes with app passwords and SMTP-style sends,
// the five SaaS services, and the multi-step application forms (plus the application_confirmed check).
import { afterEach, describe, expect, it } from 'vitest'
import { buildDirectories } from '../../src/sandbox/directories.ts'
import { PROGRAMS, validateStep } from '../../src/sandbox/applications.ts'
import { SERVICES } from '../../src/sandbox/saas.ts'
import { SANDBOX_SEED } from '../../src/sandbox/index.ts'
import { checkCtx, FIXTURE_PASSWORD, makeBox, product, sessionsFor, type Box } from './helpers.ts'

let box: Box
afterEach(async () => box?.cleanup())

const dirs = buildDirectories(SANDBOX_SEED)
const accountDir = () => dirs.find((d) => d.needs_account && d.behavior === 'instant')!
const basic = (user: string, pass: string) => ({ authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` })
const path = (url: string) => new URL(url).pathname
const inbox = async (b: Box, address: string, headers?: Record<string, string>) => (await b.app.inject({ url: `/sandbox/mail/messages?address=${encodeURIComponent(address)}`, headers })).json().messages as { from: string; to: string; subject: string; text: string; message_id: string; in_reply_to: string | null; reply_kind: string | null }[]

describe('directories that want an account', () => {
  it('are 14 of the free directories, never the email-confirm, paid or captcha ones', () => {
    const wanting = dirs.filter((d) => d.needs_account)
    expect(wanting).toHaveLength(14)
    expect(wanting.every((d) => !['email_confirm', 'paid_only', 'human_verification'].includes(d.behavior))).toBe(true)
    // the seed moves them, the count stays
    expect(buildDirectories('another-seed').filter((d) => d.needs_account)).toHaveLength(14)
  })

  it('declare it in dirs.json with the signup and login endpoints', async () => {
    box = await makeBox()
    const j = (await box.app.inject({ url: '/sandbox/dirs.json' })).json()
    const withAcct = j.directories.filter((d: { account?: { required: boolean } }) => d.account?.required)
    expect(withAcct).toHaveLength(14)
    expect(withAcct[0].account.signup_endpoint).toMatch(/\/api\/signup$/)
    expect(withAcct[0].requirements).toContain('account required (email-verified)')
    expect(withAcct[0].account_required).toBe(true)
  })

  it('signup -> verification email -> link -> login -> submit; every step refuses what a real site would', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const d = accountDir()
    const submit = (headers?: Record<string, string>) => box.app.inject({ method: 'POST', url: `/sandbox/dirs/${d.slug}/api/submit`, payload: product(), headers })
    const signup = (payload: Record<string, unknown>) => box.app.inject({ method: 'POST', url: `/sandbox/dirs/${d.slug}/api/signup`, payload })
    const login = (payload: Record<string, unknown>) => box.app.inject({ method: 'POST', url: `/sandbox/dirs/${d.slug}/api/login`, payload })

    // no account: refused with the way in
    const refused = await submit()
    expect(refused.statusCode).toBe(401)
    expect(refused.json()).toMatchObject({ error: 'account_required' })
    expect((await submit({ authorization: 'Bearer nonsense' })).statusCode).toBe(401)

    // password policy
    const weak = await signup({ email: 'hello@oranoai.com', password: 'password' })
    expect(weak.statusCode).toBe(422)
    expect(weak.json().problems.length).toBeGreaterThan(2)
    expect((await signup({ email: 'hello@oranoai.com', password: 'Hello-hello-1234!' })).json().error).toBe('weak_password') // contains the email name

    const ok = await signup({ email: 'hello@oranoai.com', password: FIXTURE_PASSWORD, display_name: 'ORANO' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().status).toBe('pending_email_verification')
    expect((await signup({ email: 'hello@oranoai.com', password: FIXTURE_PASSWORD })).statusCode).toBe(409)

    // the mail is slow, the account is not usable before the link is opened
    expect((await inbox(box, 'hello@oranoai.com')).some((m) => /Verify your email/.test(m.subject))).toBe(false)
    expect((await login({ email: 'hello@oranoai.com', password: FIXTURE_PASSWORD })).json().error).toBe('email_not_verified')
    box.advanceMinutes(4)
    const mail = (await inbox(box, 'hello@oranoai.com')).find((m) => m.from === `noreply@${d.slug}.dirs.sandbox`)!
    expect(mail.subject).toContain('Verify your email')
    const link = mail.text.match(/https?:\/\/\S+\/account\/verify\/[0-9a-f]+/)![0]
    expect((await login({ email: 'hello@oranoai.com', password: 'Wrong-password-1!' })).statusCode).toBe(401)
    expect((await box.app.inject({ url: `${path(link)}0` })).statusCode).toBe(404)
    expect((await box.app.inject({ url: path(link) })).statusCode).toBe(200)
    const session = await login({ email: 'hello@oranoai.com', password: FIXTURE_PASSWORD })
    expect(session.statusCode).toBe(200)

    const listed = await submit({ authorization: `Bearer ${session.json().session_token}` })
    expect(listed.statusCode).toBe(201)
    expect((await box.app.inject({ url: path(listed.json().listing_url) })).body).toContain('ORANO')
    // a session of one directory is worthless on another
    const other = dirs.find((x) => x.needs_account && x.slug !== d.slug && x.behavior === 'instant')!
    expect((await box.app.inject({ method: 'POST', url: `/sandbox/dirs/${other.slug}/api/submit`, payload: product(), headers: { authorization: `Bearer ${session.json().session_token}` } })).statusCode).toBe(401)
  })

  it('the HTML pages work too: signup form, login sets a cookie, the submit form needs it', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const d = accountDir()
    expect((await box.app.inject({ url: `/sandbox/dirs/${d.slug}/submit` })).statusCode).toBe(401)
    const form = (kind: string, payload: Record<string, string>) => box.app.inject({ method: 'POST', url: `/sandbox/dirs/${d.slug}/${kind}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(payload).toString() })
    expect((await box.app.inject({ url: `/sandbox/dirs/${d.slug}/signup` })).body).toContain('Create your')
    expect((await form('signup', { email: 'hello@oranoai.com', password: FIXTURE_PASSWORD })).statusCode).toBe(201)
    box.advanceMinutes(4)
    const mail = (await inbox(box, 'hello@oranoai.com')).find((m) => m.from === `noreply@${d.slug}.dirs.sandbox`)!
    await box.app.inject({ url: path(mail.text.match(/https?:\/\/\S+\/account\/verify\/[0-9a-f]+/)![0]) })
    const res = await form('login', { email: 'hello@oranoai.com', password: FIXTURE_PASSWORD })
    expect(res.statusCode).toBe(302)
    const cookie = String(res.headers['set-cookie']).split(';')[0]!
    expect((await box.app.inject({ url: `/sandbox/dirs/${d.slug}/submit`, headers: { cookie } })).statusCode).toBe(200)
  })

  it('sessionsFor logs in on several at once (the helper the other tests use)', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const slugs = dirs.filter((d) => d.needs_account).slice(0, 3).map((d) => d.slug)
    const s = await sessionsFor(box, slugs)
    expect(Object.keys(s)).toEqual(slugs)
  })
})

describe('mailboxes with app passwords and the SMTP-style send API', () => {
  const create = (b: Box, address: string) => b.app.inject({ method: 'POST', url: '/sandbox/mail/mailboxes', payload: { address, label: 'Outreach' } })
  const smtp = (b: Box, payload: Record<string, unknown>, headers?: Record<string, string>) => b.app.inject({ method: 'POST', url: '/sandbox/mail/smtp/send', payload, headers })

  it('issues an app password once; the address cannot be registered twice or on a sandbox domain', async () => {
    box = await makeBox()
    const r = await create(box, 'Founder@Acme-Test.com')
    expect(r.statusCode).toBe(201)
    const j = r.json()
    expect(j.address).toBe('founder@acme-test.com')
    expect(j.app_password).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/)
    expect(j.smtp.send_endpoint).toContain('/sandbox/mail/smtp/send')
    expect((await create(box, 'founder@acme-test.com')).statusCode).toBe(409)
    expect((await create(box, 'x@demo-vc.sandbox')).statusCode).toBe(400)
    expect((await create(box, 'x@toolhatch.dirs.sandbox')).statusCode).toBe(400)
  })

  it('sends as the mailbox with the client Message-ID; bad credentials and other senders are refused like SMTP', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const { app_password: pw } = (await create(box, 'founder@acme-test.com')).json()
    const to = 'maya.okafor@demo-vc.sandbox'
    const msg = { username: 'founder@acme-test.com', password: pw, to, subject: 'Developer tools for agents', text: 'We build developer tools for agents.', message_id: '<rab.job1.1.abc123@acme-test.com>' }

    const bad = await smtp(box, { ...msg, password: 'wrong-wrong-wrong-wrong' })
    expect(bad.statusCode).toBe(401)
    expect(bad.json().smtp.code).toBe(535)
    const spoof = await smtp(box, { ...msg, mail_from: 'ceo@acme-test.com' })
    expect(spoof.statusCode).toBe(403)
    expect(spoof.json().smtp.code).toBe(553)

    const ok = await smtp(box, msg)
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({ ok: true, message_id: '<rab.job1.1.abc123@acme-test.com>', status: 'delivered', from: 'founder@acme-test.com', via: 'smtp_auth', authenticated_as: 'founder@acme-test.com' })
    expect(ok.json().smtp.code).toBe(250)
    // HTTP Basic works as well, and a repeat of the same submission sends nothing twice
    const again = await smtp(box, { to, subject: msg.subject, text: msg.text, message_id: msg.message_id }, basic('founder@acme-test.com', pw))
    expect(again.statusCode).toBe(200)
    expect(again.json().replayed).toBe(true)
    // the same Message-ID for another recipient is refused
    expect((await smtp(box, { ...msg, to: 'aisha.khan@demo-vc.sandbox' })).statusCode).toBe(409)
    expect((await smtp(box, { ...msg, message_id: 'not an id' })).statusCode).toBe(400)

    // the delivery record
    const rec = (await box.app.inject({ url: `/sandbox/mail/message/${encodeURIComponent(msg.message_id)}` })).json()
    expect(rec).toMatchObject({ kind: 'sent', status: 'delivered', via: 'smtp_auth', from: 'founder@acme-test.com', to })

    // the open test API cannot impersonate a registered mailbox
    const open = await box.app.inject({ method: 'POST', url: '/sandbox/mail/send', payload: { from: 'founder@acme-test.com', to, subject: 'x', text: 'y' } })
    expect(open.statusCode).toBe(401)
    expect(open.json().error).toBe('auth_required')
    // but still works for addresses nobody registered
    expect((await box.app.inject({ method: 'POST', url: '/sandbox/mail/send', payload: { from: 'someone@else.example', to, subject: 'x', text: 'y' } })).statusCode).toBe(201)
  })

  it('the mailbox is read only with the app password; the reply comes back to it', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const { app_password: pw } = (await create(box, 'founder@acme-test.com')).json()
    const sent = (await smtp(box, { username: 'founder@acme-test.com', password: pw, to: 'maya.okafor@demo-vc.sandbox', subject: 'Developer tools for agents', text: 'We build open-source developer tools and infrastructure for agents.' })).json()
    expect(sent.message_id).toMatch(/^<sbx\./) // no client id: the server assigns one

    expect((await box.app.inject({ url: '/sandbox/mail/messages?address=founder@acme-test.com' })).statusCode).toBe(401)
    expect((await box.app.inject({ url: '/sandbox/mail/messages?address=founder@acme-test.com', headers: basic('founder@acme-test.com', 'nope-nope-nope-nope') })).statusCode).toBe(401)
    box.advanceMinutes(120)
    const mine = await inbox(box, 'founder@acme-test.com', basic('founder@acme-test.com', pw))
    const reply = mine.find((m) => m.in_reply_to === sent.message_id)
    expect(reply).toMatchObject({ from: 'maya.okafor@demo-vc.sandbox', reply_kind: 'positive' })
    // the unfiltered listing never exposes a registered mailbox
    const all = (await box.app.inject({ url: '/sandbox/mail/messages' })).json().messages as { to: string; from: string }[]
    expect(all.some((m) => m.to === 'founder@acme-test.com' || m.from === 'founder@acme-test.com')).toBe(false)
    // unregistered addresses stay open catch-all inboxes
    expect(((await box.app.inject({ url: '/sandbox/mail/messages?address=hello@oranoai.com' })).json() as { count: number }).count).toBe(0)
  })

  it('app passwords can be added and revoked; a revoked one stops working', async () => {
    box = await makeBox()
    const first = (await create(box, 'founder@acme-test.com')).json().app_password as string
    const second = (await box.app.inject({ method: 'POST', url: '/sandbox/mail/mailboxes/founder%40acme-test.com/app-passwords', payload: { label: 'laptop' }, headers: basic('founder@acme-test.com', first) })).json()
    expect(second.app_password).not.toBe(first)
    const info = (await box.app.inject({ url: '/sandbox/mail/mailboxes/founder%40acme-test.com', headers: basic('founder@acme-test.com', second.app_password) })).json()
    expect(info.app_passwords).toHaveLength(2)
    const id = info.app_passwords[0].id
    expect((await box.app.inject({ method: 'DELETE', url: `/sandbox/mail/mailboxes/founder%40acme-test.com/app-passwords/${id}`, headers: basic('founder@acme-test.com', second.app_password) })).statusCode).toBe(200)
    const payload = { to: 'maya.okafor@demo-vc.sandbox', subject: 's', text: 't' }
    expect((await smtp(box, { ...payload, username: 'founder@acme-test.com', password: first })).statusCode).toBe(401)
    expect((await smtp(box, { ...payload, username: 'founder@acme-test.com', password: second.app_password })).statusCode).toBe(201)
  })

  it('email_delivered carries the delivery record, and with via smtp_auth rejects mail sent through the open API', async () => {
    box = await makeBox()
    const { app_password: pw } = (await create(box, 'founder@acme-test.com')).json()
    const authed = (await smtp(box, { username: 'founder@acme-test.com', password: pw, to: 'maya.okafor@demo-vc.sandbox', subject: 's', text: 't' })).json()
    const open = (await box.app.inject({ method: 'POST', url: '/sandbox/mail/send', payload: { from: 'other@else.example', to: 'maya.okafor@demo-vc.sandbox', subject: 's', text: 't' } })).json()
    const run = (id: string, meta: Record<string, unknown>) => box.checks.get('email_delivered')!.run(checkCtx('email_delivered', { message_id: id, to: 'maya.okafor@demo-vc.sandbox', ...meta }, { via: 'smtp_auth' }))
    expect((await run(authed.message_id, { from: 'founder@acme-test.com' })).status).toBe('pass')
    expect((await run(authed.message_id, { from: 'ceo@acme-test.com' })).detail).toMatch(/was sent from founder@acme-test.com/)
    expect((await run(open.message_id, {})).detail).toMatch(/not submitted with a mailbox app password/)
    expect((await box.checks.get('email_delivered')!.run(checkCtx('email_delivered', { message_id: open.message_id, to: 'maya.okafor@demo-vc.sandbox' }, {}))).status).toBe('pass') // without via: as before
  })
})

describe('the five SaaS services', () => {
  const j = (b: Box, method: 'POST' | 'PUT' | 'GET', url: string, payload?: Record<string, unknown>, headers?: Record<string, string>) => b.app.inject({ method, url, payload, headers })
  const profile = { display_name: 'ORANO', bio: 'ORANO is an AI money coach.', logo_url: 'https://oranoai.com/logo.png', link: 'https://oranoai.com' }

  it('lists five services with limits and rules', async () => {
    box = await makeBox()
    const cat = (await box.app.inject({ url: '/sandbox/saas.json' })).json()
    expect(cat.count).toBe(5)
    expect(cat.services.map((s: { kind: string }) => s.kind).sort()).toEqual(['analytics', 'forum', 'newsletter', 'social', 'status'])
    expect(cat.services[0]).toMatchObject({ limits: { display_name: expect.any(Number), bio: expect.any(Number) }, handle_rules: { length: expect.any(Array) } })
  })

  it('every service: signup (with its friction), verification, login, profile, public page', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const email = 'hello@oranoai.com'
    const password = 'Tr0ub4dor&3-fixture-long!'
    const tokens: Record<string, string> = {}
    for (const s of SERVICES) {
      const base = `/sandbox/saas/${s.slug}`
      // handle rules
      expect((await j(box, 'POST', `${base}/api/signup`, { email, password, handle: 'Bad Handle!' })).json().errors.handle).toBeTruthy()
      let first = await j(box, 'POST', `${base}/api/signup`, { email, password, handle: 'orano-test', display_name: 'ORANO' })
      if (s.rate_limited) {
        expect(first.statusCode).toBe(429)
        expect(first.headers['retry-after']).toBe('2')
        first = await j(box, 'POST', `${base}/api/signup`, { email, password, handle: 'orano-test', display_name: 'ORANO' })
      }
      expect(first.statusCode).toBe(201)
      // (a rate-limited service answers 429 to the first try of every email)
      const again = async (payload: Record<string, unknown>) => {
        const r = await j(box, 'POST', `${base}/api/signup`, payload)
        return r.statusCode === 429 ? j(box, 'POST', `${base}/api/signup`, payload) : r
      }
      expect((await again({ email: 'other@oranoai.com', password, handle: 'orano-test' })).json()).toMatchObject({ error: 'handle_taken' })
      expect((await again({ email: 'x@oranoai.com', password: 'short', handle: 'fresh-handle' })).statusCode).toBe(422)
      // profile before login
      expect((await j(box, 'PUT', `${base}/api/profile`, profile)).statusCode).toBe(401)
    }
    box.advanceMinutes(6)
    const mail = await inbox(box, email)
    for (const s of SERVICES) {
      const base = `/sandbox/saas/${s.slug}`
      const m = mail.find((x) => x.from === `noreply@${s.slug}.saas.sandbox`)!
      expect(m.subject).toContain('Verify your email')
      expect((await j(box, 'POST', `${base}/api/login`, { email, password })).statusCode).toBe(403) // not verified yet
      await j(box, 'GET', path(m.text.match(/https?:\/\/\S+\/account\/verify\/[0-9a-f]+/)![0]))
      const login = await j(box, 'POST', `${base}/api/login`, { email, password })
      expect(login.statusCode).toBe(200)
      tokens[s.slug] = login.json().session_token
    }
    for (const s of SERVICES) {
      const base = `/sandbox/saas/${s.slug}`
      const auth = { authorization: `Bearer ${tokens[s.slug]}` }
      // limits are enforced
      const long = await j(box, 'PUT', `${base}/api/profile`, { ...profile, bio: 'x'.repeat(s.limits.bio + 1) }, auth)
      expect(long.statusCode).toBe(422)
      expect(long.json().errors.bio).toContain(String(s.limits.bio))
      expect((await j(box, 'PUT', `${base}/api/profile`, { ...profile, logo_url: 'nope' }, auth)).statusCode).toBe(422)
      const saved = await j(box, 'PUT', `${base}/api/profile`, profile, auth)
      expect(saved.statusCode).toBe(200)
      const url = path(saved.json().profile_url)
      if (s.review_minutes) {
        expect(saved.json().status).toBe('pending_review')
        expect((await j(box, 'GET', url)).statusCode).toBe(404)
        box.advanceMinutes(s.review_minutes)
      } else expect(saved.json().status).toBe('live')
      const page = await j(box, 'GET', url)
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('ORANO')
      expect(page.body).toContain('oranoai.com')
      expect((await j(box, 'GET', `${url}/snapshot`)).headers['content-type']).toContain('image/svg+xml')
      // a session of one service is not valid on another
      const other = SERVICES.find((x) => x.slug !== s.slug)!
      expect((await j(box, 'PUT', `/sandbox/saas/${other.slug}/api/profile`, profile, auth)).statusCode).toBe(401)
    }
  })

  it('the squatted handle is taken and suggestions are offered', async () => {
    box = await makeBox()
    const s = SERVICES.find((x) => x.squatted.includes('orano'))!
    const r = await j(box, 'POST', `/sandbox/saas/${s.slug}/api/signup`, { email: 'hello@oranoai.com', password: 'Tr0ub4dor&3-fixture-long!', handle: 'orano' })
    if (s.rate_limited) return
    expect(r.statusCode).toBe(409)
    expect(r.json().suggestions).toContain('orano-hq')
  })
})

describe('application forms', () => {
  const NORTH = PROGRAMS[0]!
  const create = (b: Box, slug: string, email = 'founder@oranoai.com') => b.app.inject({ method: 'POST', url: `/sandbox/apps/${slug}/api/applications`, payload: { email, applicant_name: 'Maya Founder' } })
  const answers = (n: number) =>
    [
      { company_name: 'ORANO', website: 'https://oranoai.com', one_liner: 'An AI money coach.', stage: 'Launched' },
      { founder_name: 'Maya Founder', founder_email: 'founder@oranoai.com', founder_role: 'CEO' },
      { product_description: 'ORANO is an AI money coach that helps people get out of debt with a friendly coach that plans, tracks and nudges every single week.', traction: 'Live on iOS and Android.', why_now: 'Agents can act for people.' },
      { currently_raising: 'Raising $500K pre-seed', use_of_funds: 'Hiring one engineer.' },
    ][n - 1]!
  const pdf = (n = 1) => Buffer.from(`%PDF-1.4\n% fixture ${n}\n%%EOF\n`).toString('base64')

  it('lists six programmes: an accelerator pair, two grants and two launch directories', async () => {
    box = await makeBox()
    const cat = (await box.app.inject({ url: '/sandbox/apps.json' })).json()
    expect(cat.count).toBe(6)
    expect(cat.programs.map((p: { kind: string }) => p.kind).sort()).toEqual(['accelerator', 'accelerator', 'grant', 'grant', 'launch_directory', 'launch_directory'])
    expect(cat.programs[0].steps).toHaveLength(4)
    expect(cat.programs[0].steps[0].fields[0]).toMatchObject({ key: 'company_name', required: true, max_length: 60 })
    expect(cat.programs[0].file).toMatchObject({ mime: 'application/pdf' })
  })

  it('fills in order, enforces limits and the file, submits once, and the confirmation is verifiable', async () => {
    box = await makeBox()
    const base = `/sandbox/apps/${NORTH.slug}/api/applications`
    const started = await create(box, NORTH.slug)
    expect(started.statusCode).toBe(201)
    const id = started.json().application_id as string
    // starting again resumes the same draft
    expect((await create(box, NORTH.slug)).json()).toMatchObject({ application_id: id, resumed: true })

    const put = (n: number, fields: Record<string, unknown>) => box.app.inject({ method: 'PUT', url: `${base}/${id}/steps/${n}`, payload: { fields } })
    expect((await put(2, answers(2))).json().error).toBe('step_out_of_order')
    const tooLong = await put(1, { ...answers(1), one_liner: 'x'.repeat(141) })
    expect(tooLong.statusCode).toBe(422)
    expect(tooLong.json().errors.one_liner).toContain('141 of 140')
    expect((await put(1, { ...answers(1), stage: 'Unicorn', website: 'ftp://x' })).json().errors).toMatchObject({ stage: expect.any(String), website: expect.any(String) })
    expect((await put(1, { ...answers(1), company_name: '' })).json().errors.company_name).toContain('required')
    for (const n of [1, 2, 3, 4]) expect((await put(n, answers(n))).statusCode).toBe(200)
    expect((await put(3, { ...answers(3), product_description: 'too short' })).json().errors.product_description).toContain('too short')

    // not submittable without the file
    const early = await box.app.inject({ method: 'POST', url: `${base}/${id}/submit` })
    expect(early.statusCode).toBe(422)
    expect(early.json().missing).toEqual([{ step: 0, key: 'one_pager' }])
    const upload = (over: Record<string, unknown>) => box.app.inject({ method: 'POST', url: `${base}/${id}/files`, payload: { field: 'one_pager', filename: 'one-pager.pdf', mime: 'application/pdf', content_base64: pdf(), ...over } })
    expect((await upload({ mime: 'image/png' })).statusCode).toBe(422)
    expect((await upload({ content_base64: Buffer.from('not a pdf at all').toString('base64') })).json().errors.content_base64).toContain('not a PDF')
    expect((await upload({})).statusCode).toBe(200)

    // the draft previews, but it is not an application yet
    const preview = await box.app.inject({ url: `/sandbox/apps/${NORTH.slug}/applications/${id}/preview` })
    expect(preview.body).toContain('Draft, not submitted')
    expect(preview.body).toContain('ORANO')

    const done = await box.app.inject({ method: 'POST', url: `${base}/${id}/submit` })
    expect(done.statusCode).toBe(201)
    const cid = done.json().confirmation_id as string
    expect(cid).toMatch(/^NSA-26-[0-9A-Z]{6}$/)
    expect((await box.app.inject({ method: 'POST', url: `${base}/${id}/submit` })).json()).toMatchObject({ replayed: true, confirmation_id: cid })
    expect((await put(1, answers(1))).statusCode).toBe(409) // submitted forms cannot be edited

    const receipt = await box.app.inject({ url: path(done.json().receipt_url) })
    expect(receipt.statusCode).toBe(200)
    expect(receipt.body).toContain(cid)
    expect(receipt.body).toContain('ORANO')
    expect((await box.app.inject({ url: `/sandbox/apps/${NORTH.slug}/receipt/NSA-26-ZZZZZZ` })).statusCode).toBe(404)
    expect((await inbox(box, 'founder@oranoai.com')).some((m) => m.subject.includes(cid))).toBe(true)

    // the platform's check
    const run = (meta: Record<string, unknown>, params: Record<string, unknown> = {}) => box.checks.get('application_confirmed')!.run(checkCtx('application_confirmed', meta, params))
    expect((await run({ program: NORTH.slug, confirmation_id: cid }, { must_include: ['ORANO'] })).status).toBe('pass')
    expect((await run({ program: NORTH.slug, confirmation_id: cid }, { must_include: ['Acme'] })).status).toBe('fail')
    expect((await run({ program: NORTH.slug, confirmation_id: 'NSA-26-ABCDEF' })).status).toBe('fail') // an invented ID
    expect((await run({ program: PROGRAMS[1]!.slug, confirmation_id: cid })).status).toBe('fail') // the wrong programme
    expect((await run({ program: NORTH.slug })).status).toBe('fail')
  })

  it('enforces the size limit of the file (500 KB for a press kit)', async () => {
    box = await makeBox()
    const slug = PROGRAMS[4]!.slug
    const id = (await create(box, slug)).json().application_id as string
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600_000, 'a')]).toString('base64')
    const r = await box.app.inject({ method: 'POST', url: `/sandbox/apps/${slug}/api/applications/${id}/files`, payload: { field: 'one_pager', filename: 'kit.pdf', mime: 'application/pdf', content_base64: big } })
    expect(r.statusCode).toBe(422)
    expect(r.json().errors.content_base64).toContain('limit is 500000')
  })

  it('a draft that was never submitted does not pass the check', async () => {
    box = await makeBox()
    const id = (await create(box, NORTH.slug)).json().application_id as string
    expect(((await box.app.inject({ url: `/sandbox/apps/${NORTH.slug}/api/applications/${id}` })).json()).status).toBe('draft')
    const r = await box.checks.get('application_confirmed')!.run(checkCtx('application_confirmed', { program: NORTH.slug, confirmation_id: id }, {}))
    expect(r.status).toBe('fail')
  })

  it('the HTML flow works: start, step forms with errors, preview, submit, receipt', async () => {
    box = await makeBox()
    const slug = PROGRAMS[4]!.slug // LaunchDay: 2 steps
    const form = (url: string, payload: Record<string, string>) => box.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(payload).toString() })
    const start = await form(`/sandbox/apps/${slug}/apply`, { email: 'founder@oranoai.com', applicant_name: 'Maya' })
    expect(start.statusCode).toBe(302)
    const step1 = String(start.headers.location)
    expect((await box.app.inject({ url: step1 })).body).toContain('Product name')
    const bad = await form(step1, { product_name: 'ORANO' })
    expect(bad.statusCode).toBe(422)
    expect(bad.body).toContain('Tagline is required')
    expect((await form(step1, { product_name: 'ORANO', tagline: 'AI money coach', url: 'https://oranoai.com', category: 'AI' })).statusCode).toBe(302)
  })

  it('validateStep: numbers, selects and optional fields', () => {
    const grant = PROGRAMS.find((p) => p.kind === 'grant')!
    const budget = grant.steps[2]!
    expect(validateStep(budget, { amount_requested: '500', budget_notes: 'x' }).errors.amount_requested).toContain('between')
    expect(validateStep(budget, { amount_requested: 'lots', budget_notes: 'x' }).errors.amount_requested).toContain('number')
    expect(validateStep(budget, { amount_requested: '2500', budget_notes: 'x' }).errors).toEqual({})
    expect(validateStep(grant.steps[0]!, { applicant_org: 'A', contact_name: 'B', contact_email: 'b@c.dd' }).errors).toEqual({}) // website is optional
  })
})
