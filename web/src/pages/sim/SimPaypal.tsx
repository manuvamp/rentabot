import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { apiGet, apiPost, ApiError } from '../../api/client'
import { useAsync } from '../../api/hooks'

interface SimInfo {
  kind: string
  id: string
  title?: string
  amount?: string
  currency?: string
  job_id?: string
  lines?: { label: string; value: string }[]
  return_to?: string
}

// Deliberately plain and off-brand: this page stands in for a payment provider's own screen.
const FONT = { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' }

export default function SimPaypal() {
  const { kind = '', id = '' } = useParams()
  const navigate = useNavigate()
  const info = useAsync(() => apiGet<SimInfo>(`/api/sim/paypal/${kind}/${id}`).catch(() => null), [kind, id])
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  const [err, setErr] = useState<{ message: string; hint: string } | null>(null)

  const isMandate = kind === 'mandate' || kind === 'vault'
  const d = info.data

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'decline')
    setErr(null)
    try {
      const r = await apiPost<{ redirect?: string }>('/api/sim/paypal/approve', { kind, id, approve })
      const to = r.redirect ?? d?.return_to ?? '/jobs'
      if (/^https?:\/\//.test(to)) {
        const u = new URL(to)
        if (u.origin === window.location.origin) navigate(u.pathname + u.search + u.hash)
        else window.location.assign(to)
      } else navigate(to)
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : 'Something went wrong.', hint: e instanceof ApiError ? e.hint : '' })
      setBusy(null)
    }
  }

  return (
    <div className="min-h-dvh bg-[#e9edf2] text-[#1c2430]" style={FONT}>
      <div role="note" className="sticky top-0 z-10 border-b-2 border-dashed border-[#b45309] bg-[#fff4d6] px-4 py-2.5 text-center text-[14px] font-semibold text-[#6b3a00]">
        Simulated PayPal &mdash; no real money. This screen only exists because the server runs the simulated payment rail.
      </div>

      <main className="mx-auto flex max-w-[460px] flex-col px-4 py-10 sm:py-16">
        <div className="mb-5 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#5b6677]">Simulated approval screen</p>
          <p className="mt-1 text-[13px] text-[#5b6677]">Stand-in for the payment provider&rsquo;s own page</p>
        </div>

        <div className="rounded-lg border border-[#c7cfda] bg-white p-6 shadow-sm">
          {info.loading && !d ? (
            <p className="py-8 text-center text-sm text-[#5b6677]" role="status">Loading…</p>
          ) : (
            <>
              <h1 className="text-[22px] font-semibold leading-snug">{d?.title ?? (isMandate ? 'Approve a spending mandate' : 'Approve an escrow authorization')}</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-[#46505f]">
                {isMandate
                  ? 'The agent may fund jobs by itself, inside the limits below, without asking you each time. You can revoke it at any time.'
                  : 'The amount is authorized and held on your account. It is not taken. Only the part the checks prove is captured; the rest is voided.'}
              </p>

              <dl className="mt-5 divide-y divide-[#e1e6ee] rounded-md border border-[#e1e6ee] text-[14px]">
                {d?.amount && (
                  <div className="flex items-baseline justify-between bg-[#f6f8fb] px-3.5 py-3">
                    <dt className="text-[#46505f]">{isMandate ? 'Monthly cap' : 'Authorize'}</dt>
                    <dd className="text-xl font-semibold tabular-nums">${Number(d.amount).toFixed(2)} <span className="text-xs font-normal text-[#5b6677]">{d.currency ?? 'USD'}</span></dd>
                  </div>
                )}
                {(d?.lines ?? []).map((l) => (
                  <div key={l.label} className="flex items-baseline justify-between gap-4 px-3.5 py-2.5">
                    <dt className="text-[#46505f]">{l.label}</dt>
                    <dd className="text-right font-medium">{l.value}</dd>
                  </div>
                ))}
                {!d && (
                  <>
                    <div className="flex justify-between px-3.5 py-2.5"><dt className="text-[#46505f]">Type</dt><dd className="font-medium">{isMandate ? 'Spending mandate' : 'Escrow authorization'}</dd></div>
                    <div className="flex justify-between gap-4 px-3.5 py-2.5"><dt className="text-[#46505f]">Reference</dt><dd className="break-all font-mono text-[13px]">{id}</dd></div>
                  </>
                )}
                {!isMandate && (
                  <div className="flex justify-between px-3.5 py-2.5"><dt className="text-[#46505f]">Payee</dt><dd className="font-medium">Rent-A-Bot escrow</dd></div>
                )}
              </dl>

              {err && (
                <div role="alert" className="mt-4 rounded-md border border-[#d9534f] bg-[#fdecea] px-3 py-2.5 text-[14px] text-[#7a1f1a]">
                  <p className="font-semibold">{err.message}</p>
                  {err.hint && <p className="mt-0.5">{err.hint}</p>}
                </div>
              )}

              <div className="mt-6 grid grid-cols-2 gap-3">
                <button
                  onClick={() => void decide(false)}
                  disabled={busy !== null}
                  className="h-11 rounded-md border border-[#9aa6b6] bg-white text-[15px] font-semibold text-[#1c2430] hover:bg-[#f0f3f7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1c2430] disabled:opacity-50"
                >
                  {busy === 'decline' ? 'Declining…' : 'Decline'}
                </button>
                <button
                  onClick={() => void decide(true)}
                  disabled={busy !== null}
                  className="h-11 rounded-md bg-[#2f4a6b] text-[15px] font-semibold text-white hover:bg-[#263d58] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1c2430] disabled:opacity-50"
                >
                  {busy === 'approve' ? 'Approving…' : 'Approve (simulated)'}
                </button>
              </div>
            </>
          )}
        </div>

        <p className="mt-5 text-center text-[12.5px] leading-relaxed text-[#5b6677]">
          No card, bank account or PayPal login is involved. Approving here only tells the Rent-A-Bot server to behave as if a buyer approved on PayPal.
        </p>
      </main>
    </div>
  )
}
