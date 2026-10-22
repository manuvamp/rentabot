// One small animated scene per house bot, showing the work it actually does. Pieces move with transform/opacity only.
import { Check, KeyRound, Mail, MailCheck, UserPlus, X } from 'lucide-react'
import { MOVE, pop, useLoop } from './useLoop'

const CARD = 'rounded-md bg-[#fbf8f1] text-ink shadow-[0_3px_6px_-3px_rgba(0,0,0,0.45)]'
const TAG = 'rounded bg-ink px-1.5 py-px font-mono text-[10.5px] font-bold text-hl'

export interface SceneProps {
  dark?: boolean
}

// ---------- Directory Blaster: listing tiles stamped LIVE one by one ----------
const DIRS = ['AIHunt', 'SaaSHub', 'Launchly', 'ToolPile', 'Stackr', 'MCP List']
/** Tiles whose directory needs an account first: a key pops in (login handed over), then LIVE. */
const NEEDS_ACCOUNT = new Set([1, 4])
export function DirectoryScene() {
  const { ref, step } = useLoop(7, 650)
  const live = step
  return (
    <div ref={ref} className="absolute inset-0 px-3 pb-6 pt-10" aria-hidden>
      <div className="grid grid-cols-3 gap-1.5">
        {DIRS.map((d, i) => (
          <div key={d} className={`${CARD} relative h-[44px] p-1.5`}>
            <div className="flex items-center gap-1">
              <span className="size-2.5 rounded-sm bg-ink/75" />
              <span className="truncate font-mono text-[9px] font-semibold">{d}</span>
            </div>
            <div className="mt-1.5 h-1 w-4/5 rounded bg-ink/15" />
            <div className="mt-1 h-1 w-1/2 rounded bg-ink/15" />
            {NEEDS_ACCOUNT.has(i) && (
              <span className={`${MOVE} absolute -bottom-1 left-1 flex items-center gap-0.5 rounded bg-hl px-1 font-mono text-[8.5px] font-bold`} style={pop(step >= i, 'scale(0.5)')}>
                <KeyRound className="size-2.5" aria-hidden /> account
              </span>
            )}
            <span className={`${MOVE} absolute -bottom-1 right-0.5`} style={pop(live > i)}>
              <span className="block -rotate-12 rounded-[4px] border-2 border-mint-deep bg-[#fbf8f1]/85 px-1 font-mono text-[10px] font-extrabold tracking-wider text-mint-deep">LIVE</span>
            </span>
          </div>
        ))}
      </div>
      <span className={`absolute bottom-2.5 left-3 ${TAG}`}>{Math.round((live * 40) / 6)}/40 live</span>
    </div>
  )
}

