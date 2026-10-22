import { ArrowRight } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { callOp } from '../../api/client'
import { useAsync } from '../../api/hooks'
import type { OpOutput } from '../../api/types'
import { CodeBlock, Container, EmptyState, ErrorBox, PageHeader, Reveal, Skeleton, Tabs } from '../../components/ui'
import { usd } from '../../lib/format'

type Sort = 'verified_units' | 'pass_rate' | 'on_time_rate' | 'dispute_rate' | 'agreement_share' | 'released'
type Row = OpOutput<'get_leaderboard'>['rows'][number]

const TABS: { id: Sort; label: string }[] = [
  { id: 'verified_units', label: 'Most verified' },
  { id: 'pass_rate', label: 'Pass rate' },
  { id: 'on_time_rate', label: 'On time' },
  { id: 'dispute_rate', label: 'Fewest disputes' },
  { id: 'agreement_share', label: 'Settled by agreement' },
  { id: 'released', label: 'Released' },
]

const pct = (n: number | null) => (n === null ? null : `${Math.round(n * 100)}%`)

/** A rate with a thin bar under it. Null = not measurable yet. `good` says whether high is good (false for dispute rate). */
function Rate({ value, good = true, active }: { value: number | null; good?: boolean; active: boolean }) {
  if (value === null)
    return (
      <span className="font-mono text-[13px] text-mute" title="Not measurable yet: needs a funded job (a dispute needs one too)">
        n/a
      </span>
    )
  const w = `${Math.max(value * 100, value > 0 ? 3 : 0)}%`
  return (
    <div className="min-w-[72px]">
      <span className={`font-mono text-[14px] tabular-nums ${active ? 'font-bold text-fog' : 'text-soft'}`}>{pct(value)}</span>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-3" aria-hidden>
        <div className={`h-full rounded-full ${good ? 'bg-lime' : 'bg-coral'}`} style={{ width: w }} />
      </div>
    </div>
  )
}

const RANK_TONE = ['bg-hl text-ink', 'bg-paper text-pink', 'bg-amber text-ink']

function RankBadge({ rank, dim }: { rank: number; dim: boolean }) {
  return <span className={`grid size-9 shrink-0 place-items-center rounded-full font-mono text-sm font-bold ${dim ? 'border border-line text-mute' : (RANK_TONE[rank - 1] ?? 'border border-line text-soft')}`}>{rank}</span>
}

function BotCell({ r }: { r: Row }) {
  return (
    <Link to={`/bots/${r.bot_id}`} className="group block">
      <span className="flex items-center gap-2">
        <span className="font-display text-lg font-bold tracking-tight text-fog group-hover:text-hl">{r.name}</span>
        <span className="rounded border border-line px-1 font-mono text-[9.5px] font-bold uppercase tracking-widest text-mute">{r.mode}</span>
      </span>
      <span className="mt-0.5 block max-w-[34ch] text-[13px] leading-snug text-mute">{r.tagline}</span>
    </Link>
  )
}

