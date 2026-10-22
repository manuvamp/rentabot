// Lead Verifier's second skill, find_leads: Hunter.io domain search -> the Lead Verifier's own page + MX rule -> only passing leads
// are delivered, and the platform's lead_verified check re-runs the same rule. Hunter is a mock (hunter-mock.ts); no live call.
import { afterEach, describe, expect, it } from 'vitest'
import { createHunter, HunterError } from '../src/hunter.ts'
import { asksForRoleAddresses, domainsInText, domainsOf, isRoleAddress, leadFinder, onSearchedSite, sourcesFor, MAX_DOMAINS } from '../src/bots/lead-finder.ts'
import { memoryLogger } from '../src/log.ts'
import { createPoliteWeb } from '../src/web.ts'
import { createCheckLibrary } from '../../server/src/intelligence/checks/library.ts'
import { registerHouseBotChecks } from '../../server/src/housebots/checks.ts'
import { HOUSE_BOTS } from '../../server/src/seed/bots.ts'
import type { SkillCard } from '../src/runtime.ts'
import { email, KEY, mockHunter, type MockDomain } from './hunter-mock.ts'
import { fakeTools, makeJob, makeSpec, passedUnits, runAcceptance, startSite } from './helpers.ts'

type Site = Awaited<ReturnType<typeof startSite>>
const sites: Site[] = []
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()))
})

const found = HOUSE_BOTS.find((b) => b.name === 'Lead Verifier')!.skills.find((s) => s.id === 'find_leads')!
const card: SkillCard = { id: found.id, title: found.title, pricing: found.pricing, turnaround: found.turnaround, checks: found.checks }

const MX_OK = new Set(['acme-corp.com', 'globex-inc.com', 'initech-llc.com', 'gmail.com'])
const mxOpts = {
  resolveMx: async (d: string) => {
    if (!MX_OK.has(d)) throw Object.assign(new Error('no data'), { code: 'ENODATA' })
    return [{ exchange: `mx.${d}`, priority: 10 }]
  },
  doh: async () => ({ ok: false, json: async () => ({}) }),
}

