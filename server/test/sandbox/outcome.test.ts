// The demo's headline number: a reasonable bot ends with 31 of 40 passing listings.
import { afterEach, describe, expect, it } from 'vitest'
import { htmlToText } from '../../src/intelligence/checks/library.ts'
import { makeBox, product, sessionsFor, type Box } from './helpers.ts'

let box: Box
afterEach(async () => box?.cleanup())

interface CatalogDir {
  slug: string
  submit_endpoint: string
  pricing: string
  human_verification: boolean
  account?: { required: boolean }
}
interface Listing {
  slug: string
  listing_url: string
}

const path = (url: string) => new URL(url).pathname

/** Skips declared paid and human-verification directories, retries 503, follows email links. */
async function runBot(b: Box): Promise<{ listings: Listing[]; refused: Record<number, number> }> {
  const catalog = (await b.app.inject({ url: '/sandbox/dirs.json' })).json().directories as CatalogDir[]
  const eligible = catalog.filter((d) => d.pricing !== 'paid' && !d.human_verification)
  const listings: Listing[] = []
  const refused: Record<number, number> = {}
  // directories that want an account: sign up, verify the email, log in
  const sessions = await sessionsFor(b, eligible.filter((d) => d.account?.required).map((d) => d.slug))
  for (const d of eligible) {
    const headers = sessions[d.slug] ? { authorization: `Bearer ${sessions[d.slug]}` } : undefined
    let res = await b.app.inject({ method: 'POST', url: path(d.submit_endpoint), payload: product(), headers })
    if (res.statusCode === 503) res = await b.app.inject({ method: 'POST', url: path(d.submit_endpoint), payload: product(), headers })
    if (res.statusCode >= 400) {
      refused[res.statusCode] = (refused[res.statusCode] ?? 0) + 1
      continue
    }
    listings.push({ slug: d.slug, listing_url: res.json().listing_url })
  }
  // confirm every verification email waiting in the buyer's inbox
  const inbox = (await b.app.inject({ url: '/sandbox/mail/messages?address=hello@oranoai.com' })).json().messages as { text: string }[]
  for (const m of inbox) {
    const link = m.text.match(/https?:\/\/\S+\/verify\/[0-9a-f]+/)
    if (link) await b.app.inject({ url: path(link[0]) })
  }
  return { listings, refused }
}

/** url_live (200) + page_mentions (product name in the visible text), like the real checks do. */
async function passing(b: Box, listings: Listing[]): Promise<number> {
  let ok = 0
  for (const l of listings) {
    const r = await b.app.inject({ url: path(l.listing_url) })
    if (r.statusCode === 200 && htmlToText(r.body).toLowerCase().includes('orano')) ok++
  }
  return ok
}

describe('31 of 40', () => {
  it('a reasonable bot submits 40 and 31 pass once moderation and removals settle', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const { listings, refused } = await runBot(box)
    expect(refused).toEqual({})
    expect(listings).toHaveLength(40)

    // right after submitting: instant, flaky(retried), email-confirmed, rewrite and removed listings answer 200;
    // rewrites already fail page_mentions
    const early = await passing(box, listings)
    expect(early).toBe(12 + 4 + 8 + 3) // instant + flaky + email_confirm + removed_later (not yet removed)

    // moderation settles (<= 19 min) but nothing has been removed yet (>= 30 min)
    box.advanceMinutes(25)
    expect(await passing(box, listings)).toBe(34)

    // everything settled: removals done (<= 49 min)
    box.advanceMinutes(40)
    expect(await passing(box, listings)).toBe(31)

    // and it stays 31
    box.advanceMinutes(600)
    expect(await passing(box, listings)).toBe(31)
  })

  it('is the same for a different seed (counts are fixed, only the assignment moves)', async () => {
    box = await makeBox({ timeScale: 0.01, seed: 'another-seed' })
    const { listings } = await runBot(box)
    expect(listings).toHaveLength(40)
    box.advanceMinutes(90)
    expect(await passing(box, listings)).toBe(31)
  })

  it('a bot that never opens the email links loses the 8 confirmation listings', async () => {
    box = await makeBox({ timeScale: 0.01 })
    const catalog = (await box.app.inject({ url: '/sandbox/dirs.json' })).json().directories as CatalogDir[]
    const listings: Listing[] = []
    const free = catalog.filter((x) => x.pricing !== 'paid' && !x.human_verification)
    const sessions = await sessionsFor(box, free.filter((d) => d.account?.required).map((d) => d.slug))
    for (const d of free) {
      const headers = sessions[d.slug] ? { authorization: `Bearer ${sessions[d.slug]}` } : undefined
      let res = await box.app.inject({ method: 'POST', url: path(d.submit_endpoint), payload: product(), headers })
      if (res.statusCode === 503) res = await box.app.inject({ method: 'POST', url: path(d.submit_endpoint), payload: product(), headers })
      listings.push({ slug: d.slug, listing_url: res.json().listing_url })
    }
    box.advanceMinutes(90)
    expect(await passing(box, listings)).toBe(31 - 8)
  })
})