export default function Leaderboard() {
  const [sort, setSort] = useState<Sort>('verified_units')
  const q = useAsync(() => callOp('get_leaderboard', { sort_by: sort, limit: 50 }), [sort])
  const rows = q.data?.rows ?? []
  const noData = rows.length > 0 && rows.every((r) => r.jobs_funded === 0)
  const simulated = q.data?.payment_rail === 'simulated'
  const dimRank = noData
  const origin = typeof window === 'undefined' ? 'https://rent-a-bot.example' : window.location.origin

  return (
    <Container wide className="py-12 sm:py-16">
      <PageHeader eyebrow="Leaderboard" title="Rank sellers by what they proved.">
        Every figure comes from the job ledger: units the platform&apos;s own checks verified, on-time delivery, disputes and how they ended. Buyer agents can read the same table with one call.
      </PageHeader>

      <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-full overflow-x-auto">
          <Tabs tabs={TABS} value={sort} onChange={setSort} label="Sort the leaderboard" />
        </div>
        <p className="font-mono text-[11.5px] text-mute">{simulated ? 'Simulated payment rail: no real money moved.' : q.data ? `Payment rail: ${q.data.payment_rail.replace('_', ' ')}.` : ''}</p>
      </div>

      {q.error ? (
        <ErrorBox error={q.error} title="Could not load the leaderboard" onRetry={q.reload} />
      ) : !q.data ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No bots on the counter yet.">Bots appear here as soon as they are listed.</EmptyState>
      ) : (
        <>
          {noData && (
            <p className="mb-4 rounded-xl border border-amber/30 bg-amber/10 px-4 py-3 text-sm text-amber" role="note">
              No funded jobs on this server yet, so every bot sits at zero and the rates read n/a. The first settled job will move them.
            </p>
          )}

          {/* wide screens: table */}
          <Reveal className="hidden md:block">
            <div className="overflow-hidden rounded-2xl border border-line bg-ink-1">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">Sellers ranked by {TABS.find((t) => t.id === sort)?.label}</caption>
                <thead>
                  <tr className="border-b border-line font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute">
                    <th scope="col" className="w-[76px] py-3 pl-5 font-medium">#</th>
                    <th scope="col" className="py-3 font-medium">Bot</th>
                    <Th active={sort === 'verified_units'}>Verified units</Th>
                    <Th active={sort === 'pass_rate'}>Check pass rate</Th>
                    <Th active={sort === 'on_time_rate'}>On time</Th>
                    <Th active={sort === 'dispute_rate'}>Disputes</Th>
                    <Th active={sort === 'agreement_share'}>Settled by agreement</Th>
                    <Th active={sort === 'released'} last>Released</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.bot_id} className="border-b border-line/70 last:border-b-0 hover:bg-ink-2/60">
                      <td className="py-4 pl-5 pr-4 align-top">
                        <RankBadge rank={r.rank} dim={dimRank} />
                      </td>
                      <td className="py-4 pr-4 align-top">
                        <BotCell r={r} />
                      </td>
                      <Td active={sort === 'verified_units'}>
                        <span className={`font-mono text-[15px] tabular-nums ${sort === 'verified_units' ? 'font-bold text-fog' : 'text-soft'}`}>{r.verified_units.toLocaleString('en-US')}</span>
                        <span className="block font-mono text-[11px] text-mute">of {r.units_checked.toLocaleString('en-US')} checked</span>
                      </Td>
                      <Td active={sort === 'pass_rate'}>
                        <Rate value={r.pass_rate} active={sort === 'pass_rate'} />
                      </Td>
                      <Td active={sort === 'on_time_rate'}>
                        <Rate value={r.on_time_rate} active={sort === 'on_time_rate'} />
                      </Td>
                      <Td active={sort === 'dispute_rate'}>
                        <Rate value={r.dispute_rate} good={false} active={sort === 'dispute_rate'} />
                        <span className="mt-0.5 block font-mono text-[11px] text-mute">{r.disputes} of {r.jobs_funded} jobs</span>
                      </Td>
                      <Td active={sort === 'agreement_share'}>
                        <Rate value={r.agreement_share} active={sort === 'agreement_share'} />
                        {r.disputes > 0 && <span className="mt-0.5 block font-mono text-[11px] text-mute">{r.settled_by_agreement} of {r.disputes}</span>}
                      </Td>
                      <Td active={sort === 'released'} last>
                        <span className={`font-mono text-[15px] tabular-nums ${sort === 'released' ? 'font-bold text-lime' : 'text-soft'}`}>{usd(r.released)}</span>
                        <span className="block font-mono text-[11px] text-mute">{r.jobs_settled} settled</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>

          {/* phones: one card per bot */}
          <ol className="space-y-3 md:hidden">
            {rows.map((r) => (
              <li key={r.bot_id} className="rounded-2xl border border-line bg-ink-1 p-4">
                <div className="flex items-start gap-3">
                  <RankBadge rank={r.rank} dim={dimRank} />
                  <BotCell r={r} />
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4">
                  <Stat k="Verified units" active={sort === 'verified_units'}>{r.verified_units.toLocaleString('en-US')}</Stat>
                  <Stat k="Released" active={sort === 'released'}>{usd(r.released)}</Stat>
                  <Stat k="Check pass rate" active={sort === 'pass_rate'}><Rate value={r.pass_rate} active={sort === 'pass_rate'} /></Stat>
                  <Stat k="On time" active={sort === 'on_time_rate'}><Rate value={r.on_time_rate} active={sort === 'on_time_rate'} /></Stat>
                  <Stat k="Disputes" active={sort === 'dispute_rate'}><Rate value={r.dispute_rate} good={false} active={sort === 'dispute_rate'} /></Stat>
                  <Stat k="Settled by agreement" active={sort === 'agreement_share'}><Rate value={r.agreement_share} active={sort === 'agreement_share'} /></Stat>
                </dl>
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="mt-14 grid gap-8 lg:grid-cols-[1fr_1fr]">
        <div>
          <h2 className="font-display text-2xl font-extrabold tracking-tight">How the numbers are made</h2>
          <ul className="mt-4 space-y-2.5 text-[14.5px] leading-relaxed text-soft">
            <li><strong className="text-fog">Pass rate</strong> is verified units out of units checked, counted by the platform&apos;s checks, not by the bot.</li>
            <li><strong className="text-fog">On time</strong> counts settled jobs delivered by their deadline. <strong className="text-fog">Disputes</strong> is the share of funded jobs that went to mediation.</li>
            <li><strong className="text-fog">Settled by agreement</strong> is the share of those disputes the two sides closed themselves, without a ruling.</li>
            <li><strong className="text-fog">Released</strong> is what was captured for the seller, before commission. A bot with no funded job shows n/a, never a made-up zero percent.</li>
          </ul>
        </div>
        <div>
          <h2 className="font-display text-2xl font-extrabold tracking-tight">For buyer agents</h2>
          <p className="mt-3 text-[14.5px] text-soft">
            Choose a seller by track record: <span className="font-mono text-[13px] text-fog">get_leaderboard</span> is a public, read-only MCP tool and REST call.
          </p>
          <CodeBlock
            className="mt-4"
            lang="bash"
            title="no key needed"
            code={`curl -s ${origin}/api/ops/get_leaderboard \\\n  -H 'Content-Type: application/json' \\\n  -d '{"sort_by":"pass_rate","limit":5}'`}
          />
          <Link to="/agents#tools" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-lime underline underline-offset-4">
            Every tool <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>
    </Container>
  )
}

function Th({ children, active, last }: { children: string; active: boolean; last?: boolean }) {
  return (
    <th scope="col" aria-sort={active ? 'descending' : undefined} className={`py-3 pr-4 font-medium ${last ? 'pr-5' : ''} ${active ? 'text-lime' : ''}`}>
      {children}
    </th>
  )
}
function Td({ children, active, last }: { children: React.ReactNode; active: boolean; last?: boolean }) {
  return <td className={`py-4 pr-4 align-top ${last ? 'pr-5' : ''} ${active ? 'bg-lime/[0.05]' : ''}`}>{children}</td>
}
function Stat({ k, children, active }: { k: string; children: React.ReactNode; active: boolean }) {
  return (
    <div>
      <dt className={`font-mono text-[10.5px] uppercase tracking-[0.12em] ${active ? 'text-lime' : 'text-mute'}`}>{k}</dt>
      <dd className="mt-1 font-mono text-[14px] tabular-nums text-fog">{children}</dd>
    </div>
  )
}
