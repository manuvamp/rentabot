// Account Setup Bot (demo mode): opens accounts for the buyer's product on the Sandbox Web SaaS services and proves each is live.
//   1. read /sandbox/saas.json (analytics, newsletter, social, status page, community forum)
//   2. per service: log_action create_account first, then sign up with the product's handle (a taken handle -> the next candidate;
//      a 429 -> the same signup after its Retry-After) using a unique strong generated password
//   3. hand the login to the buyer through the locker at once, tied to that service's unit (it opens when the unit is paid)
//   4. read the verification mail in the buyer's inbox (A1, with the buyer's app password), open the link (log_action browse first),
//      log in, and fill the profile (log_action fill_form first): name, logo, bio and link, trimmed to the service's limits
//   5. wait until the public profile is live (the forum reviews first), open it, and keep it only if it shows the product and its link;
//      store a rendered snapshot as the artifact
//   6. deliver one unit per working account: its public profile URL. Logins never appear in the delivery; they are in the locker.
// Without a consent in the contract the bot creates no accounts.
import type { Delivery } from '@rentabot/shared'
import { actionLogger, fit, handOver, handedOverRefs, loginFrom, readMailbox, sandboxLink, slugify, strongPassword, type ActionLogger, type Login } from '../actions.ts'
import { asString, badAsk, http, httpJson, needsSchema, onOrigin, pool, primary, sleep, str } from '../common.ts'
import { htmlToText } from '../server-shared.ts'
import { buildQuote, type SellerBot, type WorkJob, type WorkResult, type WorkTools } from '../runtime.ts'

export interface AccountSetupOptions {
  /** Sandbox Web base, e.g. http://localhost:8790/sandbox. */
  sandboxUrl: string
  pollMs?: number
  /** Upper bound on waiting for mail and review; default derives from the sandbox's time scale. */
  settleMs?: number
  retryCapMs?: number
  concurrency?: number
}

interface CatalogService {
  slug: string
  name: string
  kind: string
  url: string
  host: string
  signup_endpoint: string
  login_endpoint: string
  profile_endpoint: string
  limits: { display_name: number; bio: number }
  handle_rules: { length: [number, number] }
}

interface Acct {
  svc: CatalogService
  stage: 'new' | 'awaiting_verification' | 'profile' | 'live_wait' | 'done' | 'failed'
  note: string | null
  password: string | null
  handle: string | null
  created: boolean
  handedOver: boolean
  verifyOpened: boolean
  profileUrl: string | null
  token: string | null
}

const REQUIRED = ['product_name', 'url', 'tagline_60', 'description_300', 'contact_email', 'logo_url']
const created = new Map<string, { password: string; handle: string }>()

/** Handle candidates for a product on a service: the plain slug first, then the usual variants, all within the service's length rules. */
export function handleCandidates(product: string, rules: [number, number], preferred = ''): string[] {
  const base = slugify(preferred || product).replace(/-+/g, '-') || 'product'
  const [min, max] = rules
  const variants = [base, `${base}-hq`, `get-${base}`, `${base}-app`, `try-${base}`, `${base}-official`]
  const ok: string[] = []
  for (const v of variants) {
    let h = v.length < min ? `${v}-app`.slice(0, max) : v.slice(0, max)
    while (h.length < min) h += 'x'
    h = h.replace(/^-+|-+$/g, '')
    if (h.length >= min && h.length <= max && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(h) && !ok.includes(h)) ok.push(h)
  }
  return ok
}

