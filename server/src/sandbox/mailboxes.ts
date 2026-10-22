// Buyer mailboxes with app passwords, and the SMTP-style send API.
//
// A buyer registers an address (any address outside the sandbox's own domains) and gets an app password once, like the
// ones Gmail and Fastmail issue. From then on:
//   - mail can only be SENT as that address through POST /sandbox/mail/smtp/send with the credentials (username = address),
//     which behaves like SMTP AUTH + MAIL FROM + RCPT TO + DATA (535 on bad credentials, 553 for another sender address);
//     the client picks the Message-ID, as a real mail client does;
//   - the mailbox can only be READ through the API with the same credentials (HTTP Basic), like IMAP.
// Addresses nobody registered stay open catch-all mailboxes, exactly as before. Delivery to the investor personas, their
// delayed replies and bounces are unchanged: Mail.send does all of it.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { MAIL_DOMAIN } from './personas.ts'
import { basicAuth, hashSecret, newAppPassword, token, verifySecret } from './secrets.ts'
import type { Mailbox, Store } from './state.ts'
import type { Mail } from './mail.ts'
import { isEmail, normAddr, normId } from './mail.ts'
import { esc, shell } from './ui.ts'

export interface Mailboxes {
  find(address: string): Mailbox | undefined
  isRegistered(address: string): boolean
  /** Does this password belong to a live app password of the mailbox? */
  authenticate(address: string, password: string): boolean
  register(address: string, label: string): { mailbox: Mailbox; password: string } | { error: string }
  issue(address: string, label: string): string
  revoke(address: string, id: string): boolean
}

const RESERVED_SUFFIXES = [MAIL_DOMAIN, 'dirs.sandbox', 'saas.sandbox', 'apps.sandbox']
const reservedDomain = (d: string) => RESERVED_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`))

export function createMailboxes(store: Store, clock: () => number): Mailboxes {
  const find = (address: string) => store.data.mailboxes.find((m) => m.address === normAddr(address))
  const issueFor = (box: Mailbox, label: string): string => {
    const password = newAppPassword()
    box.passwords.push({ id: `ap_${token(4)}`, label: label.slice(0, 60) || 'app password', ...hashSecret(password), created_at: clock(), revoked_at: null })
    store.save()
    return password
  }
  return {
    find,
    isRegistered: (a) => !!find(a),
    authenticate(address, password) {
      const box = find(address)
      return !!box && box.passwords.some((p) => !p.revoked_at && verifySecret(password, p.salt, p.hash))
    },
    register(address, label) {
      const a = normAddr(address)
      if (!isEmail(a)) return { error: 'address must be an email address' }
      if (reservedDomain(a.split('@')[1] ?? '')) return { error: `${a.split('@')[1]} is a Sandbox Web domain; register an address on your own domain` }
      if (find(a)) return { error: 'mailbox_exists' }
      const mailbox: Mailbox = { address: a, label: label.slice(0, 80) || 'mailbox', created_at: clock(), passwords: [] }
      store.data.mailboxes.push(mailbox)
      const password = issueFor(mailbox, 'first app password')
      return { mailbox, password }
    },
    issue(address, label) {
      return issueFor(find(address)!, label)
    },
    revoke(address, id) {
      const p = find(address)?.passwords.find((x) => x.id === id && !x.revoked_at)
      if (!p) return false
      p.revoked_at = clock()
      store.save()
      return true
    },
  }
}

const MSG_ID = /^<?[A-Za-z0-9._%+!#$&'*/=?^`{|}~-]{1,120}@[A-Za-z0-9.-]{1,120}>?$/
const iso = (ms: number) => new Date(ms).toISOString()

