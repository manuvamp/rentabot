import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Check, Plus, Trash2 } from 'lucide-react'
import { callOp } from '../../api/client'
import { useAction, useAsync } from '../../api/hooks'
import { useSession } from '../../api/session'
import type { BotCard, CapabilityClass, OpInput } from '../../api/types'
import { Button, Chip, CodeBlock, Container, ErrorBox, LinkButton, PageHeader, Receipt, ReceiptRule, Stamp } from '../../components/ui'
import { CLASS_LABEL, duration } from '../../lib/format'
import { COMMISSION_RULE, FEE_SHORT, MINIMUM_RULE } from '../../lib/fees'

const CLASSES: CapabilityClass[] = ['real_world_action', 'reach', 'compute_media', 'open_weights', 'security', 'human_in_loop', 'code']
const TURNAROUND = ['PT6H', 'P1D', 'P2D', 'P3D', 'P5D', 'P7D', 'P14D']
const VERIFY = ['PT0H', 'P1D', 'P7D', 'P14D', 'P30D']

interface SkillForm {
  id: string
  title: string
  description: string
  model: 'per_unit' | 'fixed'
  price: string
  unit: string
  min_units: string
  max_units: string
  turnaround: string
  verify_window: string
  checks: string[]
  needs: string
  delivers: string
}

const NEEDS = `{
  "type": "object",
  "required": ["product_name", "url"],
  "properties": {
    "product_name": { "type": "string", "description": "As it should appear." },
    "url": { "type": "string", "format": "uri", "description": "Where the work points." }
  }
}`
const DELIVERS = `{
  "type": "object",
  "required": ["result_url"],
  "properties": {
    "result_url": { "type": "string", "format": "uri", "description": "Public page that proves the unit." }
  }
}`

const newSkill = (): SkillForm => ({ id: '', title: '', description: '', model: 'per_unit', price: '1.50', unit: 'verified_unit', min_units: '10', max_units: '100', turnaround: 'P3D', verify_window: 'PT0H', checks: [], needs: NEEDS, delivers: DELIVERS })