export function accountSetup(opts: AccountSetupOptions): SellerBot {
  const base = opts.sandboxUrl.replace(/\/+$/, '')
  const origin = new URL(base).origin
  const pollMs = opts.pollMs ?? 3000
  const retryCap = opts.retryCapMs ?? 5000

  return {
    slug: 'account-setup-bot',
    name: 'Account Setup Bot',
    skillId: 'account_setup',
    maxConcurrent: 3,

    scope(spec) {
      if (spec.deliverables.length > 1) return 'I deliver one deliverable of accounts per job.'
      return badAsk(spec)
    },

    requirements(spec) {
      const quantity = primary(spec).quantity
      return {
        inputs_schema: needsSchema(
          {
            product_name: str('Product name (the name on every profile)'),
            url: str('Product URL (the link on every profile)', { format: 'uri' }),
            tagline_60: str('Tagline, max 60 characters', { maxLength: 60 }),
            description_300: str('Description / bio, max 300 characters', { maxLength: 300 }),
            contact_email: str('Contact email: every account is created with it and verification mails are read here', { format: 'email' }),
            logo_url: str('Public URL of the logo image', { format: 'uri' }),
            handle: str('Preferred handle (default: the product name)'),
          },
          REQUIRED,
        ),
        access: [
          {
            id: 'A1',
            kind: 'inbox_verification',
            why: 'Every service emails a verification link to contact_email. Put the address and app password of that mailbox here (demo: create one at /sandbox/mail/mailboxes). I only read verification mail, and every action is capped below.',
            scope: 'read-only: verification mail for contact_email; create accounts, fill profiles and open links on the services only',
            required: false,
            consent: { actions: ['create_account', 'fill_form', 'browse'], max_total: quantity * 3 + 3, targets: ['saas.sandbox'], until: spec.deadline },
          },
        ],
        assumptions: [
          'One account per service, in your product\'s name, created with contact_email and a unique strong generated password.',
          'Logins reach you only through the job locker, and open once the matching account is paid. They never appear in a message or the delivery.',
          'Demo mode: the services are Sandbox Web fixtures, not real products.',
          'A unit is a working account: I deliver it only after opening its public profile and seeing your product name and link on it; the platform re-checks it.',
        ],
        questions: [],
      }
    },

    quote(spec, skill) {
      return buildQuote(spec, skill, { priced: [primary(spec).id] })
    },

    missingInputs(inputs) {
      return REQUIRED.filter((k) => !asString(inputs[k]))
    },

    clarify(question) {
      if (/password|login|credential/i.test(question)) return 'Each account gets a unique generated password. The login goes into your job locker and opens once that account is paid; I never post it in the room.'
      if (/inbox|email|verif/i.test(question)) return 'Every service emails a verification link to contact_email. Share that mailbox\'s app password for access A1 so I can read those mails (read-only).'
      if (/how many|which service/i.test(question)) return 'One account per service, in the catalog order: analytics, newsletter, social profile, status page, community forum. Ask for 4 or 5.'
      return null
    },

    async canAgree(offer, job) {
      if (offer.kind !== 'substitute' || offer.deliverable_id !== primary(job.spec).id) return false
      const cat = await httpJson<{ services: CatalogService[] }>(`${base}/saas.json`)
      return !!cat.json && cat.json.services.length - primary(job.spec).quantity >= offer.units.length
    },

    async work(job: WorkJob, tools: WorkTools): Promise<WorkResult> {
      const inputs = job.inputs
      const product = asString(inputs.product_name)
      const want = primary(job.spec).quantity
      const contact = asString(inputs.contact_email).toLowerCase()
      const deliverableId = primary(job.spec).id
      const link = asString(inputs.url)
      const mustShow = [...new Set([product, ...primary(job.spec).acceptance.filter((t) => t.check === 'page_mentions').flatMap((t) => (Array.isArray(t.params.must_include) ? t.params.must_include.map(String) : []))])]
      const linkHost = (() => {
        try {
          return new URL(link).host.replace(/^www\./, '')
        } catch {
          return link
        }
      })()

      const inbox: Login | null = loginFrom(job.secrets, 'A1')
      const consented = !!job.contract?.requirements?.access.find((a) => a.id === 'A1')?.consent
      const logger: ActionLogger | null = consented ? await actionLogger(tools, job.id, 'A1') : null
      const allow = async (action: 'create_account' | 'fill_form' | 'browse', target: string, extra: { external_ref?: string } = {}) => (logger ? logger.allow(action, target, extra) : false)
      const already = await handedOverRefs(tools, job.id)

      const cat = await httpJson<{ time_scale: number; services: CatalogService[] }>(`${base}/saas.json`)
      if (!cat.json) throw new Error(`Sandbox Web SaaS catalog unavailable (HTTP ${cat.status})`)
      const scale = Number.isFinite(cat.json.time_scale) ? cat.json.time_scale : 1
      const services = cat.json.services
      const chosen = job.agreement?.kind === 'substitute' ? services.slice(want, want + job.agreement.units.length) : services.slice(0, want)
      tools.log('catalog', { services: services.length, chosen: chosen.length })

      const list: Acct[] = chosen.map((svc) => ({ svc, stage: 'new', note: null, password: null, handle: null, created: false, handedOver: false, verifyOpened: false, profileUrl: null, token: null }))

      // 2-3) sign up and hand over
      await pool(list, opts.concurrency ?? 3, async (a) => {
        await signUp(a)
      })
      await tools.progress(35, `${list.filter((a) => a.created).length}/${list.length} accounts created; waiting for verification mail`)

      // 4) verification mail, login, profile; 5) wait until live
      const deadline = Date.now() + (opts.settleMs ?? Math.ceil(30 * 60_000 * scale) + 4000)
      let denied = false
      for (;;) {
        const r = await mailPass(list)
        denied ||= r.denied
        await livePass(list)
        const open = list.filter((a) => a.stage === 'awaiting_verification' || a.stage === 'profile' || a.stage === 'live_wait')
        if (!open.length || Date.now() > deadline || tools.signal.aborted) break
        await sleep(pollMs)
      }
      for (const a of list) if (!['done', 'failed'].includes(a.stage) && !a.note) a.note = a.stage === 'awaiting_verification' ? (denied ? 'the inbox refused the app password (or it was not shared)' : 'the verification mail did not arrive in time') : 'the profile was not public in time'
      await tools.progress(80, 'profiles settled; checking each one')

      // 6) observe every public profile and keep the evidence
      const units: Delivery['deliverables'][number]['units'] = []
      const skipped: string[] = []
      await pool(list, opts.concurrency ?? 3, async (a) => {
        if (!a.profileUrl) return void skipped.push(`${a.svc.name} (${a.note ?? 'no profile'})`)
        const page = await http(onOrigin(a.profileUrl, origin))
        if (page.status !== 200) return void skipped.push(`${a.svc.name} (profile not public: HTTP ${page.status})`)
        const shown = htmlToText(page.text).toLowerCase()
        const lacking = [...mustShow, linkHost].filter((t) => !shown.includes(t.toLowerCase()))
        if (lacking.length) return void skipped.push(`${a.svc.name} (the public page lacks ${lacking.map((t) => `"${t}"`).join(', ')})`)
        const snap = await http(`${onOrigin(a.profileUrl, origin)}/snapshot`)
        if (snap.status !== 200) return void skipped.push(`${a.svc.name} (no snapshot)`)
        const artifact = await tools.uploadArtifact({ name: `profile-${a.svc.slug}.svg`, mime: 'image/svg+xml', text: snap.text })
        units.push({
          ref: a.svc.slug,
          url: a.profileUrl,
          artifact_ids: [artifact],
          meta: {
            service: a.svc.name,
            kind: a.svc.kind,
            handle: a.handle,
            profile_status: 'live',
            mentions_product: true,
            email_verified: true,
            login: 'created for you; in your locker, opens once this unit is paid',
            observed_at: new Date().toISOString(),
          },
        })
      })
      units.sort((a, b) => a.ref.localeCompare(b.ref))

      const handed = list.filter((a) => a.handedOver).length
      const delivered = new Set(units.map((u) => u.ref))
      const orphaned = list.filter((a) => a.handedOver && !delivered.has(a.svc.slug)).length
      const parts = [
        `Services: ${services.length} on offer; ${chosen.length} chosen (${chosen.map((s) => s.name).join(', ')}).`,
        `Created ${list.filter((a) => a.created).length} account(s) with unique generated passwords (each logged with log_action first) and put ${handed} login(s) in your locker; they open once the matching account is paid${orphaned ? `; ${orphaned} of them did not become a working account, so those logins stay unreleased and are shredded when the job ends` : ''}.`,
        logger?.blockedReason ? `I stopped acting at your consent limit (${logger.blockedReason}); ${logger.accepted} action(s) were taken and logged.` : logger ? `${logger.accepted} action(s) were logged against your consent.` : 'This contract carries no consent, so I created no accounts.',
        `Delivered ${units.length} working account(s): I opened each public profile myself and saw "${product}" and ${linkHost} on it, with a rendered snapshot.`,
        skipped.length ? `Not delivered: ${skipped.join('; ')}. The platform re-checks delivered profiles later.` : 'Nothing was left out. The platform re-checks delivered profiles later.',
      ]
      return { summary: parts.join('\n'), delivery: { deliverables: [{ deliverable_id: deliverableId, units, note: parts[3]! }], note: parts.join(' ') } }

      // ---- steps ----

      async function signUp(a: Acct): Promise<void> {
        const key = `${job.id}:${a.svc.slug}`
        const earlier = created.get(key)
        if (earlier) {
          // This process created it in an earlier attempt of this job: carry on with it.
          Object.assign(a, { password: earlier.password, handle: earlier.handle, created: true, handedOver: already.has(a.svc.slug), stage: 'awaiting_verification' })
          return
        }
        if (!(await allow('create_account', a.svc.host, { external_ref: a.svc.signup_endpoint }))) {
          a.stage = 'failed'
          a.note = logger ? `no account created: ${logger.blockedReason ?? 'the consent does not allow it'}` : 'no account created: this contract has no consent for creating accounts'
          return
        }
        const password = strongPassword()
        const queue = handleCandidates(product, a.svc.handle_rules.length, asString(inputs.handle))
        const tried: string[] = []
        let busy = 0
        for (let guard = 0; guard < 14 && queue.length; guard++) {
          const handle = queue[0]!
          const r = await httpJson<{ error?: string; suggestions?: string[] }>(onOrigin(a.svc.signup_endpoint, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: contact, password, handle, display_name: product }) })
          if (r.status === 429 || r.status === 503) {
            // Busy: the same signup again after the Retry-After (the action is already logged).
            if (busy++ >= 3) break
            await sleep(Math.min(retryCap, (Number(r.headers.get('retry-after')) || 2) * 1000))
            continue
          }
          if (r.status === 409 && r.json?.error === 'handle_taken') {
            tried.push(queue.shift()!)
            queue.unshift(...(r.json.suggestions ?? []).filter((x) => !tried.includes(x) && !queue.includes(x)))
            continue
          }
          if (r.status === 409) {
            a.stage = 'failed'
            a.note = `an account for ${contact} already exists on ${a.svc.name} (not created by this job)`
            reuseEarlier(a)
            return
          }
          if (r.status !== 201) {
            a.stage = 'failed'
            a.note = `signup refused: HTTP ${r.status} ${String(r.json?.error ?? '')}`.trim()
            return
          }
          created.set(key, { password, handle })
          Object.assign(a, { password, handle, created: true })
          try {
            await handOver(tools, job.id, { deliverable_id: deliverableId, unit_ref: a.svc.slug, site: a.svc.host, label: `${product} on ${a.svc.name}`, url: `${a.svc.url}/login`, username: contact, password, notes: `Handle @${handle}. Created by Account Setup Bot for ${product}. Change the password when you take it over.` })
            a.handedOver = true
          } catch (e) {
            a.stage = 'failed'
            a.note = `the account was created but its login could not be handed over (${(e as Error).message.slice(0, 120)}), so I did not set it up`
            return
          }
          a.stage = 'awaiting_verification'
          return
        }
        a.stage = 'failed'
        a.note = busy > 3 ? 'the service stayed busy (rate limited)' : `no free handle found (tried ${tried.slice(0, 5).join(', ') || queue.slice(0, 3).join(', ')})`
      }

      /** A rerun finds an account of its earlier delivery again (the profile page is public; the login is already in the locker). */
      function reuseEarlier(a: Acct) {
        const prev = job.previous?.deliverables.flatMap((d) => d.units).find((u) => u.ref === a.svc.slug && u.url)
        if (!prev?.url) return
        a.profileUrl = prev.url
        a.handle = String(prev.meta.handle ?? '') || null
        a.stage = 'done'
        a.note = null
      }

      async function mailPass(accts: Acct[]): Promise<{ denied: boolean }> {
        const waiting = accts.filter((a) => a.stage === 'awaiting_verification' && !a.verifyOpened)
        if (!waiting.length || !contact) return { denied: false }
        const box = await readMailbox(base, contact, inbox)
        if (box.denied) {
          for (const a of waiting) {
            a.stage = 'failed'
            a.note = 'the inbox refused the app password (or it was not shared), so the account could not be verified'
          }
          return { denied: true }
        }
        for (const a of waiting) {
          const hit = box.messages.find((m) => m.to === contact && m.from === `noreply@${a.svc.host}` && /verify your email/i.test(m.subject))
          const verify = hit ? sandboxLink(hit.text, origin, new RegExp(`^/sandbox/saas/${a.svc.slug}/account/verify/[a-f0-9]+$`)) : null
          if (!verify) continue
          if (!(await allow('browse', a.svc.host, { external_ref: new URL(verify).pathname }))) {
            a.stage = 'failed'
            a.note = `the verification link was not opened: ${logger?.blockedReason ?? 'not allowed by the consent'}`
            continue
          }
          a.verifyOpened = (await http(verify)).status === 200
          if (!a.verifyOpened) continue
          const login = await httpJson<{ session_token?: string }>(onOrigin(a.svc.login_endpoint, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: contact, password: a.password }) })
          if (login.status !== 200 || !login.json?.session_token) {
            a.stage = 'failed'
            a.note = `login failed after verification: HTTP ${login.status}`
            continue
          }
          a.token = login.json.session_token
          a.stage = 'profile'
          await fillProfile(a)
        }
        return { denied: false }
      }

      async function fillProfile(a: Acct): Promise<void> {
        if (!(await allow('fill_form', a.svc.host, { external_ref: a.svc.profile_endpoint }))) {
          a.stage = 'failed'
          a.note = `the profile was not filled: ${logger?.blockedReason ?? 'not allowed by the consent'}`
          return
        }
        const body = { display_name: fit(product, a.svc.limits.display_name), bio: fit(asString(inputs.description_300) || asString(inputs.tagline_60), a.svc.limits.bio), logo_url: asString(inputs.logo_url), link }
        const r = await httpJson<{ status?: string; profile_url?: string; errors?: Record<string, string> }>(onOrigin(a.svc.profile_endpoint, origin), { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` }, body: JSON.stringify(body) })
        if (r.status !== 200 || !r.json?.profile_url) {
          a.stage = 'failed'
          a.note = `profile refused: HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json ?? {}).slice(0, 160)}`
          return
        }
        a.profileUrl = r.json.profile_url
        a.stage = r.json.status === 'live' ? 'done' : 'live_wait'
      }

      async function livePass(accts: Acct[]): Promise<void> {
        for (const a of accts.filter((x) => x.stage === 'live_wait' && x.profileUrl)) {
          if ((await http(onOrigin(a.profileUrl!, origin))).status === 200) a.stage = 'done'
        }
      }
    },
  }
}
