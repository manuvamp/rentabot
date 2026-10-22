// Application Filler (demo mode): multi-step application forms on Sandbox Web, filled from the buyer's facts, SUBMITTED ONLY AFTER APPROVAL.
//   1. read /sandbox/apps.json (a fake accelerator, grants and launch directories: steps, required fields, character limits, a PDF upload)
//   2. per programme: log_action fill_form, start (or resume) the draft, write every answer from the facts kit (the server's AI writes the
//      free text; numbers and limits are checked; defaults are listed as assumptions), save each step, upload a one-pager PDF
//   3. STOP. Post one blocker in the Job Room, "Approval needed: ...", with a preview of every filled form (a link per form and a preview
//      artifact each). Nothing has been submitted. The buyer approves with provide_inputs { approved_applications: "all" | "id,id" | "none" }
//   4. wait for an approval that arrives AFTER the preview (an earlier answer in the contract does not count), then unblock
//   5. for each approved form: log_action fill_form, submit, open the receipt page, read the confirmation mail when the inbox is shared,
//      and deliver one unit {confirmation_id, receipt url}. Forms that were not approved stay drafts and are not delivered.
// Without a consent in the contract the bot fills nothing.
import type { Delivery } from '@rentabot/shared'
import { actionLogger, loginFrom, readMailbox, type ActionLogger, type Login } from '../actions.ts'
import { draftApplication, onePagerPdf, type FormStep } from '../application-writing.ts'
import { parseFacts, type FactsKit } from '../email-writing.ts'
import { asString, badAsk, http, httpJson, needsSchema, onOrigin, pool, primary, sleep, str } from '../common.ts'
import { RabError, readRoom } from '../rab.ts'
import { htmlToText } from '../server-shared.ts'
import { NeedInput, buildQuote, type SellerBot, type WorkJob, type WorkResult, type WorkTools } from '../runtime.ts'

export interface ApplicationFillerOptions {
  /** Sandbox Web base, e.g. http://localhost:8790/sandbox. */
  sandboxUrl: string
  /** How often the room is read while waiting for the approval. */
  pollMs?: number
  /** Longest wait for the approval inside one run (the job stays blocked after that and resumes on the next run). */
  approvalWaitMs?: number
  concurrency?: number
}

interface Programme {
  slug: string
  name: string
  kind: string
  url: string
  host: string
  create_endpoint: string
  steps: FormStep[]
  file: { field: string; mime: string; max_bytes: number }
}

interface Draft {
  p: Programme
  applicationId: string | null
  previewUrl: string | null
  /** Already submitted (an earlier attempt after an approval): reused, not submitted again. */
  confirmation: { id: string; receipt_url: string } | null
  assumptions: string[]
  previewArtifact: string | null
  note: string | null
}

export const APPROVAL_PREFIX = 'Approval needed:'
const REQUIRED = ['facts_kit', 'applicant_name', 'applicant_email']

/** Which programme ids an approval answer names: "all", "none", or a list (commas, spaces or newlines). */
export function parseApproval(value: unknown, ids: string[]): string[] {
  const raw = Array.isArray(value) ? value.map(String).join(',') : typeof value === 'string' ? value : ''
  const tokens = raw.toLowerCase().split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
  if (!tokens.length || tokens.includes('none')) return []
  if (tokens.includes('all')) return ids
  return ids.filter((id) => tokens.includes(id))
}

