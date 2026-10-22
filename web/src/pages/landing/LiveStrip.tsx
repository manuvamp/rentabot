import type { ReactNode } from 'react'
import { usePublicStats } from '../../api/public'
import { Container, CountUp, Reveal } from '../../components/ui'
import { botArt } from '../../lib/botArt'
import { Polaroid } from './parts'

const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const whole = (n: number) => Math.round(n).toLocaleString('en-US')

/* ------------------------------------------------------------ spot icons */
const Units = () => (
  <svg viewBox="0 0 96 96" className="size-24" aria-hidden>
    {Array.from({ length: 9 }, (_, i) => (
      <rect key={i} x={6 + (i % 3) * 30} y={6 + Math.floor(i / 3) * 30} width="24" height="24" rx="7" fill="#2B2238" opacity={i === 4 || i === 7 ? 0.22 : 1} />
    ))}
    {[0, 1, 2, 3, 5, 6, 8].map((i) => (
      <path key={i} d={`M${12 + (i % 3) * 30} ${19 + Math.floor(i / 3) * 30} l5 5 l9 -11`} fill="none" stroke="#8BE3B4" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    ))}
  </svg>
)
const BotIcon = () => (
  <svg viewBox="0 0 96 96" className="size-24" aria-hidden>
    <line x1="48" y1="8" x2="48" y2="22" stroke="#1A1814" strokeWidth="5" strokeLinecap="round" />
    <circle cx="48" cy="9" r="6" fill="#FF6B5B" />
    <rect x="12" y="22" width="72" height="56" rx="20" fill="#1A1814" />
    <rect x="3" y="40" width="9" height="20" rx="4.5" fill="#1A1814" />
    <rect x="84" y="40" width="9" height="20" rx="4.5" fill="#1A1814" />
    <circle cx="33" cy="48" r="8" fill="#FFD84D" />
    <circle cx="63" cy="48" r="8" fill="#FFD84D" />
    <path d="M34 64 q14 9 28 0" fill="none" stroke="#FFD84D" strokeWidth="4.5" strokeLinecap="round" />
  </svg>
)
const Coins = () => (
  <svg viewBox="0 0 96 96" className="size-24" aria-hidden>
    {[62, 42, 22].map((y, i) => (
      <g key={y}>
        <path d={`M10 ${y} v14 c0 8 17 14 38 14 s38 -6 38 -14 v-14`} fill={i === 2 ? '#E0B522' : '#4a3a63'} stroke="#F2F0EA" strokeWidth="3.5" />
        <ellipse cx="48" cy={y} rx="38" ry="14" fill={i === 2 ? '#FFD84D' : '#3a2d4f'} stroke="#F2F0EA" strokeWidth="3.5" />
      </g>
    ))}
  </svg>
)
const Shield = () => (
  <svg viewBox="0 0 96 96" className="size-24" aria-hidden>
    <path d="M48 6 L82 18 V46 C82 68 66 82 48 90 C30 82 14 68 14 46 V18 Z" fill="#2B2238" />
    <path d="M62 40 H40 a12 12 0 1 0 0 24 h6" fill="none" stroke="#FF6B5B" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M50 28 L62 40 L50 52" fill="none" stroke="#FF6B5B" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

interface StatCard {
  label: string
  value: number
  fmt: (n: number) => string
  /** A robot photo (when generated) replaces the drawn icon. */
  photo?: { bot: string; rotate: number }
  icon: ReactNode
  tone: string
  rot: string
  drop: string
}

/** Four fanned stat cards in the sticky-note colours, with the live numbers from the ledger. */
export function LiveStrip() {
  const { stats, live } = usePublicStats()
  const cards: StatCard[] = [
    { label: 'Units verified', value: Number(stats.units_verified ?? 0), fmt: whole, icon: <Units />, tone: 'bg-rose text-ink', rot: '[--r:-5deg] lg:[--r:-6deg]', drop: 'lg:translate-y-4' },
    { label: 'Released to sellers', value: Number(stats.paid_out ?? 0), fmt: dollars, icon: <Coins />, tone: 'bg-plum text-fog', rot: '[--r:2deg] lg:[--r:-2deg]', drop: '' },
    { label: 'Bots listed', value: Number(stats.bots ?? 0), fmt: whole, photo: { bot: 'Directory Blaster', rotate: 4 }, icon: <BotIcon />, tone: 'bg-hl text-ink', rot: '[--r:-2deg] lg:[--r:2deg]', drop: '' },
    { label: 'Voided back to buyers', value: Number(stats.voided ?? 0), fmt: dollars, photo: { bot: 'Agent-Readiness Auditor', rotate: -4 }, icon: <Shield />, tone: 'bg-sand text-ink', rot: '[--r:4deg] lg:[--r:6deg]', drop: 'lg:translate-y-4' },
  ]
  return (
    <section aria-label="Live numbers" className="pb-6 pt-4 lg:pt-8">
      <Container wide>
        <ul className="mx-auto grid max-w-[1180px] grid-cols-2 gap-3 sm:gap-5 lg:flex lg:justify-center lg:gap-0 lg:pb-6">
          {cards.map((c, i) => (
            <li key={c.label} className={`${c.drop} lg:-mx-4 lg:w-[290px] lg:shrink-0 lg:hover:z-10`}>
              <Reveal delay={i * 0.08} y={40} className="h-full">
                <div
                  className={`flex h-full min-h-[250px] flex-col justify-between rounded-[26px] p-5 shadow-[0_22px_40px_-18px_rgba(0,0,0,0.75)] transition-transform duration-300 ease-[var(--ease-snap)] motion-reduce:transition-none sm:p-6 lg:min-h-[340px] lg:hover:-translate-y-3 lg:hover:rotate-0 ${c.tone} ${c.rot} rotate-[var(--r)]`}
                >
                  <div>
                    <p className="display text-[clamp(1.9rem,3.2vw,3rem)] num">
                      <CountUp value={c.value} format={c.fmt} />
                    </p>
                    <p className="mt-2 font-display text-[17px] font-semibold leading-tight tracking-tight sm:text-xl">{c.label}</p>
                  </div>
                  <div className="mt-4 self-start">{c.photo && botArt(c.photo.bot) ? <Polaroid name={c.photo.bot} rotate={c.photo.rotate} size="size-28 sm:size-32" /> : c.icon}</div>
                </div>
              </Reveal>
            </li>
          ))}
        </ul>
        <p className="flex items-center justify-center gap-2 pt-5 font-mono text-[11.5px] text-mute">
          <span className={`size-1.5 rounded-full ${live ? 'bg-mint live-dot' : 'bg-mute'}`} aria-hidden />
          {live ? 'Live from the sandbox ledger' : 'Sample figures: the live API did not answer'}
        </p>
      </Container>
    </section>
  )
}
