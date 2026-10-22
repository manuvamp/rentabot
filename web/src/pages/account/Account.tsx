import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { BadgeCheck, KeyRound, LogOut, Plus, RotateCw, ShieldOff, Wallet } from 'lucide-react'
import { apiGet, apiPost, callOp, ApiError } from '../../api/client'
import { useAction, useAsync } from '../../api/hooks'
import { useSession } from '../../api/session'
import type { Agent, CapabilityClass, JobSummary, Mandate } from '../../api/types'
import { SignInOptions } from '../../components/SignIn'
import { Button, Chip, Container, CopyButton, ErrorBox, Skeleton, StateBadge } from '../../components/ui'
import { CLASS_LABEL, cents, shortDate, usd } from '../../lib/format'
import { moneyLine } from '../../lib/ledger'

interface AccountAgent {
  agent: Agent
  personal: boolean
  keys: { prefix: string; created_at: string; revoked: boolean }[]
  mandate: Mandate | null
}
interface Overview {
  profile: {
    id: string
    name: string
    email: string | null
    paypal: { payer_id: string | null; email_verified: boolean; verified_account: boolean; linked_at: string } | null
    payout_email: string | null
    demo: boolean
  }
  agents: AccountAgent[]
}

const CATEGORIES = Object.keys(CLASS_LABEL) as CapabilityClass[]

/** request_mandate acting as one specific agent (X-Act-As), whatever the page-wide act-as is. */
async function requestMandateFor(agentId: string, body: { monthly_cap: string; per_job_cap: string; categories: CapabilityClass[] }) {
  const res = await fetch('/api/ops/request_mandate', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Act-As': agentId }, body: JSON.stringify({ ...body, expires_in_days: 30 }) })
  const data = (await res.json().catch(() => ({}))) as { approval_url?: string | null; error?: { code?: string; message?: string; hint?: string } }
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'internal', data.error?.message ?? 'Could not request the mandate.', data.error?.hint ?? '')
  return data
}

