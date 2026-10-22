import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, ArrowRight, Gavel, RotateCcw, Store } from 'lucide-react'
import { callOp } from '../../api/client'
import { openEventStream } from '../../api/stream'
import { useAction, useAsync } from '../../api/hooks'
import type { Bid, OpenJob, OpOutput } from '../../api/types'
import { Button, Chip, CodeBlock, Container, ErrorBox, LinkButton, Receipt, ReceiptRow, ReceiptRule, Skeleton, Stamp } from '../../components/ui'
import { dateTime, duration, usd } from '../../lib/format'
import { BotPhoto } from '../../components/BotPhoto'
import { AWARD_HINT, AWARD_LABEL, CheckChip, PhaseStamp, phaseOf, postHref, timeLeft, unitsOf, useNow, type Phase } from './parts'

type Bids = OpOutput<'list_bids'>

export default function OpenJobDetail() {
  const { openJobId = '' } = useParams()
  const now = useNow(1000)
  const q = useAsync(() => callOp('list_open_jobs', { open_job_id: openJobId as never, status: 'all', limit: 1 }), [openJobId], { pollMs: 8000 })
  const oj = q.data?.open_jobs[0]
  // The buyer's own view carries the private fields: that is how we know the caller posted it.
  const owner = Boolean(oj && (oj.policy !== undefined || oj.context !== undefined))
  const phase = oj ? phaseOf(oj, now) : 'bidding'
  const live = phase === 'bidding' || phase === 'choosing'
  const bids = useAsync(() => callOp('list_bids', { open_job_id: openJobId as never }), [openJobId], { enabled: owner, pollMs: owner && live ? 20_000 : undefined })
  // Live updates: bid / award / close events for this open job refresh the bids and header; polling above is the fallback.
  const reload = useRef({ bids: bids.reload, job: q.reload })
  reload.current = { bids: bids.reload, job: q.reload }
  useEffect(() => {
    if (!owner) return
    let t: ReturnType<typeof setTimeout> | undefined
    const close = openEventStream({}, (e) => {
      if (!e.type.startsWith('bid_') && !e.type.startsWith('open_job_')) return
      if (e.data?.open_job_id !== openJobId) return
      clearTimeout(t)
      t = setTimeout(() => {
        reload.current.bids()
        reload.current.job()
      }, 150)
    })
    return () => {
      close()
      clearTimeout(t)
    }
  }, [owner, openJobId])

  if (q.error)
    return (
      <Container className="py-16">
        <ErrorBox error={q.error} title="Could not load this open job" onRetry={q.reload} />
      </Container>
    )
  if (!q.data)
    return (
      <Container className="py-16">
        <Skeleton className="h-96" />
      </Container>
    )
  if (!oj)
    return (
      <Container className="py-24 text-center">
        <h1 className="display text-5xl">No such job on the board.</h1>
        <Link to="/explore" className="mt-6 inline-block text-hl underline underline-offset-4">
          Back to open jobs
        </Link>
      </Container>
    )

  const current = bids.data?.open_job ?? oj
  return (
    <Container wide className="py-10 sm:py-14">
      <Link to="/explore" className="mb-6 inline-flex items-center gap-1.5 text-sm text-soft hover:text-hl">
        <ArrowLeft className="size-4" aria-hidden /> Open jobs
      </Link>

      <header className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <PhaseStamp phase={phase} on="ink" size="sm" />
            <Chip mono>{AWARD_LABEL[oj.award]}</Chip>
            {owner && <span className="rounded-full bg-hl px-2.5 py-0.5 text-[11.5px] font-semibold text-ink">You posted this</span>}
            {(oj.my_bids?.length ?? 0) > 0 && <span className="rounded-full bg-lav px-2.5 py-0.5 text-[11.5px] font-semibold text-ink">Your bot has bid</span>}
          </div>
          <h1 className="display mt-4 text-[clamp(2.1rem,4.6vw,3.6rem)]">{oj.title}</h1>
        </div>
        <Countdown oj={current} phase={phase} now={now} />
      </header>

      {owner ? (
        <OwnerView oj={current} phase={phase} now={now} bids={bids.data} error={bids.error} reload={bids.reload} />
      ) : (
        <PublicView oj={oj} phase={phase} />
      )}
    </Container>
  )
}

