// Multi-step application forms for the Application Filler: a fake accelerator, grants and launch directories, with
// required fields, character limits, a file upload (a PDF one-pager) and a confirmation ID on submit. A draft is saved per
// (program, applicant email); it can be previewed at any time and only becomes an application when submitted.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { createHash } from 'node:crypto'
import type { CheckImpl, CheckLibrary, CheckOutcome } from '../intelligence/types.ts'
import { ensureFormParser } from './accounts.ts'
import type { Mail } from './mail.ts'
import { isEmail, normAddr } from './mail.ts'
import { hash32, hex } from './rng.ts'
import type { Application, Clock, Store } from './state.ts'
import { esc, isoUtc, shell } from './ui.ts'

export interface Field {
  key: string
  label: string
  type: 'text' | 'textarea' | 'url' | 'email' | 'select' | 'number'
  required: boolean
  min?: number
  max?: number
  options?: string[]
}
export interface Step {
  n: number
  title: string
  fields: Field[]
}
export interface Program {
  slug: string
  name: string
  kind: 'accelerator' | 'grant' | 'launch_directory'
  blurb: string
  /** Confirmation ID prefix. */
  prefix: string
  hue: number
  steps: Step[]
  file: { field: string; label: string; mime: string; max_bytes: number }
}

const f = (key: string, label: string, type: Field['type'], required: boolean, extra: Partial<Field> = {}): Field => ({ key, label, type, required, ...extra })
const FILE = (label: string, max_bytes = 1_000_000) => ({ field: 'one_pager', label, mime: 'application/pdf', max_bytes })

