import { afterEach, describe, expect, it } from 'vitest'
import { htmlToText } from '../../src/intelligence/checks/library.ts'
import { buildDirectories, type Behavior } from '../../src/sandbox/directories.ts'
import { SANDBOX_SEED } from '../../src/sandbox/index.ts'
import { makeBox, product, type Box } from './helpers.ts'

let box: Box
afterEach(async () => box?.cleanup())

const dirs = buildDirectories(SANDBOX_SEED)
// The behaviour tests use directories without an account step; the account flow has its own tests below.
const of = (b: Behavior) => dirs.find((d) => d.behavior === b && !d.needs_account)!
const api = (b: Box, slug: string, payload: Record<string, unknown>) => b.app.inject({ method: 'POST', url: `/sandbox/dirs/${slug}/api/submit`, payload })
const path = (url: string) => new URL(url).pathname
const get = (b: Box, url: string) => b.app.inject({ url: path(url) })
const mailFor = async (b: Box, addr: string) => (await b.app.inject({ url: `/sandbox/mail/messages?address=${encodeURIComponent(addr)}` })).json().messages as { from: string; text: string; subject: string }[]

describe('catalog', () => {
  it('has 48 distinct directories with the documented mix', () => {
    expect(dirs).toHaveLength(48)
    expect(new Set(dirs.map((d) => d.slug)).size).toBe(48)
    expect(new Set(dirs.map((d) => d.name)).size).toBe(48)
    const count = dirs.reduce<Record<string, number>>((m, d) => ((m[d.behavior] = (m[d.behavior] ?? 0) + 1), m), {})
    expect(count).toEqual({ instant: 12, email_confirm: 8, moderation_delay: 7, flaky_503: 4, moderation_reject: 3, rewrite_name: 3, removed_later: 3, paid_only: 4, human_verification: 4 })
  })

  it('is deterministic per seed and the seed changes the assignment', () => {
    expect(buildDirectories('a')).toEqual(buildDirectories('a'))
    expect(buildDirectories('a').map((d) => d.behavior)).not.toEqual(buildDirectories('b').map((d) => d.behavior))
  })

  it('serves dirs.json with declared requirements and no hidden outcomes', async () => {
    box = await makeBox()
    const res = await box.app.inject({ url: '/sandbox/dirs.json' })
    const j = res.json()
    expect(j.count).toBe(48)
    const d0 = j.directories[0]
    expect(d0).toMatchObject({ slug: expect.any(String), name: expect.any(String), pricing: expect.stringMatching(/free|paid/), human_verification: expect.any(Boolean) })
    expect(d0.url).toBe(`http://sandbox.test/sandbox/dirs/${d0.slug}`)
    expect(d0.submit_endpoint).toBe(`http://sandbox.test/sandbox/dirs/${d0.slug}/api/submit`)
    expect(d0.submit_fields.required).toContain('contact_email')
    const reqs = j.directories.flatMap((d: { requirements: string[] }) => d.requirements)
    expect(reqs.filter((r: string) => r === 'email verification')).toHaveLength(8)
    expect(reqs.filter((r: string) => r.startsWith('paid listing'))).toHaveLength(4)
    expect(reqs.filter((r: string) => r.startsWith('human verification'))).toHaveLength(4)
    expect(j.directories.filter((d: { pricing: string }) => d.pricing === 'paid')).toHaveLength(4)
    expect(j.directories.filter((d: { human_verification: boolean }) => d.human_verification)).toHaveLength(4)
    // hidden behaviours never leak
    expect(res.body).not.toMatch(/behavior|rewrite|removed|flaky|reject|503/i)
  })
})