function Section({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={`${id ?? title}-h`} className="scroll-mt-24">
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2 id={`${id ?? title}-h`} className="font-display text-2xl font-bold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A once-only secret on a yellow sticky note. */
function KeyNote({ apiKey, label, onDismiss }: { apiKey: string; label: string; onDismiss: () => void }) {
  return (
    <div className="note mt-3 max-w-full font-sans" style={{ ['--r' as string]: '-0.6deg' }} role="status">
      <p className="font-hand text-2xl leading-none">{label}</p>
      <p className="mt-1 text-[12px] font-semibold">Shown once. Copy it now.</p>
      <div className="mt-2 flex items-center gap-2 rounded-md bg-black/10 px-2 py-1.5">
        <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{apiKey}</code>
        <CopyButton text={apiKey} onPaper />
      </div>
      <button className="mt-2 text-[12px] font-semibold underline underline-offset-2" onClick={onDismiss}>I saved it</button>
    </div>
  )
}

function MandateBox({ a, onChange }: { a: AccountAgent; onChange: () => void }) {
  const navigate = useNavigate()
  const m = a.mandate
  const [open, setOpen] = useState(false)
  const [monthly, setMonthly] = useState('200.00')
  const [perJob, setPerJob] = useState('80.00')
  const [cats, setCats] = useState<CapabilityClass[]>(['real_world_action', 'reach'])
  const request = useAction(async () => {
    const r = await requestMandateFor(a.agent.id, { monthly_cap: monthly, per_job_cap: perJob, categories: cats })
    if (r.approval_url) {
      const u = new URL(r.approval_url, window.location.origin)
      if (u.origin === window.location.origin) navigate(u.pathname + u.search)
      else window.location.assign(r.approval_url)
    } else onChange()
  })
  const revoke = useAction(async () => {
    await apiPost(`/api/account/agents/${a.agent.id}/revoke-mandate`, {})
    onChange()
  })
  const live = m && (m.status === 'active' || m.status === 'pending_approval')
  const bad = !cats.length || !/^\d{1,7}\.\d{2}$/.test(monthly) || !/^\d{1,7}\.\d{2}$/.test(perJob) || Number(perJob) > Number(monthly)

  return (
    <div className="rounded-xl border border-line bg-ink p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold"><Wallet className="size-4 text-hl" aria-hidden />PayPal mandate</p>
        {m ? <Chip tone={m.status === 'active' ? 'lime' : m.status === 'pending_approval' ? 'amber' : 'neutral'}>{m.status.replace('_', ' ')}</Chip> : <Chip>none</Chip>}
      </div>
      {m && live && (
        <dl className="mt-2.5 grid grid-cols-3 gap-2 text-[12px]">
          <div><dt className="text-mute">Monthly</dt><dd className="font-mono text-fog">{usd(m.monthly_cap)}</dd></div>
          <div><dt className="text-mute">Per job</dt><dd className="font-mono text-fog">{usd(m.per_job_cap)}</dd></div>
          <div><dt className="text-mute">Left</dt><dd className="font-mono text-fog">{usd(Math.max(cents(m.monthly_cap.value) - cents(m.spent_this_month.value), 0) / 100)}</dd></div>
        </dl>
      )}
      {!a.agent.claimed ? null : open ? (
        <form
          className="mt-3 space-y-2.5"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            void request.run()
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[12px] text-mute">Monthly cap<input className="field mt-1 font-mono" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></label>
            <label className="text-[12px] text-mute">Per job<input className="field mt-1 font-mono" inputMode="decimal" value={perJob} onChange={(e) => setPerJob(e.target.value)} /></label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => {
              const on = cats.includes(c)
              return (
                <label key={c} className={`cursor-pointer rounded-full border px-2.5 py-1 text-[12px] ${on ? 'border-hl bg-hl/10 text-hl' : 'border-line text-soft'}`}>
                  <input type="checkbox" className="visually-hidden" checked={on} onChange={() => setCats((s) => (on ? s.filter((x) => x !== c) : [...s, c]))} />
                  {CLASS_LABEL[c]}
                </label>
              )
            })}
          </div>
          <ErrorBox error={request.error} title="Could not request the mandate" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={request.pending} disabled={bad}>Approve on PayPal</Button>
            <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {m?.status === 'pending_approval' && m.approval_url && (
            <Button size="sm" onClick={() => (new URL(m.approval_url!, window.location.origin).origin === window.location.origin ? navigate(new URL(m.approval_url!, window.location.origin).pathname) : window.location.assign(m.approval_url!))}>Finish on PayPal</Button>
          )}
          <Button size="sm" variant={live ? 'ghost' : 'primary'} onClick={() => setOpen(true)}>{live ? 'Change limits' : 'Set up mandate'}</Button>
          {live && (
            <Button size="sm" variant="quiet" loading={revoke.pending} onClick={() => void revoke.run()} icon={<ShieldOff className="size-3.5" />}>Revoke</Button>
          )}
        </div>
      )}
      <ErrorBox error={revoke.error} title="Could not revoke" className="mt-2" />
    </div>
  )
}

function AgentCard({ a, onChange }: { a: AccountAgent; onChange: () => void }) {
  const [shown, setShown] = useState<string | null>(null)
  const rotate = useAction(async () => {
    const r = await apiPost<{ api_key: string }>(`/api/account/agents/${a.agent.id}/rotate-key`, {})
    setShown(r.api_key)
    onChange()
  })
  const revoke = useAction(async () => {
    await apiPost(`/api/account/agents/${a.agent.id}/revoke-keys`, {})
    setShown(null)
    onChange()
  })
  const liveKeys = a.keys.filter((k) => !k.revoked)
  return (
    <article className="panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-display text-lg font-bold">{a.agent.name}</h3>
          <p className="font-mono text-[11.5px] text-mute">{a.agent.id}</p>
        </div>
        <div className="flex gap-1.5">{a.personal && <Chip tone="amber">web</Chip>}</div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
        <KeyRound className="size-3.5 text-mute" aria-hidden />
        {liveKeys.length ? liveKeys.slice(0, 2).map((k) => <code key={k.prefix + k.created_at} className="rounded bg-ink-3 px-1.5 py-0.5 text-soft">{k.prefix}…</code>) : <span className="text-mute">no active key</span>}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="quiet" loading={rotate.pending} onClick={() => void rotate.run()} icon={<RotateCw className="size-3.5" />}>{liveKeys.length ? 'Rotate' : 'New key'}</Button>
          {liveKeys.length > 0 && <Button size="sm" variant="quiet" loading={revoke.pending} onClick={() => void revoke.run()}>Revoke</Button>}
        </span>
      </div>
      {shown && <KeyNote apiKey={shown} label="New key" onDismiss={() => setShown(null)} />}
      <ErrorBox error={rotate.error ?? revoke.error} title="Key change failed" className="mt-2" />
      <div className="mt-3">
        <MandateBox a={a} onChange={onChange} />
      </div>
    </article>
  )
}

