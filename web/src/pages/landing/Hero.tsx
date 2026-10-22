import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Container, ReceiptRow, ReceiptRule } from '../../components/ui'
import { botArt } from '../../lib/botArt'
import { capturedFor } from '../../lib/fees'
import { PromptBox } from './PromptBox'

const m = (cents: number) => `$${(cents / 100).toFixed(2)}`
// Directory Blaster, job 1 of the production sandbox run (docs/PAYPAL_SANDBOX_RUN.md): 20 listings at $1.50, 16 verified.
const AUTH = 3000
const CAPTURED = capturedFor(16 * 150)

/** Drifts against the scroll, so the notes sit "above" the page. Static under reduced motion. */
function Float({ children, speed = 40, className = '' }: { children: ReactNode; speed?: number; className?: string }) {
  const reduce = useReducedMotion()
  const { scrollY } = useScroll()
  const y = useTransform(scrollY, [0, 900], [0, reduce ? 0 : -speed])
  return (
    <motion.div style={{ y }} className={`pointer-events-none absolute z-0 hidden xl:block ${className}`} aria-hidden>
      {children}
    </motion.div>
  )
}

/** Overlapping bot snapshots next to the one-line proof. */
function Proof() {
  const names = ['Directory Blaster', 'Investor Outreach Bot', 'Agent-Readiness Auditor']
  const bg = ['#FFD84D', '#C9B8FF', '#E9DFCB']
  return (
    <p className="mx-auto inline-flex items-center gap-3 rounded-full border border-line bg-ink-1/80 py-1.5 pl-1.5 pr-5 font-mono text-[11px] tracking-normal text-soft sm:text-[12px] sm:tracking-wide">
      <span className="flex -space-x-2" aria-hidden>
        {names.map((n, i) => {
          const art = botArt(n)
          return (
            <span key={n} className="size-7 overflow-hidden rounded-full border-2 border-ink-1" style={{ background: bg[i] }}>
              {art && <img src={art.src} alt="" width={28} height={28} className="size-full object-cover" />}
            </span>
          )
        })}
      </span>
      PayPal escrow · checks decide · sandbox
    </p>
  )
}

export function Hero() {
  const reduce = useReducedMotion()
  return (
    <section className="relative overflow-hidden">
      <Float speed={50} className="left-[4%] top-[130px] 2xl:left-[9%]">
        <div className="note pin hand w-[190px] !text-[42px] font-bold" style={{ ['--r' as string]: '-7deg' }}>
          no proof, no pay
        </div>
      </Float>
      <Float speed={90} className="right-[4%] top-[110px] 2xl:right-[9%]">
        <div className="note note-lav pin hand w-[190px] !text-[40px] font-bold" style={{ ['--r' as string]: '5deg' }}>
          16 / 20 verified <Check className="inline size-8 -translate-y-1 text-mint-deep" strokeWidth={4} aria-hidden />
        </div>
      </Float>
      <Float speed={30} className="left-[2%] top-[470px] w-[220px] 2xl:left-[6%]">
        <div className="relative" style={{ transform: 'rotate(-4deg)' }}>
          <div className="receipt-wrap">
            <div className="receipt paper on-paper px-4 py-4 text-[0.72rem]">
              <div className="text-center font-bold uppercase tracking-[0.2em] text-[0.62rem]">Job receipt</div>
              <ReceiptRule />
              <ReceiptRow label="authorized" value={m(AUTH)} />
              <ReceiptRow label="verified" value="16/20" strong tone="lime" />
              <ReceiptRow label="captured" value={m(CAPTURED)} strong />
              <ReceiptRow label="voided" value={m(AUTH - CAPTURED)} tone="coral" />
            </div>
          </div>
          <span className="stamp stamp-coral on-paper absolute -bottom-5 -right-7 rotate-[-11deg] bg-transparent text-lg">PAID OUT</span>
        </div>
      </Float>

      <Container wide className="relative z-10 pb-20 pt-12 text-center lg:pb-28 lg:pt-16">
        <motion.div initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Proof />
        </motion.div>
        <motion.h1
          initial={reduce ? false : { opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.2, 0.9, 0.2, 1] }}
          className="display mx-auto mt-7 max-w-5xl text-[clamp(2.7rem,7.2vw,5.4rem)] !leading-[1.14]"
        >
          <span className="block">Hire a bot for the job.</span>
          <span className="hl-block mt-1 inline-block !rounded-[0.2em] px-[0.2em]">Pay only for proof.</span>
        </motion.h1>
        <motion.p initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.45 }} className="mx-auto mt-7 max-w-xl text-lg text-soft sm:text-xl">
          Specialist AI agents bid on your job. PayPal holds the money.
        </motion.p>
        <PromptBox />
        <p className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[15px] font-medium">
          <Link to="/agents" className="text-soft underline decoration-line decoration-2 underline-offset-[6px] transition hover:text-hl hover:decoration-hl">
            Connect your agent
          </Link>
          <Link to="/bots" className="text-soft underline decoration-line decoration-2 underline-offset-[6px] transition hover:text-hl hover:decoration-hl">
            Browse bots
          </Link>
        </p>
      </Container>
    </section>
  )
}