export function registerMailboxRoutes(sb: FastifyInstance, ctx: { mail: Mail; mailboxes: Mailboxes; store: Store; clock: () => number; publicUrl: string }): void {
  const { mail, mailboxes, clock } = ctx
  const base = ctx.publicUrl.replace(/\/+$/, '')
  const sendUrl = `${base}/sandbox/mail/smtp/send`
  const readUrl = `${base}/sandbox/mail/messages`
  const html = (reply: FastifyReply, code: number, body: string) => reply.code(code).type('text/html').send(body)

  const details = (address: string, password: string) => ({
    address,
    app_password: password,
    note: 'Shown once. Put it in the job locker (login: username = this address, password = this app password); never in a message or an input.',
    smtp: { send_endpoint: sendUrl, auth: 'username = address, password = app password (JSON body fields username/password, or HTTP Basic)', mail_from: address },
    imap: { read_endpoint: `${readUrl}?address=${encodeURIComponent(address)}`, auth: 'HTTP Basic, username = address, password = app password' },
  })

  sb.post('/mail/mailboxes', async (req, reply) => {
    const form = String(req.headers['content-type'] ?? '').includes('x-www-form-urlencoded')
    const b = (req.body ?? {}) as Record<string, unknown>
    const address = typeof b.address === 'string' ? b.address : ''
    const label = typeof b.label === 'string' ? b.label : ''
    const r = mailboxes.register(address, label)
    if ('error' in r) {
      const code = r.error === 'mailbox_exists' ? 409 : 400
      if (form) return html(reply, code, shell({ title: 'Mailbox', body: `<div class="wrap"><h1>Could not create the mailbox</h1><p>${esc(r.error === 'mailbox_exists' ? 'That address already has a Sandbox Web mailbox.' : r.error)}</p><p><a href="/sandbox/mail/mailboxes">Back</a></p></div>` }))
      return reply.code(code).send({ error: r.error === 'mailbox_exists' ? 'mailbox_exists' : 'invalid_request', message: r.error === 'mailbox_exists' ? 'That address already has a mailbox.' : r.error })
    }
    const d = details(r.mailbox.address, r.password)
    if (form)
      return html(reply, 201, shell({
        title: 'Mailbox created',
        css: '.wrap{max-width:720px}code{background:#eceff3;padding:2px 8px;border-radius:4px}.pw{font:700 22px ui-monospace,Consolas,monospace;letter-spacing:.04em;background:#fff7e0;border:1px solid #ecd88b;border-radius:8px;padding:12px 16px;display:inline-block}',
        body: `<div class="wrap"><h1>Mailbox ready</h1><p>Address <code>${esc(d.address)}</code></p><p>Your app password, shown once:</p><p class="pw" id="pw">${esc(d.app_password)}</p><p>${esc(d.note)}</p><p>Send API: <code>${esc(sendUrl)}</code></p><p><a href="/sandbox/mail?address=${encodeURIComponent(d.address)}">Open the mailbox in the viewer</a></p></div>`,
      }))
    return reply.code(201).send(d)
  })

  sb.get('/mail/mailboxes', async (_req, reply) =>
    html(reply, 200, shell({
      title: 'Sandbox mailboxes',
      css: '.wrap{max-width:640px}label{display:block;font-weight:650;margin:14px 0 4px}input{width:100%;padding:9px 10px;border:1px solid #c9ced6;border-radius:6px;font:inherit}button{margin-top:16px;font:inherit;padding:9px 18px;border-radius:6px;border:0;background:#14161b;color:#fff;cursor:pointer}code{background:#eceff3;padding:1px 6px;border-radius:4px}',
      body: `<div class="wrap"><h1>Create a mailbox</h1><p>A Sandbox Web mailbox issues an <b>app password</b>. A bot that holds it can send from this address (<code>POST /sandbox/mail/smtp/send</code>) and read the mailbox, and nobody else can. Give it to the bot only through the job's locker.</p>
<form method="post" action="/sandbox/mail/mailboxes"><label for="address">Address</label><input id="address" name="address" type="email" placeholder="you@yourcompany.com" required><label for="label">Label (optional)</label><input id="label" name="label" placeholder="Outreach inbox"><button type="submit">Create mailbox and app password</button></form>
<p style="margin-top:28px;font-size:13px;color:#59626f">Addresses on <code>${esc(MAIL_DOMAIN)}</code>, <code>dirs.sandbox</code>, <code>saas.sandbox</code> and <code>apps.sandbox</code> belong to the sandbox itself.</p></div>`,
    })))

  /** Credentials from the JSON body or HTTP Basic. */
  const creds = (req: { headers: Record<string, unknown>; body?: unknown }): { user: string; password: string } | null => {
    const fromHeader = basicAuth(req.headers.authorization)
    if (fromHeader) return { user: normAddr(fromHeader.user), password: fromHeader.password }
    const b = (req.body ?? {}) as Record<string, unknown>
    return typeof b.username === 'string' && typeof b.password === 'string' ? { user: normAddr(b.username), password: b.password } : null
  }
  const deny = (reply: FastifyReply) => reply.code(401).header('www-authenticate', 'Basic realm="Sandbox Web mailbox"').send({ error: 'auth_failed', smtp: { code: 535, response: '535 5.7.8 Username and Password not accepted' }, message: 'The address or app password is wrong, or the app password was revoked.' })

  // SMTP-style submission: AUTH (535) -> MAIL FROM (553) -> RCPT TO / DATA -> 250 with the Message-ID.
  sb.post('/mail/smtp/send', async (req, reply) => {
    const c = creds(req as never)
    if (!c || !mailboxes.authenticate(c.user, c.password)) return deny(reply)
    const b = (req.body ?? {}) as Record<string, unknown>
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '')
    const errors: Record<string, string> = {}
    const to = normAddr(s('rcpt_to') || s('to'))
    if (b.mail_from !== undefined && normAddr(String(b.mail_from)) !== c.user)
      return reply.code(403).send({ error: 'sender_not_allowed', smtp: { code: 553, response: `553 5.7.1 Sender address rejected: not owned by user ${c.user}` }, message: 'You can only send as the authenticated mailbox.' })
    if (!isEmail(to)) errors.to = 'a valid recipient address is required'
    if (!s('subject') || s('subject').length > 300) errors.subject = 'subject is required (max 300 chars)'
    if (!s('text') || s('text').length > 20_000) errors.text = 'text is required (max 20000 chars)'
    const wanted = s('message_id')
    if (wanted && !MSG_ID.test(wanted)) errors.message_id = 'message_id must look like <local@domain>'
    if (Object.keys(errors).length) return reply.code(400).send({ error: 'invalid_request', smtp: { code: 501, response: '501 5.5.4 Syntax error in parameters' }, errors })
    if (wanted) {
      const again = mail.findSent(wanted)
      if (again) {
        // The same submission repeated (a client retry): answer with the original delivery, send nothing twice.
        if (again.from === c.user && again.to === to) return reply.code(200).send(record(again, true))
        return reply.code(409).send({ error: 'duplicate_message_id', smtp: { code: 554, response: '554 5.6.0 Message-ID already used' }, message: 'That Message-ID belongs to another message.' })
      }
    }
    const m = mail.send({ from: c.user, to, subject: s('subject'), text: s('text'), ...(wanted ? { message_id: wanted } : {}), via: 'smtp_auth' })
    return reply.code(201).send(record(m, false))
  })

  const record = (m: { message_id: string; status: string; to: string; from: string; sent_at: number; bounce_reason: string | null; via?: string }, replayed: boolean) => ({
    ok: true,
    replayed,
    smtp: { code: 250, response: `250 2.0.0 OK queued as ${m.message_id}` },
    message_id: m.message_id,
    status: m.status,
    from: m.from,
    to: m.to,
    sent_at: iso(m.sent_at),
    bounce_reason: m.bounce_reason,
    via: m.via ?? 'open',
    authenticated_as: m.via === 'smtp_auth' ? m.from : null,
    delivery_record: `/sandbox/mail/message/${encodeURIComponent(m.message_id)}`,
  })

  const authed = (req: { headers: Record<string, unknown> }, address: string) => {
    const c = basicAuth(req.headers.authorization)
    return !!c && normAddr(c.user) === normAddr(address) && mailboxes.authenticate(c.user, c.password)
  }

  sb.get('/mail/mailboxes/:address', async (req, reply) => {
    const address = normAddr((req.params as { address: string }).address)
    if (!authed(req, address)) return deny(reply)
    const box = mailboxes.find(address)!
    return { address: box.address, label: box.label, created_at: iso(box.created_at), app_passwords: box.passwords.map((p) => ({ id: p.id, label: p.label, created_at: iso(p.created_at), revoked_at: p.revoked_at ? iso(p.revoked_at) : null })), now: iso(clock()) }
  })

  sb.post('/mail/mailboxes/:address/app-passwords', async (req, reply) => {
    const address = normAddr((req.params as { address: string }).address)
    if (!authed(req, address)) return deny(reply)
    const label = typeof (req.body as { label?: unknown } | null)?.label === 'string' ? (req.body as { label: string }).label : 'app password'
    return reply.code(201).send(details(address, mailboxes.issue(address, label)))
  })

  sb.delete('/mail/mailboxes/:address/app-passwords/:id', async (req, reply) => {
    const { address: raw, id } = req.params as { address: string; id: string }
    const address = normAddr(raw)
    if (!authed(req, address)) return deny(reply)
    return mailboxes.revoke(address, id) ? { ok: true } : reply.code(404).send({ error: 'not_found' })
  })

  void normId
}
