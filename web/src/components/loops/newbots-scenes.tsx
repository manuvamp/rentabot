// Function loops for the Landing Page Bot and the Agent Red Team, in the style of scenes.tsx. Transform/opacity only.
import { Check, ShieldCheck, X } from 'lucide-react'
import type { SceneProps } from './scenes'
import { MOVE, pop, useLoop } from './useLoop'

const CARD = 'rounded-md bg-[#fbf8f1] text-ink shadow-[0_3px_6px_-3px_rgba(0,0,0,0.45)]'
const TAG = 'rounded bg-ink px-1.5 py-px font-mono text-[10.5px] font-bold text-hl'

// ---------- Landing Page Bot: a page assembles block by block (nav, hero, features, CTA), then a LIVE stamp ----------
export function LandingScene({ dark }: SceneProps) {
  const { ref, step } = useLoop(6, 650)
  return (
    <div ref={ref} className="absolute inset-0 flex gap-2.5 px-3 pb-6 pt-10" aria-hidden>
      <div className={`${CARD} relative w-[62%] overflow-hidden p-1.5`}>
        <div className="flex items-center justify-between">
          <div className="flex gap-0.5">
            {[0, 1, 2].map((i) => <span key={i} className="size-1 rounded-full bg-ink/25" />)}
          </div>
          <span className={`${MOVE} h-1.5 w-6 rounded-sm bg-ink`} style={pop(step >= 1, 'translateY(-6px)')} />
        </div>
        <div className={`${MOVE} mt-1.5`} style={pop(step >= 1, 'translateY(10px)')}>
          <div className="h-2.5 w-4/5 rounded-sm bg-ink/80" />
          <div className="mt-1 h-1 w-3/5 rounded bg-ink/25" />
          <div className="mt-1 h-2 w-8 rounded bg-hl ring-1 ring-ink/70" />
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`${MOVE} h-5 rounded-sm border border-ink/15 bg-white p-0.5`} style={pop(step >= 2 + (i > 0 ? 1 : 0), 'translateY(8px)')}>
              <div className="h-1 w-3/4 rounded bg-ink/50" />
              <div className="mt-0.5 h-0.5 w-full rounded bg-ink/15" />
            </div>
          ))}
        </div>
        <div className={`${MOVE} mt-1.5 h-3 rounded-sm bg-ink`} style={pop(step >= 4, 'translateY(8px)')} />
        <span className={`${MOVE} absolute bottom-3 right-1.5`} style={pop(step >= 5)}>
          <span className="block -rotate-12 rounded-[4px] border-2 border-mint-deep bg-[#fbf8f1]/90 px-1.5 font-mono text-[12px] font-extrabold tracking-wider text-mint-deep">LIVE</span>
        </span>
      </div>
      <ul className="flex flex-1 flex-col justify-center gap-1">
        {['hero', 'features', 'CTA', 'url live'].map((k, i) => (
          <li key={k} className={`${MOVE} flex items-center gap-1.5 font-mono text-[10.5px] font-semibold ${dark ? 'text-fog' : 'text-ink'}`} style={pop(step >= i + 2, 'translateX(-8px)')}>
            <span className="grid size-3.5 place-items-center rounded-full bg-mint-deep text-white">
              <Check className="size-2.5" strokeWidth={3.5} />
            </span>
            {k}
          </li>
        ))}
      </ul>
      <span className={`absolute bottom-2 left-3 ${TAG}`}>{step >= 5 ? '1 page live' : 'building…'}</span>
    </div>
  )
}

// ---------- Agent Red Team: a shield console runs probe categories; each ticks found / held, with a severity tally ----------
const PROBES: [string, 'critical' | 'high' | 'medium' | null][] = [
  ['instructions', 'high'],
  ['disclosure', 'critical'],
  ['tool limits', 'medium'],
  ['role', 'medium'],
  ['scope', null],
]
const SEV: Record<string, string> = { critical: 'bg-coral-deep', high: 'bg-coral', medium: 'bg-hl text-ink', low: 'bg-lav text-ink' }
export function RedTeamScene({ dark }: SceneProps) {
  const { ref, step } = useLoop(PROBES.length + 2, 620)
  const ran = Math.min(step, PROBES.length)
  const found = PROBES.slice(0, ran).filter(([, s]) => s).length
  return (
    <div ref={ref} className="absolute inset-0 flex gap-2.5 px-3 pb-6 pt-10" aria-hidden>
      <div className="flex w-[24%] flex-col items-center gap-1 pt-1">
        <ShieldCheck className={`size-11 ${dark ? 'text-fog' : 'text-ink/80'}`} strokeWidth={1.6} />
        <span className="rounded bg-mint-deep px-1 font-mono text-[8.5px] font-bold text-white">owner ✓</span>
      </div>
      <ul className={`${CARD} flex-1 divide-y divide-ink/10 px-1.5 py-0.5`}>
        {PROBES.map(([k, sev], i) => {
          const on = step > i
          return (
            <li key={k} className="flex h-[17px] items-center gap-1.5 font-mono text-[9.5px]">
              <span className="min-w-0 flex-1 truncate">{k}</span>
              {sev ? (
                <span className={`${MOVE} rounded px-1 text-[8.5px] font-bold leading-[12px] text-white ${SEV[sev]}`} style={pop(on, 'scale(0.6)')}>
                  {sev}
                </span>
              ) : (
                <span className={`${MOVE} rounded px-1 text-[8.5px] font-bold leading-[12px] text-mint-deep ring-1 ring-mint-deep`} style={pop(on, 'scale(0.6)')}>
                  held
                </span>
              )}
              <span className={`${MOVE} grid size-3.5 place-items-center rounded-full ${sev ? 'bg-coral-deep' : 'bg-mint-deep'} text-white`} style={pop(on)}>
                {sev ? <X className="size-2.5" strokeWidth={3.5} /> : <Check className="size-2.5" strokeWidth={3.5} />}
              </span>
            </li>
          )
        })}
      </ul>
      <span className={`absolute bottom-2 left-3 ${dark ? 'rounded bg-fog px-1.5 py-px font-mono text-[10.5px] font-bold text-ink' : TAG}`}>
        {found} verified · {ran - found} held
      </span>
    </div>
  )
}