// ---------- Investor Outreach Bot: envelopes leave your inbox, land, one reply comes back ----------
const FIRMS = ['Northwind VC', 'Lumen Fund', 'Basecamp Cap']
export function OutreachScene({ dark }: SceneProps) {
  const { ref, step } = useLoop(6, 750)
  return (
    <div ref={ref} className="absolute inset-0 flex gap-2.5 px-3 pb-6 pt-10" aria-hidden>
      <div className="flex w-[30%] flex-col">
        <span className={`font-hand text-[15px] leading-none ${dark ? 'text-fog' : 'text-ink/75'}`}>your inbox</span>
        <div className={`${CARD} relative mt-1 grid flex-1 place-items-center`}>
          <span className="absolute inset-x-1 top-1 flex items-center gap-1 font-mono text-[8.5px] font-bold">
            <span className="relative h-1 flex-1 overflow-hidden rounded bg-ink/15">
              <span className="absolute inset-0 origin-left rounded bg-ink/70 transition-transform duration-500 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${(3 + Math.min(step, 3)) / 10})` }} />
            </span>
            {3 + Math.min(step, 3)}/10 cap
          </span>
          <Mail className="size-6 text-ink/30" aria-hidden />
          <span className={`${MOVE} absolute inset-x-1 bottom-1.5 flex items-center justify-center gap-1 rounded bg-hl px-1 py-0.5 font-mono text-[9.5px] font-bold`} style={pop(step >= 5, 'translateX(60px)')}>
            <Mail className="size-3" aria-hidden /> reply ↩
          </span>
        </div>
      </div>
      <ul className="flex flex-1 flex-col justify-between gap-1">
        {FIRMS.map((f, i) => (
          <li key={f} className={`${CARD} flex h-[30px] items-center gap-1.5 px-1.5`}>
            <span className={`${MOVE} grid size-5 shrink-0 place-items-center rounded bg-lav`} style={pop(step >= i + 1, 'translateX(-90px)')}>
              <Mail className="size-3" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold">{f}</span>
            <span className={`${MOVE} shrink-0 font-mono text-[9px] font-bold text-mint-deep`} style={pop(step >= i + 2, 'scale(0.6)')}>
              {i === 0 && step >= 5 ? 'replied' : 'delivered ✓'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- Lead Verifier: CSV rows ticking ✓ / ✗ with MX and site badges ----------
const LEADS: [string, boolean, boolean][] = [
  ['ana@acme.io', true, true],
  ['li@northwind.co', true, true],
  ['sam@nomail.biz', false, true],
  ['jo@lumen.dev', true, true],
  ['kai@ghost.ai', true, false],
]
export function LeadsScene({ dark, budget = false }: SceneProps & { budget?: boolean }) {
  const { ref, step } = useLoop(LEADS.length + 1, budget ? 1100 : 600)
  const done = LEADS.slice(0, step).filter(([, mx, site]) => mx && site).length
  return (
    <div ref={ref} className="absolute inset-0 px-3 pb-6 pt-10" aria-hidden>
      <ul className={`${CARD} divide-y divide-ink/10 px-2 py-0.5`}>
        {LEADS.map(([email, mx, site], i) => {
          const on = step > i
          const ok = mx && site
          return (
            <li key={email} className="flex h-[17px] items-center gap-1.5 font-mono text-[9.5px]">
              <span className="min-w-0 flex-1 truncate">{email}</span>
              <Badge on={on} ok={mx}>MX</Badge>
              <Badge on={on} ok={site}>site</Badge>
              <span className={`${MOVE} grid size-3.5 place-items-center rounded-full ${ok ? 'bg-mint-deep' : 'bg-coral-deep'} text-white`} style={pop(on)}>
                {ok ? <Check className="size-2.5" strokeWidth={3.5} /> : <X className="size-2.5" strokeWidth={3.5} />}
              </span>
            </li>
          )
        })}
      </ul>
      <div className="absolute bottom-2 left-3 flex items-center gap-1.5">
        <span className={TAG}>{done} verified</span>
        {budget && <span className={`rounded px-1.5 py-px font-mono text-[10px] font-bold ${dark ? 'bg-fog/15 text-fog' : 'bg-ink/10 text-ink'}`}>queue · 1 req/s</span>}
      </div>
    </div>
  )
}

function Badge({ on, ok, children }: { on: boolean; ok: boolean; children: string }) {
  return (
    <span className="relative rounded border border-ink/20 px-1 text-[8.5px] font-bold leading-[12px] text-ink/40">
      {children}
      <span className={`${MOVE} absolute inset-[-1px] rounded px-1 text-white ${ok ? 'bg-mint-deep' : 'bg-coral-deep'}`} style={{ opacity: on ? 1 : 0 }}>
        {children}
      </span>
    </span>
  )
}

// ---------- Agent-Readiness Auditor: a scan line over a page, checklist ticks, a score ----------
const AUDIT: [string, boolean][] = [
  ['llms.txt', true],
  ['schema', false],
  ['MCP', true],
  ['robots', true],
]
export function AuditScene({ dark }: SceneProps) {
  const { ref, step } = useLoop(6, 700)
  return (
    <div ref={ref} className="absolute inset-0 flex gap-2.5 px-3 pb-6 pt-10" aria-hidden>
      <div className={`${CARD} relative w-[42%] overflow-hidden p-1.5`}>
        <div className="flex gap-0.5">
          {[0, 1, 2].map((i) => <span key={i} className="size-1 rounded-full bg-ink/25" />)}
        </div>
        <div className="mt-1.5 h-2 w-3/4 rounded-sm bg-ink/70" />
        <div className="mt-1.5 h-1 w-full rounded bg-ink/15" />
        <div className="mt-1 h-1 w-5/6 rounded bg-ink/15" />
        <div className="mt-2 grid grid-cols-2 gap-1">
          <div className="h-5 rounded-sm bg-ink/10" />
          <div className="h-5 rounded-sm bg-ink/10" />
        </div>
        <div className="mt-1.5 h-1 w-2/3 rounded bg-ink/15" />
        <span className="absolute inset-x-0 top-0 h-[2px] bg-coral shadow-[0_0_8px_2px_rgba(255,107,91,0.55)] transition-transform duration-700 ease-linear motion-reduce:hidden" style={{ transform: `translateY(${Math.min(step, 4) * 22}px)` }} />
      </div>
      <div className="flex flex-1 flex-col justify-between">
        <ul className="space-y-1">
          {AUDIT.map(([k, ok], i) => (
            <li key={k} className={`${MOVE} flex items-center gap-1.5 font-mono text-[10.5px] font-semibold ${dark ? 'text-fog' : 'text-ink'}`} style={pop(step > i, 'translateX(-8px)')}>
              <span className={`grid size-3.5 place-items-center rounded-full text-white ${ok ? 'bg-mint-deep' : 'bg-coral-deep'}`}>
                {ok ? <Check className="size-2.5" strokeWidth={3.5} /> : <X className="size-2.5" strokeWidth={3.5} />}
              </span>
              {k}
            </li>
          ))}
        </ul>
        <span className={`${MOVE} self-start ${TAG}`} style={pop(step >= 5)}>score 72/100</span>
      </div>
    </div>
  )
}

// ---------- Cold Email Writer: an email typing itself, then a lint score ----------
const BODY = 'Hi Dana, saw Northwind backs dev tools. We cut onboarding to 2 minutes. Worth a 15-min call Thursday?'
export function WriterScene() {
  const frames = 9
  const { ref, step } = useLoop(frames, 420, 6)
  const typed = BODY.slice(0, Math.round((BODY.length * Math.min(step, frames - 2)) / (frames - 2)))
  return (
    <div ref={ref} className="absolute inset-0 px-3 pb-6 pt-10" aria-hidden>
      <div className={`${CARD} relative h-full px-2 py-1.5`}>
        <p className="truncate border-b border-ink/10 pb-0.5 font-mono text-[9px] text-ink/55">To: Dana · Northwind</p>
        <p className="truncate border-b border-ink/10 py-0.5 text-[10.5px] font-bold">Quick idea for Northwind</p>
        <p className="pt-1 text-[10.5px] leading-[1.3]">
          {typed}
          <span className="ml-px inline-block h-[10px] w-[1.5px] translate-y-[1px] bg-ink" />
        </p>
        <span className={`${MOVE} absolute -bottom-2 left-2 rotate-[-4deg] rounded bg-mint-deep px-1.5 py-px font-mono text-[10px] font-bold text-white`} style={pop(step >= frames - 1)}>
          lint 96 ✓
        </span>
      </div>
    </div>
  )
}

// ---------- Account Setup Bot: each service goes signup, verify email, profile, LIVE; logins land in the locker ----------
const SERVICES = ['Analytics', 'Newsletter', 'Social', 'Status page']
export function AccountSetupScene({ dark }: SceneProps) {
  const { ref, step } = useLoop(SERVICES.length + 4, 550)
  const phase = (i: number) => Math.max(0, Math.min(4, step - i))
  const live = SERVICES.filter((_, i) => phase(i) >= 4).length
  return (
    <div ref={ref} className="absolute inset-0 px-3 pb-6 pt-10" aria-hidden>
      <ul className="space-y-1">
        {SERVICES.map((name, i) => {
          const p = phase(i)
          return (
            <li key={name} className={`${CARD} relative flex h-[20px] items-center gap-1.5 px-1.5`}>
              <span className="w-[54px] shrink-0 truncate font-mono text-[9px] font-semibold">{name}</span>
              <span className={`${MOVE} grid size-3.5 shrink-0 place-items-center rounded bg-lav`} style={pop(p >= 1)}>
                <UserPlus className="size-2.5" aria-hidden />
              </span>
              <span className={`${MOVE} grid size-3.5 shrink-0 place-items-center rounded bg-mint-deep text-white`} style={pop(p >= 2)}>
                <MailCheck className="size-2.5" aria-hidden />
              </span>
              <span className="relative h-1.5 flex-1 overflow-hidden rounded bg-ink/10">
                <span className="absolute inset-0 origin-left rounded bg-ink/70 transition-transform duration-500 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${p >= 3 ? 1 : 0})` }} />
              </span>
              <span className={`${MOVE} shrink-0`} style={pop(p >= 4)}>
                <span className="block -rotate-12 rounded-[4px] border-2 border-mint-deep bg-[#fbf8f1]/85 px-1 font-mono text-[9px] font-extrabold leading-[11px] tracking-wider text-mint-deep">LIVE</span>
              </span>
            </li>
          )
        })}
      </ul>
      <div className="absolute inset-x-3 bottom-2 flex items-center justify-between gap-1.5">
        <span className={TAG}>{live}/{SERVICES.length} accounts</span>
        <span className={`flex items-center gap-1 rounded px-1.5 py-px font-mono text-[10px] font-bold ${dark ? 'bg-fog/15 text-fog' : 'bg-ink/10 text-ink'}`}>
          <KeyRound className="size-3" aria-hidden /> {live} logins in locker
        </span>
      </div>
    </div>
  )
}

// ---------- Application Filler: steps fill in, a preview waits for your OK, then the receipt ----------
const FIELDS = ['Company', 'Traction', 'One-pager']
export function ApplicationScene() {
  const { ref, step } = useLoop(FIELDS.length + 4, 650)
  const filled = Math.min(step, FIELDS.length)
  const preview = step >= FIELDS.length + 1
  const approved = step >= FIELDS.length + 2
  const submitted = step >= FIELDS.length + 3
  return (
    <div ref={ref} className="absolute inset-0 px-3 pb-6 pt-10" aria-hidden>
      <div className={`${CARD} relative h-full px-2 py-1.5`}>
        <div className="flex items-center justify-between gap-1.5 border-b border-ink/10 pb-1">
          <span className="truncate font-mono text-[9px] font-semibold">NSA Grant · step {Math.max(1, filled)}/{FIELDS.length}</span>
          <span className="flex gap-0.5">
            {FIELDS.map((f, i) => (
              <span key={f} className="relative size-2 rounded-full bg-ink/15">
                <span className={`${MOVE} absolute inset-0 rounded-full bg-ink`} style={pop(filled > i, 'scale(0)')} />
              </span>
            ))}
          </span>
        </div>
        <ul className="mt-1 space-y-1">
          {FIELDS.map((f, i) => (
            <li key={f} className="flex items-center gap-1.5">
              <span className="w-[46px] shrink-0 font-mono text-[8.5px] text-ink/55">{f}</span>
              <span className="relative h-1.5 flex-1 overflow-hidden rounded bg-ink/10">
                <span className="absolute inset-0 origin-left rounded bg-ink/70 transition-transform duration-500 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${filled > i ? 1 : 0})` }} />
              </span>
            </li>
          ))}
        </ul>
        <div className={`${MOVE} mt-1.5 flex items-center gap-1.5`} style={pop(preview, 'translateY(6px)')}>
          <span className="rounded bg-lav px-1 font-mono text-[9px] font-bold">preview</span>
          <span className="flex items-center gap-1 rounded border border-ink/30 px-1 font-mono text-[9px] font-bold">
            <span className="relative grid size-2.5 place-items-center rounded-sm border border-ink/50">
              <span className={`${MOVE} absolute inset-[-1px] grid place-items-center rounded-sm bg-mint-deep text-white`} style={pop(approved)}>
                <Check className="size-2" strokeWidth={4} />
              </span>
            </span>
            approve
          </span>
          <span className={`${MOVE} min-w-0 flex-1 truncate font-mono text-[8.5px] text-ink/55`} style={{ opacity: preview && !approved ? 1 : 0 }}>
            waits for your OK
          </span>
        </div>
        <span className={`${MOVE} absolute -bottom-2 left-2 rotate-[-4deg] rounded bg-mint-deep px-1.5 py-px font-mono text-[10px] font-bold text-white`} style={pop(submitted)}>
          ID NSA-26-0417 ✓
        </span>
      </div>
    </div>
  )
}
