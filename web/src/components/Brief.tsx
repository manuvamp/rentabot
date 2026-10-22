// A skill's brief, shown three ways: a tiny Needs / Does / You get row on cards, sticky notes on the bot page,
// and the "when it talks to you" strip.
import { ClipboardList, Gift, KeyRound, Lock, MessageCircleQuestion, PackageCheck, Radio, Wallet, Zap, type LucideIcon } from 'lucide-react'
import type { SkillBrief } from '@rentabot/shared'

type Action = SkillBrief['does'][number]['action']

const VERB: Record<Action, string> = {
  send_email: 'sends email',
  create_account: 'makes accounts',
  fill_form: 'fills forms',
  post_content: 'posts',
  call_api: 'calls APIs',
  browse: 'reads the web',
  write: 'writes',
  analyze: 'checks',
}
/** The most "out in the world" action first: that is the one a card names. */
const WEIGHT: Action[] = ['send_email', 'create_account', 'fill_form', 'post_content', 'call_api', 'browse', 'write', 'analyze']

const headline = (b: SkillBrief) => [...b.does].sort((x, y) => WEIGHT.indexOf(x.action) - WEIGHT.indexOf(y.action))[0]

/** One compact row of three tabs under a card's tagline. */
export function BriefTabs({ brief }: { brief: SkillBrief }) {
  const top = headline(brief)
  const needLock = brief.needs.some((n) => n.sensitive)
  const getLock = brief.returns.some((r) => r.sensitive)
  const tabs: [LucideIcon, string, string, boolean][] = [
    [ClipboardList, 'Needs', String(brief.needs.length), needLock],
    [Zap, 'Does', top ? VERB[top.action] : '–', false],
    [Gift, 'You get', String(brief.returns.length), getLock],
  ]
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="What it needs, does and returns">
      {tabs.map(([Icon, k, v, lock]) => (
        <li key={k} className="flex items-center gap-1 whitespace-nowrap rounded-md border border-pink/15 bg-paper-2/70 px-1.5 py-1 text-[11px] leading-none text-pink/80">
          <Icon className="size-3 shrink-0" aria-hidden />
          <span className="shrink-0 font-semibold">{k}</span>
          <span className="font-mono text-pink">{v}</span>
          {lock && <Lock className="size-3 shrink-0 text-coral-deep" aria-label="includes logins, kept encrypted" />}
        </li>
      ))}
    </ul>
  )
}

const NOTE = 'note relative !font-sans'

/** Three sticky notes: It needs, It does, You get. Sensitive items get a lock and "encrypted in your locker". */
export function BriefNotes({ brief, demo }: { brief: SkillBrief; demo: boolean }) {
  return (
    <div className="grid gap-5 sm:grid-cols-3">
      <div className={NOTE} style={{ ['--note' as string]: '#FFD84D', ['--r' as string]: '-1.2deg' }}>
        <NoteHead icon={ClipboardList}>It needs</NoteHead>
        <ul className="mt-2 space-y-1.5">
          {brief.needs.map((n) => (
            <li key={n.label} className="text-[14px] leading-snug" title={n.why || undefined}>
              <span className="font-semibold">{n.label}</span>
              {n.sensitive && <Locker />}
            </li>
          ))}
        </ul>
      </div>
      <div className={NOTE} style={{ ['--note' as string]: '#C9B8FF', ['--r' as string]: '0.8deg' }}>
        <NoteHead icon={Zap}>It does</NoteHead>
        <ul className="mt-2 space-y-1.5">
          {brief.does.map((d) => (
            <li key={d.label} className="text-[14px] leading-snug">
              <span className="font-semibold">{d.label}</span>
              {d.limit && <span className="ml-1.5 inline-block max-w-full whitespace-normal rounded bg-ink/10 px-1 align-top font-mono text-[11px]">{d.limit}</span>}
            </li>
          ))}
        </ul>
        {demo && <p className="mt-2.5 font-mono text-[10.5px] text-ink/60">demo: on Sandbox Web only</p>}
      </div>
      <div className={NOTE} style={{ ['--note' as string]: '#8BE3B4', ['--r' as string]: '-0.6deg' }}>
        <NoteHead icon={Gift}>You get</NoteHead>
        <ul className="mt-2 space-y-1.5">
          {brief.returns.map((r) => (
            <li key={r.label} className="text-[14px] leading-snug">
              <span className="font-semibold">{r.label}</span>
              {r.sensitive && <Locker />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function NoteHead({ icon: Icon, children }: { icon: LucideIcon; children: string }) {
  return (
    <p className="flex items-center gap-1.5 font-hand text-[1.6rem] leading-none">
      <Icon className="size-4" aria-hidden /> {children}
    </p>
  )
}

function Locker() {
  return (
    <span className="mt-0.5 flex items-center gap-1 font-mono text-[10.5px] text-coral-deep">
      <Lock className="size-3" aria-hidden /> encrypted in your locker
    </span>
  )
}

const TALK: [LucideIcon, string, string][] = [
  [MessageCircleQuestion, 'Before you sign', 'asks questions'],
  [KeyRound, 'After you sign', 'asks for access'],
  [Radio, 'While working', 'progress per unit'],
  [PackageCheck, 'On delivery', 'proof per unit'],
  [Wallet, 'When you pay', 'hands over logins'],
]

/** When the bot talks to you, as five steps. The access and handover steps drop out when the brief has nothing sensitive. */
export function TalkStrip({ brief }: { brief?: SkillBrief }) {
  const access = !brief || brief.needs.some((n) => n.kind === 'access')
  const handover = !brief || brief.returns.some((r) => r.sensitive)
  const steps = TALK.filter((_, i) => (i === 1 ? access : i === 4 ? handover : true))
  return (
    <section aria-labelledby="talk-h">
      <h3 id="talk-h" className="font-display text-xl font-bold tracking-tight">
        When it talks to you
      </h3>
      <ol className="mt-3 flex flex-wrap gap-2">
        {steps.map(([Icon, when, what], i) => (
          <li key={when} className="flex items-center gap-2 rounded-xl border border-line bg-ink-1 py-2 pl-2 pr-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-hl font-mono text-[12px] font-bold text-ink">{i + 1}</span>
            <span className="leading-tight">
              <span className="block text-[11px] uppercase tracking-widest text-mute">{when}</span>
              <span className="flex items-center gap-1 text-[14px] text-fog">
                <Icon className="size-3.5 text-hl" aria-hidden /> {what}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
