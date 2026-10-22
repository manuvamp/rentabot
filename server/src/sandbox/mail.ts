// Sandbox mail: investor personas on demo-vc.sandbox plus catch-all mailboxes for every other address
// (so directory verification mails land somewhere readable). Nothing ever leaves the process.
import type { FastifyInstance } from 'fastify'
import { hash32, hex } from './rng.ts'
import { MAIL_DOMAIN, PERSONAS, matchedKeywords, type Persona } from './personas.ts'
import type { Mailboxes } from './mailboxes.ts'
import { basicAuth } from './secrets.ts'
import type { Clock, MailMessage, Store } from './state.ts'
import { esc, isoUtc, shell } from './ui.ts'

export interface SendRequest {
  from: string
  to: string
  subject: string
  text: string
  /** The client's own Message-ID (an SMTP client sets it). The server assigns one when missing. */
  message_id?: string
  via?: 'smtp_auth' | 'open'
}

export interface Mail {
  send(req: SendRequest): MailMessage
  /** Deliver a system mail (directory confirmations). `at` schedules it for later. */
  deliverSystem(m: { from: string; to: string; subject: string; text: string; at?: number }): MailMessage
  /** Visible messages (sent, received, bounces) touching an address; all visible messages if omitted. */
  list(address?: string): MailMessage[]
  get(messageId: string): MailMessage | undefined
  /** The sent message with this id (not replies or system mails). */
  findSent(messageId: string): MailMessage | undefined
  /** Visible replies and bounce notices answering a sent message. */
  repliesTo(messageId: string): MailMessage[]
}

const byAddress = new Map(PERSONAS.map((p) => [p.address, p]))
export const normAddr = (a: string): string => a.trim().toLowerCase().replace(/^.*<([^>]+)>\s*$/, '$1')
export const isEmail = (a: string): boolean => /^[^\s@<>]+@[^\s@<>]+\.[a-z][a-z0-9-]*$/i.test(a)
export const normId = (id: string): string => `<${id.trim().replace(/^<|>$/g, '')}>`

