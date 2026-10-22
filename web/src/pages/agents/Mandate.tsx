import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { ExternalLink, UserCheck } from 'lucide-react'
import { callOp } from '../../api/client'
import { useAction, useAsync } from '../../api/hooks'
import { useSession } from '../../api/session'
import type { CapabilityClass, Mandate as MandateT } from '../../api/types'
import { Button, Chip, Container, ErrorBox, PageHeader, Receipt, ReceiptRow, ReceiptRule, Skeleton, Stamp, type StampKind } from '../../components/ui'
import { CLASS_LABEL, cents, countdown, dateTime, usd } from '../../lib/format'

const CATEGORIES = Object.keys(CLASS_LABEL) as CapabilityClass[]

function goTo(navigate: (p: string) => void, url: string) {
  if (/^https?:\/\//.test(url)) {
    const u = new URL(url)
    if (u.origin === window.location.origin) navigate(u.pathname + u.search)
    else window.location.assign(url)
  } else navigate(url)
}

const STATUS_STAMP: Record<MandateT['status'], { kind: StampKind; label: string }> = {
  active: { kind: 'verified', label: 'Active' },
  pending_approval: { kind: 'held', label: 'Pending' },
  revoked: { kind: 'flagged', label: 'Revoked' },
  expired: { kind: 'voided', label: 'Expired' },
}

function AuthoritySlip({ m, agentName }: { m: MandateT; agentName: string }) {
  const spent = cents(m.spent_this_month.value)
  const cap = Math.max(cents(m.monthly_cap.value), 1)
  const pct = Math.min(100, (spent / cap) * 100)
  const st = STATUS_STAMP[m.status]
  return (
    <div className="relative">
      <Receipt title="Spending authority" tilt={-0.8}>
        <p className="text-center text-[0.68rem] text-pmute">AP2 intent mandate · saved in PayPal Vault</p>
        <ReceiptRule />
        <ReceiptRow label="Agent" value={agentName} />
        <ReceiptRow label="Mandate" value={m.id} />
        <ReceiptRow label="Rail" value={m.rail.replace('_', ' ')} />
        <ReceiptRule />
        <ReceiptRow label="Monthly cap" value={usd(m.monthly_cap)} strong />
        <ReceiptRow label="Per-job cap" value={usd(m.per_job_cap)} strong />
        <div className="mt-3">
          <ReceiptRow label="Spent this month" value={usd(m.spent_this_month)} />
          <div className="mt-1.5 h-3 w-full overflow-hidden rounded-sm border border-pink/40 bg-pink/5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Share of monthly cap spent">
            <div className="h-full bg-lime-deep" style={{ width: `${pct}%` }} />
          </div>
          <ReceiptRow className="mt-1 text-[0.72rem]" tone="mute" label="Left" value={usd(Math.max(cap - spent, 0) / 100)} />
        </div>
        <ReceiptRule />
        <div className="flex flex-wrap gap-1.5" aria-label="Allowed categories">
          {m.categories.map((c) => (
            <span key={c} className="rounded border border-pink/35 px-1.5 py-0.5 text-[0.68rem] uppercase tracking-wider">{CLASS_LABEL[c] ?? c}</span>
          ))}
        </div>
        <ReceiptRule />
        <ReceiptRow label="Expires" value={dateTime(m.expires_at)} />
        <ReceiptRow tone="mute" label="Time left" value={countdown(m.expires_at)} />
        <div className="mt-5 flex justify-end pr-2">
          <Stamp kind={st.kind} size="md" rotate={-7}>{st.label}</Stamp>
        </div>
      </Receipt>
    </div>
  )
}

function RequestForm({ onDone }: { onDone: (approvalUrl: string | null) => void }) {
  const [monthly, setMonthly] = useState('200.00')
  const [perJob, setPerJob] = useState('80.00')
  const [days, setDays] = useState(30)
  const [cats, setCats] = useState<CapabilityClass[]>(['real_world_action', 'reach'])
  const act = useAction(async () => {
    const r = await callOp('request_mandate', { monthly_cap: monthly, per_job_cap: perJob, categories: cats, expires_in_days: days })
    onDone(r.approval_url)
    return r
  })
  const bad = cats.length === 0 || !/^\d{1,7}\.\d{2}$/.test(monthly) || !/^\d{1,7}\.\d{2}$/.test(perJob) || Number(perJob) > Number(monthly)
  const toggle = (c: CapabilityClass) => setCats((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void act.run()
  }
  return (
    <form onSubmit={submit} className="panel space-y-5 p-5 sm:p-6" aria-labelledby="req-h">
      <div>
        <h2 id="req-h" className="font-display text-2xl font-bold">Request a mandate</h2>
        <p className="mt-1 text-sm text-mute">Ask for the smallest limits that cover the work. You approve on PayPal; the agent can never exceed them.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="m-monthly" className="mb-1.5 block text-sm font-medium">Monthly cap (USD)</label>
          <input id="m-monthly" className="field font-mono" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} aria-invalid={!/^\d{1,7}\.\d{2}$/.test(monthly)} />
        </div>
        <div>
          <label htmlFor="m-job" className="mb-1.5 block text-sm font-medium">Per-job cap (USD)</label>
          <input id="m-job" className="field font-mono" inputMode="decimal" value={perJob} onChange={(e) => setPerJob(e.target.value)} aria-invalid={!/^\d{1,7}\.\d{2}$/.test(perJob) || Number(perJob) > Number(monthly)} />
        </div>
        <div>
          <label htmlFor="m-days" className="mb-1.5 block text-sm font-medium">Expires in (days)</label>
          <input id="m-days" type="number" min={1} max={365} className="field font-mono" value={days} onChange={(e) => setDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))} />
        </div>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Categories the agent may buy</legend>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => {
            const on = cats.includes(c)
            return (
              <label key={c} className={`cursor-pointer rounded-full border px-3 py-1.5 text-[13px] transition focus-within:outline focus-within:outline-2 focus-within:outline-hl ${on ? 'border-lime bg-lime/10 text-lime' : 'border-line text-soft hover:border-soft'}`}>
                <input type="checkbox" className="visually-hidden" checked={on} onChange={() => toggle(c)} />
                {CLASS_LABEL[c]}
              </label>
            )
          })}
        </div>
      </fieldset>
      {Number(perJob) > Number(monthly) && <p className="text-sm text-amber">The per-job cap cannot be higher than the monthly cap.</p>}
      <ErrorBox error={act.error} title="Could not request the mandate" />
      <Button type="submit" loading={act.pending} disabled={bad}>Request mandate</Button>
    </form>
  )
}

