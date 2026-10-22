import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { BotSticker } from '../../components/BotPhoto'
import { BriefNotes, TalkStrip } from '../../components/Brief'
import { BotLoop } from '../../components/loops'
import { PassportSection, isDeclared } from '../../components/Passport'
import { tileColor } from '../../lib/botArt'
import { callOp } from '../../api/client'
import { useAsync } from '../../api/hooks'
import type { BotCard, Skill } from '../../api/types'
import { ClassChip, Chip, CodeBlock, Container, ErrorBox, LinkButton, ModeBadge, Receipt, ReceiptRow, ReceiptRule, Reveal, Skeleton, Stamp, Tabs } from '../../components/ui'
import { duration, usd } from '../../lib/format'
import { SchemaFields } from './SchemaFields'
import type { JsonSchemaNode } from '../../api/meta'
import { FEE_SHORT, MIN_SETTLEMENT_CENTS } from '../../lib/fees'
const usdCents = (c: number) => `$${(c / 100).toFixed(2)}`

const pct = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : `${Math.round(n * 100)}%`)

export default function BotDetail() {
  const { id = '' } = useParams()
  const bot = useAsync(() => callOp('get_bot', { bot_id: id }), [id])
  const checks = useAsync(() => callOp('list_checks', {}), [])
  const [skillId, setSkillId] = useState<string | null>(null)

  const b = bot.data?.bot
  const skill = useMemo(() => b?.skills.find((s) => s.id === skillId) ?? b?.skills[0], [b, skillId])
  const checkTitle = (cid: string) => checks.data?.checks.find((c) => c.id === cid)?.title ?? cid

  if (bot.error) {
    return (
      <Container className="py-16">
        <BackLink />
        <ErrorBox error={bot.error} title="Could not load this bot" onRetry={bot.reload} />
      </Container>
    )
  }
  if (!b || !skill) {
    return (
      <Container className="py-16">
        <Skeleton className="mb-4 h-10 w-80" />
        <Skeleton className="h-96" />
      </Container>
    )
  }
  const paused = b.status !== 'listed'

  return (
    <Container className="py-10 sm:py-14" wide>
      <BackLink />
      <header className="mb-12 grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        <div className="max-w-4xl">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-block rounded-md bg-paper px-1 py-0.5">
            <ModeBadge mode={b.mode} />
          </span>
          <ClassChip cls={b.capability_class} />
          {paused && <Chip tone="amber">Coming soon</Chip>}
          {b.policy.class !== 'standard' && <Chip tone="coral">Policy: {b.policy.class}</Chip>}
        </div>
        <h1 className="display mt-4 text-[clamp(2.6rem,6vw,4.8rem)]">{b.name}</h1>
        <p className="mt-4 max-w-2xl text-lg text-soft">{b.tagline}</p>
        <p className="mt-3 hidden max-w-2xl text-[15px] leading-relaxed text-mute sm:block">{b.description}</p>
        <p className="mt-3 text-[13px] text-mute">
          {b.mode === 'demo' ? 'Demo bot: acts only on Sandbox Web, fake sites with no real-world side effects.' : 'Live bot: acts on the real web.'}
        </p>
        {!paused && (
          <LinkButton to={`/hire/${b.id}?skill=${skill.id}`} size="lg" className="mt-5 w-full sm:w-auto lg:hidden">
            Hire {b.name}
          </LinkButton>
        )}
        </div>
        <div className="paper on-paper pin relative mx-auto w-full max-w-[320px] rounded-[28px] p-3 shadow-[0_26px_40px_-18px_rgba(0,0,0,0.7)] lg:mx-0" style={{ transform: 'rotate(2deg)' }}>
          <div className="relative h-[190px] overflow-hidden rounded-[20px]" style={{ background: tileColor(b.name) }}>
            <BotLoop name={b.name} cls={b.capability_class} dark={tileColor(b.name) === '#2B2238'} />
          </div>
          <span className="absolute -left-4 -top-5 z-[3]"><BotSticker name={b.name} size={72} rotate={-8} /></span>
          <p className="px-2 pb-1 pt-3 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-pmute">{b.id.slice(0, 18)}</p>
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-10">
          {b.passport && <PassportSection passport={b.passport} declared={isDeclared(b.name, b.passport)} />}
          {b.skills.length > 1 && <Tabs label="Skills" tabs={b.skills.map((s) => ({ id: s.id, label: s.title }))} value={skill.id} onChange={setSkillId} />}

          <Reveal key={skill.id}>
            <section aria-labelledby="skill-h" className="space-y-8">
              <div>
                <p className="eyebrow mb-2">Skill · {skill.id}</p>
                <h2 id="skill-h" className="font-display text-3xl font-bold tracking-tight">
                  {skill.title}
                </h2>
                <p className="mt-2 max-w-2xl text-soft">{skill.description}</p>
                {skill.examples.length > 0 && (
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {skill.examples.map((e) => (
                      <li key={e} className="rounded-lg border border-dashed border-line px-3 py-1.5 text-[13px] italic text-soft">
                        “{e}”
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {skill.brief && <BriefNotes brief={skill.brief} demo={b.mode === 'demo'} />}
              <TalkStrip brief={skill.brief} />

              <div className="grid gap-6 xl:grid-cols-2">
                <SchemaPanel title="Needs" sub="What the bot requires before it can start." schema={skill.needs} />
                <SchemaPanel title="Delivers" sub="The shape of each delivered unit." schema={skill.delivers} />
              </div>

              <div>
                <h3 className="font-display text-xl font-bold tracking-tight">Acceptance checks</h3>
                <p className="mt-1 text-sm text-mute">Every unit is run through these by the platform. Only units that pass are paid.</p>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {skill.checks.map((c) => (
                    <li key={c}>
                      <Chip tone="lime" mono>
                        {c}
                      </Chip>
                      <span className="sr-only">{checkTitle(c)}</span>
                    </li>
                  ))}
                </ul>
                <dl className="mt-4 hidden gap-x-8 gap-y-2 text-[13.5px] sm:grid sm:grid-cols-2">
                  {skill.checks.map((c) => (
                    <div key={c} className="flex gap-2">
                      <dt className="shrink-0 font-mono text-[12px] text-lime">{c}</dt>
                      <dd className="text-soft">{checks.data?.checks.find((x) => x.id === c)?.description ?? ''}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </section>
          </Reveal>

          <Reputation bot={b} />
          {(b.policy.notes || b.policy.requires_scope_proof) && (
            <div className="flex gap-3 rounded-xl border border-amber/30 bg-amber/10 p-4 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden />
              <div>
                <p className="font-semibold text-amber">Policy</p>
                <p className="mt-1 text-soft">{b.policy.notes || 'Requires proof that you own the target before funding.'}</p>
                {b.policy.requires_scope_proof && <p className="mt-1 text-soft">Scope proof required: funding is blocked until the platform checks that you own the target{b.skills.some((k) => (k.needs as { required?: string[] }).required?.includes('ownership_token')) ? ' (an ownership token bound to the job)' : ' (/.well-known/rentabot-scope.txt listing the job id)'}.</p>}
              </div>
            </div>
          )}
        </div>

        <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start" aria-label="Pricing and hiring">
          <PriceSlip bot={b} skill={skill} />
          {paused ? (
            <div className="rounded-xl border border-dashed border-line p-5 text-center text-sm text-mute">This bot is not accepting jobs yet.</div>
          ) : (
            <>
              <div className="panel p-5">
                <p className="eyebrow mb-2">Hire as a person</p>
                <p className="mb-4 text-sm text-soft">Describe the goal. The Spec Copilot turns it into deliverables with acceptance tests before anyone pays.</p>
                <LinkButton to={`/hire/${b.id}?skill=${skill.id}`} size="lg" className="w-full">
                  Hire {b.name}
                </LinkButton>
              </div>
              <div>
                <p className="eyebrow mb-2">Hire via MCP</p>
                <McpSnippet bot={b} skill={skill} />
              </div>
            </>
          )}
        </aside>
      </div>
    </Container>
  )
}

function BackLink() {
  return (
    <Link to="/bots" className="mb-6 inline-flex items-center gap-1.5 text-sm text-soft hover:text-hl">
      <ArrowLeft className="size-4" aria-hidden /> All bots
    </Link>
  )
}

function SchemaPanel({ title, sub, schema }: { title: string; sub: string; schema: JsonSchemaNode }) {
  return (
    <div className="panel p-5">
      <h3 className="font-display text-xl font-bold tracking-tight">{title}</h3>
      <p className="mb-2 mt-0.5 text-[13px] text-mute">{sub}</p>
      <SchemaFields schema={schema} />
    </div>
  )
}

function PriceSlip({ bot, skill }: { bot: BotCard; skill: Skill }) {
  const p = skill.pricing
  const perUnit = p.model === 'per_unit'
  return (
    <Receipt title="Rental slip" tilt={-0.8}>
      <p className="text-center text-[0.7rem] text-pmute">{bot.name}</p>
      <ReceiptRule />
      <ReceiptRow label={perUnit ? `Per ${(p.unit ?? 'unit').replace(/_/g, ' ')}` : 'Fixed price'} value={usd(p.price)} strong />
      {p.extras?.map((x) => (
        <ReceiptRow key={x.id} label={`+ ${x.title}, flat`} value={usd(x.price)} strong />
      ))}
      {perUnit && p.min_units && <ReceiptRow label="Minimum units" value={p.min_units} />}
      {perUnit && p.max_units && <ReceiptRow label="Maximum units" value={p.max_units} />}
      {perUnit && p.min_units && <ReceiptRow label={`Smallest job (${p.min_units})`} value={usd(Number(p.price) * p.min_units)} tone="mute" />}
      {perUnit && p.max_units && <ReceiptRow label={`Largest job (${p.max_units})`} value={usd(Number(p.price) * p.max_units)} tone="mute" />}
      <ReceiptRule />
      <ReceiptRow label="Turnaround" value={duration(skill.turnaround)} />
      <ReceiptRow label="Verify window" value={skill.verify_window === 'PT0H' ? 'immediate' : duration(skill.verify_window)} />
      <ReceiptRow label="Platform fee" value={`${FEE_SHORT}, from seller; jobs from ${usdCents(MIN_SETTLEMENT_CENTS)}`} />
      <ReceiptRule double />
      <p className="text-[0.72rem] leading-snug text-pmute">Authorized on PayPal, not taken. You pay only for units that pass their checks; the rest is voided.</p>
      <p className="mt-2 font-mono text-[0.68rem] tracking-widest text-pmute">{bot.id.toUpperCase()}</p>
      <div className="mt-3 flex justify-end">
        <Stamp kind="held" size="xs" rotate={-5} delay={0.3}>
          HELD, NOT TAKEN
        </Stamp>
      </div>
    </Receipt>
  )
}

function Reputation({ bot }: { bot: BotCard }) {
  const r = bot.reputation
  const rows: [string, string, 'lime' | 'coral' | undefined][] = [
    ['Jobs completed', String(r.jobs_completed), undefined],
    ['On-time rate', pct(r.on_time_rate), undefined],
    ['Dispute rate', pct(r.dispute_rate), undefined],
    ['Settled by agreement', String(r.settled_by_agreement ?? 0), r.settled_by_agreement ? 'lime' : undefined],
    ['Rulings lost', String(r.rulings_lost), r.rulings_lost ? 'coral' : undefined],
    ['Integrity flags', String(r.integrity_flags), r.integrity_flags ? 'coral' : undefined],
    ['Avg fulfilment', pct(r.avg_fulfilment), 'lime'],
  ]
  return (
    <section aria-labelledby="rep-h">
      <h2 id="rep-h" className="font-display text-2xl font-bold tracking-tight">
        Reputation
      </h2>
      <p className="mt-1 text-sm text-mute">Computed from settled jobs and rulings.</p>
      {r.jobs_completed === 0 && !r.rulings_lost && !r.integrity_flags ? (
        <div className="panel-2 mt-4 flex items-center gap-4 p-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-hl font-display text-xl font-extrabold text-ink" aria-hidden>
            0
          </span>
          <p className="text-[15px] text-soft">
            <span className="font-semibold text-fog">No settled jobs yet.</span> The record starts with the first job it proves.
          </p>
        </div>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map(([k, v, tone]) => (
            <div key={k} className="panel-2 p-4">
              <dt className="eyebrow">{k}</dt>
              <dd className={`num mt-1 font-display text-3xl font-extrabold tracking-tight ${tone === 'lime' ? 'text-lime' : tone === 'coral' ? 'text-coral' : ''}`}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function McpSnippet({ bot, skill }: { bot: BotCard; skill: Skill }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const [tab, setTab] = useState<'tools' | 'curl'>('tools')
  const tools = `# your agent, in order
get_bot          { "bot_id": "${bot.id}" }
draft_job_spec   { "bot_id": "${bot.id}", "skill_id": "${skill.id}",
                   "goal": "Get ORANO listed before launch" }
create_job       { "bot_id": "${bot.id}", "spec": <spec from draft_job_spec> }
wait_for_events  { "job_id": <job.id> }   # then accept_contract, fund_job`
  const curl = `curl -X POST ${origin}/api/ops/create_job \\
  -H "Authorization: Bearer $RENTABOT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"bot_id":"${bot.id}","spec":{ "skill_id":"${skill.id}", ... }}'`
  return (
    <div className="space-y-2">
      <Tabs label="Snippet" value={tab} onChange={setTab} tabs={[{ id: 'tools', label: 'MCP tools' }, { id: 'curl', label: 'curl' }]} />
      <CodeBlock code={tab === 'tools' ? tools : curl} title={tab === 'tools' ? 'mcp' : 'bash'} />
    </div>
  )
}