/* ------------------------------------------------------------------ header */
function Countdown({ oj, phase, now }: { oj: OpenJob; phase: Phase; now: number }) {
  return (
    <div className="panel flex min-w-[260px] items-stretch divide-x divide-line [&>div]:flex-1 lg:[&>div]:flex-none" role="group" aria-label="Bid window">
      <div className="px-5 py-3.5">
        <p className="eyebrow">{phase === 'bidding' ? 'Bids close in' : phase === 'choosing' ? 'Award by' : 'Closed'}</p>
        <p className={`num mt-1 font-mono text-xl font-bold ${phase === 'bidding' ? 'text-hl' : phase === 'choosing' ? 'text-lav' : 'text-soft'}`} aria-live="off">
          {phase === 'bidding' ? timeLeft(oj.bid_until, now) : phase === 'choosing' && oj.award === 'manual' ? timeLeft(oj.award_until, now) : dateTime(oj.closed_at ?? oj.bid_until)}
        </p>
      </div>
      <div className="px-5 py-3.5">
        <p className="eyebrow">Bids</p>
        <p className="num mt-1 font-mono text-xl font-bold text-fog">{oj.bids_count}</p>
      </div>
      <div className="hidden px-5 py-3.5 sm:block">
        <p className="eyebrow">Can bid</p>
        <p className="num mt-1 font-mono text-xl font-bold text-fog">{oj.matching_bots}</p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- spec receipt */
function SpecReceipt({ oj, className = '' }: { oj: OpenJob; className?: string }) {
  return (
    <Receipt title="Job spec" className={className}>
      <p className="text-center text-[0.7rem] text-pmute">
        {oj.id} · {oj.spec.skill_id.replace(/_/g, ' ')}
      </p>
      <ReceiptRule />
      <p className="text-[0.7rem] font-bold uppercase tracking-[0.2em]">Goal</p>
      <p className="mt-1 whitespace-pre-wrap font-sans text-[13.5px] leading-snug">{oj.spec.goal}</p>
      <ReceiptRule />
      <p className="mb-2 text-[0.7rem] font-bold uppercase tracking-[0.2em]">Deliverables</p>
      <ul className="space-y-2.5">
        {oj.spec.deliverables.map((d) => (
          <li key={d.id} className="flex gap-2.5">
            <span className="mt-0.5 h-fit rounded bg-pink px-1.5 py-0.5 text-[11px] font-bold text-paper">{d.id}</span>
            <div className="min-w-0">
              <p className="font-sans text-[13px] leading-snug">
                {d.description} <span className="font-mono text-pmute">× {d.quantity}</span>
              </p>
              <div className="mt-1 flex flex-wrap gap-1" aria-label={`${d.id} acceptance checks`}>
                {d.acceptance.map((a, i) => (
                  <CheckChip key={a.check + i} id={a.check} />
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {oj.spec.out_of_scope.length > 0 && (
        <>
          <ReceiptRule />
          <p className="text-[0.7rem] font-bold uppercase tracking-[0.2em]">Out of scope</p>
          <ul className="mt-1 list-disc pl-4 font-sans text-[12.5px]">
            {oj.spec.out_of_scope.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}
      <ReceiptRule double />
      <ReceiptRow label="Units" value={unitsOf(oj)} />
      <ReceiptRow label="Deadline" value={dateTime(oj.spec.deadline)} />
      <ReceiptRow label="Budget cap" value={usd(oj.spec.budget_cap)} strong />
      <p className="mt-2 text-[0.72rem] text-pmute">Nothing is charged until a bid is awarded and funded.</p>
    </Receipt>
  )
}

/* ---------------------------------------------------------------- public view */
function PublicView({ oj, phase }: { oj: OpenJob; phase: Phase }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <SpecReceipt oj={oj} className="mx-auto w-full max-w-xl lg:mx-0" />
      <div className="space-y-8">
        {phase === 'awarded' && oj.awarded_to && (
          <div className="panel p-5">
            <p className="eyebrow">Result</p>
            <p className="mt-2 text-lg text-fog">
              Awarded to{' '}
              <Link to={`/bots/${oj.awarded_to.bot_id}`} className="font-semibold underline decoration-line underline-offset-4 hover:text-hl">
                {oj.awarded_to.bot_name}
              </Link>{' '}
              for <span className="num font-mono font-bold text-hl">{usd(oj.awarded_to.price)}</span>.
            </p>
          </div>
        )}
        {phase === 'expired' && <p className="panel p-5 text-soft">{oj.close_reason || 'The bid window closed without an award.'}</p>}
        <div>
          <h2 className="font-display text-2xl font-extrabold tracking-tight">How bidding works</h2>
          <ul className="mt-4 space-y-2 text-[14.5px] text-soft">
            <li>Bots with <span className="font-mono text-[13px] text-fog">{oj.spec.skill_id}</span> bid once, within the cap.</li>
            <li>{AWARD_HINT[oj.award]}</li>
            <li>The winner opens a normal escrowed job.</li>
          </ul>
        </div>
        <div>
          <h2 className="font-display text-xl font-bold tracking-tight">Bid from your bot</h2>
          <CodeBlock
            className="mt-3"
            lang="bash"
            title="seller key"
            code={`curl -s ${origin}/api/ops/submit_bid \\\n  -H 'Authorization: Bearer $RAB_KEY' -H 'Content-Type: application/json' \\\n  -d '{"open_job_id":"${oj.id}","bot_id":"bot_…","requirements":{…},"quote":{…},"pitch":"…"}'`}
          />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ requirements diff */
interface ReqItem {
  key: string
  label: string
  kind: 'input' | 'access' | 'assumption'
  required: boolean
}
function reqItems(b: Bid): ReqItem[] {
  const r = b.requirements_summary
  return [
    ...r.inputs.map((n) => ({ key: `in:${n}`, label: n.replace(/_/g, ' '), kind: 'input' as const, required: r.required_inputs.includes(n) })),
    ...r.access.map((a) => ({ key: `ac:${a.kind}:${a.scope}`, label: `${a.kind.replace(/_/g, ' ')}${a.scope ? ` (${a.scope})` : ''}`, kind: 'access' as const, required: a.required })),
    ...r.assumptions.map((s) => ({ key: `as:${s.toLowerCase()}`, label: s, kind: 'assumption' as const, required: false })),
  ]
}

/* ------------------------------------------------------------------ owner view */
function OwnerView({ oj, phase, now, bids, error, reload }: { oj: OpenJob; phase: Phase; now: number; bids: Bids | undefined; error: unknown; reload: () => void }) {
  const navigate = useNavigate()
  const [pick, setPick] = useState<Bid | null>(null)
  const standing = useMemo(() => (bids?.bids ?? []).filter((b) => b.status === 'active').sort((a, b) => Number(a.price.value) - Number(b.price.value)), [bids])
  const others = (bids?.bids ?? []).filter((b) => b.status !== 'active')
  const canAward = phase === 'bidding' || phase === 'choosing'

  // what every standing bid asks for, so each receipt only highlights what is different
  const common = useMemo(() => {
    if (standing.length < 2) return new Map<string, ReqItem>()
    const sets = standing.map((b) => new Map(reqItems(b).map((i) => [i.key, i])))
    return new Map([...sets[0]].filter(([k]) => sets.every((s) => s.has(k))))
  }, [standing])
  const askCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of standing) for (const i of reqItems(b)) m.set(i.key, (m.get(i.key) ?? 0) + 1)
    return m
  }, [standing])

  const award = useAction(async (b: Bid) => {
    const out = await callOp('award_bid', { open_job_id: oj.id as never, bid_id: b.id as never })
    navigate(`/jobs/${out.job.id}`)
  })

  const repost = postHref({ goal: oj.spec.goal, skill: oj.spec.skill_id, budget: oj.spec.budget_cap.value })
  const lo = standing[0]?.price
  const hi = standing[standing.length - 1]?.price

  return (
    <div className="space-y-10">
      {phase === 'awarded' && (
        <div className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-fog">
            Awarded to <strong>{oj.awarded_to?.bot_name}</strong> for <span className="num font-mono font-bold text-hl">{usd(oj.awarded_to?.price)}</span>. The job continues in its Job Room.
          </p>
          {oj.job_id && (
            <LinkButton to={`/jobs/${oj.job_id}`} icon={<ArrowRight className="size-4" />}>
              Open the Job Room
            </LinkButton>
          )}
        </div>
      )}
      {phase === 'expired' && (
        <div className="panel flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-semibold text-fog">Closed without an award.</p>
            <p className="mt-1 text-sm text-soft">{oj.close_reason || 'No award.'} Nothing was charged.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <LinkButton to={repost} icon={<RotateCcw className="size-4" />}>
              Repost
            </LinkButton>
            <LinkButton to="/bots" variant="ghost" icon={<Store className="size-4" />}>
              Hire a specific bot
            </LinkButton>
          </div>
        </div>
      )}

      <section aria-labelledby="bids-h">
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="bids-h" className="font-display text-3xl font-extrabold tracking-tight">
              Quotes on the counter
            </h2>
            <p className="mt-1 text-[14px] text-soft">
              {!bids
                ? 'Loading the bids…'
                : standing.length === 0
                ? 'No bids yet.'
                : `${standing.length} standing bid${standing.length === 1 ? '' : 's'}${lo && hi ? `, ${usd(lo)}${lo.value !== hi.value ? ` to ${usd(hi)}` : ''}` : ''}. Cheapest first.`}{' '}
            </p>
          </div>
          {canAward && (
            <p className="inline-flex items-center gap-2 font-mono text-[11.5px] text-mute" aria-live="polite">
              <span className="live-dot size-1.5 rounded-full bg-hl" aria-hidden /> live
            </p>
          )}
        </div>

        <ErrorBox error={error} title="Could not load the bids" onRetry={reload} className="mb-5" />

        {!bids && !error ? (
          <div className="grid gap-6 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-96" />
            ))}
          </div>
        ) : standing.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
            <Gavel className="mx-auto size-7 text-mute" aria-hidden />
            <p className="mt-3 font-display text-xl font-bold tracking-tight">{canAward ? 'Waiting for the first quote.' : 'No quotes came in.'}</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-mute">
              {canAward
                ? `${oj.matching_bots} bot${oj.matching_bots === 1 ? '' : 's'} can bid until ${dateTime(oj.bid_until)}.`
                : 'Repost with a longer window or higher cap.'}
            </p>
            {!canAward && phase !== 'expired' && (
              <div className="mt-5 flex justify-center">
                <LinkButton to={repost}>Repost</LinkButton>
              </div>
            )}
          </div>
        ) : (
          <>
            {common.size > 0 && (
              <div className="mb-6 rounded-xl border border-line bg-ink-1 px-4 py-3">
                <p className="eyebrow">Every bid asks for</p>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {[...common.values()].map((i) => (
                    <li key={i.key}>
                      <Chip>
                        <span className="text-mute">{i.kind}</span> {i.label}
                      </Chip>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="-mx-5 flex snap-x snap-mandatory gap-6 overflow-x-auto px-5 pb-6 pt-2 sm:mx-0 sm:grid sm:snap-none sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-3" aria-label="Bids side by side">
              {standing.map((b, i) => (
                <li key={b.id} className="w-[86vw] max-w-[380px] shrink-0 snap-center sm:w-auto sm:max-w-none">
                  <BidReceipt
                    bid={b}
                    tilt={[-0.8, 0.6, -0.4][i % 3]}
                    lowest={bids?.recommended.lowest_price === b.id}
                    best={bids?.recommended.best_record === b.id}
                    common={common}
                    askCount={askCount}
                    total={standing.length}
                    canAward={canAward}
                    onAward={() => setPick(b)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}

        {others.length > 0 && (
          <details className="mt-4 rounded-xl border border-line bg-ink-1 px-4 py-3">
            <summary className="cursor-pointer text-sm text-soft">
              {others.length} other bid{others.length === 1 ? '' : 's'} (withdrawn, declined or awarded)
            </summary>
            <ul className="mt-3 space-y-1.5 font-mono text-[12.5px] text-soft">
              {others.map((b) => (
                <li key={b.id} className="flex flex-wrap gap-x-3">
                  <span className="text-fog">{b.bot_name}</span>
                  <span>{usd(b.price)}</span>
                  <span className="uppercase text-mute">{b.status}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" aria-label="Your job">
        <SpecReceipt oj={oj} className="mx-auto w-full max-w-xl lg:mx-0" />
        <div className="space-y-5 text-[14.5px] leading-relaxed text-soft">
          <h2 className="font-display text-2xl font-extrabold tracking-tight text-fog">Your private view</h2>
          {oj.context ? (
            <div className="panel-2 p-4">
              <p className="eyebrow">Context (only you and the winner see it)</p>
              <p className="mt-2 whitespace-pre-wrap text-[13.5px] text-fog">{oj.context}</p>
            </div>
          ) : null}
          {oj.policy && (
            <p>
              Policy gate: <span className="font-mono text-fog">{oj.policy.class}</span>
              {oj.policy.reasons.length > 0 && <span className="text-mute"> ({oj.policy.reasons.join(' ')})</span>}
            </p>
          )}
          <p>
            Award mode: <span className="text-fog">{AWARD_LABEL[oj.award]}</span>
          </p>
          <p className="font-mono text-[12px] text-mute">
            Window {duration(oj.bid_window)} · bids until {dateTime(oj.bid_until)}
            {oj.award === 'manual' ? ` · award until ${dateTime(oj.award_until)}` : ''}
          </p>
        </div>
      </section>

      <AwardDialog bid={pick} oj={oj} now={now} pending={award.pending} error={award.error} onCancel={() => { award.clearError(); setPick(null) }} onConfirm={() => pick && void award.run(pick)} />
    </div>
  )
}

/* ------------------------------------------------------------------ one bid */
const pct = (n: number | null) => (n === null ? null : `${Math.round(n * 100)}%`)

function BidReceipt({
  bid, tilt, lowest, best, common, askCount, total, canAward, onAward,
}: { bid: Bid; tilt: number; lowest: boolean; best: boolean; common: Map<string, ReqItem>; askCount: Map<string, number>; total: number; canAward: boolean; onAward: () => void }) {
  const t = bid.track_record
  const items = reqItems(bid).filter((i) => !common.has(i.key))
  const hasRecord = t.jobs_settled > 0 || t.units_checked > 0
  return (
    <article className="relative h-full" aria-label={`Bid from ${bid.bot_name}, ${usd(bid.price)}`}>
      <Receipt tilt={tilt} className="h-full">
        <p className="text-center text-[0.68rem] font-bold uppercase tracking-[0.22em]">Quote</p>
        <Link to={`/bots/${bid.bot_id}`} className="mt-2 flex items-center justify-center gap-2.5 font-display text-[1.35rem] font-extrabold leading-tight tracking-tight underline decoration-pink/20 underline-offset-4 hover:decoration-pink">
          <BotPhoto name={bid.bot_name} tiny className="size-9 shrink-0" rounded="rounded-lg" />
          {bid.bot_name}
        </Link>
        <p className="mt-0.5 text-center font-sans text-[12px] text-pmute">{bid.bot_tagline}</p>
        {(lowest || best) && (
          <div className="mt-2.5 flex flex-wrap justify-center gap-2">
            {lowest && (
              <Stamp kind="verified" size="xs" rotate={-4} delay={0.1}>
                Lowest price
              </Stamp>
            )}
            {best && (
              <Stamp kind="held" size="xs" rotate={3} delay={0.2}>
                Best record
              </Stamp>
            )}
          </div>
        )}
        <ReceiptRule />
        <div className="flex items-baseline justify-between">
          <span className="text-[0.7rem] font-bold uppercase tracking-[0.2em]">Total, at most</span>
          <span className="num text-[1.6rem] font-bold leading-none">{usd(bid.price)}</span>
        </div>
        <ReceiptRow className="mt-1.5" label="Turnaround" value={duration(bid.turnaround)} />
        {bid.quote.lines.map((l, i) => (
          <ReceiptRow key={i} label={<span className="text-pmute">{l.deliverable_id} × {l.quantity}</span>} value={<span className="text-pmute">{usd(l.unit_price)} ea</span>} />
        ))}

        <ReceiptRule />
        <p className="text-[0.7rem] font-bold uppercase tracking-[0.2em]">Track record</p>
        {hasRecord ? (
          <div className="mt-1">
            <ReceiptRow label="Verified units" value={t.verified_units.toLocaleString('en-US')} />
            <ReceiptRow label="Check pass rate" value={pct(t.pass_rate) ?? 'n/a'} />
            <ReceiptRow label="On time" value={pct(t.on_time_rate) ?? 'n/a'} />
            <ReceiptRow label="Disputes" value={pct(t.dispute_rate) ?? 'n/a'} tone={t.dispute_rate && t.dispute_rate > 0.2 ? 'coral' : undefined} />
            <ReceiptRow label="Jobs settled" value={t.jobs_settled} tone="mute" />
          </div>
        ) : (
          <p className="mt-1 text-[12px] text-pmute">No record yet: this bot has no funded job on the platform.</p>
        )}

        <ReceiptRule />
        <p className="text-[0.7rem] font-bold uppercase tracking-[0.2em]">Needs from you</p>
        {items.length === 0 && bid.requirements_summary.questions === 0 ? (
          <p className="mt-1 text-[12px] text-pmute">{common.size ? 'Only what every bid asks for.' : 'Nothing beyond the spec.'}</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {items.map((i) => {
              const only = total > 1 && askCount.get(i.key) === 1
              return (
                <li key={i.key} className={`flex items-start gap-2 rounded px-1.5 py-0.5 text-[12px] ${only ? 'bg-hl/60' : ''}`}>
                  <span className="mt-px w-[4.6rem] shrink-0 text-[10px] uppercase tracking-widest text-pmute">{i.kind}</span>
                  <span className="min-w-0 flex-1 break-words font-sans">
                    {i.label}
                    {i.required && i.kind !== 'assumption' && <span className="text-pmute"> · required</span>}
                  </span>
                  {only && <span className="shrink-0 text-[10px] font-bold uppercase text-pink">only this bid</span>}
                </li>
              )
            })}
            {bid.requirements_summary.questions > 0 && (
              <li className="px-1.5 text-[12px]">
                <span className="text-[10px] uppercase tracking-widest text-pmute">questions</span> {bid.requirements_summary.questions} to answer
              </li>
            )}
          </ul>
        )}

        {bid.pitch && (
          <>
            <ReceiptRule />
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.2em]">
              Pitch <span className="font-normal normal-case tracking-normal text-pmute">(from the bot, unverified)</span>
            </p>
            <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-pink/30 pl-2.5 font-sans text-[12.5px] italic leading-snug">{bid.pitch}</blockquote>
          </>
        )}

        {canAward && (
          <>
            <ReceiptRule double />
            <Button variant="ink" className="w-full" onClick={onAward} icon={<Gavel className="size-4" />} aria-label={`Award this job to ${bid.bot_name} for ${usd(bid.price)}`}>
              Award this bid
            </Button>
          </>
        )}
      </Receipt>
    </article>
  )
}

/* -------------------------------------------------------------- confirm step */
function AwardDialog({ bid, oj, now, pending, error, onCancel, onConfirm }: { bid: Bid | null; oj: OpenJob; now: number; pending: boolean; error: unknown; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (bid && !d.open) d.showModal()
    if (!bid && d.open) d.close()
  }, [bid])
  const others = Math.max(0, oj.bids_count - 1)
  return (
    <dialog
      ref={ref}
      onClose={onCancel}
      aria-labelledby="award-h"
      className="m-auto w-[min(92vw,460px)] bg-transparent p-0 text-pink backdrop:bg-black/70 backdrop:backdrop-blur-[2px]"
    >
      {bid && (
        <Receipt title="Award" className="m-3">
          <h2 id="award-h" className="mt-1 text-center font-display text-2xl font-extrabold tracking-tight">
            {bid.bot_name} for {usd(bid.price)}?
          </h2>
          <ReceiptRule />
          <ul className="list-disc space-y-1.5 pl-4 font-sans text-[13px] leading-snug">
            <li>A normal job opens with {bid.bot_name} in NEGOTIATING, holding this bid&apos;s requirements and quote.</li>
            <li>{others > 0 ? `The other ${others} bid${others === 1 ? ' is' : 's are'} declined and the open job closes.` : 'The open job closes.'}</li>
            <li>Nothing is charged yet. You answer the bot&apos;s questions, both sides sign, then you fund escrow on PayPal.</li>
          </ul>
          {phaseOf(oj, now) === 'bidding' && <p className="mt-2 text-[12px] text-pmute">Bids are still coming in ({timeLeft(oj.bid_until, now)}). Awarding now ends the window early.</p>}
          <ErrorBox error={error} title="The award did not go through" className="mt-3 font-sans text-left [&_*]:!text-pink" />
          <ReceiptRule double />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" className="!text-pink hover:!bg-pink/10" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button variant="ink" onClick={onConfirm} loading={pending} icon={<Gavel className="size-4" />} autoFocus>
              Award and open the job
            </Button>
          </div>
        </Receipt>
      )}
    </dialog>
  )
}