function ClaimForm({ onClaimed }: { onClaimed: () => void }) {
  const [code, setCode] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const act = useAction(async () => {
    const r = await callOp('claim_agent', { claim_code: code.trim() })
    setDone(r.agent.name)
    setCode('')
    onClaimed()
    return r
  })
  return (
    <form
      className="panel space-y-3 p-5"
      onSubmit={(e) => {
        e.preventDefault()
        setDone(null)
        void act.run()
      }}
    >
      <h2 className="font-display text-xl font-bold">Claim an agent</h2>
      <p className="text-sm text-mute">An agent that registered itself gives you a claim code. Paste it to take ownership. Only then can you approve a mandate for it.</p>
      <label htmlFor="claim-code" className="block text-sm font-medium">Claim code</label>
      <input id="claim-code" className="field font-mono" placeholder="e.g. RAB-7F3K-92QD" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
      <ErrorBox error={act.error} title="Could not claim" />
      {done && (
        <p className="flex items-center gap-2 text-sm text-lime" role="status">
          <UserCheck className="size-4" aria-hidden /> You now own {done}.
        </p>
      )}
      <Button type="submit" variant="ghost" loading={act.pending} disabled={code.trim().length < 6}>Claim agent</Button>
    </form>
  )
}

export default function Mandate() {
  const navigate = useNavigate()
  const { session, actAs, setActAs, refresh } = useSession()
  const me = useAsync(() => callOp('whoami', {}), [actAs])
  const [polling, setPolling] = useState(false)
  const mq = useAsync(() => callOp('get_mandate', {}), [actAs], { pollMs: polling ? 4000 : undefined })
  const mandate = mq.data?.mandate ?? me.data?.mandate ?? null
  const pending = mandate?.status === 'pending_approval'
  if (pending !== polling) setPolling(pending)
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null)
  const approve = approvalUrl ?? (pending ? mandate?.approval_url : null) ?? null
  const agents = session?.agents ?? []
  const agentName = me.data?.agent.name ?? 'Your agent'

  return (
    <Container className="py-12 sm:py-16">
      <PageHeader eyebrow="Agents" title="Spending mandate">
        Your agent spends only inside limits you approve once on PayPal. The money is authorized, never taken, until work is verified.
      </PageHeader>

      <ErrorBox error={me.error} title="Could not load your agent" onRetry={me.reload} className="mb-6" />

      {agents.length > 1 && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-ink-1 px-4 py-3">
          <label htmlFor="act-as" className="text-sm text-soft">Acting as</label>
          <select id="act-as" className="field w-auto min-w-56" value={actAs ?? ''} onChange={(e) => setActAs(e.target.value || null)}>
            <option value="">Default agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,420px)_1fr]">
        <div>
          {mq.loading && !mq.data && !me.data ? (
            <Skeleton className="h-[520px]" />
          ) : mandate ? (
            <AuthoritySlip m={mandate} agentName={agentName} />
          ) : (
            <Receipt title="Spending authority" tilt={-0.8}>
              <ReceiptRule />
              <p className="py-4 text-center text-pmute">No mandate yet.</p>
              <p className="text-center text-[0.72rem] text-pmute">Until one is active, every job needs a separate PayPal approval.</p>
              <ReceiptRule />
              <div className="flex justify-end pr-2 pt-2"><Stamp kind="open" size="sm" rotate={-6}>Not set</Stamp></div>
            </Receipt>
          )}
          {approve && pending && (
            <div className="mt-8 rounded-xl border border-amber/40 bg-amber/10 p-4" role="status">
              <p className="font-semibold text-amber">Waiting for your approval</p>
              <p className="mt-1 text-sm text-soft">Approve on PayPal to save a payment method in the Vault. This page updates by itself.</p>
              <Button className="mt-3" icon={<ExternalLink className="size-4" />} onClick={() => goTo(navigate, approve)}>Approve on PayPal</Button>
            </div>
          )}
          {mandate && (
            <div className="mt-6 flex flex-wrap gap-1.5">
              {mandate.categories.map((c) => (
                <Chip key={c}>{CLASS_LABEL[c] ?? c}</Chip>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          {approvalUrl && !pending && (
            <div className="rounded-xl border border-amber/40 bg-amber/10 p-4" role="status">
              <p className="font-semibold text-amber">Mandate requested</p>
              <Button className="mt-3" icon={<ExternalLink className="size-4" />} onClick={() => goTo(navigate, approvalUrl)}>Approve on PayPal</Button>
            </div>
          )}
          <RequestForm
            onDone={(url) => {
              setApprovalUrl(url)
              mq.reload()
              me.reload()
            }}
          />
          <ClaimForm
            onClaimed={() => {
              void refresh()
              me.reload()
            }}
          />
        </div>
      </div>
    </Container>
  )
}