export const PROGRAMS: Program[] = [
  {
    slug: 'northstar-accelerator', name: 'Northstar Accelerator', kind: 'accelerator', prefix: 'NSA', hue: 222,
    blurb: 'A 12-week programme for early-stage software companies. Four-step application, one-pager required.',
    steps: [
      { n: 1, title: 'Company', fields: [f('company_name', 'Company name', 'text', true, { max: 60 }), f('website', 'Website', 'url', true), f('one_liner', 'One-line description', 'text', true, { max: 140 }), f('stage', 'Stage', 'select', true, { options: ['Idea', 'Prototype', 'Launched', 'Revenue'] })] },
      { n: 2, title: 'Founder', fields: [f('founder_name', 'Founder name', 'text', true, { max: 80 }), f('founder_email', 'Founder email', 'email', true), f('founder_role', 'Role', 'text', true, { max: 40 })] },
      { n: 3, title: 'Product', fields: [f('product_description', 'What are you building?', 'textarea', true, { min: 120, max: 600 }), f('traction', 'Traction so far', 'textarea', true, { max: 400 }), f('why_now', 'Why now?', 'textarea', true, { max: 300 })] },
      { n: 4, title: 'Funding', fields: [f('currently_raising', 'Are you raising, and how much?', 'text', true, { max: 60 }), f('use_of_funds', 'Use of funds', 'textarea', true, { max: 300 })] },
    ],
    file: FILE('Company one-pager (PDF, up to 1 MB)'),
  },
  {
    slug: 'summit-seed-accelerator', name: 'Summit Seed Accelerator', kind: 'accelerator', prefix: 'SSA', hue: 160,
    blurb: 'Seed-stage cohort for developer and AI tools. Three steps, short answers.',
    steps: [
      { n: 1, title: 'Company', fields: [f('name', 'Company', 'text', true, { max: 50 }), f('url', 'Website', 'url', true), f('one_liner', 'One-liner', 'text', true, { max: 100 }), f('sector', 'Sector', 'select', true, { options: ['Developer tools', 'AI and agents', 'Fintech', 'Productivity', 'Other'] })] },
      { n: 2, title: 'Team', fields: [f('founder_name', 'Founder name', 'text', true, { max: 80 }), f('founder_email', 'Founder email', 'email', true), f('team_size', 'Team size', 'number', true, { min: 1, max: 50 })] },
      { n: 3, title: 'Pitch', fields: [f('problem', 'The problem', 'textarea', true, { max: 500 }), f('solution', 'Your solution', 'textarea', true, { max: 500 }), f('traction', 'Traction', 'textarea', true, { max: 300 })] },
    ],
    file: FILE('Company one-pager (PDF, up to 1 MB)'),
  },
  {
    slug: 'open-builders-grant', name: 'Open Builders Grant', kind: 'grant', prefix: 'OBG', hue: 28,
    blurb: 'Small grants for people building useful software in the open. Three steps with a budget.',
    steps: [
      { n: 1, title: 'Applicant', fields: [f('applicant_org', 'Organisation or project', 'text', true, { max: 80 }), f('contact_name', 'Contact name', 'text', true, { max: 80 }), f('contact_email', 'Contact email', 'email', true), f('website', 'Website', 'url', false)] },
      { n: 2, title: 'Project', fields: [f('project_title', 'Project title', 'text', true, { max: 80 }), f('summary', 'Summary', 'textarea', true, { min: 80, max: 500 }), f('impact', 'Who benefits and how', 'textarea', true, { max: 400 }), f('open_source', 'Is it open source?', 'select', true, { options: ['Yes', 'Partly', 'No'] })] },
      { n: 3, title: 'Budget', fields: [f('amount_requested', 'Amount requested (USD)', 'number', true, { min: 1000, max: 50000 }), f('budget_notes', 'What the money pays for', 'textarea', true, { max: 300 })] },
    ],
    file: FILE('Project one-pager (PDF, up to 1 MB)'),
  },
  {
    slug: 'civic-ai-grant', name: 'Civic AI Grant', kind: 'grant', prefix: 'CAG', hue: 340,
    blurb: 'Funding for AI projects with a public benefit. Proposal, outcomes and an amount.',
    steps: [
      { n: 1, title: 'Organisation', fields: [f('org_name', 'Organisation', 'text', true, { max: 80 }), f('org_website', 'Website', 'url', true), f('contact_email', 'Contact email', 'email', true)] },
      { n: 2, title: 'Proposal', fields: [f('title', 'Proposal title', 'text', true, { max: 100 }), f('problem', 'Problem', 'textarea', true, { max: 600 }), f('approach', 'Approach', 'textarea', true, { max: 600 })] },
      { n: 3, title: 'Outcomes', fields: [f('outcomes', 'Expected outcomes', 'textarea', true, { max: 300 }), f('amount', 'Amount requested (USD)', 'number', true, { min: 5000, max: 100000 })] },
    ],
    file: FILE('Proposal one-pager (PDF, up to 1 MB)'),
  },
  {
    slug: 'launchday-directory', name: 'LaunchDay', kind: 'launch_directory', prefix: 'LDD', hue: 12,
    blurb: 'A daily launch board. Two steps and a press-kit PDF.',
    steps: [
      { n: 1, title: 'Product', fields: [f('product_name', 'Product name', 'text', true, { max: 50 }), f('tagline', 'Tagline', 'text', true, { max: 60 }), f('url', 'Website', 'url', true), f('category', 'Category', 'select', true, { options: ['AI', 'SaaS', 'Developer tools', 'Productivity', 'Fintech'] })] },
      { n: 2, title: 'Details', fields: [f('description', 'Description', 'textarea', true, { min: 60, max: 400 }), f('maker_name', 'Maker name', 'text', true, { max: 80 }), f('maker_email', 'Maker email', 'email', true)] },
    ],
    file: FILE('Press kit (PDF, up to 500 KB)', 500_000),
  },
  {
    slug: 'firstlight-launches', name: 'FirstLight', kind: 'launch_directory', prefix: 'FLL', hue: 48,
    blurb: 'Early-access launches, curated by hand. Two steps, short copy.',
    steps: [
      { n: 1, title: 'Product', fields: [f('name', 'Name', 'text', true, { max: 40 }), f('url', 'Website', 'url', true), f('tagline', 'Tagline', 'text', true, { max: 80 })] },
      { n: 2, title: 'Maker', fields: [f('description', 'Description', 'textarea', true, { max: 260 }), f('maker_email', 'Maker email', 'email', true), f('pricing', 'Pricing', 'select', true, { options: ['Free', 'Freemium', 'Paid'] })] },
    ],
    file: FILE('Press kit (PDF, up to 500 KB)', 500_000),
  },
]

