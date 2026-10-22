// Directory Blaster (demo mode): submits a product to the Sandbox Web directories and proves every listing.
//   1. read /sandbox/dirs.json; skip directories that declare payment or human verification
//   2. for each directory chosen: where it wants an account, create one (unique strong password, log_action first), hand its
//      login to the buyer through the locker tied to that listing's unit, wait for the verification mail in the buyer's inbox
//      (A1, read with the buyer's app password), open the link, log in; then fill the listing form (log_action first) through
//      the directory's JSON API (a 503 is retried once, after its Retry-After)
//   3. open the confirmation links found in the contact address's mailbox
//   4. wait for moderation to settle; open each listing, check it shows the product, and store its
//      "rendered snapshot" as an artifact
//   5. deliver one unit per listing it actually SAW live with the product name on the page. Rejected,
//      rewritten, removed and still-pending listings are not delivered; they are counted in the note.
// Every real action (create_account, fill_form, browse) is reported with log_action BEFORE it is taken and counts against the
// buyer's consent; at the cap the bot stops and says so. Without a consent in the contract it creates no accounts.
import type { Delivery } from '@rentabot/shared'
import { actionLogger, handOver, handedOverRefs, loginFrom, readMailbox, sandboxLink, strongPassword, type ActionLogger, type Login } from '../actions.ts'
import { asString, badAsk, http, httpJson, needsSchema, onOrigin, pool, primary, sleep, str } from '../common.ts'
import { htmlToText } from '../server-shared.ts'
import { buildQuote, type SellerBot, type WorkJob, type WorkResult, type WorkTools } from '../runtime.ts'

export interface DirectoryBlasterOptions {
  /** Sandbox Web base, e.g. http://localhost:8790/sandbox. Demo mode only ever talks to this. */
  sandboxUrl: string
  /** Receipt polling interval while listings settle. */
  pollMs?: number
  /** Upper bound on waiting for moderation; default derives from the sandbox's time scale. */
  settleMs?: number
  /** Longest Retry-After honoured before the single 503 retry. */
  retryCapMs?: number
  concurrency?: number
}

interface CatalogDir {
  slug: string
  name: string
  url: string
  categories: string[]
  submit_endpoint: string
  pricing: 'free' | 'paid'
  human_verification: boolean
  requirements: string[]
  account?: { required: boolean; signup_endpoint: string; login_endpoint: string }
}

type Phase = 'pending_email_verification' | 'pending_review' | 'live' | 'rejected' | 'removed' | 'unknown'

interface Sub {
  dir: CatalogDir
  submissionId: string | null
  listingUrl: string | null
  receiptUrl: string | null
  phase: Phase
  /** Why this directory ended without a delivered unit (or null while it may still). */
  note: string | null
  via: 'instant' | 'email link' | 'moderation' | null
  retried503: boolean
  emailOpened: boolean
  /** Account steps (directories that require one). */
  stage: 'none' | 'awaiting_verification' | 'ready' | 'submitted' | 'failed'
  account: { password: string; created: boolean } | null
  handedOver: boolean
  verifyOpened: boolean
}

const REQUIRED = ['product_name', 'url', 'tagline_60', 'description_300', 'category', 'contact_email']
const hostOf = (d: CatalogDir) => `${d.slug}.dirs.sandbox`
/** Passwords of accounts created by this process, so a retry inside it can still log in (the locker never gives them back to the bot). */
const created = new Map<string, string>()

