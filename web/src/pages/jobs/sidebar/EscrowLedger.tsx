import type { Escrow } from '../../../api/types'
import { EscrowBar, Receipt, ReceiptRow, ReceiptRule, Stamp, type StampKind } from '../../../components/ui'
import { cents, countdown, dateTime, usd } from '../../../lib/format'
import { awaitingWebhook, payoutFlight } from '../../../lib/ledger'
import { useNow } from './useNow'

const RAIL: Record<string, string> = { simulated: 'Simulated rail (no real money)', paypal_sandbox: 'PayPal sandbox', paypal_live: 'PayPal live' }
const KIND: Record<string, string> = {
  order_created: 'Order created',
  approval_required: 'Approval needed',
  authorized: 'Authorized',
  reauthorized: 'Reauthorized',
  captured: 'Captured',
  voided: 'Voided',
  refunded: 'Refunded',
  payout_sent: 'Payout sent',
  payout_succeeded: 'Payout confirmed',
  payout_failed: 'Payout failed',
  dispute_opened: 'Dispute opened',
  dispute_resolved: 'Dispute resolved',
}
const KIND_TONE: Record<string, string> = { captured: 'text-lime-deep', payout_succeeded: 'text-lime-deep', authorized: 'text-amber-deep', reauthorized: 'text-amber-deep', voided: 'text-coral-deep', payout_failed: 'text-coral-deep', refunded: 'text-pmute' }

function stamps(e: Escrow): { kind: StampKind; label: string; rotate: number }[] {
  const out: { kind: StampKind; label: string; rotate: number }[] = []
  const held = cents(e.authorized.value) - cents(e.captured.value) - cents(e.voided.value) - cents(e.refunded.value)
  switch (e.status) {
    case 'pending_approval':
      out.push({ kind: 'open', label: 'Awaiting approval', rotate: -5 })
      break
    case 'authorized':
      out.push({ kind: 'held', label: 'Held', rotate: -6 })
      break
    case 'partially_captured':
      out.push({ kind: 'captured', label: `Captured ${usd(e.captured)}`, rotate: -5 })
      if (held > 0) out.push({ kind: 'held', label: `Held ${usd(held / 100)}`, rotate: 3 })
      break
    case 'settled':
      out.push({ kind: 'paid', label: 'Settled', rotate: -5 })
      break
    case 'voided':
      out.push({ kind: 'voided', label: 'Voided', rotate: -6 })
      break
    case 'refunded':
      out.push({ kind: 'refunded', label: 'Refunded', rotate: -4 })
      break
  }
  if (cents(e.voided.value) > 0 && e.status !== 'voided') out.push({ kind: 'voided', label: `Voided ${usd(e.voided)}`, rotate: 4 })
  return out
}

const idRow = (label: string, ids: (string | null)[] | string | null) => {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean) as string[]
  if (!list.length) return null
  return (
    <div key={label} className="flex items-baseline justify-between gap-2 text-[0.72rem]">
      <span className="shrink-0 text-pmute">{label}</span>
      <span className="min-w-0 break-all text-right font-medium">{list.join(', ')}</span>
    </div>
  )
}