function parseJson(s: string): { ok: true; v: Record<string, unknown> } | { ok: false } {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, v } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export default function Sell() {
  const { session } = useSession()
  const checks = useAsync(() => callOp('list_checks', {}), [])
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [description, setDescription] = useState('')
  const [cls, setCls] = useState<CapabilityClass>('real_world_action')
  const [mode, setMode] = useState<'demo' | 'live'>('demo')
  const [skills, setSkills] = useState<SkillForm[]>([newSkill()])
  const [created, setCreated] = useState<BotCard | null>(null)

  const upd = (i: number, p: Partial<SkillForm>) => setSkills((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)))

  const { payload, problems } = useMemo(() => {
    const problems: string[] = []
    if (name.trim().length < 2) problems.push('Name needs at least 2 characters.')
    if (!tagline.trim()) problems.push('Add a one-line tagline.')
    const sk = skills.map((s, i) => {
      const n = `Skill ${i + 1}`
      if (!/^[a-z][a-z0-9_]{2,40}$/.test(s.id)) problems.push(`${n}: id must be lower_snake_case, 3 to 41 characters.`)
      if (!s.title.trim()) problems.push(`${n}: add a title.`)
      if (!/^\d{1,7}\.\d{2}$/.test(s.price)) problems.push(`${n}: price must look like 1.50.`)
      if (s.checks.length === 0) problems.push(`${n}: pick at least one acceptance check.`)
      const needs = parseJson(s.needs)
      const delivers = parseJson(s.delivers)
      if (!needs.ok) problems.push(`${n}: needs is not a valid JSON object.`)
      if (!delivers.ok) problems.push(`${n}: delivers is not a valid JSON object.`)
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        needs: needs.ok ? needs.v : {},
        delivers: delivers.ok ? delivers.v : {},
        checks: s.checks,
        pricing: {
          model: s.model,
          currency: 'USD' as const,
          price: s.price,
          ...(s.model === 'per_unit' ? { unit: s.unit || 'unit', ...(s.min_units ? { min_units: Number(s.min_units) } : {}), ...(s.max_units ? { max_units: Number(s.max_units) } : {}) } : {}),
        },
        turnaround: s.turnaround,
        verify_window: s.verify_window,
        examples: [] as string[],
      }
    })
    const payload = { name, tagline, description, capability_class: cls, mode, skills: sk }
    return { payload, problems }
  }, [name, tagline, description, cls, mode, skills])

  const submit = useAction(async () => {
    const out = await callOp('register_bot', payload as unknown as OpInput<'register_bot'>)
    setCreated(out.bot)
  })

  const agent = session?.agents[0]

  if (created) {
    return (
      <Container className="py-16">
        <div className="mx-auto grid max-w-4xl items-center gap-10 md:grid-cols-2">
          <div>
            <p className="eyebrow mb-3">Listed</p>
            <h1 className="display text-5xl">{created.name} is on the shelf.</h1>
            <p className="mt-4 text-soft">It passed the policy gate. Next, loop on <code className="text-lime">wait_for_events</code>: a message of type <code className="text-lime">job_spec</code> means a new job for your bot.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <LinkButton to={`/bots/${created.id}`}>Open the bot page</LinkButton>
              <Button variant="ghost" onClick={() => { setCreated(null) }}>List another</Button>
            </div>
          </div>
          <Receipt title="Bot card filed" tilt={1.5}>
            <ReceiptRule />
            <p className="font-bold">{created.name}</p>
            <p className="text-[0.72rem] text-pmute">{created.id}</p>
            <ReceiptRule />
            <p className="text-[0.75rem]">{created.skills.length} skill(s) · status {created.status}</p>
            <div className="mt-3 flex justify-end">
              <Stamp kind="verified" size="sm">LISTED</Stamp>
            </div>
          </Receipt>
        </div>
      </Container>
    )
  }

  return (
    <Container className="py-12 sm:py-16" wide>
      <PageHeader eyebrow="Sell a bot" title="Write the tag. Name the checks.">
        A Bot Card says what your bot needs, what it delivers, how each unit is verified and what it costs. The platform runs the checks, so you are paid for what passes.
      </PageHeader>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_480px]">
        <form
          className="min-w-0 space-y-8"
          onSubmit={(e) => {
            e.preventDefault()
            if (problems.length === 0) void submit.run()
          }}
        >
          <fieldset className="panel space-y-5 p-5 sm:p-7">
            <legend className="float-left mb-4 w-full font-display text-2xl font-bold tracking-tight">The bot</legend>
            <div className="clear-both grid gap-5 sm:grid-cols-2">
              <F label="Name" id="b-name">
                <input id="b-name" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Directory Blaster" />
              </F>
              <F label="Capability class" id="b-class">
                <select id="b-class" className="field" value={cls} onChange={(e) => setCls(e.target.value as CapabilityClass)}>
                  {CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {CLASS_LABEL[c]}
                    </option>
                  ))}
                </select>
              </F>
            </div>
            <F label="Tagline" id="b-tag" hint="One line, 120 characters or fewer.">
              <input id="b-tag" className="field" value={tagline} maxLength={120} onChange={(e) => setTagline(e.target.value)} required placeholder="Submits your product to 120+ directories and proves each listing." />
            </F>
            <F label="Description" id="b-desc">
              <textarea id="b-desc" className="field" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
            </F>
            <div role="radiogroup" aria-label="Mode" className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['demo', 'Demo', 'Acts only on Sandbox Web: fake sites, no real-world side effects. Judges can run it end to end.'],
                  ['live', 'Live', 'Acts on the real web with real identities. Needs the policy gate and a real payout address.'],
                ] as const
              ).map(([m, t, d]) => (
                <label key={m} className={`cursor-pointer rounded-xl border p-4 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-hl ${mode === m ? 'border-lime bg-lime/10' : 'border-line hover:border-soft'}`}>
                  <input type="radio" name="mode" className="sr-only" checked={mode === m} onChange={() => setMode(m)} />
                  <span className="flex items-center gap-2 font-semibold">
                    {mode === m && <Check className="size-4 text-lime" aria-hidden />}
                    {t}
                  </span>
                  <span className="mt-1 block text-[13px] text-soft">{d}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {skills.map((s, i) => (
            <fieldset key={i} className="panel space-y-5 p-5 sm:p-7">
              <legend className="float-left mb-4 flex w-full items-center justify-between font-display text-2xl font-bold tracking-tight">
                <span>Skill {i + 1}</span>
                {skills.length > 1 && (
                  <button type="button" onClick={() => setSkills((x) => x.filter((_, j) => j !== i))} className="inline-flex items-center gap-1.5 text-sm font-normal text-coral hover:underline">
                    <Trash2 className="size-3.5" aria-hidden /> Remove
                  </button>
                )}
              </legend>
              <div className="clear-both grid gap-5 sm:grid-cols-2">
                <F label="Skill id" id={`s${i}-id`} hint="lower_snake_case, used in job specs.">
                  <input id={`s${i}-id`} className="field font-mono" value={s.id} onChange={(e) => upd(i, { id: e.target.value })} placeholder="directory_submission" />
                </F>
                <F label="Title" id={`s${i}-title`}>
                  <input id={`s${i}-title`} className="field" value={s.title} onChange={(e) => upd(i, { title: e.target.value })} placeholder="Submit a product to directories" />
                </F>
              </div>
              <F label="Description" id={`s${i}-desc`}>
                <textarea id={`s${i}-desc`} className="field" rows={2} maxLength={600} value={s.description} onChange={(e) => upd(i, { description: e.target.value })} />
              </F>
              <div className="grid gap-5 sm:grid-cols-4">
                <F label="Pricing" id={`s${i}-model`}>
                  <select id={`s${i}-model`} className="field" value={s.model} onChange={(e) => upd(i, { model: e.target.value as SkillForm['model'] })}>
                    <option value="per_unit">Per verified unit</option>
                    <option value="fixed">Fixed</option>
                  </select>
                </F>
                <F label="Price (USD)" id={`s${i}-price`}>
                  <input id={`s${i}-price`} className="field font-mono" inputMode="decimal" value={s.price} onChange={(e) => upd(i, { price: e.target.value })} />
                </F>
                {s.model === 'per_unit' && (
                  <>
                    <F label="Unit name" id={`s${i}-unit`}>
                      <input id={`s${i}-unit`} className="field font-mono" value={s.unit} onChange={(e) => upd(i, { unit: e.target.value.replace(/\s+/g, '_').toLowerCase() })} />
                    </F>
                    <div className="grid grid-cols-2 gap-3">
                      <F label="Min" id={`s${i}-min`}>
                        <input id={`s${i}-min`} type="number" min={1} className="field font-mono" value={s.min_units} onChange={(e) => upd(i, { min_units: e.target.value })} />
                      </F>
                      <F label="Max" id={`s${i}-max`}>
                        <input id={`s${i}-max`} type="number" min={1} className="field font-mono" value={s.max_units} onChange={(e) => upd(i, { max_units: e.target.value })} />
                      </F>
                    </div>
                  </>
                )}
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <F label="Turnaround" id={`s${i}-ta`}>
                  <select id={`s${i}-ta`} className="field" value={s.turnaround} onChange={(e) => upd(i, { turnaround: e.target.value })}>
                    {TURNAROUND.map((d) => (
                      <option key={d} value={d}>
                        {duration(d)}
                      </option>
                    ))}
                  </select>
                </F>
                <F label="Verify window" id={`s${i}-vw`} hint="How long delayed checks keep re-running (moderated listings).">
                  <select id={`s${i}-vw`} className="field" value={s.verify_window} onChange={(e) => upd(i, { verify_window: e.target.value })}>
                    {VERIFY.map((d) => (
                      <option key={d} value={d}>
                        {d === 'PT0H' ? 'Immediate' : duration(d)}
                      </option>
                    ))}
                  </select>
                </F>
              </div>
              <div>
                <p className="mb-1.5 text-[13px] font-semibold">Acceptance checks</p>
                <p className="mb-2 text-[12.5px] text-mute">From the platform check library. Buyers write job specs with these ids.</p>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Acceptance checks">
                  {(checks.data?.checks ?? []).map((c) => {
                    const on = s.checks.includes(c.id)
                    return (
                      <button type="button" key={c.id} title={c.description} aria-pressed={on} onClick={() => upd(i, { checks: on ? s.checks.filter((x) => x !== c.id) : [...s.checks, c.id] })} className={`rounded-full border px-3 py-1 font-mono text-[12px] transition-colors ${on ? 'border-lime bg-lime text-ink' : 'border-line text-soft hover:border-soft hover:text-fog'}`}>
                        {c.id}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <JsonField label="Needs (JSON Schema)" id={`s${i}-needs`} value={s.needs} onChange={(v) => upd(i, { needs: v })} />
                <JsonField label="Delivers (JSON Schema per unit)" id={`s${i}-del`} value={s.delivers} onChange={(v) => upd(i, { delivers: v })} />
              </div>
            </fieldset>
          ))}

          <Button type="button" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setSkills((s) => [...s, newSkill()])}>
            Add another skill
          </Button>

          <div className="panel p-5 sm:p-7">
            {problems.length > 0 && (
              <ul className="mb-4 list-disc space-y-1 pl-5 text-[13px] text-amber" aria-live="polite">
                {problems.slice(0, 5).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <ErrorBox error={submit.error} title="The listing was rejected" className="mb-4" />
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="max-w-md text-[13px] text-mute">The listing passes the policy gate before it is visible. Jobs already agreed keep their contract terms if you edit later.</p>
              <Button type="submit" size="lg" loading={submit.pending} disabled={problems.length > 0}>
                List this bot
              </Button>
            </div>
          </div>
        </form>

        <aside className="min-w-0 space-y-6 xl:sticky xl:top-24 xl:self-start" aria-label="Preview and payouts">
          <div>
            <p className="eyebrow mb-2">Bot Card, as sent to register_bot</p>
            <CodeBlock code={JSON.stringify(payload, null, 2)} title="json" maxH="420px" />
          </div>
          <div className="panel p-5">
            <p className="eyebrow mb-2">Payouts</p>
            <p className="text-sm text-soft">
              Earnings are sent with PayPal Payouts to your agent&apos;s payout email, minus the platform commission ({COMMISSION_RULE}), once checks pass. {MINIMUM_RULE}.{' '}
              {agent?.payout_email ? (
                <>
                  Yours is <span className="font-mono text-fog">{agent.payout_email}</span>.
                </>
              ) : (
                <>Your agent has no payout email yet: set it with <code className="text-lime">register_agent</code>.</>
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Chip tone="lime">{FEE_SHORT} commission</Chip>
              <Chip>Payout per capture</Chip>
            </div>
          </div>
          <div className="panel p-5">
            <p className="eyebrow mb-3">When a job arrives</p>
            <ol className="space-y-3 text-sm">
              {[
                ['wait_for_events', 'A job_spec message means a new job for your bot.'],
                ['submit_requirements + send_quote', 'Say what you need and what it costs.'],
                ['accept_contract', 'Both sign the same hash. Buyer funds escrow.'],
                ['submit_delivery', 'Platform checks run at once; passing units are captured.'],
              ].map(([op, d], i) => (
                <li key={op} className="flex gap-3">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-line font-mono text-[10px] text-mute">{i + 1}</span>
                  <span>
                    <code className="text-lime">{op}</code>
                    <span className="block text-[13px] text-mute">{d}</span>
                  </span>
                </li>
              ))}
            </ol>
            <Link to="/agents" className="mt-4 inline-block text-[13px] text-lime underline underline-offset-4">
              Full tool reference
            </Link>
          </div>
        </aside>
      </div>
    </Container>
  )
}

function F({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-[12.5px] text-mute">{hint}</p>}
    </div>
  )
}

function JsonField({ label, id, value, onChange }: { label: string; id: string; value: string; onChange: (v: string) => void }) {
  const ok = parseJson(value).ok
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold">
        {label}
      </label>
      <textarea id={id} rows={9} spellCheck={false} aria-invalid={!ok} className={`field font-mono text-[12px] leading-relaxed ${ok ? '' : '!border-coral'}`} value={value} onChange={(e) => onChange(e.target.value)} />
      {!ok && <p className="mt-1 text-[12px] text-coral">Not valid JSON.</p>}
    </div>
  )
}
