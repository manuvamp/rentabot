// Lead Verifier (live mode): runs the ported leads.py checks on each lead the buyer gives.
//   - the exact address must appear on the lead's own source page (mailto, plain text, "[at]" form or a
//     Cloudflare-protected email), and
//   - the address's domain must have MX records.
// `verified` means exactly that, the same rule the platform's lead_verified check re-runs, so an honest
// "false" is a deliverable too. Extra findings (free webmail, a second contact at one domain) are flags in
// the unit, never a reason to claim something the platform would not confirm.
// Polite fetching: browser-like UA, 15 s timeout, at most 2 requests per second overall, no retries on 4xx.
import { asString, badAsk, needsSchema, parseJsonl, primary, str } from '../common.ts'
import { createPoliteWeb, type PoliteWeb } from '../web.ts'
import { makeMx, pageHasEmail, parseEmail, type MxOptions } from '../server-shared.ts'
import { buildQuote, type SellerBot, type WorkJob, type WorkResult, type WorkTools } from '../runtime.ts'

export interface LeadVerifierOptions {
  web?: PoliteWeb
  /** Hosts that skip the public-address guard (local fixtures in tests). */
  allowHosts?: string[]
  /** DNS overrides (tests). */
  mx?: MxOptions
  /** The budget variant: same rule, own bot card, slower fetching. */
  variant?: 'standard' | 'budget'
}

const FREEMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'btinternet.com', 'hotmail.co.uk', 'yahoo.co.uk', 'me.com', 'msn.com'])

export interface LeadVerdict {
  verified: boolean
  why: string
  email_source_url: string
  flags: string[]
}

export type LeadInput = Record<string, unknown>

export interface VerifyContext {
  web: PoliteWeb
  hasMx: ReturnType<typeof makeMx>
  pages: Map<string, Promise<{ ok: boolean; status: number; body: string; error?: string }>>
  verifiedDomains: Set<string>
}

export function createVerifyContext(web: PoliteWeb, mx?: MxOptions): VerifyContext {
  // DNS-over-HTTPS fallback requests count against the same 2 requests/second budget.
  const doh: NonNullable<MxOptions['doh']> = async (url, signal) => {
    await web.limiter.wait()
    const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal })
    return { ok: r.ok, json: () => r.json() as Promise<unknown> }
  }
  return { web, hasMx: makeMx({ doh, ...mx }), pages: new Map(), verifiedDomains: new Set() }
}

export async function verifyLead(lead: LeadInput, ctx: VerifyContext): Promise<LeadVerdict> {
  const src = asString(lead.email_source_url) || asString(lead.source_url) || asString(lead.website)
  const email = parseEmail(lead.to)
  const flags: string[] = []
  if (!email) return { verified: false, why: `"${asString(lead.to).slice(0, 60)}" is not an email address (a form or placeholder, not a mailbox)`, email_source_url: src, flags }
  if (FREEMAIL.has(email.domain)) flags.push('free_webmail')
  if (ctx.verifiedDomains.has(email.domain)) flags.push('second_contact_at_domain')
  if (!src) return { verified: false, why: 'no email_source_url: there is no page to check the address against', email_source_url: '', flags }

  let page = ctx.pages.get(src)
  if (!page) {
    page = ctx.web.get(src).then(
      (r) => ({ ok: r.status < 400, status: r.status, body: r.body }),
      (e: Error) => ({ ok: false, status: 0, body: '', error: e.message }),
    )
    ctx.pages.set(src, page)
  }
  const p = await page
  const mx = await ctx.hasMx(email.domain)
  const parts: string[] = []
  let found = false
  if (p.error) parts.push(`could not read the source page (${p.error.slice(0, 120)})`)
  else if (!p.ok) parts.push(`source page answered HTTP ${p.status}`)
  else {
    const hit = pageHasEmail(p.body, email.address)
    found = hit.found
    parts.push(hit.found ? `address is on the source page (${hit.how})` : 'address not on the source page')
  }
  parts.push(mx.result === null ? `MX lookup for ${email.domain} was inconclusive` : mx.result ? `${email.domain} has MX records` : `${email.domain} has no MX records`)
  const verified = found && mx.result === true
  if (verified) ctx.verifiedDomains.add(email.domain)
  return { verified, why: parts.join('; '), email_source_url: src, flags }
}

/** "lead-12" (or "D1:lead-12") -> row index 11; null for anything else. */
function leadIndex(ref: string): number | null {
  const m = /^(?:[^:]*:)?lead-(\d+)$/.exec(ref)
  return m && Number(m[1]) >= 1 ? Number(m[1]) - 1 : null
}