export function applicationFiller(opts: ApplicationFillerOptions): SellerBot {
  const base = opts.sandboxUrl.replace(/\/+$/, '')
  const origin = new URL(base).origin
  const pollMs = opts.pollMs ?? 3000
  const approvalWaitMs = opts.approvalWaitMs ?? 24 * 3_600_000

  return {
    slug: 'application-filler',
    name: 'Application Filler',
    skillId: 'application_filling',
    maxConcurrent: 4,

    scope(spec) {
      if (spec.deliverables.length > 1) return 'I deliver one deliverable of submitted applications per job.'
      return badAsk(spec)
    },

    requirements(spec) {
      const quantity = primary(spec).quantity
      return {
        inputs_schema: needsSchema(
          {
            facts_kit: str('Facts about the company: what it is, URL, stage, traction you can prove (text; every answer is written from these facts only)'),
            applicant_name: str('Name of the person the applications are in the name of'),
            applicant_email: str('Applicant email: confirmations arrive here', { format: 'email' }),
            applicant_role: str('Applicant role, e.g. Founder (default Founder)'),
            programs: str('Optional: comma-separated programme ids to apply to (default: the first ones in the catalog)'),
            amount_usd: { type: 'integer', description: 'Optional: amount to request on grant forms, in USD' },
          },
          REQUIRED,
        ),
        access: [
          {
            id: 'A1',
            kind: 'inbox_verification',
            why: 'Each application sends a confirmation mail to applicant_email. Optionally put the address and app password of that mailbox here so I can cross-check every confirmation ID (read-only). The consent below bounds the forms I may fill.',
            scope: 'read-only: confirmation mail for applicant_email; fill forms on the application sites only',
            required: false,
            consent: { actions: ['fill_form'], max_total: quantity * 2, targets: ['apps.sandbox'], until: spec.deadline },
          },
        ],
        assumptions: [
          'I fill every form from your facts kit only. Anything the kit does not say is answered "not stated", or is a stated default listed in the preview.',
          'I NEVER submit before you approve: I post a preview of each filled form in the room and wait. Approve with provide_inputs approved_applications = "all" or a list of the ids ("none" submits nothing). While I wait the job is blocked, so the deadline pauses.',
          'The file upload is a one-page PDF I generate from your facts.',
          'Demo mode: the programmes are Sandbox Web fixtures, not real accelerators or grants.',
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
      if (/approv|submit|before/i.test(question)) return 'I fill the forms and post a preview of each in this room, then wait. I submit only the forms you approve with provide_inputs approved_applications ("all", a list of ids, or "none").'
      if (/fact|invent|claim/i.test(question)) return 'Every answer is written from your facts kit. Numbers that are not in it are dropped; if the kit says nothing for a field, the answer says so, and any default is listed in the preview.'
      return null
    },

    async work(job: WorkJob, tools: WorkTools): Promise<WorkResult> {
      const inputs = job.inputs
      const kit = asString(inputs.facts_kit)
      const facts: FactsKit = parseFacts(kit)
      if (!facts.url) throw new NeedInput(['a website URL in facts_kit'])
      const applicant = {
        name: asString(inputs.applicant_name),
        email: asString(inputs.applicant_email).toLowerCase(),
        role: asString(inputs.applicant_role) || 'Founder',
        ...(Number.isFinite(Number(inputs.amount_usd)) && Number(inputs.amount_usd) > 0 ? { amount_usd: Math.round(Number(inputs.amount_usd)) } : {}),
      }
      const want = primary(job.spec).quantity
      const deliverableId = primary(job.spec).id

      const inbox: Login | null = loginFrom(job.secrets, 'A1')
      const consented = !!job.contract?.requirements?.access.find((a) => a.id === 'A1')?.consent
      const logger: ActionLogger | null = consented ? await actionLogger(tools, job.id, 'A1') : null
      const allow = async (target: string, ref: string) => (logger ? logger.allow('fill_form', target, { external_ref: ref }) : false)

      const cat = await httpJson<{ programs: Programme[] }>(`${base}/apps.json`)
      if (!cat.json) throw new Error(`Sandbox Web application catalog unavailable (HTTP ${cat.status})`)
      const asked = asString(inputs.programs).toLowerCase().split(/[\s,;]+/).filter(Boolean)
      const pool_ = asked.length ? cat.json.programs.filter((p) => asked.includes(p.slug)) : cat.json.programs
      const chosen = job.agreement?.kind === 'substitute' ? pool_.slice(want, want + job.agreement.units.length) : pool_.slice(0, want)
      tools.log('catalog', { programmes: cat.json.programs.length, chosen: chosen.length })

      // 2) fill every form, without submitting
      const drafts: Draft[] = chosen.map((p) => ({ p, applicationId: null, previewUrl: null, confirmation: null, assumptions: [], previewArtifact: null, note: null }))
      await pool(drafts, opts.concurrency ?? 2, fill)
      const ready = drafts.filter((d) => d.applicationId && !d.note)
      await tools.progress(45, `${ready.length}/${drafts.length} applications filled; nothing submitted yet`)

      // 3-4) the approval gate
      const pending = ready.filter((d) => !d.confirmation)
      let approvedIds: string[] = ready.filter((d) => d.confirmation).map((d) => d.p.slug) // submitted before: already approved then
      let approvalNote = ''
      if (pending.length) {
        const ids = pending.map((d) => d.p.slug)
        const answer = await awaitApproval(pending)
        approvedIds = [...approvedIds, ...parseApproval(answer, ids)]
        approvalNote = answer === null ? 'no answer' : parseApproval(answer, ids).length === 0 ? 'the buyer approved none' : ''
      }

      // 5) submit what was approved
      const units: Delivery['deliverables'][number]['units'] = []
      const notSubmitted: string[] = []
      await pool(ready, opts.concurrency ?? 2, async (d) => {
        if (!approvedIds.includes(d.p.slug)) return void notSubmitted.push(d.p.name)
        const u = await submitApproved(d)
        if (u) units.push(u)
      })
      units.sort((a, b) => a.ref.localeCompare(b.ref))
      const failed = drafts.filter((d) => d.note).map((d) => `${d.p.name} (${d.note})`)
      const parts = [
        `Programmes: ${cat.json.programs.length} on offer; ${chosen.length} chosen (${chosen.map((p) => p.name).join(', ')}).`,
        `Filled ${ready.length} application(s) from your facts kit (free text written by AI within each limit, numbers checked against the kit) and posted a preview of each; nothing was submitted before your approval.`,
        approvedIds.length ? `You approved ${approvedIds.length}; I submitted ${units.length} (a log_action fill_form was made before each form was filled and before each submit${logger?.blockedReason ? `; I stopped at your consent limit: ${logger.blockedReason}` : ''}).` : `No application was approved${approvalNote ? ` (${approvalNote})` : ''}, so none was submitted.`,
        `Delivered ${units.length} submitted application(s), each with its confirmation ID and receipt page.`,
        notSubmitted.length ? `Left as drafts, not submitted: ${notSubmitted.join(', ')}.` : '',
        failed.length ? `Not filled: ${failed.join('; ')}.` : '',
      ].filter(Boolean)
      return { summary: parts.join('\n'), delivery: { deliverables: [{ deliverable_id: deliverableId, units, note: parts[3]! }], note: parts.join(' ') } }

      // ---- steps ----

      async function fill(d: Draft): Promise<void> {
        const p = d.p
        if (!(await allow(p.host, p.create_endpoint))) {
          d.note = logger ? `not filled: ${logger.blockedReason ?? 'the consent does not allow it'}` : 'not filled: this contract has no consent for filling forms'
          return
        }
        const start = await httpJson<{ application_id?: string; status?: string; confirmation_id?: string; receipt_url?: string; preview_url?: string; error?: string }>(onOrigin(p.create_endpoint, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: applicant.email, applicant_name: applicant.name }) })
        const j = start.json
        if (!j?.application_id) {
          d.note = `could not start the draft: HTTP ${start.status} ${String(j?.error ?? '')}`.trim()
          return
        }
        d.applicationId = j.application_id
        d.previewUrl = j.preview_url ?? `${p.url}/applications/${j.application_id}/preview`
        if (start.status === 409 && j.confirmation_id && j.receipt_url) {
          d.confirmation = { id: j.confirmation_id, receipt_url: j.receipt_url } // an earlier run already submitted it with approval
          return
        }
        const drafted = await draftApplication(p.steps, facts, applicant, tools.ai)
        d.assumptions = drafted.assumptions
        const api = onOrigin(`${p.create_endpoint}/${d.applicationId}`, origin)
        for (const step of p.steps) {
          let fields = drafted.steps[step.n] ?? {}
          let r = await httpJson<{ errors?: Record<string, string> }>(`${api}/steps/${step.n}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields }) })
          if (r.status === 422 && r.json?.errors) {
            // One repair: cut over-long answers to the limit; fields that are empty or too short are rewritten from the kit.
            fields = repair(step, fields, r.json.errors)
            r = await httpJson(`${api}/steps/${step.n}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields }) })
          }
          if (r.status !== 200) {
            d.note = `step ${step.n} (${step.title}) refused: ${JSON.stringify((r.json as { errors?: unknown } | null)?.errors ?? r.json ?? {}).slice(0, 200)}`
            return
          }
          drafted.steps[step.n] = fields
        }
        const pdf = onePagerPdf(facts, p.name)
        const up = await httpJson<{ errors?: unknown }>(`${api}/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ field: p.file.field, filename: 'one-pager.pdf', mime: p.file.mime, content_base64: pdf.toString('base64') }) })
        if (up.status !== 200) {
          d.note = `the file upload was refused: ${JSON.stringify(up.json?.errors ?? {}).slice(0, 160)}`
          return
        }
        d.previewArtifact = await tools.uploadArtifact({ name: `preview-${p.slug}.txt`, mime: 'text/plain', text: previewText(d, drafted.steps, drafted.source) })
      }

      function repair(step: FormStep, fields: Record<string, string>, errors: Record<string, string>): Record<string, string> {
        const out = { ...fields }
        for (const f of step.fields) {
          if (!errors[f.key]) continue
          const max = f.max_length ?? 400
          const v = out[f.key] ?? ''
          if (v.length > max) out[f.key] = v.slice(0, max).replace(/\s+\S*$/, '')
          else out[f.key] = `${facts.oneLiner || facts.product} ${facts.url}`.slice(0, max)
        }
        return out
      }

      function previewText(d: Draft, steps: Record<number, Record<string, string>>, source: Record<string, string>): string {
        const lines = [`Application preview: ${d.p.name}`, `Applicant: ${applicant.name} <${applicant.email}>`, `Status: DRAFT, NOT SUBMITTED. Nothing is sent until you approve.`, `Live preview page: ${d.previewUrl}`, '']
        for (const s of d.p.steps) {
          lines.push(`Step ${s.n}: ${s.title}`)
          for (const f of s.fields) lines.push(`  ${f.label}${source[f.key] ? ` [${source[f.key]}]` : ''}: ${steps[s.n]?.[f.key] ?? '(empty)'}`)
          lines.push('')
        }
        lines.push(`File: one-pager.pdf (generated from your facts kit)`)
        if (d.assumptions.length) lines.push('', 'Defaults I had to choose (check these):', ...d.assumptions.map((a) => `  - ${a}`))
        return lines.join('\n').slice(0, 20_000)
      }

      /** Post the preview blocker (once per set of forms) and wait for an approval that comes after it. null = none arrived in time. */
      async function awaitApproval(list: Draft[]): Promise<unknown | null> {
        const ids = list.map((d) => d.p.slug)
        const text = [
          `${APPROVAL_PREFIX} I filled ${list.length} application${list.length === 1 ? '' : 's'} and have NOT submitted ${list.length === 1 ? 'it' : 'any'}. Open each preview, then approve.`,
          ...list.map((d) => `- ${d.p.slug}: ${d.p.name} (${d.p.steps.length} steps, one-pager attached) preview: ${d.previewUrl}`),
          ...(list.some((d) => d.assumptions.length) ? ['', 'Defaults I had to choose:', ...list.flatMap((d) => d.assumptions.map((a) => `  - ${d.p.name}: ${a}`))] : []),
          '',
          `To approve, call provide_inputs with inputs.approved_applications = "all" or a comma-separated list of the ids above ("none" submits nothing). Nothing is submitted until you do.`,
        ].join('\n').slice(0, 7900)
        const room = await readRoom(tools.rab, job.id)
        const mine = [...room].reverse().find((m) => m.type === 'blocker' && m.from.role === 'seller' && m.text.startsWith(APPROVAL_PREFIX) && ids.every((id) => m.text.includes(`- ${id}:`)))
        const state = (await tools.rab.call<{ job: { state: string } }>('get_job', { job_id: job.id })).job.state
        let after = mine?.seq ?? -1
        if (!mine || state !== 'BLOCKED') {
          const posted = await tools.rab.call<{ message: { seq: number } }>('send_message', { job_id: job.id, type: 'blocker', text, artifact_ids: list.map((d) => d.previewArtifact).filter((x): x is string => !!x).slice(0, 10) })
          after = posted.message.seq
        }
        // An approval counts only if it came AFTER the preview that was shown (the room is read from there on).
        const end = Date.now() + approvalWaitMs
        for (;;) {
          const msgs = await readRoom(tools.rab, job.id, after)
          for (const m of msgs) {
            if (m.type !== 'inputs' || m.from.role !== 'buyer') continue
            const inp = ((m.body as { inputs?: Record<string, unknown> }).inputs ?? {}) as Record<string, unknown>
            if ('approved_applications' in inp) {
              await unblock()
              return inp.approved_applications
            }
          }
          if (tools.signal.aborted || Date.now() > end) throw new NeedInput(['approved_applications (your approval of the filled forms)'])
          const s = (await tools.rab.call<{ job: { state: string } }>('get_job', { job_id: job.id })).job.state
          if (s !== 'BLOCKED' && s !== 'IN_PROGRESS') return null // the job moved on (cancelled, disputed): submit nothing
          await sleep(pollMs)
        }
      }

      async function unblock(): Promise<void> {
        try {
          const s = (await tools.rab.call<{ job: { state: string } }>('get_job', { job_id: job.id })).job.state
          if (s === 'BLOCKED') await tools.rab.call('send_message', { job_id: job.id, type: 'unblock', text: 'Thanks, I have your approval and I am submitting the approved applications now.' })
        } catch (e) {
          if (!(e instanceof RabError)) throw e
        }
      }

      async function submitApproved(d: Draft): Promise<Delivery['deliverables'][number]['units'][number] | null> {
        const p = d.p
        let conf = d.confirmation
        let submittedAt = ''
        if (!conf) {
          if (!(await allow(p.host, `${p.slug}/${d.applicationId}`))) {
            d.note = `approved but not submitted: ${logger?.blockedReason ?? 'not allowed by the consent'}`
            return null
          }
          const r = await httpJson<{ confirmation_id?: string; receipt_url?: string; error?: string; missing?: unknown }>(`${onOrigin(`${p.create_endpoint}/${d.applicationId}`, origin)}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if ((r.status !== 201 && r.status !== 200) || !r.json?.confirmation_id || !r.json.receipt_url) {
            d.note = `submit refused: HTTP ${r.status} ${JSON.stringify(r.json?.missing ?? r.json?.error ?? '').slice(0, 120)}`
            return null
          }
          conf = { id: r.json.confirmation_id, receipt_url: r.json.receipt_url }
          submittedAt = new Date().toISOString()
        }
        // Proof: the receipt page shows the confirmation ID (and the applicant); the confirmation mail carries it too, when the inbox is shared.
        const page = await http(onOrigin(conf.receipt_url, origin))
        const shown = htmlToText(page.text)
        if (page.status !== 200 || !shown.includes(conf.id)) {
          d.note = `the receipt page does not show the confirmation ${conf.id}`
          return null
        }
        const box = await readMailbox(base, applicant.email, inbox)
        const mail = box.messages.find((m) => m.subject.includes(conf!.id) && m.from === `noreply@${p.host}`)
        const receipt = await tools.uploadArtifact({ name: `receipt-${p.slug}.txt`, mime: 'text/plain', text: `${p.name}\nConfirmation ID: ${conf.id}\nReceipt page: ${conf.receipt_url}\n\n${shown.slice(0, 1500)}\n${mail ? `\nConfirmation email: "${mail.subject}" from ${mail.from} to ${mail.to}\n` : box.denied ? '\nConfirmation email not read: the inbox needs its app password (not shared).\n' : ''}` })
        return {
          ref: p.slug,
          url: conf.receipt_url,
          artifact_ids: [receipt, ...(d.previewArtifact ? [d.previewArtifact] : [])],
          meta: { program: p.slug, program_name: p.name, kind: p.kind, confirmation_id: conf.id, application_id: d.applicationId, approved_by_buyer: true, ...(submittedAt ? { submitted_at: submittedAt } : {}), confirmation_email_seen: !!mail },
        }
      }
    },
  }
}