export function createMail(opts: { store: Store; clock: Clock; scale: number }): Mail {
  const { store, clock, scale } = opts
  const minutes = (m: number) => m * 60_000 * scale

  const newId = (): string => {
    const seq = ++store.data.mail_seq
    return `<sbx.${String(seq).padStart(6, '0')}.${hex(hash32(`${store.data.seed}:mail:${seq}`))}@mail.${MAIL_DOMAIN}>`
  }
  const push = (m: MailMessage) => {
    store.data.mail.push(m)
    store.save()
    return m
  }
  const base = (over: Partial<MailMessage> & Pick<MailMessage, 'from' | 'to' | 'subject' | 'text' | 'kind'>): MailMessage => {
    const t = clock()
    return { message_id: newId(), sent_at: t, visible_at: t, status: 'delivered', bounce_reason: null, in_reply_to: null, reply_kind: null, persona_id: null, ...over }
  }

  function planReply(p: Persona, sent: MailMessage): void {
    if (p.style === 'no_reply' || p.style === 'bounce') return
    const hits = p.style === 'positive' ? matchedKeywords(p, `${sent.subject}\n${sent.text}`) : []
    const positive = p.style === 'positive' && hits.length > 0
    const jitter = hash32(`${p.id}:${sent.message_id}`) % 100 // deterministic spread
    const delayMin = positive ? 25 + Math.floor(jitter * 0.65) : 10 + Math.floor(jitter * 0.35) // 25-90 / 10-45 nominal minutes
    const first = p.name.split(' ')[0]!
    const text = positive
      ? `Hi,\n\nThanks for the note. Your point on ${hits[0]} lines up with what we back at ${p.firm} (${p.thesis}). Happy to talk. Do you have 25 minutes next week? Send two or three slots and a short deck.\n\n${first}\n${p.firm}`
      : p.style === 'positive'
        ? `Hi,\n\nThanks for reaching out. This reads like a general pitch and I can't see the fit with our thesis (${p.thesis}). If you can tell me why it matters for that, I'll take another look.\n\n${first}\n${p.firm}`
        : `Hi,\n\nThanks for thinking of us. This isn't a fit for ${p.firm} right now (we focus on: ${p.thesis}). I'll pass, and I wish you the best with it.\n\n${first}\n${p.firm}`
    const at = sent.sent_at + minutes(delayMin)
    push(base({
      from: p.address,
      to: sent.from,
      subject: /^re:/i.test(sent.subject) ? sent.subject : `Re: ${sent.subject}`,
      text,
      kind: 'reply',
      sent_at: at,
      visible_at: at,
      in_reply_to: sent.message_id,
      reply_kind: positive ? 'positive' : 'decline',
      persona_id: p.id,
    }))
  }

  const mail: Mail = {
    send(req) {
      const from = normAddr(req.from)
      const to = normAddr(req.to)
      const domain = to.split('@')[1] ?? ''
      let bounce: string | null = null
      let persona: Persona | undefined
      if (domain === MAIL_DOMAIN) {
        persona = byAddress.get(to)
        if (!persona) bounce = `550 5.1.1 <${to}>: Recipient address rejected: User unknown in ${MAIL_DOMAIN}`
        else if (persona.style === 'bounce') bounce = `550 5.7.1 <${to}>: Recipient address rejected: mailbox disabled by the recipient's domain policy`
      }
      const sent = push(base({ from, to, subject: req.subject, text: req.text, kind: 'sent', status: bounce ? 'bounced' : 'delivered', bounce_reason: bounce, persona_id: persona?.id ?? null, via: req.via ?? 'open', ...(req.message_id ? { message_id: normId(req.message_id) } : {}) }))
      if (bounce) {
        push(base({
          from: `mailer-daemon@${MAIL_DOMAIN}`,
          to: from,
          subject: 'Undelivered Mail Returned to Sender',
          text: `Your message "${req.subject}" to ${to} could not be delivered.\n\n${bounce}\n\nOriginal message id: ${sent.message_id}`,
          kind: 'bounce',
          in_reply_to: sent.message_id,
        }))
      } else if (persona) planReply(persona, sent)
      return sent
    },
    deliverSystem(m) {
      const at = m.at ?? clock()
      return push(base({ from: normAddr(m.from), to: normAddr(m.to), subject: m.subject, text: m.text, kind: 'system', sent_at: at, visible_at: at }))
    },
    list(address) {
      const t = clock()
      const a = address ? normAddr(address) : null
      return store.data.mail
        .filter((m) => m.visible_at <= t && (!a || m.to === a || m.from === a))
        .sort((x, y) => x.visible_at - y.visible_at || x.message_id.localeCompare(y.message_id))
    },
    get(id) {
      const t = clock()
      const nid = normId(id)
      return store.data.mail.find((m) => m.message_id === nid && m.visible_at <= t)
    },
    findSent(id) {
      const m = mail.get(id)
      return m && m.kind === 'sent' ? m : undefined
    },
    repliesTo(id) {
      const t = clock()
      const nid = normId(id)
      return store.data.mail.filter((m) => m.in_reply_to === nid && m.visible_at <= t && (m.kind === 'reply' || m.kind === 'bounce'))
    },
  }
  return mail
}

// ---------- HTTP ----------

const iso = (ms: number) => new Date(ms).toISOString()

function toJson(m: MailMessage, viewer?: string) {
  return {
    message_id: m.message_id,
    kind: m.kind,
    status: m.status,
    from: m.from,
    to: m.to,
    subject: m.subject,
    text: m.text,
    sent_at: iso(m.sent_at),
    in_reply_to: m.in_reply_to,
    bounce_reason: m.bounce_reason,
    reply_kind: m.reply_kind,
    direction: viewer ? (m.from === viewer ? 'out' : 'in') : undefined,
    ...(m.kind === 'sent' ? { via: m.via ?? 'open', authenticated_as: m.via === 'smtp_auth' ? m.from : null } : {}),
  }
}