export function EscrowLedger({ escrow }: { escrow: Escrow }) {
  const now = useNow()
  const total = cents(escrow.authorized.value)
  const held = Math.max(total - cents(escrow.captured.value) - cents(escrow.voided.value) - cents(escrow.refunded.value), 0)
  const st = stamps(escrow)
  // paid_out counts only confirmed payouts: while one is on its way the ledger says so instead of printing $0.00.
  const flight = payoutFlight(escrow.events)
  const paid = cents(escrow.paid_out.value)
  const empty = escrow.status === 'none'
  return (
    <section id="escrow-ledger" aria-labelledby="escrow-h" className="scroll-mt-24 px-1 pb-3 pt-3">
      <h2 id="escrow-h" className="visually-hidden">
        Escrow ledger
      </h2>
      <Receipt title="Escrow ledger" padded>
        <p className="mb-2 text-center text-[0.68rem] uppercase tracking-widest text-pmute">{RAIL[escrow.rail] ?? escrow.rail} · {escrow.mode === 'hold' ? 'hold mode' : 'capture and hold'}</p>

        {!empty && <EscrowBar total={total} captured={cents(escrow.captured.value)} voided={cents(escrow.voided.value)} refunded={cents(escrow.refunded.value)} height={16} className="mb-1" />}
        {!empty && (
          <div className="mb-3 flex flex-wrap gap-x-3 font-mono text-[10.5px] text-pmute">
            <span>
              <i className="mr-1 inline-block size-2 rounded-sm bg-lime align-middle" />captured
            </span>
            <span>
              <i className="mr-1 inline-block size-2 rounded-sm bg-amber align-middle" />held
            </span>
            <span>
              <i className="mr-1 inline-block size-2 rounded-sm bg-coral align-middle" />voided
            </span>
          </div>
        )}

        <ReceiptRule />
        {empty ? (
          <p className="py-2 text-pmute">Nothing authorized yet. Money is held on PayPal only after both sides sign and the buyer funds the job.</p>
        ) : (
          <>
            <ReceiptRow label="Authorized" value={usd(escrow.authorized)} tone="amber" />
            <ReceiptRow label="Captured" value={usd(escrow.captured)} tone={cents(escrow.captured.value) ? 'lime' : 'mute'} />
            <ReceiptRow label="Still held" value={usd(held / 100)} tone={held ? 'amber' : 'mute'} />
            <ReceiptRow label="Voided" value={usd(escrow.voided)} tone={cents(escrow.voided.value) ? 'coral' : 'mute'} />
            <ReceiptRow label="Refunded" value={usd(escrow.refunded)} tone="mute" />
            <ReceiptRule />
            <ReceiptRow label="Platform fee" value={usd(escrow.fees)} tone="mute" />
            {(paid > 0 || flight.inFlightCents === 0) && <ReceiptRow label="Paid out to seller" value={usd(escrow.paid_out)} strong />}
            {flight.inFlightCents > 0 && (
              <div role="status">
                <ReceiptRow label="Payout sending…" value={usd(flight.inFlightCents / 100)} tone="amber" strong={paid === 0} />
              </div>
            )}
          </>
        )}

        {st.length > 0 && (
          <div className="my-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-3" aria-label="Escrow status">
            {st.map((s, i) => (
              <Stamp key={`${escrow.status}-${s.label}`} kind={s.kind} rotate={s.rotate} size="sm" delay={0.15 + i * 0.25}>
                {s.label.toUpperCase()}
              </Stamp>
            ))}
          </div>
        )}

        {(escrow.honor_expires_at || escrow.authorization_expires_at) && held > 0 && (
          <>
            <ReceiptRule />
            {escrow.honor_expires_at && <ReceiptRow label="Honor period ends" value={`${countdown(escrow.honor_expires_at, now)}`} tone="amber" />}
            {escrow.authorization_expires_at && <ReceiptRow label="Authorization expires" value={countdown(escrow.authorization_expires_at, now)} tone="mute" />}
            <p className="mt-1 text-[0.66rem] leading-snug text-pmute">PayPal honors a hold for 3 days; the platform reauthorizes while the job is open, up to 29 days.</p>
          </>
        )}

        {(escrow.paypal.order_id || escrow.paypal.authorization_id || escrow.paypal.capture_ids.length > 0) && (
          <>
            <ReceiptRule />
            <div className="space-y-0.5">
              {idRow('Order', escrow.paypal.order_id)}
              {idRow('Authorization', escrow.paypal.authorization_id)}
              {idRow('Captures', escrow.paypal.capture_ids)}
              {idRow('Refunds', escrow.paypal.refund_ids)}
              {idRow('Payout items', escrow.paypal.payout_item_ids)}
            </div>
          </>
        )}

        {escrow.events.length > 0 && (
          <>
            <ReceiptRule double />
            <p className="mb-1.5 text-[0.66rem] font-bold uppercase tracking-[0.2em] text-pmute">Ledger events</p>
            <ol className="space-y-2.5">
              {escrow.events.map((e, i) => (
                <li key={i} className="text-[0.74rem] leading-snug">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`font-bold ${KIND_TONE[e.kind] ?? ''}`}>{KIND[e.kind] ?? e.kind}</span>
                    <span className="num font-bold">{e.amount ? usd(e.amount) : ''}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.66rem] text-pmute">
                    <span>{dateTime(e.ts)}</span>
                    {e.paypal_id && <span className="break-all">{e.paypal_id}</span>}
                    {e.webhook_event ? (
                      <span className="rounded border border-lime-deep/50 bg-lime-deep/10 px-1.5 py-px font-semibold text-lime-deep" title={e.webhook_event === 'reconciler' ? 'No webhook came in time; the platform asked PayPal directly and PayPal confirmed this step' : 'PayPal webhook that confirmed this step'}>
                        {e.webhook_event}
                      </span>
                    ) : awaitingWebhook(e, escrow.events, flight) ? (
                      <span className="rounded border border-amber-deep/50 bg-amber-deep/10 px-1.5 py-px font-semibold text-amber-deep">awaiting webhook</span>
                    ) : null}
                  </div>
                  {e.note && <p className="mt-0.5 text-[0.68rem] text-pmute">{e.note}</p>}
                </li>
              ))}
            </ol>
          </>
        )}
      </Receipt>
    </section>
  )
}