const addrs = (domain: string, prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}@${domain}`)
const mailtos = (list: string[]) => `<html><body>${list.map((a) => `<a href="mailto:${a}">${a}</a>`).join('\n')}</body></html>`

/** The company pages Hunter points at. `gone` holds addresses that have since been taken off their page. */
async function makeSite(gone: Set<string> = new Set()) {
  const lists: Record<string, string[]> = {
    '/acme': [...addrs('acme-corp.com', 'a', 6)], // a7 and a8 are NOT here
    '/acme-2': ['a7@acme-corp.com'], // a7's second source
    '/globex': [...addrs('globex-inc.com', 'g', 8), 'jane@gmail.com'],
    '/initech': addrs('initech-llc.com', 'i', 3),
  }
  const s = await startSite((u) => {
    const list = lists[u.pathname]
    return list ? [200, mailtos(list.filter((a) => !gone.has(a)))] : [404, 'not found']
  })
  sites.push(s)
  return s
}

function table(origin: string): Record<string, MockDomain> {
  return {
    'acme-corp.com': {
      organization: 'Acme Corp',
      emails: [
        ...addrs('acme-corp.com', 'a', 6).map((a) => email(a, `${origin}/acme`)),
        // a7: Hunter says the first page still has it (it does not any more); the second, older page does.
        email('a7@acme-corp.com', `${origin}/acme`, { sources: [{ uri: `${origin}/acme`, last_seen_on: '2026-09-30', still_on_page: true }, { uri: `${origin}/acme-2`, last_seen_on: '2025-01-01', still_on_page: false }] }),
        // a8: its only page no longer has it: never delivered, never paid.
        email('a8@acme-corp.com', `${origin}/acme`),
      ],
    },
    'globex-inc.com': {
      organization: 'Globex',
      emails: [...addrs('globex-inc.com', 'g', 8).map((a) => email(a, `${origin}/globex`)), email('jane@gmail.com', `${origin}/globex`, { confidence: 99 })],
    },
    'initech-llc.com': {
      organization: 'Initech',
      emails: [...addrs('initech-llc.com', 'i', 3).map((a) => email(a, `${origin}/initech`)), email('nopage@initech-llc.com', '', { sources: [] })],
    },
  }
}

const GOAL = 'Find 20 marketing leads at acme-corp.com, globex-inc.com and initech-llc.com.'
const spec = (over: Parameters<typeof makeSpec>[0] = {}) => makeSpec({ skill_id: 'find_leads', goal: GOAL, quantity: 20, acceptance: [{ check: 'lead_verified', params: {} }], ...over })

function bot(mock: ReturnType<typeof mockHunter>, site: Site | null, o: { key?: string; ttl?: number } = {}) {
  const hunter = createHunter({ apiKey: o.key ?? KEY, fetchImpl: mock.fetchImpl, accountTtlMs: o.ttl ?? 0 })
  return { hunter, bot: leadFinder({ web: createPoliteWeb({ allowHosts: site ? [site.host] : [], perSecond: 1000 }), mx: mxOpts, hunter }) }
}

const reasonOf = async (b: ReturnType<typeof leadFinder>, s = spec(), inputs: Record<string, unknown> = {}) => {
  const q = await b.quote(s, card, { inputs, ai: undefined as never })
  return q.ok ? null : q.reason
}

describe('Hunter client', () => {
  it('sends the key only in the X-API-KEY header, never in a URL, and refuses redirects', async () => {
    const m = mockHunter({ 'acme-corp.com': { emails: [] } })
    const h = createHunter({ apiKey: KEY, fetchImpl: m.fetchImpl, accountTtlMs: 0 })
    await h.account()
    await h.domainSearch('acme-corp.com', { department: ['marketing', 'bogus'], seniority: ['senior'], type: 'personal' })
    expect(m.calls.map((c) => c.path)).toEqual(['/v2/account', '/v2/domain-search'])
    for (const c of m.calls) {
      expect(c.key).toBe(KEY)
      expect(c.url).not.toContain(KEY)
      expect(c.url.startsWith('https://api.hunter.io/v2/')).toBe(true)
      expect(c.redirect).toBe('error')
    }
    // only filter values Hunter accepts go out; the page size is Hunter's free-plan maximum
    expect(m.calls[1]!.query).toEqual({ domain: 'acme-corp.com', limit: '10', department: 'marketing', seniority: 'senior', type: 'personal' })
  })

  it('reads the account counters (the smaller of searches and credits) and reuses a fresh answer', async () => {
    const m = mockHunter({}, { used: 3, available: 50 })
    const h = createHunter({ apiKey: KEY, fetchImpl: m.fetchImpl })
    expect(await h.account()).toMatchObject({ plan: 'Free', resetDate: '2026-11-20', searchesLeft: 47, verificationsLeft: 100 })
    await h.account()
    expect(h.requests.account).toBe(1) // reused inside the TTL
    await h.account({ fresh: true })
    expect(h.requests.account).toBe(2)
  })

  it('never lets the key into an error, even when the service echoes it back', async () => {
    const m = mockHunter({}, { key: 'some-other-key-entirely-0000' }) // our key is wrong: the mock echoes it in its 401
    const h = createHunter({ apiKey: KEY, fetchImpl: m.fetchImpl, accountTtlMs: 0 })
    const err = await h.account().then(() => null, (e: unknown) => e as HunterError)
    expect(err).toBeInstanceOf(HunterError)
    expect(err!.kind).toBe('auth')
    expect(JSON.stringify({ message: err!.message, stack: err!.stack })).not.toContain(KEY)
    const echoing = createHunter({ apiKey: KEY, accountTtlMs: 0, fetchImpl: async () => new Response(JSON.stringify({ errors: [{ id: 'wrong_params', code: 400, details: `bad domain, key ${KEY} rejected` }] }), { status: 400 }) })
    const e2 = await echoing.domainSearch('acme-corp.com').then(() => null, (e: unknown) => e as HunterError)
    expect(e2!.kind).toBe('bad_request')
    expect(e2!.message).not.toContain(KEY)
    const down = createHunter({ apiKey: KEY, accountTtlMs: 0, fetchImpl: async () => Promise.reject(new Error(`connect failed (X-API-KEY ${KEY})`)) })
    const e3 = await down.account().then(() => null, (e: unknown) => e as HunterError)
    expect(e3!.kind).toBe('network')
    expect(e3!.message).not.toContain(KEY)
  })

  it('classifies the monthly allowance and rate limits, and makes no request without a key', async () => {
    const m = mockHunter({ 'acme-corp.com': { emails: [] } }, { used: 50, available: 50 })
    const h = createHunter({ apiKey: KEY, fetchImpl: m.fetchImpl })
    expect(await h.domainSearch('acme-corp.com').catch((e: HunterError) => e.kind)).toBe('quota')
    const none = createHunter({ apiKey: '', fetchImpl: m.fetchImpl })
    expect(none.configured).toBe(false)
    const before = m.calls.length
    expect(await none.account().catch((e: HunterError) => e.kind)).toBe('no_key')
    expect(await none.domainSearch('acme-corp.com').catch((e: HunterError) => e.kind)).toBe('no_key')
    expect(m.calls.length).toBe(before)
  })
})

describe('find_leads: inputs and sources', () => {
  it('reads domains from an array or text, drops non-company entries and free webmail providers', () => {
    expect(domainsOf('https://www.Acme-Corp.com/about, @globex-inc.com\nGMAIL.com; not a domain')).toEqual({ domains: ['acme-corp.com', 'globex-inc.com'], rejected: ['not', 'a', 'domain', 'gmail.com'] })
    expect(domainsOf(['acme-corp.com', 'acme-corp.com', '10.0.0.1', 'localhost']).domains).toEqual(['acme-corp.com'])
    expect(domainsInText('Find leads at acme-corp.com and https://www.globex-inc.com/team, e.g. ask hello@initech-llc.com; see leads.csv')).toEqual(['acme-corp.com', 'globex-inc.com'])
  })

  it('tries still_on_page sources first, then the most recently seen, public http(s) only', () => {
    const src = (uri: string, lastSeenOn: string, stillOnPage: boolean | null) => ({ uri, extractedOn: '', lastSeenOn, stillOnPage })
    const e = {
      value: 'a@acme-corp.com', type: 'personal', confidence: 90, firstName: '', lastName: '', position: '', department: '', seniority: '',
      sources: [
        src('http://old.example.com/a', '2024-01-01', false),
        src('ftp://nope.example.com/a', '2026-01-01', true),
        src('https://new.example.com/b', '2026-02-01', false),
        src('https://live.example.com/c', '2020-01-01', true),
        src('https://live.example.com/c', '2020-01-01', true),
      ],
    }
    expect(sourcesFor(e)).toEqual(['https://live.example.com/c', 'https://new.example.com/b'])
  })

  it('tries pages on the searched domain or its subdomains first, then still_on_page, then the most recent', () => {
    const src = (uri: string, lastSeenOn: string, stillOnPage: boolean | null) => ({ uri, extractedOn: '', lastSeenOn, stillOnPage })
    const e = {
      value: 'admissions@ox.ac.uk', type: 'generic', confidence: 90, firstName: '', lastName: '', position: '', department: '', seniority: '',
      sources: [src('https://thepathfindr.com/oxford', '2026-10-01', true), src('https://atma.om/list', '2026-10-02', true), src('https://www.ox.ac.uk/admissions', '2023-01-01', false)],
    }
    expect(sourcesFor(e, 'ox.ac.uk')).toEqual(['https://www.ox.ac.uk/admissions', 'https://atma.om/list'])
    expect(onSearchedSite('https://www.ox.ac.uk/a', 'ox.ac.uk')).toBe(true)
    expect(onSearchedSite('https://ox.ac.uk/a', 'ox.ac.uk')).toBe(true)
    expect(onSearchedSite('https://notox.ac.uk/a', 'ox.ac.uk')).toBe(false)
    expect(onSearchedSite('https://ox.ac.uk.evil.com/a', 'ox.ac.uk')).toBe(false)
  })
})

describe('find_leads: role addresses (type "generic")', () => {
  it('drops the personal IDs and the placeholder production delivered as "generic" (job_mvgm1t51sbfGwFRfJx2W61)', () => {
    for (const a of ['kq01@uni.example', 'mlarkin@uni.example', 'zx892@uni.example', 'abcd1234@uni.example', 'j.smith@acme.com', 'jsmith2@acme.com', 'john.admissions@acme.com', 'ab12@acme.com', 'noreply@acme.com', 'test@acme.com', 'helen@acme.com', 'newsom@acme.com'])
      expect(isRoleAddress(a), a).toBe(false)
  })

  it('keeps clear role and functional mailboxes, joined with dots, dashes, qualifiers or run together', () => {
    for (const a of ['info@acme.com', 'admissions@ox.ac.uk', 'press@stanford.edu', 'undergraduate.admissions@cam.ac.uk', 'press-office@acme.com', 'pressoffice@acme.com', 'media_relations@acme.com', 'ugadmissions@acme.com', 'contactus@acme.com', 'hello@acme.com', 'webmaster@acme.com', 'info2@acme.com', 'international-admissions@acme.com', 'mitadmissions@mit.edu', 'careers@acme.com', 'student.services@acme.com', 'archive@ox.ac.uk', 'researchdata@ox.ac.uk', 'deansoffice@acme.com'])
      expect(isRoleAddress(a), a).toBe(true)
    for (const a of ['data@acme.com', 'deans@acme.com', 'dean@acme.com']) expect(isRoleAddress(a), a).toBe(false) // a qualifier alone, or a first name
  })

  it('reads a request for role addresses as type "generic", and a negated one as not', () => {
    for (const t of [
      'generic role email addresses (info@, admissions@, press@ style, not named people) at mit.edu and stanford.edu', // production's goal
      'Find 20 general email addresses at acme.com',
      'role-based mailboxes at the three companies',
      'shared inboxes only',
      'contacts like info@ or press@ at acme.com',
    ])
      expect(asksForRoleAddresses(t), t).toBe(true)
    for (const t of [
      'Find 20 marketing leads at acme-corp.com, globex-inc.com and initech-llc.com.',
      'Named people only, not generic addresses',
      'Find people at acme.com, no role addresses please',
      'Find sales leads at acme.com and send them to hello@orano.ai',
    ])
      expect(asksForRoleAddresses(t), t).toBe(false)
  })
})

describe('find_leads: pricing and quota', () => {
  it('prices $0.35 a lead: 20 leads at 3 named domains is $7.00 and says what it will not do', async () => {
    const m = mockHunter(table('http://x'))
    const { bot: b } = bot(m, null)
    const q = await b.quote(spec(), card, { inputs: {}, ai: undefined as never })
    if (!q.ok) throw new Error(q.reason)
    expect(q.quote.total_max.value).toBe('7.00')
    expect(q.quote.lines[0]).toMatchObject({ unit_price: '0.35', quantity: 20, max_total: '7.00' })
    expect(q.quote.excludes.join(' ')).toMatch(/At most 10 leads per domain.*not delivered and not paid/)
    expect(q.quote.excludes.join(' ')).not.toMatch(/Minimum settlement/) // 18+ leaves room for failures
    expect(m.calls.map((c) => c.path)).toEqual(['/v2/account']) // the free account call only: no domain search before a deal
  })

  it('the card: $0.35, minimum 18 ($6.30, room for 3 failures above the $5.00 settlement), maximum 100', () => {
    expect(card.pricing).toMatchObject({ model: 'per_unit', price: '0.35', unit: 'verified_lead', min_units: 18, max_units: 100 })
    expect(card.checks).toEqual(['lead_verified'])
  })

  it('asks for 17 and the quote warns that no failure room is left; below $5.00 it declines', async () => {
    const { bot: b } = bot(mockHunter({}), null)
    const seventeen = await b.quote(spec({ goal: 'Find leads', quantity: 17 }), card, { inputs: {}, ai: undefined as never })
    expect(seventeen.ok && seventeen.quote.excludes.join(' ')).toMatch(/Minimum settlement: at least 15 of 17/)
    expect(await reasonOf(b, spec({ goal: 'Find leads', quantity: 10 }))).toMatch(/below the platform's \$5\.00 minimum/)
    expect(await reasonOf(b, spec({ goal: 'Find leads', quantity: 101 }))).toMatch(/at most 100/)
  })

  it('never promises more than 10 leads per domain', async () => {
    const { bot: b } = bot(mockHunter({}), null)
    expect(await reasonOf(b, spec({ quantity: 40 }))).toMatch(/at most 10 leads per domain: 3 domains give at most 30/)
    // domains given as inputs count too
    expect(await reasonOf(b, spec({ goal: 'Find leads', quantity: 25 }), { domains: ['acme-corp.com', 'globex-inc.com'] })).toMatch(/2 domains give at most 20/)
    expect(await reasonOf(b, spec({ goal: 'Find leads', quantity: 30 }), { domains: Array.from({ length: 11 }, (_, i) => `co${i}.com`) })).toMatch(/at most 10 domains/)
    expect(MAX_DOMAINS).toBe(10)
  })

  it('declines when this month\'s searches are used up, and when what is left cannot reach the $5.00 minimum', async () => {
    const { bot: b } = bot(mockHunter({}, { used: 50, available: 50 }), null)
    expect(await reasonOf(b)).toMatch(/used up, resets 2026-11-20|used up.*resets 2026-11-20/)
    const one = bot(mockHunter({}, { used: 49, available: 50 }), null).bot
    expect(await reasonOf(one, spec({ goal: 'Find 20 leads at acme-corp.com', quantity: 20 }), { domains: ['acme-corp.com', 'globex-inc.com'] })).toMatch(/only 1 Hunter\.io search are left this month.*at most 10 leads \(\$3\.50\).*below the platform's \$5\.00 minimum/)
  })

  it('quotes fewer leads when fewer searches are left than the job needs', async () => {
    // 5 domains named, 50 leads asked for, but only 3 searches left: at most 30 leads can be found
    const { bot: b } = bot(mockHunter({}, { used: 47, available: 50 }), null)
    const domains = ['acme-corp.com', 'globex-inc.com', 'initech-llc.com', 'umbrella-co.com', 'hooli-xyz.com']
    const q = await b.quote(spec({ goal: 'Find 50 leads', quantity: 50, budget_cap: { value: '100.00', currency: 'USD' } }), card, { inputs: { domains }, ai: undefined as never })
    if (!q.ok) throw new Error(q.reason)
    expect(q.quote.lines[0]).toMatchObject({ quantity: 50, unit_price: '0.35', max_total: '10.50' }) // 30 x $0.35
    expect(q.quote.total_max.value).toBe('10.50')
    expect(q.quote.excludes.join(' ')).toMatch(/only 3 domain searches left this month.*at most 30 leads/)
    // the buyer's own cap still wins when it is lower
    const capped = await b.quote(spec({ goal: 'Find 50 leads', quantity: 50, budget_cap: { value: '7.00', currency: 'USD' } }), card, { inputs: { domains }, ai: undefined as never })
    expect(capped.ok && capped.quote.total_max.value).toBe('7.00')
  })

  it('declines, and says why, when it cannot check its quota', async () => {
    const m = mockHunter({})
    m.accountFails = { status: 500, details: 'database is on fire' }
    const { bot: b } = bot(m, null)
    expect(await reasonOf(b)).toMatch(/could not check how many Hunter\.io searches I have left/)
  })
})

describe('find_leads: no key', () => {
  it('is not offered as working: scope and quote decline cleanly, work searches nothing, Hunter is never called', async () => {
    const m = mockHunter(table('http://x'))
    const { bot: b } = bot(m, null, { key: '' })
    expect(b.scope(spec(), card)).toMatch(/Hunter\.io access is not set up.*Nothing was quoted or charged/)
    expect(await reasonOf(b)).toMatch(/Hunter\.io access is not set up/)
    const r = await b.work(makeJob(spec(), { domains: ['acme-corp.com'] }, 'find_leads'), fakeTools())
    expect(r.delivery.deliverables[0]!.units).toEqual([])
    expect(r.summary).toMatch(/not set up.*nothing is owed/)
    expect(m.calls).toEqual([])
  })
})

describe('find_leads: the work', () => {
  const run = async (o: { gone?: Set<string>; used?: number; tweak?: (m: ReturnType<typeof mockHunter>) => void; inputs?: Record<string, unknown>; want?: number } = {}) => {
    const s = await makeSite(o.gone)
    const m = mockHunter(table(s.origin), { used: o.used ?? 0 })
    o.tweak?.(m)
    const { bot: b, hunter } = bot(m, s)
    const sp = spec(o.want ? { quantity: o.want } : {})
    const tools = fakeTools()
    const r = await b.work(makeJob(sp, o.inputs ?? { domains: ['acme-corp.com', 'globex-inc.com', 'initech-llc.com'] }, 'find_leads'), tools)
    return { s, m, hunter, b, sp, tools, r, units: r.delivery.deliverables[0]!.units }
  }

  it('delivers only addresses that are on their source page and have MX; the rest are counted, not delivered, not paid', async () => {
    const { m, units, r, tools } = await run()
    const tos = units.map((u) => String(u.meta.to))
    expect(units.every((u) => u.meta.verified === true)).toBe(true) // never an honest "false" unit: it would pass lead_verified and be paid
    expect(tos).not.toContain('a8@acme-corp.com') // its only page lost it
    expect(tos).not.toContain('nopage@initech-llc.com') // Hunter named no source page
    expect(tos).toContain('a7@acme-corp.com')
    expect(units.find((u) => u.meta.to === 'a7@acme-corp.com')!.url).toMatch(/\/acme-2$/) // fell back to the second source
    expect(units).toHaveLength(19) // 6 + 1 acme, 8 + jane globex, 3 initech; a8 and nopage dropped
    expect(units.map((u) => u.ref)).toEqual(units.map((_, i) => `lead-${i + 1}`))
    expect(units[0]!.meta).toMatchObject({ to: 'a1@acme-corp.com', company: 'Acme Corp', domain: 'acme-corp.com', verified: true, first_name: 'a', last_name: 'Tester', position: 'Head of Marketing', found_via: 'Hunter.io domain search' })
    expect(r.summary).toMatch(/Delivered 19 verified leads of the 20 asked for/)
    expect(r.summary).toMatch(/2 listed addresses not delivered and not paid: 1 no longer on their source page or without MX records, 1 with no source page/)
    expect(r.summary).toMatch(/At most 10 leads per domain/)
    // a fair share per domain first: no domain was drained before the others were searched
    expect(m.calls.filter((c) => c.path === '/v2/domain-search')).toHaveLength(3)
    expect(tools.logs.filter((l) => l.action === 'hunter_search')).toHaveLength(3)
  })

  it('type "generic": only role addresses are delivered, personal-looking ones are counted, never units; third-party pages are flagged', async () => {
    const s = await startSite((u) => (u.pathname === '/people' ? [200, mailtos(['info@acme-corp.com', 'press-office@acme-corp.com', 'kq01@acme-corp.com', 'mlarkin@acme-corp.com', 'abcd1234@acme-corp.com'])] : [404, 'not found']))
    sites.push(s)
    const list = ['info@acme-corp.com', 'press-office@acme-corp.com', 'kq01@acme-corp.com', 'mlarkin@acme-corp.com', 'abcd1234@acme-corp.com']
    // Hunter claims all five are generic: its filter does not hold, so the bot must not trust it.
    const m = mockHunter({ 'acme-corp.com': { organization: 'Acme Corp', emails: list.map((a) => email(a, `${s.origin}/people`, { type: 'generic' })) } })
    const { bot: b } = bot(m, s)
    const r = await b.work(makeJob(spec({ quantity: 18 }), { domains: ['acme-corp.com'], type: 'generic' }, 'find_leads'), fakeTools())
    const units = r.delivery.deliverables[0]!.units
    expect(units.map((u) => u.meta.to)).toEqual(['info@acme-corp.com', 'press-office@acme-corp.com'])
    expect(m.calls.find((c) => c.path === '/v2/domain-search')!.query.type).toBe('generic')
    expect(r.summary).toMatch(/3 addresses looked personal, not a role address, and were left out \(not delivered, not paid\)/)
    // the test site is not on acme-corp.com, so each lead says its page is a third party's
    expect(units.every((u) => (u.meta.flags as string[]).includes('third_party_source'))).toBe(true)
    // without a type nothing is filtered out
    const m2 = mockHunter({ 'acme-corp.com': { organization: 'Acme Corp', emails: list.map((a) => email(a, `${s.origin}/people`)) } })
    const r2 = await bot(m2, s).bot.work(makeJob(spec({ quantity: 18 }), { domains: ['acme-corp.com'] }, 'find_leads'), fakeTools())
    expect(r2.delivery.deliverables[0]!.units).toHaveLength(5)
    expect(r2.summary).not.toMatch(/looked personal/)
    // the request alone (no inputs at all): its domain and its ask for role addresses are enough, as in production's goal
    const m4 = mockHunter({ 'acme-corp.com': { organization: 'Acme Corp', emails: list.map((a) => email(a, `${s.origin}/people`)) } })
    const asked = spec({ quantity: 18, goal: 'Find generic role email addresses (info@, press@ style, not named people) at acme-corp.com.' })
    const r4 = await bot(m4, s).bot.work(makeJob(asked, {}, 'find_leads'), fakeTools())
    expect(r4.delivery.deliverables[0]!.units.map((u) => u.meta.to)).toEqual(['info@acme-corp.com', 'press-office@acme-corp.com'])
    expect(m4.calls.find((c) => c.path === '/v2/domain-search')!.query).toMatchObject({ domain: 'acme-corp.com', type: 'generic' })
    expect(bot(m4, s).bot.requirements(asked, card).assumptions[1]).toMatch(/type "generic" without a separate input/)
    // personal: unchanged too
    const m3 = mockHunter({ 'acme-corp.com': { organization: 'Acme Corp', emails: list.map((a) => email(a, `${s.origin}/people`)) } })
    const r3 = await bot(m3, s).bot.work(makeJob(spec({ quantity: 18 }), { domains: ['acme-corp.com'], type: 'personal' }, 'find_leads'), fakeTools())
    expect(r3.delivery.deliverables[0]!.units).toHaveLength(5)
  })

  it('flags free webmail addresses, still verified because the page and MX hold', async () => {
    const { units } = await run()
    const jane = units.find((u) => u.meta.to === 'jane@gmail.com')!
    expect(jane.meta.flags).toContain('free_webmail')
    // ranked last: every company address came first
    expect(units.indexOf(jane)).toBeGreaterThan(units.findIndex((u) => u.meta.domain === 'globex-inc.com'))
  })

  it('applies a department named in the request ("marketing leads") to the Hunter search; a buyer filter wins', async () => {
    const a = await run()
    expect(a.m.calls.find((c) => c.path === '/v2/domain-search')!.query.department).toBe('marketing')
    const b = await run({ inputs: { domains: ['acme-corp.com'], department: 'sales,finance', seniority: 'executive' }, want: 18 })
    expect(b.m.calls.find((c) => c.path === '/v2/domain-search')!.query).toMatchObject({ department: 'sales,finance', seniority: 'executive' })
    expect(b.r.summary).toMatch(/Filters: department sales\+finance, seniority executive/)
  })

  it('reads the account again before it works and searches only as many domains as are left', async () => {
    const { m, r, hunter } = await run({ used: 48 }) // 2 searches left: the quote may have assumed more
    expect(m.calls.filter((c) => c.path === '/v2/domain-search').map((c) => c.query.domain)).toEqual(['acme-corp.com', 'globex-inc.com'])
    expect(r.summary).toMatch(/Hunter\.io quota: 2 searches left this month, so only the first 2 domains could be searched/)
    expect(hunter.requests.domainSearch).toBe(2)
  })

  it('declines to work when the searches are used up: an empty delivery, nothing owed, no search sent', async () => {
    const { m, units, r } = await run({ used: 50 })
    expect(units).toEqual([])
    expect(r.summary).toMatch(/used up.*nothing is owed/)
    expect(m.calls.filter((c) => c.path === '/v2/domain-search')).toEqual([])
  })

  it('stops when Hunter refuses mid-job and delivers what it already has; a domain Hunter will not list is skipped', async () => {
    const { units, r } = await run({
      tweak: (m) => {
        m.domains['globex-inc.com']!.fail = { status: 429, id: 'usage_limit_reached', details: 'You have reached your monthly usage limit.' }
      },
    })
    expect(units.length).toBeGreaterThan(0)
    expect(units.every((u) => u.meta.domain === 'acme-corp.com')).toBe(true)
    expect(r.summary).toMatch(/globex-inc\.com: Hunter\.io says the monthly allowance is used up/)
    expect(r.summary).toMatch(/Stopped searching/)
    const skip = await run({
      tweak: (m) => {
        m.domains['globex-inc.com']!.fail = { status: 451, id: 'claimed_email', details: 'unavailable for legal reasons' }
      },
    })
    expect(skip.units.some((u) => u.meta.domain === 'initech-llc.com')).toBe(true) // went on to the next domain
  })

  it('skips a domain that is itself a free webmail provider and a list with no company domain', async () => {
    const s = await makeSite()
    const m = mockHunter({ ...table(s.origin), 'acme-corp.com': { organization: 'x', webmail: true, emails: [] } })
    const { bot: b } = bot(m, s)
    const r = await b.work(makeJob(spec({ quantity: 18 }), { domains: ['acme-corp.com', 'gmail.com'] }, 'find_leads'), fakeTools())
    expect(r.summary).toMatch(/acme-corp\.com is a free webmail provider/)
    expect(r.summary).toMatch(/Not searched \(not a company domain\): gmail\.com/)
    const none = await b.work(makeJob(spec(), { domains: ['gmail.com', 'nonsense'] }, 'find_leads'), fakeTools())
    expect(none.delivery.deliverables[0]!.units).toEqual([])
    expect(none.summary).toMatch(/none of the domains you gave is a company domain/)
  })

  it('names the missing input, and does no redo or substitute (it would spend more searches)', () => {
    const { bot: b } = { bot: leadFinder({ hunter: createHunter({ apiKey: KEY, fetchImpl: mockHunter({}).fetchImpl }) }) }
    const vague = spec({ goal: 'Find 20 marketing leads at the companies I will send.' })
    expect(b.missingInputs({}, vague)).toEqual(['domains'])
    expect(b.missingInputs({ domains: 'gmail.com' }, spec())).toEqual(['domains']) // a domains input that names none is not replaced by the request
    expect(b.missingInputs({ domains: ['acme-corp.com'] }, vague)).toEqual([])
    expect(b.missingInputs({}, spec())).toEqual([]) // the request names its 3 domains
    expect(b.requirements(vague, card).inputs_schema).toMatchObject({ required: ['domains'] })
    expect(b.canAgree).toBeUndefined()
    const two = spec()
    two.deliverables.push({ ...two.deliverables[0]!, id: 'D2' })
    expect(b.scope(two, card)).toMatch(/one deliverable/)
    const req = b.requirements(spec(), card)
    expect(req.inputs_schema).toMatchObject({ required: [], properties: { domains: { type: 'array', maxItems: 10 } } })
    expect(req.assumptions[0]).toBe('Domains: I search the 3 domains your request names (acme-corp.com, globex-inc.com, initech-llc.com). Send `domains` only to search others instead.')
    expect(req.assumptions.join(' ')).toMatch(/Hunter\.io.*50 domain searches a month/)
    expect(b.clarify!('what is the monthly limit?', spec(), card)).toMatch(/50 domain searches a month/)
  })
})

describe('find_leads: the key never leaves', () => {
  it('appears in no quote, delivery, summary, log line, note or error text, even when Hunter echoes it', async () => {
    const s = await makeSite()
    const log = memoryLogger()
    const m = mockHunter(table(s.origin))
    // every refusal of Hunter repeats the key back in its details
    m.domains['globex-inc.com']!.fail = { status: 400, details: `domain refused for key ${KEY}` }
    const { bot: b } = bot(m, s)
    const tools = fakeTools()
    const q = await b.quote(spec(), card, { inputs: {}, ai: undefined as never })
    const r = await b.work(makeJob(spec(), { domains: ['acme-corp.com', 'globex-inc.com', 'initech-llc.com'] }, 'find_leads'), { ...tools, log: (action, extra) => { tools.log(action, extra); log({ action, ...extra }) } })
    // and a wrong key (the mock echoes it back in its 401)
    const wrong = bot(mockHunter({}, { key: 'another-key-0000000000' }), s)
    const rejected = await wrong.bot.work(makeJob(spec(), { domains: ['acme-corp.com'] }, 'find_leads'), fakeTools())
    const quoteWrong = await reasonOf(wrong.bot)
    const everything = JSON.stringify({ q, r, logs: tools.logs, memory: log.entries, rejected, quoteWrong, assumptions: b.requirements(spec(), card), progress: tools.progressCalls })
    expect(everything).not.toContain(KEY)
    expect(everything.length).toBeGreaterThan(500)
    expect(rejected.summary).toMatch(/Hunter\.io rejected the bot's API key/)
    expect(r.summary).toMatch(/globex-inc\.com: Hunter\.io refused the request \(domain refused for key \[redacted\]\)/)
  })

  it('the bot never puts the key anywhere a model could read: its prompts come from the skill card, not from the key', async () => {
    // The bot has no AI step at all: nothing it builds is sent to a model.
    const s = await makeSite()
    const { bot: b } = bot(mockHunter(table(s.origin)), s)
    let asked = 0
    const ai = { enabled: true, complete: async () => (asked++, 'x') } as never
    const tools = { ...fakeTools(), ai }
    await b.work(makeJob(spec(), { domains: ['acme-corp.com'] }, 'find_leads'), tools)
    expect(asked).toBe(0)
  })
})

describe('find_leads: the platform pays only what it re-verifies', () => {
  const lib = (s: Site) => {
    const l = createCheckLibrary({ allowHosts: [s.host] })
    registerHouseBotChecks(l, { allowHosts: [s.host], ...mxOpts })
    return l
  }

  it('re-runs lead_verified on every delivered unit: all pass when nothing changed', async () => {
    const { s, sp, r, tools } = await (async () => {
      const s = await makeSite()
      const m = mockHunter(table(s.origin))
      const { bot: b } = bot(m, s)
      const tools = fakeTools()
      const sp = spec()
      return { s, sp, tools, r: await b.work(makeJob(sp, { domains: ['acme-corp.com', 'globex-inc.com', 'initech-llc.com'] }, 'find_leads'), tools) }
    })()
    const results = await runAcceptance(lib(s), sp, r.delivery, tools)
    expect(passedUnits(results)).toHaveLength(19)
    expect(results.every((x) => x.check === 'lead_verified' && x.status === 'pass')).toBe(true)
  })

  it('a lead whose address left its page after the bot checked fails the platform check, so it is not paid; a forged claim fails too', async () => {
    const gone = new Set<string>()
    const s = await makeSite(gone)
    const m = mockHunter(table(s.origin))
    const { bot: b } = bot(m, s)
    const tools = fakeTools()
    const sp = spec()
    const r = await b.work(makeJob(sp, { domains: ['acme-corp.com', 'globex-inc.com', 'initech-llc.com'] }, 'find_leads'), tools)
    gone.add('g3@globex-inc.com') // taken off the page between the bot's check and the platform's
    const forged = { ...r.delivery.deliverables[0]!.units[0]!, ref: 'lead-99', meta: { ...r.delivery.deliverables[0]!.units[0]!.meta, to: 'nobody@acme-corp.com', verified: true } } // claims a lead the page never had
    const delivery = { ...r.delivery, deliverables: [{ ...r.delivery.deliverables[0]!, units: [...r.delivery.deliverables[0]!.units, forged] }] }
    const results = await runAcceptance(lib(s), sp, delivery, tools)
    const pass = passedUnits(results)
    const g3 = r.delivery.deliverables[0]!.units.find((u) => u.meta.to === 'g3@globex-inc.com')!
    expect(pass).not.toContain(g3.ref)
    expect(pass).not.toContain('lead-99')
    expect(pass).toHaveLength(18) // 19 delivered - g3 (changed); the forged one is the 20th and fails
    expect(results.find((x) => x.unit === g3.ref)!.detail).toMatch(/not verified.*address not on the source page/)
    expect(results.find((x) => x.unit === 'lead-99')!.detail).toMatch(/not verified/)
  })
})