describe('behaviours', () => {
  it('instant: live at once, listing page mentions the product, appears on the home page, snapshot renders', async () => {
    box = await makeBox()
    const d = of('instant')
    const r = await api(box, d.slug, product())
    expect(r.statusCode).toBe(201)
    const j = r.json()
    expect(j.status).toBe('live')
    expect(j.listing_url).toBe(`http://sandbox.test/sandbox/dirs/${d.slug}/listing/${j.submission_id}`)
    const page = await get(box, j.listing_url)
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('ORANO')
    expect((await box.app.inject({ url: `/sandbox/dirs/${d.slug}` })).body).toContain('ORANO')
    const snap = await get(box, `${j.listing_url}/snapshot`)
    expect(snap.statusCode).toBe(200)
    expect(snap.headers['content-type']).toContain('image/svg+xml')
    expect(snap.body).toContain('rendered snapshot')
    expect(snap.body).toContain('ORANO')
    expect((await get(box, `${j.listing_url}x`)).statusCode).toBe(404)
  })

  it('email_confirm: listing is 404 until the verify link from the mailbox is visited', async () => {
    box = await makeBox()
    const d = of('email_confirm')
    const j = (await api(box, d.slug, product())).json()
    expect(j.status).toBe('pending_email_verification')
    expect((await get(box, j.listing_url)).statusCode).toBe(404)
    const mail = (await mailFor(box, 'hello@oranoai.com')).find((m) => m.from === `noreply@${d.slug}.dirs.sandbox`)!
    const link = mail.text.match(/https?:\/\/\S+\/verify\/[0-9a-f]+/)![0]
    expect(link.startsWith(`http://sandbox.test/sandbox/dirs/${d.slug}/verify/`)).toBe(true)
    expect((await get(box, link)).statusCode).toBe(200)
    expect((await get(box, j.listing_url)).statusCode).toBe(200)
    expect((await get(box, `${link}0`)).statusCode).toBe(404)
  })

  it('moderation_delay: 404, then live after the scaled delay, with an approval email', async () => {
    box = await makeBox({ timeScale: 0.02 })
    const d = of('moderation_delay')
    const r = await api(box, d.slug, product())
    expect(r.statusCode).toBe(202)
    const j = r.json()
    expect(j.status).toBe('pending_review')
    expect((await get(box, j.listing_url)).statusCode).toBe(404)
    box.advanceMinutes(d.review_minutes - 1)
    expect((await get(box, j.listing_url)).statusCode).toBe(404)
    expect((await mailFor(box, 'hello@oranoai.com')).some((m) => /now listed/.test(m.subject))).toBe(false)
    box.advanceMinutes(1)
    expect((await get(box, j.listing_url)).statusCode).toBe(200)
    expect((await mailFor(box, 'hello@oranoai.com')).some((m) => /now listed/.test(m.subject))).toBe(true)
  })

  it('moderation_reject: never goes live; status says rejected and a rejection email arrives', async () => {
    box = await makeBox()
    const d = of('moderation_reject')
    const j = (await api(box, d.slug, product())).json()
    expect(j.status).toBe('pending_review')
    box.advanceMinutes(100)
    expect((await get(box, j.listing_url)).statusCode).toBe(404)
    expect((await get(box, j.receipt_url)).json().status).toBe('rejected')
    expect((await mailFor(box, 'hello@oranoai.com')).some((m) => /not approved/.test(m.subject))).toBe(true)
  })

  it('human_verification: refuses automation with a clear 403 (API and form)', async () => {
    box = await makeBox()
    const d = of('human_verification')
    const r = await api(box, d.slug, product())
    expect(r.statusCode).toBe(403)
    expect(r.json().error).toBe('human_verification_required')
    const form = await box.app.inject({ method: 'POST', url: `/sandbox/dirs/${d.slug}/submit`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(product() as Record<string, string>).toString() })
    expect(form.statusCode).toBe(403)
    expect((await box.app.inject({ url: `/sandbox/dirs/${d.slug}` })).body).not.toContain('ORANO')
  })

  it('paid_only: 402 with the price', async () => {
    box = await makeBox()
    const d = of('paid_only')
    const r = await api(box, d.slug, product())
    expect(r.statusCode).toBe(402)
    expect(r.json()).toMatchObject({ error: 'payment_required', price_usd: d.price_usd })
  })

  it('rewrite_name: listing is live and returns 200 but does not mention the product', async () => {
    box = await makeBox()
    const d = of('rewrite_name')
    const r = await api(box, d.slug, product())
    expect(r.statusCode).toBe(201)
    const page = await get(box, r.json().listing_url)
    expect(page.statusCode).toBe(200)
    expect(htmlToText(page.body).toLowerCase()).not.toContain('orano') // what page_mentions reads
    const snap = await get(box, `${r.json().listing_url}/snapshot`)
    expect(htmlToText(snap.body).toLowerCase()).not.toContain('orano')
  })

  it('removed_later: live first, 404 after the removal time', async () => {
    box = await makeBox({ timeScale: 0.02 })
    const d = of('removed_later')
    const j = (await api(box, d.slug, product())).json()
    expect((await get(box, j.listing_url)).statusCode).toBe(200)
    box.advanceMinutes(d.removal_minutes - 1)
    expect((await get(box, j.listing_url)).statusCode).toBe(200)
    box.advanceMinutes(1)
    expect((await get(box, j.listing_url)).statusCode).toBe(404)
    expect((await get(box, `${j.listing_url}/snapshot`)).statusCode).toBe(404)
    expect((await get(box, j.receipt_url)).json().status).toBe('removed')
  })

  it('flaky_503: first attempt is 503 with Retry-After, the retry is accepted', async () => {
    box = await makeBox()
    const d = of('flaky_503')
    const first = await api(box, d.slug, product())
    expect(first.statusCode).toBe(503)
    expect(first.headers['retry-after']).toBe('2')
    const second = await api(box, d.slug, product())
    expect(second.statusCode).toBe(201)
    expect((await get(box, second.json().listing_url)).body).toContain('ORANO')
  })
})