const VIEWER_CSS = `
body{background:#eef0f3}
.mail{display:grid;grid-template-columns:260px 340px 1fr;height:calc(100vh - 31px);background:#fff}
.col{overflow:auto;border-right:1px solid #dfe3e8}
.col h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7482;margin:18px 16px 6px}
.box{display:flex;justify-content:space-between;gap:8px;padding:8px 16px;text-decoration:none;font-size:13px;border-left:3px solid transparent}
.box:hover{background:#f3f5f7}.box.sel{background:#e9efff;border-left-color:#3a63e0}
.box small{color:#6b7482;display:block}.cnt{background:#e4e8ee;border-radius:10px;padding:0 8px;font-size:12px;height:20px;line-height:20px}
.msg{display:block;padding:11px 16px;border-bottom:1px solid #eef0f3;text-decoration:none;font-size:13px}
.msg:hover{background:#f7f8fa}.msg.sel{background:#e9efff}.msg b{display:block;font-size:13px}.msg span{color:#6b7482;font-size:12px}
.tag{display:inline-block;font-size:10px;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:1px}
.t-reply{background:#dff5e6;color:#1d6b3a}.t-bounce{background:#fde3e1;color:#a3281f}.t-system{background:#e8ecf4;color:#44506b}.t-sent{background:#eceff3;color:#59626f}.t-decline{background:#f6ebd4;color:#7a5a12}
.read{padding:26px 32px}.read h1{font-size:20px;margin:0 0 14px}.hdr{color:#59626f;font-size:13px;line-height:1.7;border-bottom:1px solid #eef0f3;padding-bottom:14px;margin-bottom:18px}
.hdr code{background:#f1f3f6;padding:1px 5px;border-radius:3px;font-size:12px}
pre.body{white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif;margin:0}
.empty{padding:40px 24px;color:#8a93a1;font-size:14px}
.top{padding:14px 16px;font-weight:650;font-size:15px;border-bottom:1px solid #dfe3e8}.top a{font-weight:400;font-size:12px;color:#3a63e0;margin-left:8px}
`