const isHttpUrl = (u: string) => {
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** Per-field errors for one step's answers (empty = valid). */
export function validateStep(step: Step, fields: Record<string, unknown>): { values: Record<string, string>; errors: Record<string, string> } {
  const values: Record<string, string> = {}
  const errors: Record<string, string> = {}
  for (const fd of step.fields) {
    const v = str(fields[fd.key])
    if (!v) {
      if (fd.required) errors[fd.key] = `${fd.label} is required`
      continue
    }
    if (fd.max && v.length > fd.max) errors[fd.key] = `${fd.label} is too long (${v.length} of ${fd.max} characters)`
    else if (fd.type !== 'number' && fd.min && v.length < fd.min) errors[fd.key] = `${fd.label} is too short (${v.length}, at least ${fd.min} characters)`
    else if (fd.type === 'url' && !isHttpUrl(v)) errors[fd.key] = `${fd.label} must be an http(s) URL`
    else if (fd.type === 'email' && !isEmail(v.toLowerCase())) errors[fd.key] = `${fd.label} must be an email address`
    else if (fd.type === 'select' && !fd.options!.includes(v)) errors[fd.key] = `${fd.label} must be one of: ${fd.options!.join(', ')}`
    else if (fd.type === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n) || !/^\d+(\.\d+)?$/.test(v)) errors[fd.key] = `${fd.label} must be a number`
      else if ((fd.min !== undefined && n < fd.min) || (fd.max !== undefined && n > fd.max)) errors[fd.key] = `${fd.label} must be between ${fd.min} and ${fd.max}`
    }
    if (!errors[fd.key]) values[fd.key] = v
  }
  return { values, errors }
}

export interface Applications {
  find(slug: string, id: string): Application | undefined
  byConfirmation(slug: string, confirmation_id: string): Application | undefined
}

const confirmationId = (p: Program, seed: string, id: string) => `${p.prefix}-26-${hash32(`${seed}:${p.slug}:${id}`).toString(36).toUpperCase().padStart(7, '0').slice(-6)}`

