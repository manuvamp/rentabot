// Acceptance checks backed by Sandbox Web mail. They replace the `email_delivered` stub.
import type { CheckContext, CheckImpl, CheckLibrary, CheckOutcome } from '../intelligence/types.ts'
import { isEmail, normAddr, type Mail } from './mail.ts'
import type { MailMessage } from './state.ts'

const out = (status: CheckOutcome['status'], detail: string, evidence_id: string | null = null): CheckOutcome => ({ status, detail: detail.slice(0, 1000), evidence_id })

/** Validate unit.meta and find the sent message. Returns an outcome when the unit can't be matched. */
function locate(ctx: CheckContext, mail: Mail): { msg: MailMessage; to: string } | CheckOutcome {
  if (!ctx.unit) return out('error', 'this check runs per delivered unit')
  const meta = ctx.unit.meta
  const id = typeof meta.message_id === 'string' ? meta.message_id.trim() : ''
  const toRaw = typeof meta.to === 'string' ? meta.to : ''
  if (!id) return out('fail', 'unit.meta.message_id is missing')
  if (!toRaw || !isEmail(normAddr(toRaw))) return out('fail', 'unit.meta.to is missing or not an email address')
  const msg = mail.findSent(id)
  if (!msg) return out('fail', `no sent message with id ${id.slice(0, 80)} in Sandbox Mail`)
  const to = normAddr(toRaw)
  if (msg.to !== to) return out('fail', `message ${id} was sent to ${msg.to}, not ${to}`)
  return { msg, to }
}

const isOutcome = (x: unknown): x is CheckOutcome => !!x && typeof x === 'object' && 'status' in x && 'detail' in x

export function registerMailChecks(checks: CheckLibrary, mail: Mail): void {
  const emailDelivered: CheckImpl = {
    def: {
      id: 'email_delivered',
      title: 'Email delivered',
      description:
        'The email identified by unit.meta.message_id exists in Sandbox Mail, was delivered (not bounced), and was sent to unit.meta.to. If unit.meta.from is given it must be the sender of record. Optionally the recipient must be in recipient_domain, and with via "smtp_auth" the message must have been submitted with a mailbox app password (SMTP-style), not through the open test API. The delivery record (sender, how it was submitted, status) is stored as evidence.',
      params: {
        type: 'object',
        properties: {
          recipient_domain: { type: 'string', maxLength: 200, description: 'If set, the recipient address must end with @<domain>.' },
          via: { enum: ['any', 'smtp_auth'], default: 'any', description: '"smtp_auth": the message must have been sent through the sender\'s own mailbox with its app password.' },
        },
        additionalProperties: false,
      },
      per_unit: true,
      delayed: false,
    },
    async run(ctx) {
      const found = locate(ctx, mail)
      if (isOutcome(found)) return found
      const { msg, to } = found
      const domain = String(ctx.test.params.recipient_domain ?? '').toLowerCase().replace(/^@/, '')
      const ev = await ctx.saveEvidence('mail_message', `${msg.message_id} -> ${to}: ${msg.status}`, {
        message_id: msg.message_id,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        sent_at: new Date(msg.sent_at).toISOString(),
        status: msg.status,
        bounce_reason: msg.bounce_reason,
        via: msg.via ?? 'open',
        authenticated_as: msg.via === 'smtp_auth' ? msg.from : null,
      })
      if (msg.status === 'bounced') return out('fail', `bounced: ${msg.bounce_reason ?? 'recipient rejected'}`, ev)
      const claimedFrom = typeof ctx.unit?.meta.from === 'string' ? normAddr(ctx.unit.meta.from) : ''
      if (claimedFrom && claimedFrom !== msg.from) return out('fail', `message ${msg.message_id} was sent from ${msg.from}, not ${claimedFrom}`, ev)
      if (ctx.test.params.via === 'smtp_auth' && msg.via !== 'smtp_auth') return out('fail', `message ${msg.message_id} was not submitted with a mailbox app password (via ${msg.via ?? 'open'})`, ev)
      if (domain && !to.endsWith(`@${domain}`)) return out('fail', `recipient ${to} is not in ${domain}`, ev)
      return out('pass', `delivered to ${to} (${msg.message_id})`, ev)
    },
  }

  const replyReceived: CheckImpl = {
    def: {
      id: 'reply_received',
      title: 'Positive reply received',
      description:
        'A reply to the email (unit.meta.message_id, sent to unit.meta.to) has arrived in Sandbox Mail. With kind "positive" (default) the reply must be positive; "decline" replies fail the check. Pending until a reply arrives, so it is delayed and re-runs through the verify window.',
      params: {
        type: 'object',
        properties: { kind: { enum: ['positive', 'any'], default: 'positive', description: '"positive": only a positive reply passes. "any": any non-bounce reply passes.' } },
        additionalProperties: false,
      },
      per_unit: true,
      delayed: true,
    },
    async run(ctx) {
      const found = locate(ctx, mail)
      if (isOutcome(found)) return found
      const { msg } = found
      const kind = (ctx.test.params.kind as string | undefined) ?? 'positive'
      if (msg.status === 'bounced') return out('fail', `the email bounced (${msg.bounce_reason ?? 'rejected'}); no reply is possible`)
      const replies = mail.repliesTo(msg.message_id).filter((r) => r.kind === 'reply')
      const positive = replies.find((r) => r.reply_kind === 'positive')
      const hit = kind === 'any' ? replies[0] : positive
      if (hit) {
        const ev = await ctx.saveEvidence('mail_reply', `${hit.from} replied (${hit.reply_kind})`, {
          reply_id: hit.message_id,
          from: hit.from,
          in_reply_to: hit.in_reply_to,
          received_at: new Date(hit.visible_at).toISOString(),
          reply_kind: hit.reply_kind,
          excerpt: hit.text.slice(0, 400),
        })
        return out('pass', `${hit.reply_kind} reply from ${hit.from} (${hit.message_id})`, ev)
      }
      const decline = replies.find((r) => r.reply_kind === 'decline')
      if (decline) {
        const ev = await ctx.saveEvidence('mail_reply', `${decline.from} declined`, { reply_id: decline.message_id, from: decline.from, excerpt: decline.text.slice(0, 400) })
        return out('fail', `${decline.from} replied with a decline`, ev)
      }
      return out('pending', `no reply from ${msg.to} yet`)
    },
  }

  checks.register(emailDelivered)
  checks.register(replyReceived)
}