export function registerMailRoutes(sb: FastifyInstance, ctx: { mail: Mail; store: Store; clock: Clock; mailboxes: Mailboxes }): void {
  const { mail, store, clock, mailboxes } = ctx
  /** A registered mailbox answers API reads only with its app password (HTTP Basic), like IMAP. */
  const mayRead = (req: { headers: Record<string, unknown> }, address: string): boolean => {
    if (!mailboxes.isRegistered(address)) return true
    const c = basicAuth(req.headers.authorization)
    return !!c && normAddr(c.user) === normAddr(address) && mailboxes.authenticate(c.user, c.password)
  }

  sb.post('/mail/send', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '')
    const errors: Record<string, string> = {}
    const from = normAddr(s('from'))
    const to = normAddr(s('to'))
    if (!isEmail(from)) errors.from = 'a valid sender address is required'
    if (!isEmail(to)) errors.to = 'a valid recipient address is required'
    if (!s('subject') || s('subject').length > 300) errors.subject = 'subject is required (max 300 chars)'
    if (!s('text') || s('text').length > 20_000) errors.text = 'text is required (max 20000 chars)'
    if (Object.keys(errors).length) return reply.code(400).send({ error: 'invalid_request', errors })
    // The open test API cannot impersonate a mailbox that has an app password: those send through /mail/smtp/send.
    if (mailboxes.isRegistered(from)) return reply.code(401).send({ error: 'auth_required', message: `${from} is a registered mailbox. Send as it with its app password through POST /sandbox/mail/smtp/send.` })
    const m = mail.send({ from, to, subject: s('subject'), text: s('text') })
    return reply.code(201).send({ message_id: m.message_id, status: m.status, to: m.to, from: m.from, sent_at: iso(m.sent_at), bounce_reason: m.bounce_reason })
  })

  sb.get('/mail/messages', async (req, reply) => {
    const q = req.query as { address?: string }
    const address = q.address ? normAddr(q.address) : undefined
    if (address && !mayRead(req, address)) return reply.code(401).header('www-authenticate', 'Basic realm="Sandbox Web mailbox"').send({ error: 'auth_failed', message: `${address} is a registered mailbox: read it with HTTP Basic (username = address, password = an app password).` })
    if (!address && mail.list().some((m) => mailboxes.isRegistered(m.to) || mailboxes.isRegistered(m.from))) {
      // Listing everything would expose private mailboxes: show only messages of open addresses.
      const open = mail.list().filter((m) => !mailboxes.isRegistered(m.to) && !mailboxes.isRegistered(m.from))
      return { address: null, count: open.length, now: iso(clock()), messages: open.map((m) => toJson(m)) }
    }
    const list = mail.list(address)
    return { address: address ?? null, count: list.length, now: iso(clock()), messages: list.map((m) => toJson(m, address)) }
  })

  // The delivery record of one message: who sent it, how (app-password SMTP or the open test API), whether it was delivered.
  sb.get('/mail/message/:id', async (req, reply) => {
    const m = mail.get((req.params as { id: string }).id)
    if (!m) return reply.code(404).send({ error: 'not_found' })
    return toJson(m)
  })

  // Public investor list: what a research step could find on a firm's site. Reply style stays hidden.
  sb.get('/mail/investors.json', async () => ({
    domain: MAIL_DOMAIN,
    count: PERSONAS.length,
    investors: PERSONAS.map((p) => ({ name: p.name, firm: p.firm, email: p.address, thesis: p.thesis, check_size: p.check_size, stage: p.stage })),
  }))

  sb.get('/mail', async (req, reply) => {
    const q = req.query as { address?: string; id?: string }
    const all = mail.list()
    const counts = new Map<string, number>()
    for (const m of all) for (const a of new Set([m.from, m.to])) counts.set(a, (counts.get(a) ?? 0) + 1)
    const personaSet = new Set(PERSONAS.map((p) => p.address))
    const box = (a: string, label: string, sub: string) =>
      `<a class="box ${q.address === a ? 'sel' : ''}" href="/sandbox/mail?address=${encodeURIComponent(a)}"><span>${esc(label)}<small>${esc(sub)}</small></span><span class="cnt">${counts.get(a) ?? 0}</span></a>`
    const others = [...counts.keys()].filter((a) => !personaSet.has(a) && a !== `mailer-daemon@${MAIL_DOMAIN}` && !/\.(dirs|saas|apps)\.sandbox$/.test(a)).sort()
    const side =
      `<div class="top">Sandbox Mail <a href="/sandbox/mail${q.address ? `?address=${encodeURIComponent(q.address)}` : ''}">refresh</a></div>` +
      `<a class="box ${!q.address ? 'sel' : ''}" href="/sandbox/mail"><span>All mail</span><span class="cnt">${all.length}</span></a>` +
      (others.length ? `<h2>Buyer inboxes</h2>${others.map((a) => box(a, a, mailboxes.isRegistered(a) ? 'app-password mailbox' : 'catch-all mailbox')).join('')}` : '') +
      `<h2>Investors @${MAIL_DOMAIN}</h2>${PERSONAS.map((p) => box(p.address, p.name, p.firm)).join('')}`

    const address = q.address ? normAddr(q.address) : undefined
    const list = mail.list(address).reverse()
    const tag = (m: MailMessage) => {
      const k = m.kind === 'reply' ? (m.reply_kind === 'decline' ? 'decline' : 'reply') : m.kind
      const label = m.kind === 'reply' ? (m.reply_kind === 'decline' ? 'decline' : 'reply') : m.status === 'bounced' ? 'bounced' : m.kind
      return `<span class="tag t-${m.status === 'bounced' ? 'bounce' : k}">${esc(label)}</span>`
    }
    const listHtml = list.length
      ? list
          .map((m) => `<a class="msg ${q.id && normId(q.id) === m.message_id ? 'sel' : ''}" href="/sandbox/mail?${address ? `address=${encodeURIComponent(address)}&` : ''}id=${encodeURIComponent(m.message_id)}"><b>${esc(m.subject)}${tag(m)}</b><span>${esc(m.from)} to ${esc(m.to)}<br>${isoUtc(m.visible_at)}</span></a>`)
          .join('')
      : `<div class="empty">No messages${address ? ` for ${esc(address)}` : ''} yet.</div>`
    const sel = q.id ? mail.get(q.id) : undefined
    const read = sel
      ? `<div class="read"><h1>${esc(sel.subject)} ${tag(sel)}</h1><div class="hdr">From <code>${esc(sel.from)}</code><br>To <code>${esc(sel.to)}</code><br>${isoUtc(sel.visible_at)}<br>Message-ID <code>${esc(sel.message_id)}</code>${sel.in_reply_to ? `<br>In reply to <code>${esc(sel.in_reply_to)}</code>` : ''}${sel.bounce_reason ? `<br>Bounce <code>${esc(sel.bounce_reason)}</code>` : ''}</div><pre class="body">${esc(sel.text)}</pre></div>`
      : `<div class="empty">Select a message to read it.<br><br>These mailboxes are fixtures: investor replies arrive after a scaled delay, and nothing is delivered outside the sandbox.</div>`
    reply.type('text/html')
    return shell({ title: 'Sandbox Mail', css: VIEWER_CSS, body: `<div class="mail"><div class="col">${side}</div><div class="col">${listHtml}</div><div class="col" style="border:0">${read}</div></div>` })
  })
  void store
}