describe('validation and the HTML form', () => {
  it('rejects bad input with field errors and duplicates with 409', async () => {
    box = await makeBox()
    const d = of('instant')
    const bad = await api(box, d.slug, product({ url: 'ftp://x', contact_email: 'nope', name: '' }))
    expect(bad.statusCode).toBe(400)
    expect(Object.keys(bad.json().errors).sort()).toEqual(['contact_email', 'name', 'url'])
    expect((await api(box, d.slug, product())).statusCode).toBe(201)
    const dupe = await api(box, d.slug, product())
    expect(dupe.statusCode).toBe(409)
    expect(dupe.json().error).toBe('duplicate')
    expect((await api(box, 'nosuchdir', product())).statusCode).toBe(404)
  })

  it('serves a submit form and accepts a urlencoded post; user text is escaped', async () => {
    box = await makeBox()
    const d = of('instant')
    const form = await box.app.inject({ url: `/sandbox/dirs/${d.slug}/submit` })
    expect(form.statusCode).toBe(200)
    expect(form.body).toContain('name="contact_email"')
    const res = await box.app.inject({
      method: 'POST',
      url: `/sandbox/dirs/${d.slug}/submit`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(product({ name: 'Evil <script>alert(1)</script>' }) as Record<string, string>).toString(),
    })
    expect(res.statusCode).toBe(201)
    const id = /listing\/(p\d+[0-9a-f]+)/.exec(res.body)![1]
    const page = (await box.app.inject({ url: `/sandbox/dirs/${d.slug}/listing/${id}` })).body
    expect(page).toContain('Evil &lt;script&gt;')
    expect(page).not.toContain('<script>alert(1)')
  })

  it('/sandbox and /sandbox/dirs render', async () => {
    box = await makeBox()
    const idx = await box.app.inject({ url: '/sandbox' })
    expect(idx.statusCode).toBe(200)
    expect(idx.body).toContain('Not real sites')
    expect(idx.body).toContain('/sandbox/dirs.json')
    expect(idx.body).toContain('/sandbox/mail')
    expect((await box.app.inject({ url: '/sandbox/dirs' })).body).toContain('ToolHatch')
  })
})

describe('state', () => {
  it('reset wipes submissions and mail', async () => {
    box = await makeBox()
    const d = of('instant')
    const j = (await api(box, d.slug, product())).json()
    expect((await get(box, j.listing_url)).statusCode).toBe(200)
    expect((await box.app.inject({ method: 'POST', url: '/sandbox/reset' })).json()).toEqual({ ok: true })
    expect((await get(box, j.listing_url)).statusCode).toBe(404)
    expect((await box.app.inject({ url: '/sandbox/mail/messages' })).json().count).toBe(0)
    // the same product can be submitted again after a reset
    expect((await api(box, d.slug, product())).statusCode).toBe(201)
  })

  it('survives a restart through dataDir/sandbox.json', async () => {
    box = await makeBox()
    const dataDir = box.dataDir
    const d = of('instant')
    const j = (await api(box, d.slug, product())).json()
    await box.app.close() // flushes the snapshot
    const second = await makeBox({ dataDir })
    try {
      expect((await get(second, j.listing_url)).statusCode).toBe(200)
    } finally {
      await second.cleanup()
      await box.cleanup()
    }
  })
})
