import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, Plus, Send, Sparkles, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { callOp } from '../../api/client'
import { useAction, useAsync } from '../../api/hooks'
import type { JobSpec, OpOutput, PolicyClass } from '../../api/types'
import { Button, Container, ErrorBox, ModeBadge, PrintLine, Receipt, ReceiptRow, ReceiptRule, Skeleton, Stamp } from '../../components/ui'
import { extrasLine } from '../../components/BotTag'
import { usd } from '../../lib/format'
import { jobTitleFrom } from '../../lib/jobTitle'

type Draft = OpOutput<'draft_job_spec'>

const toLocal = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined)

export default function Hire() {
  const { botId = '' } = useParams()
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const bot = useAsync(() => callOp('get_bot', { bot_id: botId }), [botId])
  const checks = useAsync(() => callOp('list_checks', {}), [])
  const b = bot.data?.bot

  const [skillId, setSkillId] = useState(sp.get('skill') ?? '')
  const [goal, setGoal] = useState((sp.get('goal') ?? '').slice(0, 1000))
  const [quantity, setQuantity] = useState('')
  const [deadline, setDeadline] = useState('')
  const [budget, setBudget] = useState('')
  const [context, setContext] = useState('')
  // null = the buyer has not typed a title: it follows the goal, then the copilot's spec.
  const [titleEdit, setTitleEdit] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [spec, setSpec] = useState<JobSpec | null>(null)
  const idem = useRef(`hire-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`)

  useEffect(() => {
    if (b && !b.skills.some((s) => s.id === skillId)) setSkillId(b.skills[0].id)
  }, [b, skillId])
  const skill = b?.skills.find((s) => s.id === skillId)
  const title = titleEdit ?? jobTitleFrom(draft?.spec.goal || goal)

  const drafting = useAction(async () => {
    const out = await callOp('draft_job_spec', {
      bot_id: botId as never,
      skill_id: skillId,
      goal,
      quantity: quantity ? Number(quantity) : undefined,
      deadline: fromLocal(deadline),
      budget_cap: budget ? Number(budget).toFixed(2) : undefined,
      context: context || undefined,
    })
    setDraft(out)
    setSpec(out.spec)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  const sending = useAction(async () => {
    if (!spec) return
    const out = await callOp('create_job', { bot_id: botId as never, spec, title: title.trim() || jobTitleFrom(spec.goal) || undefined, idempotency_key: idem.current })
    navigate(`/jobs/${out.job.id}`)
  })

  if (bot.error)
    return (
      <Container className="py-16">
        <ErrorBox error={bot.error} title="Could not load this bot" onRetry={bot.reload} />
      </Container>
    )
  if (!b)
    return (
      <Container className="py-16">
        <Skeleton className="h-96" />
      </Container>
    )
  if (b.status !== 'listed')
    return (
      <Container className="py-24 text-center">
        <h1 className="display text-5xl">Not on the counter yet.</h1>
        <p className="mt-4 text-soft">{b.name} is coming soon and is not taking jobs.</p>
        <Link to="/bots" className="mt-6 inline-block text-lime underline underline-offset-4">
          Back to the shelf
        </Link>
      </Container>
    )

  const step = draft && spec ? 2 : 1
  return (
    <Container className="py-10 sm:py-14">
      <Link to={`/bots/${b.id}`} className="mb-6 inline-flex items-center gap-1.5 text-sm text-soft hover:text-hl">
        <ArrowLeft className="size-4" aria-hidden /> {b.name}
      </Link>
      <div className="grid gap-12 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div>
          <p className="eyebrow mb-3">Hire as a person</p>
          <h1 className="display text-[clamp(2.4rem,5vw,3.6rem)]">{step === 1 ? 'Say what you need.' : 'Check the spec. Then send it.'}</h1>
          <div className="mt-4 flex items-center gap-2">
            <ModeBadge mode={b.mode} className="bg-paper" />
            <span className="text-sm text-soft">{b.name}</span>
          </div>
          <ol className="mt-8 space-y-4" aria-label="Steps">
            {[
              ['Goal', 'Plain words. The Spec Copilot writes the contract terms.'],
              ['Spec', 'Edit deliverables and the tests that decide what you pay for.'],
              ['Send', 'The bot replies with requirements and a quote. Nothing is charged yet.'],
            ].map(([t, d], i) => {
              const state = i + 1 < step ? 'done' : i + 1 === step ? 'now' : i === 2 && step === 2 ? 'next' : 'next'
              return (
                <li key={t} className="flex gap-3" aria-current={state === 'now' ? 'step' : undefined}>
                  <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full font-mono text-[11px] font-bold ${state === 'done' ? 'bg-lime text-ink' : state === 'now' ? 'border-2 border-lime text-lime' : 'border border-line text-mute'}`}>{i + 1}</span>
                  <div>
                    <p className={`text-sm font-semibold ${state === 'next' ? 'text-mute' : 'text-fog'}`}>{t}</p>
                    <p className="text-[13px] text-mute">{d}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>

        <div className="min-w-0">
          <AnimatePresence mode="wait" initial={false}>
            {step === 1 ? (
              <motion.form
                key="goal"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                onSubmit={(e) => {
                  e.preventDefault()
                  void drafting.run()
                }}
                className="panel space-y-5 p-5 sm:p-7"
              >
                <Field label="Goal" htmlFor="goal" hint="What should be true when the job is done?">
                  <textarea id="goal" required minLength={10} maxLength={1000} rows={4} className="field" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={skill?.examples[0] ?? 'Get my product listed on 40 AI directories before launch.'} />
                </Field>
                <Field label="Job title (optional)" htmlFor="title" hint="Shown in your jobs list and the Job Room. Leave it to use the start of your goal.">
                  <input id="title" className="field" maxLength={140} value={title} onChange={(e) => setTitleEdit(e.target.value)} placeholder="Short name for this job" />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Skill" htmlFor="skill">
                    <select id="skill" className="field" value={skillId} onChange={(e) => setSkillId(e.target.value)}>
                      {b.skills.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Quantity (optional)" htmlFor="qty" hint={`${skill?.pricing.model === 'per_unit' ? `${skill.pricing.min_units ?? 1} to ${skill.pricing.max_units ?? 'many'} ${(skill.pricing.unit ?? 'units').replace(/_/g, ' ')}` : 'Fixed price: one deliverable'}${skill?.pricing.extras?.length ? `, ${extrasLine(skill)}` : ''}`}>
                    <input id="qty" type="number" min={1} className="field font-mono" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={String(skill?.pricing.min_units ?? 1)} />
                  </Field>
                  <Field label="Deadline (optional)" htmlFor="deadline">
                    <input id="deadline" type="datetime-local" className="field font-mono" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                  </Field>
                  <Field label="Budget cap in USD (optional)" htmlFor="budget" hint="The most you are willing to hold in escrow.">
                    <input id="budget" type="number" min={1} step="0.01" className="field font-mono" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="80.00" />
                  </Field>
                </div>
                <Field label="Context (optional)" htmlFor="ctx" hint="Facts the bot may rely on: product name, URL, approved copy. Never put passwords here.">
                  <textarea id="ctx" rows={3} maxLength={8000} className="field" value={context} onChange={(e) => setContext(e.target.value)} placeholder="ORANO is a personal AI assistant. Site: https://oranoai.com" />
                </Field>
                <ErrorBox error={drafting.error} title="The Spec Copilot could not draft that" />
                <div className="flex items-center justify-between gap-4">
                  <p className="text-[13px] text-mute">Drafting creates nothing and charges nothing.</p>
                  <Button type="submit" size="lg" loading={drafting.pending} icon={<Sparkles className="size-4" />}>
                    {drafting.pending ? 'Drafting…' : 'Draft the spec'}
                  </Button>
                </div>
              </motion.form>
            ) : (
              <motion.div key="spec" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <SpecReceipt
                  botName={b.name}
                  draft={draft!}
                  spec={spec!}
                  setSpec={setSpec}
                  title={title}
                  onTitle={setTitleEdit}
                  checks={checks.data?.checks.map((c) => ({ id: c.id, title: c.title })) ?? []}
                  budgetInput={budget}
                />
                <ErrorBox className="mt-5" error={sending.error} title="The bot did not receive the job" />
                <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                  <Button variant="ghost" onClick={() => { setDraft(null); setSpec(null) }}>
                    Back to goal
                  </Button>
                  <div className="flex flex-wrap items-center gap-3">
                    {draft!.policy.class === 'blocked' && <span className="text-sm text-coral">Blocked by the policy gate. Change the goal.</span>}
                    <Link
                      to={`/post?${new URLSearchParams({ goal: spec!.goal || goal, skill: skillId, budget: spec!.budget_cap.value })}`}
                      className="inline-flex h-12 items-center rounded-xl border border-line px-5 text-[15px] font-semibold text-fog hover:border-soft hover:bg-ink-2"
                      title="Get competing quotes: every bot with this skill may bid"
                    >
                      Post to all bots
                    </Link>
                    <Button size="lg" onClick={() => void sending.run()} loading={sending.pending} disabled={draft!.policy.class === 'blocked'} icon={<Send className="size-4" />}>
                      Send job to {b.name}
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Container>
  )
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-semibold text-fog">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-[12.5px] text-mute">{hint}</p>}
    </div>
  )
}

/* ---------------------------------------------------------------- spec receipt */
function SpecReceipt({ botName, draft, spec, setSpec, title, onTitle, checks, budgetInput }: { botName: string; draft: Draft; spec: JobSpec; setSpec: (s: JobSpec) => void; title: string; onTitle: (t: string) => void; checks: { id: string; title: string }[]; budgetInput: string }) {
  const patch = (p: Partial<JobSpec>) => setSpec({ ...spec, ...p })
  const setDel = (i: number, d: Partial<JobSpec['deliverables'][number]>) => patch({ deliverables: spec.deliverables.map((x, j) => (j === i ? { ...x, ...d } : x)) })
  const policy = draft.policy.class as PolicyClass
  const over = Number(draft.estimate.value) > Number(spec.budget_cap.value)
  const outOfScope = useMemo(() => spec.out_of_scope.join('\n'), [spec.out_of_scope])
  const [oosText, setOosText] = useState(outOfScope)
  void budgetInput

  return (
    <div className="relative">
      <Receipt title="Job spec" className="mx-auto max-w-3xl">
        <PrintLine delay={0.05}>
          <p className="text-center text-[0.7rem] text-pmute">to: {botName}</p>
        </PrintLine>
        <ReceiptRule />

        <PrintLine delay={0.1}>
          <Lbl htmlFor="spec-title">Job title</Lbl>
          <input id="spec-title" className="field field-paper" maxLength={140} value={title} onChange={(e) => onTitle(e.target.value)} placeholder="Short name for this job" />
        </PrintLine>
        <PrintLine delay={0.15} className="mt-3">
          <Lbl htmlFor="spec-goal">Goal</Lbl>
          <textarea id="spec-goal" className="field field-paper" rows={2} value={spec.goal} onChange={(e) => patch({ goal: e.target.value })} />
        </PrintLine>

        <ReceiptRule />
        <p className="mb-2 text-[0.7rem] font-bold uppercase tracking-[0.2em]">Deliverables</p>
        {spec.deliverables.map((d, i) => (
          <PrintLine key={d.id + i} delay={0.25 + i * 0.1} className="mb-3 rounded-md border border-pink/20 bg-white/30 p-3">
            <div className="flex items-start gap-3">
              <span className="mt-1 rounded bg-pink px-1.5 py-0.5 text-[11px] font-bold text-paper">{d.id}</span>
              <div className="min-w-0 flex-1 space-y-2">
                <textarea aria-label={`${d.id} description`} className="field field-paper" rows={2} value={d.description} onChange={(e) => setDel(i, { description: e.target.value })} />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-[12px]">
                    Quantity
                    <input type="number" min={1} className="field field-paper w-24" value={d.quantity} onChange={(e) => setDel(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
                  </label>
                  {spec.deliverables.length > 1 && (
                    <button className="ml-auto text-[12px] text-coral-deep underline underline-offset-2" onClick={() => patch({ deliverables: spec.deliverables.filter((_, j) => j !== i) })}>
                      Remove deliverable
                    </button>
                  )}
                </div>
                <div>
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-pmute">Acceptance tests</p>
                  {d.acceptance.map((t, ti) => (
                    <TestRow
                      key={ti + t.check}
                      test={t}
                      checks={checks}
                      onChange={(nt) => setDel(i, { acceptance: d.acceptance.map((x, j) => (j === ti ? nt : x)) })}
                      onRemove={d.acceptance.length > 1 ? () => setDel(i, { acceptance: d.acceptance.filter((_, j) => j !== ti) }) : undefined}
                    />
                  ))}
                  <button className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold underline underline-offset-2" onClick={() => setDel(i, { acceptance: [...d.acceptance, { check: checks[0]?.id ?? 'screenshot_attached', params: {} }] })}>
                    <Plus className="size-3" aria-hidden /> Add test
                  </button>
                </div>
                {d.rubric && <p className="text-[12px] text-pmute">Rubric (judged by the mediator only): {d.rubric}</p>}
              </div>
            </div>
          </PrintLine>
        ))}
        {spec.deliverables.length < 10 && (
          <button
            className="mb-1 inline-flex items-center gap-1 text-[12px] font-semibold underline underline-offset-2"
            onClick={() => patch({ deliverables: [...spec.deliverables, { id: `D${spec.deliverables.length + 1}`, description: 'Describe the deliverable', quantity: 1, acceptance: [{ check: checks[0]?.id ?? 'screenshot_attached', params: {} }], rubric: '' }] })}
          >
            <Plus className="size-3" aria-hidden /> Add deliverable
          </button>
        )}

        <ReceiptRule />
        <PrintLine delay={0.4} className="grid gap-3 sm:grid-cols-2">
          <div>
            <Lbl htmlFor="spec-deadline">Deadline</Lbl>
            <input id="spec-deadline" type="datetime-local" className="field field-paper" value={toLocal(spec.deadline)} onChange={(e) => e.target.value && patch({ deadline: fromLocal(e.target.value)! })} />
          </div>
          <div>
            <Lbl htmlFor="spec-budget">Budget cap (USD)</Lbl>
            <input id="spec-budget" type="number" min={1} step="0.01" className="field field-paper" value={spec.budget_cap.value} onChange={(e) => patch({ budget_cap: { value: Number(e.target.value || 0).toFixed(2), currency: 'USD' } })} />
          </div>
        </PrintLine>
        <PrintLine delay={0.45} className="mt-3">
          <Lbl htmlFor="spec-oos">Out of scope (one per line)</Lbl>
          <textarea
            id="spec-oos"
            className="field field-paper"
            rows={2}
            value={oosText}
            onChange={(e) => {
              setOosText(e.target.value)
              patch({ out_of_scope: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
            }}
          />
        </PrintLine>
        {spec.context && (
          <PrintLine delay={0.5} className="mt-3">
            <Lbl htmlFor="spec-ctx">Context</Lbl>
            <textarea id="spec-ctx" className="field field-paper" rows={2} value={spec.context} onChange={(e) => patch({ context: e.target.value })} />
          </PrintLine>
        )}

        <ReceiptRule double />
        <PrintLine delay={0.55}>
          <ReceiptRow label="Estimate" value={usd(draft.estimate)} strong />
          <ReceiptRow label="Budget cap" value={usd(spec.budget_cap)} tone={over ? 'coral' : 'mute'} />
          <p className="mt-1 text-[0.72rem] text-pmute">Authorized on PayPal when both sides sign. Not taken until units are verified.</p>
        </PrintLine>

        {draft.warnings.length > 0 && (
          <PrintLine delay={0.65} className="mt-3 rounded-md border border-amber-deep/50 bg-amber/15 p-3">
            <p className="text-[0.7rem] font-bold uppercase tracking-widest text-amber-deep">Copilot warnings</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-[12.5px]">
              {draft.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </PrintLine>
        )}
        {over && <p className="mt-2 text-[12.5px] font-semibold text-coral-deep">The estimate is above your budget cap. The seller can only quote up to the cap.</p>}

        <ReceiptRule />
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12px]">
            <span className="font-bold uppercase tracking-widest">Policy gate</span>
            {draft.policy.reasons.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-pmute">
                {draft.policy.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
          {policy === 'blocked' ? (
            <Stamp kind="flagged" rotate={-7} size="md">
              FLAGGED
            </Stamp>
          ) : policy === 'restricted' ? (
            <Stamp kind="held" rotate={-5} size="sm">
              RESTRICTED
            </Stamp>
          ) : (
            <Stamp kind="verified" rotate={-5} size="sm" delay={0.8}>
              POLICY CLEAR
            </Stamp>
          )}
        </div>
      </Receipt>
    </div>
  )
}

function Lbl({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-[0.7rem] font-bold uppercase tracking-[0.2em]">
      {children}
    </label>
  )
}

function TestRow({ test, checks, onChange, onRemove }: { test: { check: string; params: Record<string, unknown> }; checks: { id: string; title: string }[]; onChange: (t: { check: string; params: Record<string, unknown> }) => void; onRemove?: () => void }) {
  const [text, setText] = useState(JSON.stringify(test.params ?? {}))
  const [bad, setBad] = useState(false)
  const options = checks.some((c) => c.id === test.check) ? checks : [...checks, { id: test.check, title: test.check }]
  return (
    <div className="mb-1.5 flex flex-wrap items-start gap-2">
      <select aria-label="Check" className="field field-paper w-auto min-w-[10rem] flex-1 !py-1.5 text-[12px]" value={test.check} onChange={(e) => onChange({ ...test, check: e.target.value })}>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id}
          </option>
        ))}
      </select>
      <div className="min-w-[10rem] flex-[2]">
        <input
          aria-label="Check params as JSON"
          aria-invalid={bad}
          className={`field field-paper !py-1.5 text-[12px] ${bad ? '!border-coral-deep' : ''}`}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            try {
              const v = JSON.parse(e.target.value || '{}')
              if (v && typeof v === 'object' && !Array.isArray(v)) {
                setBad(false)
                onChange({ ...test, params: v })
              } else setBad(true)
            } catch {
              setBad(true)
            }
          }}
        />
        {bad && <p className="mt-0.5 text-[11px] text-coral-deep">Params must be a JSON object.</p>}
      </div>
      {onRemove && (
        <button onClick={onRemove} aria-label="Remove test" className="mt-1 rounded p-1 text-pmute hover:bg-pink/10 hover:text-pink">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
