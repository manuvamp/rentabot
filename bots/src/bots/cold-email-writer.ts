// Cold Email Writer (live mode): one email per recipient from the buyer's facts kit.
// It only writes; it never sends. Each email is self-linted with the same function the platform's
// email_lint check runs, rewritten up to twice when a rule fails, and left out (and reported) if it
// still does not pass.
import { asString, badAsk, needsSchema, pool, primary, str } from '../common.ts'
import { parseFacts, writeEmail, type Recipient } from '../email-writing.ts'
import { buildQuote, type SellerBot, type WorkJob, type WorkResult, type WorkTools } from '../runtime.ts'

export interface ColdEmailWriterOptions {
  concurrency?: number
}

/** recipients can arrive as an array or as a JSON string. */
export function recipientsOf(inputs: Record<string, unknown>): Recipient[] {
  let raw: unknown = inputs.recipients
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = []
    }
  }
  if (!Array.isArray(raw)) return []
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ name: asString(r.name), company: asString(r.company), angle: asString(r.angle), email: asString(r.email) || asString(r.to) }))
    .filter((r) => r.company)
}

export function coldEmailWriter(opts: ColdEmailWriterOptions = {}): SellerBot {
  return {
    slug: 'cold-email-writer',
    name: 'Cold Email Writer',
    skillId: 'write_cold_emails',
    maxConcurrent: 3,

    scope(spec) {
      if (spec.deliverables.length > 1) return 'I deliver one deliverable of written emails per job.'
      const bad = badAsk(spec)
      if (bad) return bad
      if (/\b(send|deliver)\s+(them|these|the emails)\b|\bsend (the )?emails\b/i.test(spec.goal)) return 'I only write emails; I never send them. The buyer sends from their own inbox.'
      return null
    },

    requirements() {
      return {
        inputs_schema: needsSchema(
          {
            facts_kit: str('Facts about the sender: product, URL, one-liner, what is true and provable (text)'),
            recipients: { type: 'array', description: 'One entry per email', items: { type: 'object', properties: { name: str('Recipient name'), company: str('Recipient company'), angle: str('Why them (a real detail you know about them)'), email: str('Their address, if you want it in the unit') }, required: ['company'] } },
          },
          ['facts_kit', 'recipients'],
        ),
        access: [],
        assumptions: [
          'I write only; I never send. Each email is linted (subject 1-60 characters, 50-150 words, one question, no placeholders, names the recipient company, no spam phrases, no shouting) before I deliver it.',
          'I use only facts from your facts_kit and the angle you give for each recipient; I will not invent details about anyone.',
          'An email that cannot pass the lint after two rewrites is left out and named in the delivery note.',
        ],
        questions: [],
      }
    },

    quote(spec, skill) {
      return buildQuote(spec, skill, { priced: [primary(spec).id] })
    },

    missingInputs(inputs) {
      const missing: string[] = []
      if (!asString(inputs.facts_kit)) missing.push('facts_kit')
      if (!recipientsOf(inputs).length) missing.push('recipients')
      return missing
    },

    clarify(question) {
      if (/send|deliver|inbox/i.test(question)) return 'I only write the emails; I do not send them. You (or your outreach tool) send them from your own inbox.'
      if (/lint|rule|spam|length/i.test(question)) return 'Each email must have a subject of at most 60 characters and a body of 50 to 150 words, with at most one question, no placeholders, the recipient company named, no spam phrases and no ALL-CAPS words.'
      return null
    },

    // A redo rewrites the named emails (their recipients come from the earlier delivery); a substitute writes to further recipients.
    async canAgree(offer, job) {
      const all = recipientsOf(job.inputs)
      const want = primary(job.spec).quantity
      if (offer.deliverable_id !== primary(job.spec).id) return false
      if (offer.kind === 'substitute') return all.length - want >= offer.units.length
      const delivered = job.previous?.deliverables.find((d) => d.deliverable_id === offer.deliverable_id)?.units ?? []
      return offer.units.every((ref) => {
        const unit = delivered.find((u) => u.ref === ref.replace(/^[^:]*:/, ''))
        return !!unit && all.some((r) => r.company === asString(unit.meta.company))
      })
    },

    async work(job: WorkJob, tools: WorkTools): Promise<WorkResult> {
      const facts = parseFacts(asString(job.inputs.facts_kit))
      const all = recipientsOf(job.inputs)
      const want = primary(job.spec).quantity
      const ag = job.agreement
      // [recipient, unit ref]
      const delivered = job.previous?.deliverables.find((d) => d.deliverable_id === ag?.deliverable_id)?.units ?? []
      const take: [Recipient, string | null][] =
        ag?.kind === 'redo'
          ? ag.units.flatMap((u): [Recipient, string | null][] => {
              const ref = u.replace(/^[^:]*:/, '')
              const r = all.find((x) => x.company === asString(delivered.find((d) => d.ref === ref)?.meta.company))
              return r ? [[r, ref]] : []
            })
          : ag?.kind === 'substitute'
            ? all.slice(want, want + ag.units.length).map((r, i): [Recipient, string | null] => [r, `email-${want + i + 1}`])
            : all.slice(0, want).map((r): [Recipient, string | null] => [r, null])
      let done = 0
      const written = await pool(take, opts.concurrency ?? 3, async ([r, ref]) => {
        const mail = await writeEmail({ ai: tools.ai, facts, recipient: r, kind: 'cold' })
        done++
        if (done % 5 === 0) await tools.progress(Math.round((done / take.length) * 95), `${done}/${take.length} emails written`)
        return { r, ref, mail }
      })
      const units: WorkResult['delivery']['deliverables'][number]['units'] = []
      const dropped: string[] = []
      written.forEach(({ r, ref, mail }) => {
        if (!mail.ok) return void dropped.push(`${r.company} (${mail.lint.violations.map((v) => v.rule).join(', ')})`)
        units.push({
          ref: ref ?? `email-${units.length + 1}`,
          artifact_ids: [],
          meta: { to: r.email || r.name || r.company, company: r.company, subject: mail.subject, body: mail.body, lint: 'passed', written_by: mail.usedAi ? 'ai' : 'template', rewrites: mail.rewrites },
        })
      })
      const note = [
        `Wrote ${units.length} of ${take.length} email(s); each passed the same lint the platform runs. I did not send anything.`,
        dropped.length ? `Left out because they could not pass the lint: ${dropped.join('; ')}.` : '',
        !ag && all.length > take.length ? `${all.length - take.length} further recipient(s) were beyond the ${want} requested.` : '',
        units.some((u) => u.meta.written_by === 'template') ? `${units.filter((u) => u.meta.written_by === 'template').length} email(s) are plain template text built from your facts (the AI was unavailable or did not pass the lint).` : '',
      ].filter(Boolean)
      return { summary: note.join('\n'), delivery: { deliverables: [{ deliverable_id: primary(job.spec).id, units, note: note[0]! }], note: note.join(' ') } }
    },
  }
}
