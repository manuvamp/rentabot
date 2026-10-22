import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, Send, Sparkles } from 'lucide-react'
import { callOp } from '../../api/client'
import { useAction, useAsync } from '../../api/hooks'
import type { AwardMode, JobSpec, OpOutput } from '../../api/types'
import { Button, Container, ErrorBox, Receipt, ReceiptRow, ReceiptRule, Skeleton, Stamp } from '../../components/ui'
import { usd } from '../../lib/format'
import { AWARD_HINT, AWARD_LABEL, CheckChip } from './parts'

type Draft = OpOutput<'draft_job_spec'>

const WINDOWS: { id: string; label: string }[] = [
  { id: 'PT15M', label: '15 min' },
  { id: 'PT1H', label: '1 hour' },
  { id: 'PT2H', label: '2 hours' },
  { id: 'P1D', label: '1 day' },
  { id: 'P3D', label: '3 days' },
]
const MODES: AwardMode[] = ['manual', 'lowest_price', 'best_record']

const toLocal = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined)

export default function PostOpenJob() {
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const bots = useAsync(() => callOp('search_bots', { limit: 50 }), [])
  const skills = useMemo(() => {
    const m = new Map<string, { title: string; bots: number; example?: string }>()
    for (const b of bots.data?.bots ?? [])
      for (const s of b.skills) {
        const cur = m.get(s.id)
        m.set(s.id, { title: cur?.title ?? s.title, bots: (cur?.bots ?? 0) + 1 })
      }
    return [...m].sort((a, b) => a[1].title.localeCompare(b[1].title))
  }, [bots.data])

  const [goal, setGoal] = useState((sp.get('goal') ?? '').slice(0, 1000))
  const [skillId, setSkillId] = useState(sp.get('skill') ?? '')
  const [quantity, setQuantity] = useState('')
  const [deadline, setDeadline] = useState('')
  const [budget, setBudget] = useState(sp.get('budget') ?? '')
  const [context, setContext] = useState('')
  const [bidWindow, setBidWindow] = useState('PT2H')
  const [award, setAward] = useState<AwardMode>('manual')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [spec, setSpec] = useState<JobSpec | null>(null)
  const [title, setTitle] = useState('')
  const idem = useRef(`open-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`)

  useEffect(() => {
    if (skills.length && !skills.some(([id]) => id === skillId)) setSkillId(skills[0][0])
  }, [skills, skillId])
  const skill = skills.find(([id]) => id === skillId)?.[1]

  const drafting = useAction(async () => {
    // The Spec Copilot drafts against one bot's skill; any listed bot with the skill gives the same checks and limits.
    const found = await callOp('search_bots', { skill: skillId, limit: 1 })
    const bot = found.bots[0]
    if (!bot) throw new Error('No listed bot has this skill right now, so nobody could bid. Pick another skill.')
    const out = await callOp('draft_job_spec', {
      bot_id: bot.id as never,
      skill_id: skillId,
      goal,
      quantity: quantity ? Number(quantity) : undefined,
      deadline: fromLocal(deadline),
      budget_cap: budget ? Number(budget).toFixed(2) : undefined,
      context: context || undefined,
    })
    setDraft(out)
    setSpec(out.spec)
    setTitle(goal.slice(0, 120))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  const posting = useAction(async () => {
    if (!spec) return
    const out = await callOp('post_open_job', { spec, title: (title || spec.goal).slice(0, 140), bid_window: bidWindow, award, idempotency_key: idem.current })
    navigate(`/explore/${out.open_job.id}`)
  })

  const step = draft && spec ? 2 : 1
  const patch = (p: Partial<JobSpec>) => spec && setSpec({ ...spec, ...p })

  return (
    <Container className="py-10 sm:py-14">
      <Link to="/explore" className="mb-6 inline-flex items-center gap-1.5 text-sm text-soft hover:text-hl">
        <ArrowLeft className="size-4" aria-hidden /> Open jobs
      </Link>
      <div className="grid gap-12 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div>
          <p className="eyebrow mb-3">Post to all bots</p>
          <h1 className="display text-[clamp(2.4rem,5vw,3.6rem)]">{step === 1 ? 'Say it once.' : 'Check it. Post it.'}</h1>
          <ol className="mt-8 space-y-4" aria-label="Steps">
            {[
              ['Goal', 'Plain words.'],
              ['Spec and rules', 'Window and who wins.'],
              ['Bids', 'Nothing charged until you award and fund.'],
            ].map(([t, d], i) => {
              const state = i + 1 < step ? 'done' : i + 1 === step ? 'now' : 'next'
              return (
                <li key={t} className="flex gap-3" aria-current={state === 'now' ? 'step' : undefined}>
                  <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full font-mono text-[11px] font-bold ${state === 'done' ? 'bg-hl text-ink' : state === 'now' ? 'border-2 border-hl text-hl' : 'border border-line text-mute'}`}>{i + 1}</span>
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
          {step === 1 ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void drafting.run()
              }}
              className="panel space-y-5 p-5 sm:p-7"
            >
              <Field label="Goal" htmlFor="goal" hint="What should be true when the job is done?">
                <textarea id="goal" required minLength={10} maxLength={1000} rows={4} className="field" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Get my product listed on 40 AI directories before launch." />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Skill" htmlFor="skill" hint={skill ? `${skill.bots} listed bot${skill.bots === 1 ? '' : 's'} can bid` : undefined}>
                  {bots.data ? (
                    <select id="skill" className="field" value={skillId} onChange={(e) => setSkillId(e.target.value)} required>
                      {skills.map(([id, s]) => (
                        <option key={id} value={id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Skeleton className="h-10" />
                  )}
                </Field>
                <Field label="Quantity (optional)" htmlFor="qty">
                  <input id="qty" type="number" min={1} className="field font-mono" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="1" />
                </Field>
                <Field label="Deadline (optional)" htmlFor="deadline">
                  <input id="deadline" type="datetime-local" className="field font-mono" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                </Field>
                <Field label="Budget cap in USD (optional)" htmlFor="budget" hint="No bid can go above it. At least $5.00.">
                  <input id="budget" type="number" min={5} step="0.01" className="field font-mono" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="80.00" />
                </Field>
              </div>
              <Field label="Context (optional, private)" htmlFor="ctx" hint="Only the winner sees it. No passwords.">
                <textarea id="ctx" rows={3} maxLength={8000} className="field" value={context} onChange={(e) => setContext(e.target.value)} placeholder="ORANO is a personal AI assistant. Site: https://oranoai.com" />
              </Field>
              <ErrorBox error={bots.error} title="Could not load the skills" onRetry={bots.reload} />
              <ErrorBox error={drafting.error} title="The Spec Copilot could not draft that" />
              <div className="flex flex-wrap items-center justify-between gap-4">
                <p className="text-[13px] text-mute">Drafting creates nothing and charges nothing.</p>
                <Button type="submit" size="lg" loading={drafting.pending} disabled={!skillId} icon={<Sparkles className="size-4" />}>
                  {drafting.pending ? 'Drafting…' : 'Draft the spec'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="space-y-8">
              <Receipt title="Open job" className="mx-auto max-w-3xl">
                <p className="text-center text-[0.7rem] text-pmute">to: every bot with {skill?.title ?? spec!.skill_id}</p>
                <ReceiptRule />
                <Lbl htmlFor="oj-title">Title on the board</Lbl>
                <input id="oj-title" className="field field-paper" maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} />
                <div className="mt-3">
                  <Lbl htmlFor="oj-goal">Goal</Lbl>
                  <textarea id="oj-goal" className="field field-paper" rows={2} minLength={10} maxLength={1000} value={spec!.goal} onChange={(e) => patch({ goal: e.target.value })} />
                </div>
                <ReceiptRule />
                <p className="mb-2 text-[0.7rem] font-bold uppercase tracking-[0.2em]">Deliverables</p>
                <ul className="space-y-2.5">
                  {spec!.deliverables.map((d, i) => (
                    <li key={d.id} className="rounded-md border border-pink/20 bg-white/30 p-3">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 rounded bg-pink px-1.5 py-0.5 text-[11px] font-bold text-paper">{d.id}</span>
                        <div className="min-w-0 flex-1">
                          <p className="font-sans text-[13px] leading-snug">{d.description}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label className="flex items-center gap-2 text-[12px]">
                              Quantity
                              <input
                                type="number"
                                min={1}
                                className="field field-paper w-24 !py-1"
                                value={d.quantity}
                                onChange={(e) => patch({ deliverables: spec!.deliverables.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)) })}
                              />
                            </label>
                            <span className="flex flex-wrap gap-1" aria-label="Acceptance checks">
                              {d.acceptance.map((a, ai) => (
                                <CheckChip key={a.check + ai} id={a.check} />
                              ))}
                            </span>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <ReceiptRule />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Lbl htmlFor="oj-deadline">Deadline</Lbl>
                    <input id="oj-deadline" type="datetime-local" className="field field-paper" value={toLocal(spec!.deadline)} onChange={(e) => e.target.value && patch({ deadline: fromLocal(e.target.value)! })} />
                  </div>
                  <div>
                    <Lbl htmlFor="oj-budget">Budget cap (USD)</Lbl>
                    <input id="oj-budget" type="number" min={5} step="0.01" className="field field-paper" value={spec!.budget_cap.value} onChange={(e) => patch({ budget_cap: { value: Number(e.target.value || 0).toFixed(2), currency: 'USD' } })} />
                  </div>
                </div>
                <ReceiptRule double />
                <ReceiptRow label="Copilot estimate" value={usd(draft!.estimate)} />
                <ReceiptRow label="Budget cap" value={usd(spec!.budget_cap)} strong />
                <p className="mt-1 text-[0.72rem] text-pmute">Nothing is charged until you award and fund.</p>
                {draft!.warnings.length > 0 && (
                  <div className="mt-3 rounded-md border border-pink/20 bg-lav/40 p-3">
                    <p className="text-[0.7rem] font-bold uppercase tracking-widest text-pink">Copilot warnings</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4 font-sans text-[12.5px]">
                      {draft!.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <ReceiptRule />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[12px]">
                    <span className="font-bold uppercase tracking-widest">Policy gate</span>
                    {draft!.policy.reasons.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 text-pmute">
                        {draft!.policy.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {draft!.policy.class === 'blocked' ? (
                    <Stamp kind="flagged" rotate={-7} size="md">
                      FLAGGED
                    </Stamp>
                  ) : draft!.policy.class === 'restricted' ? (
                    <Stamp kind="held" rotate={-5} size="sm">
                      RESTRICTED
                    </Stamp>
                  ) : (
                    <Stamp kind="verified" rotate={-5} size="sm" delay={0.3}>
                      POLICY CLEAR
                    </Stamp>
                  )}
                </div>
              </Receipt>

              <div className="panel space-y-6 p-5 sm:p-7">
                <fieldset>
                  <legend className="mb-2 text-[13px] font-semibold text-fog">Bid window</legend>
                  <div className="flex flex-wrap gap-2">
                    {WINDOWS.map((w) => (
                      <label key={w.id} className={`cursor-pointer rounded-lg border px-3.5 py-2 font-mono text-[13px] transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-hl ${bidWindow === w.id ? 'border-hl bg-hl/10 text-hl' : 'border-line text-soft hover:border-soft'}`}>
                        <input type="radio" name="bid-window" value={w.id} checked={bidWindow === w.id} onChange={() => setBidWindow(w.id)} className="sr-only" />
                        {w.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="mb-2 text-[13px] font-semibold text-fog">Who wins</legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {MODES.map((m) => (
                      <label key={m} className={`cursor-pointer rounded-xl border p-3.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-hl ${award === m ? 'border-hl bg-hl/10' : 'border-line hover:border-soft'}`}>
                        <input type="radio" name="award" value={m} checked={award === m} onChange={() => setAward(m)} className="sr-only" />
                        <span className={`block text-sm font-semibold ${award === m ? 'text-hl' : 'text-fog'}`}>{AWARD_LABEL[m]}</span>
                        <span className="mt-1 block text-[12.5px] leading-snug text-mute">{AWARD_HINT[m].replace('The buyer compares', 'You compare').replace('awards one by hand', 'award one by hand')}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>

              <ErrorBox error={posting.error} title="The open job was not posted" />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button variant="ghost" onClick={() => { setDraft(null); setSpec(null) }}>
                  Back to goal
                </Button>
                <div className="flex flex-wrap items-center gap-3">
                  {draft!.policy.class === 'blocked' && <span className="text-sm text-coral">Blocked by the policy gate. Change the goal.</span>}
                  <Button size="lg" onClick={() => void posting.run()} loading={posting.pending} disabled={draft!.policy.class === 'blocked'} icon={<Send className="size-4" />}>
                    Post to all bots
                  </Button>
                </div>
              </div>
            </div>
          )}
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

function Lbl({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-[0.7rem] font-bold uppercase tracking-[0.2em]">
      {children}
    </label>
  )
}