export function registerApplicationRoutes(sb: FastifyInstance, ctx: { store: Store; mail: Mail; clock: Clock; publicUrl: string }): Applications {
  const { store, mail, clock } = ctx
  const base = ctx.publicUrl.replace(/\/+$/, '')
  const bySlug = new Map(PROGRAMS.map((p) => [p.slug, p]))
  const progUrl = (p: Program) => `${base}/sandbox/apps/${p.slug}`
  const appUrl = (p: Program, a: Application) => `${progUrl(p)}/applications/${a.id}`
  const receiptUrl = (p: Program, a: Application) => `${progUrl(p)}/receipt/${a.confirmation_id}`
  const html = (reply: FastifyReply, code: number, body: string) => reply.code(code).type('text/html').send(body)
  const missing = (reply: FastifyReply, what: string, json = false) =>
    json ? reply.code(404).send({ error: 'not_found', message: what }) : html(reply, 404, shell({ title: 'Not found', body: `<div class="wrap"><h1>404</h1><p>${esc(what)}</p></div>` }))
  ensureFormParser(sb)

  const find = (slug: string, id: string) => store.data.applications.find((a) => a.program === slug && a.id === id)
  const byConfirmation = (slug: string, cid: string) => store.data.applications.find((a) => a.program === slug && a.confirmation_id === cid)
  const answers = (a: Application) => Object.assign({}, ...Object.values(a.steps)) as Record<string, string>
  const missingOf = (p: Program, a: Application) => {
    const out: { step: number; key: string }[] = []
    for (const s of p.steps) for (const fd of s.fields) if (fd.required && !a.steps[String(s.n)]?.[fd.key]) out.push({ step: s.n, key: fd.key })
    if (!a.files[p.file.field]) out.push({ step: 0, key: p.file.field })
    return out
  }
  const status = (p: Program, a: Application) => {
    const miss = missingOf(p, a)
    return {
      application_id: a.id,
      program: p.slug,
      status: a.submitted_at ? 'submitted' : 'draft',
      completed_steps: [...a.completed].sort((x, y) => x - y),
      next_step: a.submitted_at ? null : (p.steps.find((s) => !a.completed.includes(s.n))?.n ?? null),
      missing: miss,
      ready_to_submit: !a.submitted_at && miss.length === 0,
      files: a.files,
      preview_url: appUrl(p, a) + '/preview',
      ...(a.confirmation_id ? { confirmation_id: a.confirmation_id, receipt_url: receiptUrl(p, a) } : {}),
    }
  }

  function create(p: Program, body: Record<string, unknown>) {
    const email = normAddr(str(body.email))
    const name = str(body.applicant_name).slice(0, 80)
    if (!isEmail(email)) return { code: 400, json: { error: 'invalid_request', errors: { email: 'a valid applicant email is required' } } }
    const existing = store.data.applications.find((a) => a.program === p.slug && a.email === email)
    if (existing) return { code: existing.submitted_at ? 409 : 200, json: { ...status(p, existing), ...(existing.submitted_at ? { error: 'already_submitted', message: 'An application from this email was already submitted.' } : { resumed: true }) } }
    const seq = store.data.applications.length + 1
    const a: Application = { id: `app${String(seq).padStart(4, '0')}${hex(hash32(`${store.data.seed}:${p.slug}:${email}`), 4)}`, program: p.slug, email, applicant_name: name, created_at: clock(), steps: {}, completed: [], files: {}, submitted_at: null, confirmation_id: null }
    store.data.applications.push(a)
    store.save()
    return { code: 201, json: { ...status(p, a), message: `Draft started. Complete steps 1-${p.steps.length}, upload the file, then submit.` } }
  }

  function saveStep(p: Program, a: Application, n: number, body: Record<string, unknown>) {
    if (a.submitted_at) return { code: 409, json: { error: 'already_submitted', message: 'This application was already submitted and cannot be edited.' } }
    const step = p.steps.find((s) => s.n === n)
    if (!step) return { code: 404, json: { error: 'not_found', message: `${p.name} has steps 1-${p.steps.length}.` } }
    if (n > 1 && !a.completed.includes(n - 1)) return { code: 409, json: { error: 'step_out_of_order', message: `Complete step ${n - 1} first.`, next_step: p.steps.find((s) => !a.completed.includes(s.n))?.n ?? 1 } }
    const fields = ((body.fields ?? body) ?? {}) as Record<string, unknown>
    const { values, errors } = validateStep(step, fields)
    if (Object.keys(errors).length) return { code: 422, json: { error: 'validation_failed', step: n, errors } }
    a.steps[String(n)] = values
    if (!a.completed.includes(n)) a.completed.push(n)
    store.save()
    return { code: 200, json: { ok: true, saved_step: n, ...status(p, a) } }
  }

  function upload(p: Program, a: Application, body: Record<string, unknown>) {
    if (a.submitted_at) return { code: 409, json: { error: 'already_submitted' } }
    const field = str(body.field) || p.file.field
    const filename = str(body.filename)
    const mime = str(body.mime)
    const b64 = typeof body.content_base64 === 'string' ? body.content_base64 : ''
    const errors: Record<string, string> = {}
    if (field !== p.file.field) errors.field = `the file field is "${p.file.field}"`
    if (!/\.pdf$/i.test(filename)) errors.filename = 'upload a .pdf file'
    if (mime !== p.file.mime) errors.mime = `only ${p.file.mime} is accepted`
    const bytes = Buffer.from(b64, 'base64')
    if (!bytes.length) errors.content_base64 = 'the file is empty'
    else if (bytes.length > p.file.max_bytes) errors.content_base64 = `the file is ${bytes.length} bytes; the limit is ${p.file.max_bytes}`
    else if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') errors.content_base64 = 'this is not a PDF file'
    if (Object.keys(errors).length) return { code: 422, json: { error: 'validation_failed', errors } }
    a.files[field] = { filename: filename.slice(0, 120), mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    store.save()
    return { code: 200, json: { ok: true, ...status(p, a) } }
  }

  function submit(p: Program, a: Application) {
    if (a.submitted_at) return { code: 200, json: { ok: true, replayed: true, ...status(p, a) } }
    const miss = missingOf(p, a)
    if (miss.length) return { code: 422, json: { error: 'incomplete', message: 'Finish every required step and upload the file first.', missing: miss } }
    a.submitted_at = clock()
    a.confirmation_id = confirmationId(p, store.data.seed, a.id)
    store.save()
    mail.deliverSystem({
      from: `noreply@${p.slug}.apps.sandbox`,
      to: a.email,
      subject: `${p.name}: we received your application ${a.confirmation_id}`,
      text: `Hi${a.applicant_name ? ` ${a.applicant_name}` : ''},\n\nThanks for applying to ${p.name}. Your confirmation ID is ${a.confirmation_id}.\n\nReceipt: ${receiptUrl(p, a)}\n\n${p.name} (Sandbox Web fixture)`,
    })
    return { code: 201, json: { ok: true, message: 'Application submitted.', ...status(p, a) } }
  }

  // ---- catalog and program pages ----
  const fieldJson = (fd: Field) => ({ key: fd.key, label: fd.label, type: fd.type, required: fd.required, ...(fd.min ? { min_length: fd.type === 'number' ? undefined : fd.min } : {}), ...(fd.type === 'number' ? { min: fd.min, max: fd.max } : fd.max ? { max_length: fd.max } : {}), ...(fd.options ? { options: fd.options } : {}) })
  sb.get('/apps.json', async () => ({
    count: PROGRAMS.length,
    note: 'Sandbox Web fixtures: a fake accelerator, grants and launch directories. Drafts are saved per applicant email; submit only when the answers are final.',
    programs: PROGRAMS.map((p) => ({
      slug: p.slug,
      name: p.name,
      kind: p.kind,
      blurb: p.blurb,
      url: progUrl(p),
      host: `${p.slug}.apps.sandbox`,
      create_endpoint: `${progUrl(p)}/api/applications`,
      steps: p.steps.map((s) => ({ n: s.n, title: s.title, fields: s.fields.map(fieldJson) })),
      file: p.file,
    })),
  }))

  const css = (p: Program) => `body{background:hsl(${p.hue} 28% 97%)}.hd{background:hsl(${p.hue} 55% 32%);color:#fff;padding:28px 20px}.hd .in{max-width:900px;margin:0 auto}.hd h1{margin:0;font-size:26px}.hd a{color:#fff;text-decoration:none}.hd p{margin:4px 0 0;opacity:.9}
.panel{background:#fff;border:1px solid hsl(${p.hue} 20% 88%);border-radius:10px;padding:22px;margin-bottom:14px}.btn{display:inline-block;background:hsl(${p.hue} 55% 32%);color:#fff;border:0;padding:10px 18px;border-radius:8px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}
label{display:block;font-weight:650;margin:14px 0 4px;font-size:14px}input,textarea,select{width:100%;padding:9px 10px;border:1px solid hsl(${p.hue} 20% 82%);border-radius:6px;font:inherit}.note{font-size:13px;opacity:.75}.err{color:#c0392b}.ok{color:#1d7a46}
dl{display:grid;grid-template-columns:200px 1fr;gap:6px 16px;margin:0}dt{font-weight:650;opacity:.8}dd{margin:0;white-space:pre-wrap}.banner{background:#fff7e0;border:1px solid #ecd88b;border-radius:8px;padding:10px 14px;margin-bottom:14px}.conf{font:800 28px ui-monospace,Consolas,monospace;letter-spacing:.04em}`
  const page = (p: Program, title: string, inner: string) =>
    shell({ title: `${title} · ${p.name}`, css: css(p), body: `<div class="hd"><div class="in"><h1><a href="/sandbox/apps/${p.slug}">${esc(p.name)}</a></h1><p>${esc(p.blurb)}</p></div></div><div class="wrap">${inner}<div class="note" style="margin-top:30px">${esc(p.name)} is a Sandbox Web fixture, not a real programme. Nothing here reaches the real internet.</div></div>` })

  sb.get('/apps', async (_req, reply) =>
    html(reply, 200, shell({
      title: 'Sandbox applications',
      css: '.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.g a{background:#fff;border:1px solid #e1e4e9;border-radius:10px;padding:14px;text-decoration:none}.g small{display:block;color:#6b7482}',
      body: `<div class="wrap"><h1>${PROGRAMS.length} sandbox programmes</h1><p>Machine-readable: <a href="/sandbox/apps.json">/sandbox/apps.json</a></p><div class="g">${PROGRAMS.map((p) => `<a href="/sandbox/apps/${p.slug}"><b style="color:hsl(${p.hue} 55% 32%)">${esc(p.name)}</b><small>${esc(p.kind.replace('_', ' '))} · ${p.steps.length} steps</small></a>`).join('')}</div></div>`,
    })))

  sb.get('/apps/:slug', async (req, reply) => {
    const p = bySlug.get((req.params as { slug: string }).slug)
    if (!p) return missing(reply, 'No such programme')
    const rows = p.steps.map((s) => `<h3>Step ${s.n}: ${esc(s.title)}</h3><ul>${s.fields.map((fd) => `<li>${esc(fd.label)}${fd.required ? ' *' : ''}${fd.max && fd.type !== 'number' ? ` <span class="note">(max ${fd.max} characters)</span>` : ''}${fd.min && fd.type !== 'number' ? ` <span class="note">(min ${fd.min})</span>` : ''}</li>`).join('')}</ul>`).join('')
    return html(reply, 200, page(p, 'Apply', `<div class="panel"><h2>Apply to ${esc(p.name)}</h2>${rows}<h3>File</h3><ul><li>${esc(p.file.label)} *</li></ul><form method="post" action="/sandbox/apps/${p.slug}/apply"><label for="email">Your email</label><input id="email" name="email" type="email" required><label for="applicant_name">Your name</label><input id="applicant_name" name="applicant_name"><p><button class="btn" type="submit">Start application</button></p></form></div>`))
  })

  sb.post('/apps/:slug/apply', async (req, reply) => {
    const p = bySlug.get((req.params as { slug: string }).slug)
    if (!p) return missing(reply, 'No such programme')
    const r = create(p, (req.body ?? {}) as Record<string, unknown>)
    const j = r.json as { application_id?: string; message?: string; error?: string }
    if (!j.application_id) return html(reply, r.code, page(p, 'Apply', `<div class="panel"><p class="err">${esc(JSON.stringify(j))}</p></div>`))
    return reply.redirect(`/sandbox/apps/${p.slug}/applications/${j.application_id}/step/1`)
  })

  // ---- JSON API ----
  sb.post('/apps/:slug/api/applications', async (req, reply) => {
    const p = bySlug.get((req.params as { slug: string }).slug)
    if (!p) return missing(reply, 'No such programme', true)
    const r = create(p, (req.body ?? {}) as Record<string, unknown>)
    return reply.code(r.code).send(r.json)
  })
  const withApp = (req: { params: unknown }) => {
    const { slug, id } = req.params as { slug: string; id: string }
    const p = bySlug.get(slug)
    const a = p && find(slug, id)
    return p && a ? { p, a } : null
  }
  sb.get('/apps/:slug/api/applications/:id', async (req, reply) => {
    const h = withApp(req)
    return h ? status(h.p, h.a) : missing(reply, 'No such application', true)
  })
  sb.put('/apps/:slug/api/applications/:id/steps/:n', async (req, reply) => {
    const h = withApp(req)
    if (!h) return missing(reply, 'No such application', true)
    const r = saveStep(h.p, h.a, Number((req.params as { n: string }).n), (req.body ?? {}) as Record<string, unknown>)
    return reply.code(r.code).send(r.json)
  })
  sb.post('/apps/:slug/api/applications/:id/files', async (req, reply) => {
    const h = withApp(req)
    if (!h) return missing(reply, 'No such application', true)
    const r = upload(h.p, h.a, (req.body ?? {}) as Record<string, unknown>)
    return reply.code(r.code).send(r.json)
  })
  sb.post('/apps/:slug/api/applications/:id/submit', async (req, reply) => {
    const h = withApp(req)
    if (!h) return missing(reply, 'No such application', true)
    const r = submit(h.p, h.a)
    return reply.code(r.code).send(r.json)
  })

  // ---- HTML: the multi-step form, the preview and the receipt ----
  const stepForm = (p: Program, a: Application, step: Step, errors: Record<string, string> = {}, values: Record<string, unknown> = a.steps[String(step.n)] ?? {}) => {
    const input = (fd: Field) => {
      const v = esc(values[fd.key])
      const hint = fd.max && fd.type !== 'number' ? ` <span class="note">(max ${fd.max})</span>` : ''
      const control = fd.type === 'textarea' ? `<textarea id="${fd.key}" name="${fd.key}" rows="5">${v}</textarea>` : fd.type === 'select' ? `<select id="${fd.key}" name="${fd.key}"><option value=""></option>${fd.options!.map((o) => `<option${values[fd.key] === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>` : `<input id="${fd.key}" name="${fd.key}" type="${fd.type === 'url' ? 'url' : fd.type === 'email' ? 'email' : 'text'}" value="${v}">`
      return `<label for="${fd.key}">${esc(fd.label)}${fd.required ? ' *' : ''}${hint}</label>${control}${errors[fd.key] ? `<div class="err note">${esc(errors[fd.key])}</div>` : ''}`
    }
    return `<div class="panel"><p class="note">Step ${step.n} of ${p.steps.length}</p><h2>${esc(step.title)}</h2><form method="post" action="${esc(appUrl(p, a).replace(base, ''))}/step/${step.n}">${step.fields.map(input).join('')}<p><button class="btn" type="submit">${step.n < p.steps.length ? 'Save and continue' : 'Save'}</button></p></form></div>`
  }
  sb.get('/apps/:slug/applications/:id/step/:n', async (req, reply) => {
    const h = withApp(req)
    if (!h) return missing(reply, 'No such application')
    const step = h.p.steps.find((s) => s.n === Number((req.params as { n: string }).n))
    return step ? html(reply, 200, page(h.p, `Step ${step.n}`, stepForm(h.p, h.a, step))) : missing(reply, 'No such step')
  })
  sb.post('/apps/:slug/applications/:id/step/:n', async (req, reply) => {
    const h = withApp(req)
    if (!h) return missing(reply, 'No such application')
    const n = Number((req.params as { n: string }).n)
    const step = h.p.steps.find((s) => s.n === n)
    if (!step) return missing(reply, 'No such step')
    const r = saveStep(h.p, h.a, n, (req.body ?? {}) as Record<string, unknown>)
    if (r.code !== 200) return html(reply, r.code, page(h.p, `Step ${n}`, stepForm(h.p, h.a, step, ((r.json as { errors?: Record<string, string> }).errors ?? {}), (req.body ?? {}) as Record<string, unknown>)))
    const next = h.p.steps.find((s) => s.n === n + 1)
    return reply.redirect(next ? `/sandbox/apps/${h.p.slug}/applications/${h.a.id}/step/${next.n}` : `/sandbox/apps/${h.p.slug}/applications/${h.a.id}/preview`)
  })
  sb.get('/apps/:slug/applications/:id/preview', async (req, reply) => {
    const h = withApp(req)
    if (!h) return missing(reply, 'No such application')
    const { p, a } = h
    const mine = answers(a)
    const rows = p.steps.map((s) => `<h3>Step ${s.n}: ${esc(s.title)}</h3><dl>${s.fields.map((fd) => `<dt>${esc(fd.label)}</dt><dd>${mine[fd.key] ? esc(mine[fd.key]) : '<span class="note">(empty)</span>'}</dd>`).join('')}</dl>`).join('')
    const file = a.files[p.file.field]
    const miss = missingOf(p, a)
    return html(reply, 200, page(p, 'Preview', `<div class="banner">${a.submitted_at ? `Submitted ${isoUtc(a.submitted_at)}. Confirmation <b>${esc(a.confirmation_id)}</b>.` : `<b>Draft, not submitted.</b> ${miss.length ? `${miss.length} required item(s) still missing.` : 'Ready to submit.'}`}</div><div class="panel"><h2>${esc(p.name)} application for ${esc(a.email)}</h2>${rows}<h3>File</h3><p>${file ? `${esc(file.filename)} (${file.bytes} bytes, sha256 ${esc(file.sha256.slice(0, 12))}…)` : '<span class="note">(no file uploaded)</span>'}</p>${a.submitted_at || miss.length ? '' : `<form method="post" action="/sandbox/apps/${p.slug}/applications/${a.id}/submit"><button class="btn" type="submit">Submit application</button></form>`}</div>`))
  })
  sb.post('/apps/:slug/applications/:id/submit', async (req, reply) => {
    const h = withApp(req)
    if (!h) return missing(reply, 'No such application')
    const r = submit(h.p, h.a)
    if (r.code >= 400) return html(reply, r.code, page(h.p, 'Submit', `<div class="panel"><p class="err">${esc((r.json as { message?: string }).message)}</p></div>`))
    return reply.redirect(`/sandbox/apps/${h.p.slug}/receipt/${h.a.confirmation_id}`)
  })
  sb.get('/apps/:slug/receipt/:cid', async (req, reply) => {
    const { slug, cid } = req.params as { slug: string; cid: string }
    const p = bySlug.get(slug)
    const a = p && byConfirmation(slug, cid)
    if (!p || !a) return missing(reply, 'There is no application with this confirmation ID.')
    const mine = answers(a)
    const name = mine.company_name ?? mine.name ?? mine.applicant_org ?? mine.org_name ?? mine.product_name ?? ''
    return html(reply, 200, page(p, 'Receipt', `<div class="panel"><h2 class="ok">Application received</h2><p>Confirmation ID</p><p class="conf">${esc(a.confirmation_id)}</p><dl><dt>Programme</dt><dd>${esc(p.name)}</dd><dt>Applicant</dt><dd>${esc(a.applicant_name || a.email)} (${esc(a.email)})</dd>${name ? `<dt>Company or project</dt><dd>${esc(name)}</dd>` : ''}<dt>Submitted</dt><dd>${isoUtc(a.submitted_at!)}</dd><dt>Status</dt><dd>Received, under review</dd></dl></div>`))
  })

  return { find, byConfirmation }
}

// ---------- the acceptance check ----------

const out = (status: CheckOutcome['status'], detail: string, evidence_id: string | null = null): CheckOutcome => ({ status, detail: detail.slice(0, 1000), evidence_id })

/** application_confirmed: the unit's confirmation ID exists in Sandbox Web for that programme, as a submitted application. */
export function registerApplicationChecks(checks: CheckLibrary, apps: Applications, store: Store): void {
  const impl: CheckImpl = {
    def: {
      id: 'application_confirmed',
      title: 'Application confirmed',
      description:
        'The confirmation ID in unit.meta.confirmation_id exists in Sandbox Web for the programme in unit.meta.program as a SUBMITTED application (a draft, a wrong programme or an invented ID fails). Optionally every string in must_include must appear in the submitted answers, case-insensitive.',
      params: {
        type: 'object',
        properties: { must_include: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Strings that must appear in the submitted answers (e.g. the company name).' } },
        additionalProperties: false,
      },
      per_unit: true,
      delayed: false,
    },
    async run(ctx) {
      if (!ctx.unit) return out('error', 'this check runs per delivered unit')
      const cid = typeof ctx.unit.meta.confirmation_id === 'string' ? ctx.unit.meta.confirmation_id.trim() : ''
      const slug = typeof ctx.unit.meta.program === 'string' ? ctx.unit.meta.program.trim() : ''
      if (!cid || !slug) return out('fail', 'unit.meta.confirmation_id and unit.meta.program are required')
      const app = apps.byConfirmation(slug, cid)
      if (!app || !app.submitted_at) return out('fail', `no submitted application with confirmation ${cid.slice(0, 40)} at ${slug.slice(0, 60)}`)
      const mine = Object.values(Object.assign({}, ...Object.values(app.steps)) as Record<string, string>).join('\n').toLowerCase()
      const need = ((ctx.test.params.must_include as string[] | undefined) ?? []).filter((t) => !mine.includes(t.toLowerCase()))
      const ev = await ctx.saveEvidence('application_receipt', `${slug} ${cid}: submitted`, { program: slug, confirmation_id: cid, application_id: app.id, applicant: app.email, submitted_at: new Date(app.submitted_at).toISOString(), file: app.files, steps_completed: app.completed })
      if (need.length) return out('fail', `the submitted answers do not mention ${need.map((n) => `"${n}"`).join(', ')}`, ev)
      return out('pass', `confirmation ${cid} exists at ${slug}, submitted ${new Date(app.submitted_at).toISOString()}`, ev)
    },
  }
  checks.register(impl)
  void store
}
