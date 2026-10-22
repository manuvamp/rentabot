// A bot's passport: the model it runs on, what it can reach (with whose account), its tools, where it runs and
// what happens to your data. A compact chip row on cards, an "Under the hood" section on the bot page.
import { BadgeCheck, Cpu, KeyRound, Lock, Server, Shield, Sparkles, Wrench } from 'lucide-react'
import { HOUSE_PASSPORTS, type BotPassport } from '@rentabot/shared'
import { Stamp } from './ui'

type Conn = BotPassport['connections'][number]

/** "claude-sonnet-5-5" -> "Sonnet 5.5"; anything else is shown as given. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : model
}

export const RUNS_ON: Record<BotPassport['runs_on'], string> = {
  rentabot: 'Rent-A-Bot servers',
  operator_server: 'the operator’s server',
  operator_device: 'the operator’s own machine',
}

const CHIP = 'inline-flex max-w-[11rem] items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] leading-none'

/** Card row: the model, then up to three connections; "own account" when the bot brings its own. */
export function PassportChips({ passport }: { passport: BotPassport }) {
  const conns = passport.connections.slice(0, 3)
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Runs on and connects to">
      <li className={`${CHIP} border-pink/80 bg-pink font-semibold text-paper`}>
        {passport.models.length ? <Sparkles className="size-3 shrink-0" aria-hidden /> : <Cpu className="size-3 shrink-0" aria-hidden />}
        <span className="truncate">{passport.models.length ? passport.models.map((m) => modelLabel(m.model)).join(' + ') : 'no AI, rule-based'}</span>
      </li>
      {conns.map((c) => (
        <li key={c.name} className={`${CHIP} border-pink/20 text-pink/80`} title={c.purpose}>
          <span className="truncate">{c.name}</span>
          {c.owner === 'bot' ? <span className="shrink-0 font-semibold text-mint-deep">✓ own</span> : <Lock className="size-3 shrink-0 text-coral-deep" aria-label="uses your account, through the locker" />}
        </li>
      ))}
    </ul>
  )
}

function Verified({ ok }: { ok: boolean }) {
  return ok ? (
    <Stamp kind="verified" on="ink" size="xs" rotate={-4} animate={false}>
      verified by Rent-A-Bot
    </Stamp>
  ) : (
    <span className="font-mono text-[10.5px] text-mute">declared by operator</span>
  )
}

/** A passport the operator wrote themselves (anything but a house bot's own): shown as declared, never verified. */
export const isDeclared = (name: string, p: BotPassport) => JSON.stringify(HOUSE_PASSPORTS[name] ?? null) !== JSON.stringify(p)

/** The bot page's "Under the hood" section. */
export function PassportSection({ passport, declared = false }: { passport: BotPassport; declared?: boolean }) {
  const own = passport.connections.filter((c) => c.owner === 'bot')
  const yours = passport.connections.filter((c) => c.owner === 'buyer')
  return (
    <section aria-labelledby="hood-h" className="space-y-5">
      <h2 id="hood-h" className="flex flex-wrap items-baseline gap-3 font-display text-2xl font-bold tracking-tight">
        Under the hood
        {declared && <span className="font-mono text-[11px] font-normal tracking-normal text-mute">declared by operator, not verified by Rent-A-Bot</span>}
      </h2>

      {passport.unlocks.length > 0 && (
        <ul className="flex flex-wrap gap-4" aria-label="What your agent can't do alone">
          {passport.unlocks.map((u, i) => (
            <li key={u} className="note max-w-[17rem] !font-sans text-[15px] font-semibold" style={{ ['--r' as string]: `${i % 2 ? 1.2 : -1.4}deg` }}>
              <span className="mb-1 block font-hand text-[1.25rem] font-normal leading-none text-ink/70">unlocks</span>
              {u}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel p-5">
          <p className="eyebrow mb-3 flex items-center gap-1.5"><Sparkles className="size-3.5" aria-hidden /> Model</p>
          {passport.models.length ? (
            <ul className="space-y-2.5">
              {passport.models.map((m) => (
                <li key={m.model}>
                  <p className="font-display text-xl font-bold">
                    {modelLabel(m.model)} <span className="text-[13px] font-normal text-mute">{m.provider}</span>
                  </p>
                  {m.role && <p className="text-[13.5px] text-soft">{m.role}</p>}
                  <p className="mt-1 flex flex-wrap gap-1.5 font-mono text-[10.5px] text-mute">
                    {m.open_weights && <span className="rounded border border-line px-1">open weights</span>}
                    {m.zero_retention && <span className="rounded border border-line px-1">zero retention</span>}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[14px] text-soft">No AI model. Plain code, same result every run.</p>
          )}
        </div>
        <div className="panel space-y-3 p-5">
          <p className="eyebrow flex items-center gap-1.5"><Server className="size-3.5" aria-hidden /> Runs on</p>
          <p className="text-[15px] text-fog">{RUNS_ON[passport.runs_on]}</p>
          {passport.data_handling && (
            <>
              <p className="eyebrow flex items-center gap-1.5"><Shield className="size-3.5" aria-hidden /> Your data</p>
              <p className="text-[14px] text-soft">{passport.data_handling}</p>
            </>
          )}
        </div>
      </div>

      {passport.connections.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <ConnList title="Brings its own" icon={<BadgeCheck className="size-3.5 text-lime" aria-hidden />} items={own} empty="Nothing: it only uses what you give it." />
          <ConnList title="Uses yours" icon={<KeyRound className="size-3.5 text-coral" aria-hidden />} items={yours} empty="Nothing of yours." locked />
        </div>
      )}

      {passport.tools.length > 0 && (
        <div>
          <p className="eyebrow mb-2 flex items-center gap-1.5"><Wrench className="size-3.5" aria-hidden /> Tools</p>
          <ul className="flex flex-wrap gap-2">
            {passport.tools.map((t) => (
              <li key={t.name} title={t.description} className="rounded-lg border border-line bg-ink-1 px-2.5 py-1 text-[13px] text-soft">
                <span className="font-semibold text-fog">{t.name}</span>
                <span className="ml-1.5 hidden text-mute sm:inline">{t.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function ConnList({ title, icon, items, empty, locked = false }: { title: string; icon: React.ReactNode; items: Conn[]; empty: string; locked?: boolean }) {
  return (
    <div className="panel p-5">
      <p className="eyebrow mb-3 flex items-center gap-1.5">{icon} {title}</p>
      {items.length ? (
        <ul className="space-y-3">
          {items.map((c) => (
            <li key={c.name}>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-fog">
                {locked && <Lock className="size-3.5 text-coral" aria-label="through your encrypted locker" />}
                {c.name}
                <span className="font-mono text-[10.5px] font-normal text-mute">{c.kind.replace('_', ' ')}</span>
                <Verified ok={c.verified} />
              </p>
              <p className="mt-0.5 text-[13.5px] text-soft">{c.purpose}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[14px] text-mute">{empty}</p>
      )}
    </div>
  )
}