export function leadVerifier(opts: LeadVerifierOptions = {}): SellerBot {
  const budget = opts.variant === 'budget'
  // The budget variant is cheaper because it is slower: one request per second instead of two.
  const web = opts.web ?? createPoliteWeb({ allowHosts: opts.allowHosts, perSecond: budget ? 1 : 2, timeoutMs: 15_000 })
  const leadsOf = (inputs: Record<string, unknown>): { rows: LeadInput[]; bad: number } => {
    if (Array.isArray(inputs.leads)) return { rows: inputs.leads.filter((x): x is LeadInput => !!x && typeof x === 'object'), bad: 0 }
    return parseJsonl(asString(inputs.leads_jsonl))
  }

  return {
    slug: budget ? 'budget-lead-verifier' : 'lead-verifier',
    name: budget ? 'Budget Lead Verifier' : 'Lead Verifier',
    skillId: 'verify_leads',
    maxConcurrent: 2,

    scope(spec) {
      if (spec.deliverables.length > 1) return 'I deliver one deliverable of lead verdicts per job.'
      return badAsk(spec)
    },

    requirements() {
      return {
        inputs_schema: needsSchema(
          { leads_jsonl: str('JSONL, one lead per line: {"to","company","domain","email_source_url","country"}. Business addresses only.') },
          ['leads_jsonl'],
        ),
        access: [],
        assumptions: [
          `I fetch each email_source_url once (browser-like User-Agent, at most ${budget ? 1 : 2} request${budget ? '' : 's'} per second) and check the exact address is on it, then check the address domain has MX records.`,
          'A lead I cannot verify is delivered as verified:false with the reason; I never mark a lead verified that I did not confirm.',
          'Public business addresses only; free webmail and second contacts at one domain are flagged, not hidden.',
        ],
        questions: [],
      }
    },

    quote(spec, skill) {
      return buildQuote(spec, skill, { priced: [primary(spec).id] })
    },

    missingInputs(inputs) {
      return leadsOf(inputs).rows.length ? [] : ['leads_jsonl']
    },

    clarify(question) {
      if (/how|method|verify|check/i.test(question)) return 'For each lead I fetch its source page and look for the exact address (mailto link, plain text, "[at]" form or a Cloudflare-protected address), then look up MX records for its domain. Both must hold for verified:true.'
      return null
    },

    // A redo re-verifies the named leads (the page may have changed since); a substitute checks further leads from the list.
    async canAgree(offer, job) {
      const { rows } = leadsOf(job.inputs)
      const want = primary(job.spec).quantity
      if (offer.deliverable_id !== primary(job.spec).id) return false
      if (offer.kind === 'redo') return offer.units.every((u) => leadIndex(u) !== null && leadIndex(u)! < Math.min(rows.length, want))
      return rows.length - want >= offer.units.length
    },

    async work(job: WorkJob, tools: WorkTools): Promise<WorkResult> {
      const { rows, bad } = leadsOf(job.inputs)
      const want = primary(job.spec).quantity
      const ag = job.agreement
      // [row index, unit ref]: the first `want` leads normally; only the named ones for an agreed redo; the next ones for a substitute.
      const take: [number, string][] =
        ag?.kind === 'redo'
          ? ag.units.flatMap((u): [number, string][] => (leadIndex(u) !== null && leadIndex(u)! < rows.length ? [[leadIndex(u)!, u.replace(/^[^:]*:/, '')]] : []))
          : ag?.kind === 'substitute'
            ? rows.slice(want, want + ag.units.length).map((_, i): [number, string] => [want + i, `lead-${want + i + 1}`])
            : rows.slice(0, want).map((_, i): [number, string] => [i, `lead-${i + 1}`])
      const ctx = createVerifyContext(web, opts.mx)
      const units: WorkResult['delivery']['deliverables'][number]['units'] = []
      let n = 0
      // Sequential on purpose: the shared rate limiter spaces the requests, and flags depend on the order.
      for (const [index, ref] of take) {
        const lead = rows[index]!
        if (tools.signal.aborted) break
        const v = await verifyLead(lead, ctx)
        n++
        const to = asString(lead.to)
        units.push({
          ref,
          ...(v.email_source_url ? { url: v.email_source_url } : {}),
          artifact_ids: [],
          meta: { to, company: asString(lead.company), domain: asString(lead.domain), country: asString(lead.country), verified: v.verified, why: v.why, email_source_url: v.email_source_url, flags: v.flags },
        })
        if (n % 10 === 0) await tools.progress(Math.round((n / take.length) * 95), `${n}/${take.length} leads checked`)
      }
      const ok = units.filter((u) => u.meta.verified === true).length
      const note = [
        `${ag ? `Agreed ${ag.kind}: checked` : 'Checked'} ${units.length} lead(s): ${ok} verified, ${units.length - ok} not verified (each with the reason).`,
        !ag && rows.length > take.length ?`${rows.length - take.length} further lead(s) in your list were beyond the ${want} requested and were not checked.` : '',
        bad ? `${bad} input line(s) were not valid JSON objects and were skipped.` : '',
        `Rule: the address appears on the lead's own source page and its domain has MX records; ${web.requests} page/DNS-over-HTTPS requests were made, at most 2 per second.`,
      ].filter(Boolean)
      return { summary: note.join('\n'), delivery: { deliverables: [{ deliverable_id: primary(job.spec).id, units, note: note[0]! }], note: note.join(' ') } }
    },
  }
}