export function directoryBlaster(opts: DirectoryBlasterOptions): SellerBot {
  const base = opts.sandboxUrl.replace(/\/+$/, '')
  const origin = new URL(base).origin
  const pollMs = opts.pollMs ?? 4000
  const retryCap = opts.retryCapMs ?? 5000

  return {
    slug: 'directory-blaster',
    name: 'Directory Blaster',
    skillId: 'directory_submission',
    maxConcurrent: 2,

    scope(spec) {
      if (spec.deliverables.length > 1) return 'I deliver one deliverable of directory listings per job.'
      return badAsk(spec) ?? (/\b(paid|sponsored)\s+(placements?|listings?)\b/i.test(spec.goal) && !/\b(no|not|without|skip|exclude)\b/i.test(spec.goal) ? 'I only submit to free directories; paid placements are out of scope.' : null)
    },

    requirements(spec) {
      const quantity = primary(spec).quantity
      return {
        inputs_schema: needsSchema(
          {
            product_name: str('Product name'),
            url: str('Product URL', { format: 'uri' }),
            tagline_60: str('Tagline, max 60 characters', { maxLength: 60 }),
            description_300: str('Description, max 300 characters', { maxLength: 300 }),
            category: str('Directory category, e.g. Productivity'),
            contact_email: str('Contact email (account and verification mails are read here)', { format: 'email' }),
            logo_url: str('Optional public logo URL'),
          },
          REQUIRED,
        ),
        access: [
          {
            id: 'A1',
            kind: 'inbox_verification',
            why: 'Some directories need an account, verified by an email link. Put the address and app password of the mailbox behind contact_email here (demo: create one at /sandbox/mail/mailboxes). I only read verification mail, and every action is capped below.',
            scope: 'read-only: verification and confirmation mail for contact_email; create accounts, fill forms and open links on the directories only',
            required: false,
            // Every account, every form and every confirmation link counts: up to three actions a listing, plus a little slack.
            consent: { actions: ['create_account', 'fill_form', 'browse'], max_total: quantity * 3 + 6, targets: ['dirs.sandbox'], until: spec.deadline },
          },
        ],
        assumptions: [
          'Free directories only. I skip any directory that asks for payment or a captcha / human verification, and I say so in the delivery note.',
          'Where a directory needs an account I create one with a unique strong password, verify it from your inbox, and hand the login to you through the locker once its listing is paid.',
          'Demo mode: the directories are Sandbox Web fixtures, not real sites.',
          'Directories may moderate. I deliver only listings I saw live, with the product name on the page; the platform re-checks them later.',
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
      if (/captcha|human verif/i.test(question)) return 'Directories that require a captcha or human verification are skipped; I never try to get around them.'
      if (/account|login|password/i.test(question)) return 'Where a directory needs an account I create it with a unique generated password and put the login in your job locker; you can open it once that listing is paid. I use your inbox (read-only, app password) to verify.'
      if (/paid|price|cost|fee/i.test(question)) return 'You pay my listing price per verified listing only. I skip directories that charge a listing fee.'
      if (/moderat|how long|when|time/i.test(question)) return 'Most listings are live within minutes; some directories moderate, so I wait for them and deliver only what I saw live.'
      return null
    },

    // Listings the directories removed cannot be recreated, but further free directories can take their place (a substitute).
    async canAgree(offer, job) {
      if (offer.kind !== 'substitute' || offer.deliverable_id !== primary(job.spec).id) return false
      const cat = await httpJson<{ directories: CatalogDir[] }>(`${base}/dirs.json`)
      if (!cat.json) return false
      const eligible = cat.json.directories.filter((d) => !(d.pricing === 'paid' || d.human_verification || d.requirements.some((r) => /paid|payment|captcha|human verification/i.test(r))))
      return eligible.length - primary(job.spec).quantity >= offer.units.length
    },

    async work(job: WorkJob, tools: WorkTools): Promise<WorkResult> {
      const inputs = job.inputs
      const product = asString(inputs.product_name)
      const want = primary(job.spec).quantity
      const contact = asString(inputs.contact_email).toLowerCase()
      const deliverableId = primary(job.spec).id
      // What the contract's page_mentions test will look for: the product name plus anything the buyer listed.
      const mustShow = [...new Set([product, ...primary(job.spec).acceptance.filter((t) => t.check === 'page_mentions').flatMap((t) => (Array.isArray(t.params.must_include) ? t.params.must_include.map(String) : []))])]

      // The buyer's inbox login (A1), and the consent that bounds every real action.
      const inbox: Login | null = loginFrom(job.secrets, 'A1')
      const grant = job.contract?.requirements?.access.find((a) => a.id === 'A1')
      const consented = !!grant?.consent
      const logger: ActionLogger | null = consented ? await actionLogger(tools, job.id, 'A1') : null
      const allow = async (action: 'create_account' | 'fill_form' | 'browse', target: string, extra: { external_ref?: string } = {}) => {
        if (!logger) return action !== 'create_account' // a contract without consent (an older one) never covers accounts
        return logger.allow(action, target, extra)
      }
      const already = await handedOverRefs(tools, job.id)

      // 1) the catalog
      const cat = await httpJson<{ time_scale: number; directories: CatalogDir[] }>(`${base}/dirs.json`)
      if (!cat.json) throw new Error(`Sandbox Web catalog unavailable (HTTP ${cat.status})`)
      const scale = Number.isFinite(cat.json.time_scale) ? cat.json.time_scale : 1
      const all = cat.json.directories
      const refused = (d: CatalogDir) => d.pricing === 'paid' || d.human_verification || d.requirements.some((r) => /paid|payment|captcha|human verification/i.test(r))
      const skipped = all.filter(refused)
      const eligible = all.filter((d) => !refused(d))
      // An agreed substitute submits to further free directories (the first `want` were used before); normally the first `want`.
      const chosen = job.agreement?.kind === 'substitute' ? eligible.slice(want, want + job.agreement.units.length) : eligible.slice(0, want)
      tools.log('catalog', { directories: all.length, eligible: eligible.length, skipped: skipped.length, chosen: chosen.length, needing_account: chosen.filter((d) => d.account?.required).length })

      // 2) submit (accounts first where a directory needs one)
      const subs: Sub[] = chosen.map((dir) => ({ dir, submissionId: null, listingUrl: null, receiptUrl: null, phase: 'unknown', note: null, via: null, retried503: false, emailOpened: false, stage: dir.account?.required ? 'awaiting_verification' : 'none', account: null, handedOver: false, verifyOpened: false }))
      let submitted = 0
      await pool(subs, opts.concurrency ?? 4, async (s) => {
        if (s.dir.account?.required) await startAccount(s)
        else await submit(s, null)
        submitted++
        if (submitted % 10 === 0) await tools.progress(Math.round((submitted / subs.length) * 45), `${submitted}/${subs.length} started`)
      })
      await tools.progress(50, `${subs.filter((s) => s.submissionId).length}/${subs.length} accepted by their directories; ${subs.filter((s) => s.stage === 'awaiting_verification').length} waiting for a verification mail`)

      // 3) verification mail, 4) settle
      const deadline = Date.now() + (opts.settleMs ?? Math.ceil(22 * 60_000 * scale) + 3000)
      let inboxDenied = false
      for (;;) {
        const mailbox = await completeMail(subs)
        inboxDenied ||= mailbox.denied
        await refresh(subs)
        const open = subs.filter((s) => (s.submissionId && (s.phase === 'pending_email_verification' || s.phase === 'pending_review')) || s.stage === 'awaiting_verification' || s.stage === 'ready')
        if (open.length === 0 || Date.now() > deadline || tools.signal.aborted) break
        await sleep(pollMs)
      }
      for (const s of subs) if ((s.stage === 'awaiting_verification' || s.stage === 'ready') && !s.note) s.note = inboxDenied ? 'the inbox refused the app password (or it was not shared), so the account could not be verified' : 'the verification mail did not arrive in time'
      await tools.progress(75, 'listings settled; checking each one')

      // 5) observe each live listing and keep the evidence
      const units: Delivery['deliverables'][number]['units'] = []
      const counts = { rewritten: 0, rejected: 0, removed: 0, pending: 0, failed: 0, lacking: 0 }
      const lackingTerms = new Set<string>()
      await pool(subs, opts.concurrency ?? 4, async (s) => {
        if (!s.submissionId) {
          counts.failed++
          return
        }
        if (s.phase === 'rejected') return void counts.rejected++
        if (s.phase === 'removed') return void counts.removed++
        if (s.phase !== 'live') return void counts.pending++
        const page = await http(onOrigin(s.listingUrl!, origin))
        if (page.status !== 200) return void counts.removed++
        const shown = htmlToText(page.text).toLowerCase()
        if (!shown.includes(product.toLowerCase())) {
          s.note = 'listing is live but does not show the product name'
          return void counts.rewritten++
        }
        const lacks = mustShow.filter((t) => !shown.includes(t.toLowerCase()))
        if (lacks.length) {
          // Live and named, but the page text lacks something the acceptance test requires: it would fail the platform check, so it is not delivered.
          lacks.forEach((t) => lackingTerms.add(t))
          return void counts.lacking++
        }
        const snap = await http(`${onOrigin(s.listingUrl!, origin)}/snapshot`)
        if (snap.status !== 200) return void counts.removed++
        const artifact = await tools.uploadArtifact({ name: `rendered-snapshot-${s.dir.slug}.svg`, mime: 'image/svg+xml', text: snap.text })
        units.push({
          ref: s.dir.slug,
          url: s.listingUrl!,
          artifact_ids: [artifact],
          meta: {
            directory: s.dir.name,
            submission_id: s.submissionId,
            listing_status: 'live',
            mentions_product: true,
            went_live_via: s.via ?? 'instant',
            observed_at: new Date().toISOString(),
            screenshot_kind: 'rendered snapshot (SVG)',
            ...(s.dir.account?.required ? { account: 'created for this listing; the login is in your locker and opens once this unit is paid' } : {}),
          },
        })
      })
      units.sort((a, b) => a.ref.localeCompare(b.ref))

      const accountSubs = subs.filter((s) => s.dir.account?.required)
      const handed = accountSubs.filter((s) => s.handedOver).length
      const deliveredRefs = new Set(units.map((u) => u.ref))
      const orphaned = accountSubs.filter((s) => s.handedOver && !deliveredRefs.has(s.dir.slug)).length
      const notAccounts = accountSubs.filter((s) => s.note && /account|inbox|verification|consent/i.test(s.note)).map((s) => `${s.dir.name} (${s.note})`)
      const parts = [
        `Catalog: ${all.length} directories; ${skipped.length} skipped because they declare payment or human verification (${skipped.map((d) => d.name).join(', ') || 'none'}); ${eligible.length} eligible.`,
        `Submitted to ${chosen.length} (requested ${want}${eligible.length < want ? `; only ${eligible.length} free directories exist` : ''}); ${subs.filter((s) => s.submissionId).length} accepted the submission.`,
        accountSubs.length
          ? `${accountSubs.length} of them required an account: I created ${accountSubs.filter((s) => s.account?.created).length} (unique generated passwords, each logged with log_action first), put ${handed} login(s) in your locker (they open once the matching listing is paid)${orphaned ? `; ${orphaned} of those listings did not go live, so those logins stay unreleased and are shredded when the job ends` : ''}${notAccounts.length ? `; no listing from: ${notAccounts.join('; ')}` : ''}.`
          : 'No chosen directory required an account.',
        logger?.blockedReason ? `I stopped acting at your consent limit (${logger.blockedReason}); ${logger.accepted} action(s) were taken and logged.` : logger ? `${logger.accepted} action(s) were logged against your consent.` : 'This contract carries no consent, so I created no accounts.',
        `Delivered ${units.length} listing(s) that I opened myself, saw live and saw showing "${product}", each with a rendered snapshot.`,
        `Not delivered: ${counts.rejected} rejected in moderation, ${counts.rewritten} live but with the product name rewritten, ${counts.lacking ? `${counts.lacking} live but whose page text lacks ${[...lackingTerms].map((t) => `"${t}"`).join(', ')} (your acceptance test requires it), ` : ''}${counts.removed} gone by the time I checked, ${counts.pending} still pending after the wait, ${counts.failed} not accepted. The platform re-checks delivered listings later; a listing that disappears after my check will fail then.`,
      ]
      return {
        summary: parts.join('\n'),
        delivery: { deliverables: [{ deliverable_id: deliverableId, units, note: parts[4]! }], note: parts.join(' ') },
      }

      // ---- steps ----

      /** Create the account at a directory that requires one; the login goes into the locker straight away. */
      async function startAccount(s: Sub): Promise<void> {
        const acct = s.dir.account!
        const cacheKey = `${job.id}:${s.dir.slug}`
        const cached = created.get(cacheKey)
        if (cached) {
          // This process already created the account (an earlier attempt of this job): carry on with it.
          s.account = { password: cached, created: true }
          s.handedOver = already.has(s.dir.slug)
          s.stage = 'awaiting_verification'
          return
        }
        if (!(await allow('create_account', hostOf(s.dir), { external_ref: acct.signup_endpoint }))) {
          s.stage = 'failed'
          s.note = logger ? `no account created: ${logger.blockedReason ?? 'the consent does not allow it'}` : 'no account created: this contract has no consent for creating accounts'
          return
        }
        const password = strongPassword()
        let r = await httpJson<Record<string, unknown>>(onOrigin(acct.signup_endpoint, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: contact, password, display_name: product }) })
        if (r.status === 429 || r.status === 503) {
          // Busy: the same signup once more after the Retry-After (the action is already logged).
          await sleep(Math.min(retryCap, (Number(r.headers.get('retry-after')) || 2) * 1000))
          r = await httpJson<Record<string, unknown>>(onOrigin(acct.signup_endpoint, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: contact, password, display_name: product }) })
        }
        if (r.status !== 201) {
          s.stage = 'failed'
          s.note = r.status === 409 ? `an account for ${contact} already exists here (not created by this job), so I could not use it` : `account signup refused: HTTP ${r.status} ${String(r.json?.error ?? '')}`.trim()
          if (r.status === 409) reuseEarlierListing(s)
          return
        }
        created.set(cacheKey, password)
        s.account = { password, created: true }
        try {
          await handOver(tools, job.id, { deliverable_id: deliverableId, unit_ref: s.dir.slug, site: hostOf(s.dir), label: `${product} on ${s.dir.name}`, url: `${s.dir.url}/login`, username: contact, password, notes: `Created by Directory Blaster for ${product}. Change the password when you take it over.` })
          s.handedOver = true
        } catch (e) {
          s.stage = 'failed'
          s.note = `the account was created but its login could not be handed over (${(e as Error).message.slice(0, 120)}), so I did not list with it`
          return
        }
        s.stage = 'awaiting_verification'
      }

      /** A rerun finds its earlier listing again from the earlier delivery (the account itself cannot be logged into without its password). */
      function reuseEarlierListing(s: Sub) {
        const prev = job.previous?.deliverables.flatMap((d) => d.units).find((u) => u.ref === s.dir.slug && u.url)
        const id = prev?.url?.match(/\/listing\/([^/?#]+)/)?.[1]
        if (!prev?.url || !id) return
        s.submissionId = id
        s.listingUrl = prev.url
        s.receiptUrl = `${s.dir.url}/api/submissions/${id}`
        s.phase = 'unknown'
        s.stage = 'submitted'
        s.note = null
      }

      async function submit(s: Sub, token: string | null): Promise<void> {
        const payload = {
          name: product,
          url: asString(inputs.url),
          tagline: asString(inputs.tagline_60),
          description: asString(inputs.description_300),
          category: asString(inputs.category),
          contact_email: contact,
          ...(asString(inputs.logo_url) ? { logo_url: asString(inputs.logo_url) } : {}),
        }
        if (!(await allow('fill_form', hostOf(s.dir), { external_ref: s.dir.submit_endpoint }))) {
          s.stage = s.stage === 'none' ? 'none' : 'failed'
          s.note = `the listing form was not filled: ${logger?.blockedReason ?? 'not allowed by the consent'}`
          return
        }
        const endpoint = onOrigin(s.dir.submit_endpoint, origin)
        const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await httpJson<Record<string, unknown>>(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) })
          const j = r.json ?? {}
          if (r.status === 503 && attempt === 0) {
            s.retried503 = true
            const wait = Math.min(retryCap, (Number(r.headers.get('retry-after')) || Number(j.retry_after_seconds) || 2) * 1000)
            await sleep(wait)
            continue
          }
          if ((r.status === 201 || r.status === 202 || r.status === 409) && typeof j.listing_url === 'string') {
            s.submissionId = String(j.submission_id ?? '')
            s.listingUrl = String(j.listing_url)
            // A duplicate (409) is our earlier submission: track it by its status URL like a new one. Some
            // directories omit the URL on duplicates, so derive it from the submit endpoint's conventions.
            s.receiptUrl = typeof j.receipt_url === 'string' ? j.receipt_url : s.submissionId ? endpoint.replace(/\/api\/submit$/, `/api/submissions/${s.submissionId}`) : null
            s.phase = r.status === 201 ? 'live' : ((j.status as Phase | undefined) ?? (r.status === 409 ? 'unknown' : 'pending_review'))
            s.via = r.status === 201 ? 'instant' : null
            if (s.stage !== 'none') s.stage = 'submitted'
            return
          }
          if (s.stage !== 'none') s.stage = 'failed'
          s.note = `submission refused: HTTP ${r.status} ${String(j.error ?? '')}`.trim()
          return
        }
        if (s.stage !== 'none') s.stage = 'failed'
        s.note = 'directory stayed unavailable (503) after one retry'
      }

      async function refresh(list: Sub[]): Promise<void> {
        await pool(list, opts.concurrency ?? 4, async (s) => {
          if (!s.submissionId || !s.receiptUrl) return
          if (s.phase === 'rejected' || s.phase === 'removed') return
          const r = await httpJson<{ status?: Phase }>(onOrigin(s.receiptUrl, origin))
          const before = s.phase
          if (r.json?.status) s.phase = r.json.status
          if (s.phase === 'live' && (before === 'pending_email_verification' || before === 'pending_review')) s.via = before === 'pending_email_verification' ? 'email link' : 'moderation'
        })
      }

      /**
       * One pass over the buyer's mailbox: open the account-verification link of each account waiting for it, log in and fill its listing
       * form; open the listing-confirmation link of each directory that sent one. Every link is opened only after log_action says it is allowed.
       */
      async function completeMail(list: Sub[]): Promise<{ denied: boolean }> {
        const accounts = list.filter((s) => s.stage === 'awaiting_verification' && s.account && !s.verifyOpened)
        const listings = list.filter((s) => s.submissionId && s.phase === 'pending_email_verification' && !s.emailOpened)
        if ((!accounts.length && !listings.length) || !contact) return { denied: false }
        const box = await readMailbox(base, contact, inbox)
        if (box.denied) {
          // A locked mailbox and no (valid) app password: waiting longer would not help.
          for (const s of accounts) {
            s.stage = 'failed'
            s.note = 'the inbox refused the app password (or it was not shared), so the account could not be verified'
          }
          for (const s of listings) {
            s.emailOpened = true
            s.note = 'the inbox refused the app password (or it was not shared), so the confirmation link could not be opened'
          }
          return { denied: true }
        }
        for (const s of accounts) {
          const hit = box.messages.find((m) => m.to === contact && m.from === `noreply@${s.dir.slug}.dirs.sandbox` && /verify your email/i.test(m.subject))
          const link = hit ? sandboxLink(hit.text, origin, new RegExp(`^/sandbox/dirs/${s.dir.slug}/account/verify/[a-f0-9]+$`)) : null
          if (!link) continue
          if (!(await allow('browse', hostOf(s.dir), { external_ref: new URL(link).pathname }))) {
            s.stage = 'failed'
            s.note = `the verification link was not opened: ${logger?.blockedReason ?? 'not allowed by the consent'}`
            continue
          }
          s.verifyOpened = (await http(link)).status === 200
          if (!s.verifyOpened) continue
          const login = await httpJson<{ session_token?: string }>(onOrigin(s.dir.account!.login_endpoint, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: contact, password: s.account!.password }) })
          if (login.status !== 200 || !login.json?.session_token) {
            s.stage = 'failed'
            s.note = `logged in failed after verification: HTTP ${login.status}`
            continue
          }
          s.stage = 'ready'
          await submit(s, login.json.session_token)
        }
        for (const s of listings) {
          // Only a confirmation link of THIS directory; opened on our own sandbox origin.
          const hit = box.messages.find((m) => m.to === contact && m.from === `noreply@${s.dir.slug}.dirs.sandbox` && /confirm/i.test(m.subject))
          const link = hit ? sandboxLink(hit.text, origin, new RegExp(`^/sandbox/dirs/${s.dir.slug}/verify/[a-f0-9]+$`)) : null
          if (!link) continue
          if (!(await allow('browse', hostOf(s.dir), { external_ref: new URL(link).pathname }))) {
            s.note = `the confirmation link was not opened: ${logger?.blockedReason ?? 'not allowed by the consent'}`
            s.emailOpened = true // stop trying
            continue
          }
          s.emailOpened = (await http(link)).status === 200
        }
        return { denied: false }
      }
    },
  }
}
