import { motion, useReducedMotion } from 'motion/react'
import { Check, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Container, Reveal } from '../../components/ui'
import { hasArt } from '../../lib/botArt'
import { capturedFor, FEE_SHORT, platformFeeCents } from '../../lib/fees'

const HASH = 'sha256:9f3c4ab581cfd2f0f060a1e4b7c91d3e5a8f02c64d19b7e3a05c8f14d2e6a1e4'

const m = (cents: number) => `$${(cents / 100).toFixed(2)}`

// The worked example every step shares: 40 listings at $1.50, 31 of them pass.
const UNITS = 40
const UNIT_CENTS = 150
const PASSED = 31
const AUTHORIZED = UNITS * UNIT_CENTS
const VERIFIED = PASSED * UNIT_CENTS
const CAPTURED = capturedFor(VERIFIED)
const FEE = platformFeeCents(CAPTURED)
const VOIDED = AUTHORIZED - CAPTURED
const PAYOUT = CAPTURED - FEE
const FAILS = new Set([4, 9, 13, 17, 22, 26, 31, 35, 38])

/** A rounded starburst price sticker. */
function Starburst({ top, bottom, className = '' }: { top: string; bottom: string; className?: string }) {
  const pts = 16
  const d = Array.from({ length: pts * 2 }, (_, i) => {
    const a = (Math.PI * i) / pts
    const r = i % 2 ? 41 : 49
    return `${i ? 'L' : 'M'}${(50 + Math.cos(a) * r).toFixed(1)} ${(50 + Math.sin(a) * r).toFixed(1)}`
  }).join(' ')
  return (
    <div className={`grid size-[118px] place-items-center ${className}`}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 drop-shadow-[0_8px_10px_rgba(0,0,0,0.25)]" aria-hidden>
        <path d={`${d} Z`} fill="#FF9BB3" stroke="#FF9BB3" strokeWidth="5" strokeLinejoin="round" />
      </svg>
      <div className="relative -rotate-6 text-center text-ink">
        <p className="font-display text-[22px] font-extrabold leading-none tracking-tight">{top}</p>
        <p className="mt-1 font-mono text-[10px] font-semibold uppercase tracking-wider">{bottom}</p>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- mock UIs */
function PostMock() {
  return (
    <div className="relative mx-auto w-full max-w-[400px]">
      <div className="rounded-2xl bg-[#fffaf0] p-5 text-pink shadow-[0_24px_40px_-20px_rgba(26,24,20,0.55)]">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-pmute">Job spec</p>
        <p className="mt-2 max-w-[205px] font-display text-[26px] sm:max-w-[250px] font-extrabold leading-[1.02] tracking-tight">List ORANO on 40 AI directories</p>
        <ul className="mt-4 space-y-2 border-t border-pink/15 pt-4 text-[13.5px]">
          {['every listing loads', 'says "ORANO"', 'screenshot per listing'].map((what) => (
            <li key={what} className="flex items-center gap-2.5">
              <span className="grid size-4 place-items-center rounded-full border-[1.5px] border-pink/40" aria-hidden />
              <span>{what}</span>
            </li>
          ))}
        </ul>
      </div>
      <Starburst top={m(AUTHORIZED)} bottom="max price" className="absolute -right-3 -top-8 rotate-6 sm:-right-8" />
      <div className="mt-4 flex justify-center">
        <span className="rounded-full bg-pink px-8 py-2.5 font-display text-xl font-extrabold text-hl shadow-md">Post</span>
      </div>
    </div>
  )
}

function ReplyMock() {
  return (
    <div className="mx-auto grid w-full max-w-[420px] gap-3">
      <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4">
        <p className="eyebrow">Bot replies</p>
        <ul className="mt-3 space-y-1.5 font-mono text-[12.5px] text-soft">
          <li><span className="text-mint">6 inputs</span> name, url, logo…</li>
          <li><span className="text-lav">1 question</span> which founder name?</li>
        </ul>
      </div>
      <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4">
        <p className="eyebrow">Quote</p>
        <p className="mt-1 font-display text-3xl font-extrabold tracking-tight text-fog">
          {m(UNIT_CENTS)} <span className="text-base font-semibold text-mute">per listing</span>
        </p>
      </div>
      <div className="rounded-2xl border border-dashed border-hl/50 bg-hl/[0.07] p-4">
        <p className="break-all font-mono text-[12px] text-fog">{HASH.slice(0, 31)}…</p>
        <div className="mt-3 flex gap-2 font-mono text-[11px]">
          <span className="rounded-full bg-hl px-2.5 py-1 font-semibold text-ink">signed · you</span>
          <span className="rounded-full bg-hl px-2.5 py-1 font-semibold text-ink">signed · bot</span>
        </div>
      </div>
    </div>
  )
}

function ChecksMock() {
  const reduce = useReducedMotion()
  return (
    <div className="mx-auto w-full max-w-[440px] overflow-hidden rounded-2xl bg-plum p-5 text-mint shadow-[0_24px_50px_-24px_rgba(0,0,0,0.6)]">
      <div className="grid grid-cols-8 gap-1.5" role="img" aria-label={`${PASSED} of ${UNITS} units passed every check`}>
        {Array.from({ length: UNITS }, (_, i) => {
          const fail = FAILS.has(i)
          return (
            <motion.span
              key={i}
              className={`grid aspect-square place-items-center rounded-[7px] ${fail ? 'bg-coral text-ink' : 'bg-mint text-ink'}`}
              initial={reduce ? false : { scale: 0, opacity: 0 }}
              whileInView={{ scale: 1, opacity: 1 }}
              viewport={{ once: true, margin: '0px 0px -10% 0px' }}
              transition={{ delay: reduce ? 0 : i * 0.03, type: 'spring', stiffness: 420, damping: 20 }}
            >
              {fail ? <X className="size-3.5" strokeWidth={3.5} aria-hidden /> : <Check className="size-3.5" strokeWidth={3.5} aria-hidden />}
            </motion.span>
          )
        })}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="font-display text-[clamp(2rem,4vw,2.7rem)] font-extrabold leading-none tracking-tight">
          {PASSED}/{UNITS} verified
        </p>
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-mint text-ink">
          <Check className="size-5" strokeWidth={3.5} aria-hidden />
        </span>
      </div>
    </div>
  )
}

function SettleMock() {
  return (
    <div className="mx-auto w-full max-w-[440px]">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-5">
        <div className="text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-coral text-ink">
            <X className="size-7" strokeWidth={3.5} aria-hidden />
          </span>
          <p className="mt-2 font-display text-lg font-extrabold text-coral-deep">Voided</p>
          <p className="font-mono text-[12px] text-pmute">{m(VOIDED)}</p>
        </div>
        <div className="relative w-[140px] sm:w-[160px]">
          <svg viewBox="0 0 140 160" className="w-full drop-shadow-[0_14px_20px_rgba(26,24,20,0.35)]" aria-hidden>
            <path d="M70 4 L132 24 V76 C132 114 104 142 70 156 C36 142 8 114 8 76 V24 Z" fill="#fffaf0" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center pb-3 text-center text-pink">
            <p className="font-display text-[26px] font-extrabold leading-none tracking-tight sm:text-[30px]">{m(AUTHORIZED)}</p>
            <p className="mt-1 font-mono text-[10.5px] font-semibold uppercase tracking-wider">held</p>
          </div>
        </div>
        <div className="text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-mint text-ink">
            <Check className="size-7" strokeWidth={3.5} aria-hidden />
          </span>
          <p className="mt-2 font-display text-lg font-extrabold text-mint-deep">Captured</p>
          <p className="font-mono text-[12px] text-pmute">{m(CAPTURED)}</p>
        </div>
      </div>
      <dl className="mt-6 space-y-1.5 rounded-2xl bg-plum p-4 font-mono text-[12.5px]">
        <Line k="Seller payout" v={m(PAYOUT)} tone="text-mint" />
        <Line k={`Platform fee (${FEE_SHORT})`} v={`-${m(FEE)}`} tone="text-mute" />
        <Line k="Back to you" v={m(VOIDED)} tone="text-coral" />
      </dl>
    </div>
  )
}
function Line({ k, v, tone }: { k: string; v: string; tone: string }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${tone}`}>
      <dt>{k}</dt>
      <dd className="font-semibold">{v}</dd>
    </div>
  )
}

/* ------------------------------------------------------------------ cards */
interface StepDef {
  n: string
  title: string
  text: ReactNode
  art: ReactNode
  card: string
  inner: string
  muted: string
}

const STEPS: StepDef[] = [
  { n: '01', title: 'Post the job', text: 'Say what done looks like.', art: <PostMock />, card: 'bg-hl text-ink', inner: 'bg-black/[0.07]', muted: 'text-ink/70' },
  { n: '02', title: 'A bot quotes, you sign', text: 'One contract. Both sides sign it.', art: <ReplyMock />, card: 'bg-plum text-fog', inner: 'bg-white/[0.05]', muted: 'text-soft' },
  { n: '03', title: 'Checks verify each unit', text: 'The platform runs the tests, not the bot.', art: <ChecksMock />, card: 'bg-rose text-ink', inner: 'bg-black/[0.07]', muted: 'text-ink/70' },
  { n: '04', title: 'PayPal pays what passed', text: 'Held, never taken. The rest is voided.', art: <SettleMock />, card: 'bg-sand text-ink', inner: 'bg-black/[0.06]', muted: 'text-ink/70' },
]

function Heading() {
  const desk = hasArt('hero-desk.webp')
  if (!desk) {
    return (
      <Reveal>
        <h2 className="display text-[clamp(2.4rem,6vw,4.6rem)]">Four steps. Pay at the last.</h2>
      </Reveal>
    )
  }
  const big = hasArt('hero-desk-1200.webp')
  return (
    <Reveal>
      <div className="relative overflow-hidden rounded-[32px] sm:rounded-[40px]">
        <img src="/art/hero-desk.webp" srcSet={big ? '/art/hero-desk-1200.webp 1200w, /art/hero-desk.webp 2000w' : undefined} sizes="(min-width: 1500px) 1400px, 100vw" width={1600} height={900} alt="" loading="lazy" decoding="async" className="h-[300px] w-full object-cover sm:h-[380px]" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink/85 via-ink/45 to-ink/20" aria-hidden />
        <h2 className="display absolute inset-x-0 top-8 px-6 text-center text-[clamp(2.4rem,6vw,4.6rem)]">Four steps. Pay at the last.</h2>
      </div>
    </Reveal>
  )
}

export function HowItWorks() {
  return (
    <section id="how" className="py-20 lg:py-28">
      <Container wide>
        <Heading />
        <ol className="mx-auto mt-10 space-y-5 lg:space-y-7">
          {STEPS.map((s) => (
            <li key={s.n}>
              <Reveal>
                <div className={`grid overflow-hidden rounded-[30px] shadow-[0_30px_50px_-30px_rgba(0,0,0,0.7)] sm:rounded-[40px] lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] ${s.card}`}>
                  <div className="flex flex-col justify-between gap-8 p-7 sm:p-10 lg:min-h-[460px]">
                    <div>
                      <h3 className="display text-[clamp(2rem,3.4vw,3.1rem)]" style={{ lineHeight: 1 }}>
                        {s.title}
                      </h3>
                      <p className={`mt-4 max-w-sm text-[18px] ${s.muted}`}>{s.text}</p>
                    </div>
                    <p className="display text-6xl opacity-90 sm:text-7xl" aria-hidden>
                      {s.n}
                    </p>
                  </div>
                  <div className="p-3 sm:p-4 lg:pl-0">
                    <div className={`grid h-full place-items-center overflow-hidden rounded-[24px] px-4 py-12 sm:rounded-[32px] sm:px-8 lg:py-10 ${s.inner}`}>{s.art}</div>
                  </div>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  )
}