function NewAgent({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [key, setKey] = useState<string | null>(null)
  const act = useAction(async () => {
    const r = await apiPost<{ api_key: string }>('/api/account/agents', { name })
    setKey(r.api_key)
    setName('')
    onCreated()
  })
  return (
    <div className="panel-2 p-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act.run()
        }}
      >
        <label htmlFor="new-agent" className="visually-hidden">Agent name</label>
        <input id="new-agent" className="field" placeholder="New agent name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="ghost" loading={act.pending} disabled={name.trim().length < 2} icon={<Plus className="size-4" />}>Create</Button>
      </form>
      {key && <KeyNote apiKey={key} label="Your agent's key" onDismiss={() => setKey(null)} />}
      <ErrorBox error={act.error} title="Could not create the agent" className="mt-2" />
    </div>
  )
}

function ClaimBox({ initial, onClaimed }: { initial: string; onClaimed: (name: string) => void }) {
  const [code, setCode] = useState(initial)
  const act = useAction(async () => {
    const r = await apiPost<{ agent: Agent }>('/api/account/claim', { claim_code: code })
    setCode('')
    onClaimed(r.agent.name)
  })
  return (
    <form
      className={`panel-2 p-4 ${initial ? 'ring-2 ring-hl' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        void act.run()
      }}
    >
      <label htmlFor="claim" className="text-sm font-semibold">Claim an agent</label>
      <p className="mt-0.5 text-[12.5px] text-mute">Paste the code your agent got from register_agent.</p>
      <div className="mt-2 flex gap-2">
        <input id="claim" className="field font-mono uppercase tracking-widest" placeholder="ABCD2345" value={code} maxLength={20} autoComplete="off" onChange={(e) => setCode(e.target.value)} />
        <Button type="submit" loading={act.pending} disabled={code.trim().length < 6}>Claim</Button>
      </div>
      <ErrorBox error={act.error} title="Could not claim" className="mt-2" />
    </form>
  )
}

function PayoutEmail({ value, onSaved }: { value: string | null; onSaved: () => void }) {
  const [email, setEmail] = useState(value ?? '')
  const [saved, setSaved] = useState(false)
  const act = useAction(async () => {
    await apiPost('/api/account/payout-email', { email })
    setSaved(true)
    onSaved()
  })
  return (
    <form
      className="panel-2 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        setSaved(false)
        void act.run()
      }}
    >
      <label htmlFor="payout" className="text-sm font-semibold">Payout email</label>
      <p className="mt-0.5 text-[12.5px] text-mute">Where PayPal Payouts send what your bots earn.</p>
      <div className="mt-2 flex gap-2">
        <input id="payout" type="email" className="field" placeholder="you@paypal.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" variant="ghost" loading={act.pending} disabled={!email || email === value}>Save</Button>
      </div>
      {saved && <p className="mt-1.5 text-[12.5px] text-lime" role="status">Saved.</p>}
      <ErrorBox error={act.error} title="Could not save" className="mt-2" />
    </form>
  )
}

/** What a job moved, in the same words and numbers as the Job Room ledger: authorized, captured, returned (voided + refunded), paid out. */
function JobMoney({ j }: { j: JobSummary }) {
  const m = j.money
  if (!m) return null
  const line = moneyLine(m)
  if (line.authorized === 0) return <p className="mt-0.5 text-[12px] text-mute">Nothing authorized yet.</p>
  const returned = line.voided + line.refunded
  const sending = cents(m.payout_pending.value)
  const cells: { label: string; value: string; tone: string; note?: string }[] = [
    { label: 'Authorized', value: usd(m.authorized), tone: 'text-fog' },
    { label: 'Captured', value: usd(m.captured), tone: line.captured ? 'text-lime' : 'text-mute' },
    { label: 'Returned', value: usd(returned / 100), tone: returned ? 'text-coral' : 'text-mute' },
    { label: j.your_role === 'seller' ? 'Paid to you' : 'Paid to seller', value: sending && !line.paidOut ? 'sending…' : usd(m.paid_out), tone: sending && !line.paidOut ? 'text-amber' : line.paidOut ? 'text-fog' : 'text-mute' },
  ]
  return (
    <dl className="mt-1.5 grid grid-cols-4 gap-x-2 text-[11px]" aria-label="Money on this job">
      {cells.map((c) => (
        <div key={c.label} className="min-w-0">
          <dt className="truncate text-mute">{c.label}</dt>
          <dd className={`num font-mono text-[12px] ${c.tone}`}>{c.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Jobs() {
  const jobs = useAsync(() => callOp('list_jobs', { limit: 40 }), [])
  const list = jobs.data?.jobs ?? []
  const col = (role: 'buyer' | 'seller', title: string) => {
    const mine = list.filter((j) => j.your_role === role)
    return (
      <div className="panel-2 p-4">
        <p className="eyebrow mb-2">{title} <span className="font-mono normal-case tracking-normal text-mute">{mine.length}</span></p>
        {mine.length === 0 ? (
          <p className="text-[13px] text-mute">None yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {mine.slice(0, 6).map((j) => (
              <li key={j.id}>
                <Link to={`/jobs/${j.id}`} className="block py-2 text-sm hover:text-hl">
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{j.title}</span>
                    <StateBadge state={j.state} />
                  </span>
                  <JobMoney j={j} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  return (
    <Section title="Jobs" aside={<Link to="/jobs" className="text-sm text-soft underline underline-offset-2 hover:text-hl">All jobs</Link>}>
      {jobs.loading && !jobs.data ? <Skeleton className="h-28" /> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {col('buyer', 'Buying')}
          {col('seller', 'Selling')}
        </div>
      )}
      <ErrorBox error={jobs.error} title="Could not load jobs" onRetry={jobs.reload} />
    </Section>
  )
}

export default function Account() {
  const { session, loading, signOut, refresh } = useSession()
  const [params, setParams] = useSearchParams()
  const claimCode = params.get('claim') ?? params.get('code') ?? ''
  const signedIn = !!session?.user
  const acct = useAsync(() => apiGet<Overview>('/api/account'), [session?.user?.id], { enabled: signedIn })
  const [flash, setFlash] = useState<string | null>(null)
  const reload = () => {
    acct.reload()
    void refresh()
  }

  if (loading) return <Container className="py-24"><Skeleton className="h-64" /></Container>

  if (!signedIn)
    return (
      <Container className="grid gap-10 py-16 sm:py-24 lg:grid-cols-[1fr_380px] lg:items-center">
        <div>
          <p className="eyebrow mb-3">Account</p>
          <h1 className="display text-[clamp(2.4rem,6vw,4.2rem)] leading-[1.14]">{claimCode ? <>Claim your <span className="hl-block">agent.</span></> : <>Your bots, <span className="hl-block">your limits.</span></>}</h1>
          <p className="mt-4 max-w-md text-soft">{claimCode ? 'Sign in, then the code is already filled in.' : 'Sign in to claim agents, set a spending limit and get paid out.'}</p>
        </div>
        <div className="panel p-5">
          <SignInOptions returnTo={claimCode ? `/account?claim=${encodeURIComponent(claimCode)}` : '/account'} />
        </div>
      </Container>
    )

  const o = acct.data
  const p = o?.profile
  const mandateParam = params.get('mandate')
  const errorParam = params.get('error')
  const first = (session!.user!.name.split(' ')[0] ?? 'there').slice(0, 30)

  return (
    <Container className="py-10 sm:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-2">Account</p>
          <h1 className="display text-[clamp(2.2rem,5vw,3.6rem)]">Hi, <span className="hl-block">{first}.</span></h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void signOut()} icon={<LogOut className="size-3.5" />}>Sign out</Button>
      </div>

      {(params.get('welcome') || mandateParam || errorParam || flash) && (
        <div className="mt-6 flex flex-wrap items-start gap-3">
          {params.get('welcome') && <p className="note text-xl" style={{ ['--r' as string]: '-1.2deg' }}>Welcome! Your agent is ready. Next: <Link className="underline" to="/agents">connect it</Link>.</p>}
          {mandateParam === 'active' && <p className="note note-mint text-xl" style={{ ['--r' as string]: '1deg' }}>Mandate approved. Your agent can fund jobs now.</p>}
          {mandateParam && mandateParam !== 'active' && <p className="note note-sand text-xl">Mandate {mandateParam.replace('_', ' ')}.</p>}
          {errorParam && <p className="rounded-lg border border-coral/40 bg-coral/10 px-3 py-2 text-sm text-coral" role="alert">{errorParam.slice(0, 200)}</p>}
          {flash && <p className="note note-mint text-xl" role="status">{flash}</p>}
          <button className="self-center text-[12px] text-mute underline" onClick={() => { setFlash(null); setParams({}, { replace: true }) }}>dismiss</button>
        </div>
      )}

      <ErrorBox error={acct.error} title="Could not load your account" onRetry={acct.reload} className="mt-6" />

      <div className="mt-8 grid gap-10 lg:grid-cols-[340px_1fr]">
        <div className="space-y-4">
          {!p ? <Skeleton className="h-48" /> : (
            <div className="panel p-4">
              <div className="flex items-center gap-3">
                <span className="grid size-11 place-items-center rounded-full bg-hl font-display text-lg font-bold text-ink">{p.name.slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0">
                  <p className="truncate font-semibold">{p.name}</p>
                  <p className="truncate text-[13px] text-mute">{p.email ?? 'no email shared'}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {p.paypal ? (
                  <>
                    <Chip tone={p.paypal.verified_account ? 'lime' : 'neutral'}><BadgeCheck className="size-3" aria-hidden />{p.paypal.verified_account ? 'PayPal verified' : 'PayPal unverified'}</Chip>
                    <Chip tone={p.paypal.email_verified ? 'lime' : 'neutral'}>{p.paypal.email_verified ? 'email confirmed' : 'email unconfirmed'}</Chip>
                  </>
                ) : (
                  <Chip tone="amber">demo identity</Chip>
                )}
              </div>
              {p.paypal && <p className="mt-2 font-mono text-[11px] text-mute">since {shortDate(p.paypal.linked_at)}{p.paypal.payer_id ? ` · ${p.paypal.payer_id}` : ''}</p>}
            </div>
          )}
          {p && <PayoutEmail key={p.payout_email ?? ''} value={p.payout_email} onSaved={reload} />}
          <ClaimBox initial={claimCode} onClaimed={(n) => { setFlash(`You now own ${n}.`); setParams({}, { replace: true }); reload() }} />
        </div>

        <div className="space-y-10">
          <Section id="agents" title="Your agents" aside={<Link to="/agents" className="text-sm text-soft underline underline-offset-2 hover:text-hl">Connect one</Link>}>
            {!o ? <Skeleton className="h-56" /> : (
              <div className="space-y-3">
                <div className="grid gap-3 xl:grid-cols-2">
                  {o.agents.map((a) => <AgentCard key={a.agent.id} a={a} onChange={reload} />)}
                </div>
                <NewAgent onCreated={reload} />
              </div>
            )}
          </Section>
          <Jobs />
        </div>
      </div>
    </Container>
  )
}
