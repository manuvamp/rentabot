import { animate, motion, useInView, useReducedMotion } from 'motion/react'
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import { CLASS_LABEL, STATE_LABEL, shortHash } from '../../lib/format'

/* ------------------------------------------------------------ small chips */
type Tone = 'neutral' | 'lime' | 'amber' | 'coral' | 'paper'
const TONES: Record<Tone, string> = {
  neutral: 'border-line text-soft bg-ink-2',
  lime: 'border-lime/40 text-lime bg-lime/10',
  amber: 'border-amber/40 text-amber bg-amber/10',
  coral: 'border-coral/40 text-coral bg-coral/10',
  paper: 'border-pink/25 text-pink bg-pink/5',
}
export function Chip({ children, tone = 'neutral', className = '', mono = false }: { children: ReactNode; tone?: Tone; className?: string; mono?: boolean }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium leading-5 ${mono ? 'font-mono' : ''} ${TONES[tone]} ${className}`}>{children}</span>
}

/** demo = acts only on Sandbox Web (fake sites). live = acts on the real web. */
export function ModeBadge({ mode, className = '' }: { mode: 'demo' | 'live'; className?: string }) {
  const demo = mode === 'demo'
  return (
    <span
      title={demo ? 'Demo bot: acts only on Sandbox Web (fake sites, no real-world side effects).' : 'Live bot: acts on the real web.'}
      className={`inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-widest ${demo ? 'border-pink/40 text-pink/80' : 'border-pink bg-pink text-paper'} ${className}`}
    >
      <span className={`size-1.5 rounded-full ${demo ? 'bg-amber-deep' : 'bg-coral-deep live-dot'}`} aria-hidden />
      {mode}
    </span>
  )
}

export const ClassChip = ({ cls }: { cls: string }) => <Chip>{CLASS_LABEL[cls] ?? cls}</Chip>

const STATE_TONE: Record<string, Tone> = {
  NEGOTIATING: 'neutral',
  AGREED: 'amber',
  AWAITING_APPROVAL: 'amber',
  IN_PROGRESS: 'lime',
  BLOCKED: 'amber',
  DELIVERED: 'lime',
  CURE: 'amber',
  DISPUTED: 'coral',
  RULED: 'coral',
  APPEALED: 'coral',
  SETTLED: 'lime',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
}
export function StateBadge({ state }: { state: string }) {
  return (
    <Chip tone={STATE_TONE[state] ?? 'neutral'} mono>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {STATE_LABEL[state] ?? state}
    </Chip>
  )
}

/* -------------------------------------------------------------- copy + code */
export function CopyButton({ text, label = 'Copy', className = '', onPaper = false }: { text: string; label?: string; className?: string; onPaper?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${onPaper ? 'text-pink/70 hover:text-pink hover:bg-pink/10' : 'text-soft hover:text-fog hover:bg-ink-3'} ${className}`}
      aria-label={done ? 'Copied' : label}
    >
      {done ? <Check className="size-3.5 text-lime" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      <span aria-live="polite">{done ? 'Copied' : label}</span>
    </button>
  )
}

export function CodeBlock({ code, lang, title, className = '', maxH }: { code: string; lang?: string; title?: string; className?: string; maxH?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-line bg-[#0a0a0c] ${className}`}>
      <div className="flex items-center justify-between border-b border-line bg-ink-1 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-widest text-mute">{title ?? lang ?? 'code'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-auto p-4 text-[12.5px] leading-relaxed text-fog" style={maxH ? { maxHeight: maxH } : undefined} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function HashText({ hash, n = 10, className = '' }: { hash: string | null | undefined; n?: number; className?: string }) {
  if (!hash) return <span className={`font-mono text-mute ${className}`}>unsigned</span>
  return (
    <span className={`font-mono ${className}`} title={hash}>
      {shortHash(hash, n)}
    </span>
  )
}

/* ------------------------------------------------------------------- tabs */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void; label: string }) {
  const uid = useId()
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-line bg-ink-1 p-1">
      {tabs.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            role="tab"
            id={`${uid}-${t.id}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              const i = tabs.findIndex((x) => x.id === value)
              if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length].id)
              if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length].id)
            }}
            className={`relative rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${active ? 'text-ink' : 'text-soft hover:text-fog'}`}
          >
            {active && <motion.span layoutId={`tab-${uid}`} className="absolute inset-0 rounded-lg bg-hl" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
            <span className="relative">{t.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- feedback */
export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <div className="flex items-center gap-2 text-sm text-mute" role="status">
    <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
  </div>
)

export function ErrorBox({ error, title = 'That did not work', onRetry, className = '' }: { error: unknown; title?: string; onRetry?: () => void; className?: string }) {
  if (!error) return null
  const e = error as ApiError
  const message = e instanceof Error ? e.message : String(error)
  const hint = e instanceof ApiError ? e.hint : ''
  return (
    <div role="alert" className={`flex gap-3 rounded-xl border border-coral/40 bg-coral/10 p-3.5 text-sm [.paper_&]:border-coral-deep/40 [.paper_&]:bg-coral/15 ${className}`}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-coral [.paper_&]:text-coral-deep" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold text-coral [.paper_&]:text-coral-deep">
          {title}
          {e instanceof ApiError && <span className="ml-2 font-mono text-[11px] font-normal text-coral/80 [.paper_&]:text-coral-deep/80">{e.code}</span>}
        </p>
        <p className="mt-0.5 text-soft [.paper_&]:text-pink">{message}</p>
        {hint && <p className="mt-1 text-fog [.paper_&]:text-pink">{hint}</p>}
        {onRetry && (
          <button onClick={onRetry} className="mt-2 text-xs font-semibold underline underline-offset-2 text-fog hover:text-hl">
            Try again
          </button>
        )}
      </div>
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <p className="font-display text-xl font-bold tracking-tight">{title}</p>
      {children && <p className="mx-auto mt-2 max-w-md text-sm text-mute">{children}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-ink-2 ${className}`} aria-hidden />
}

/* --------------------------------------------------------- page scaffolding */
export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: string; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-3xl">
        {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
        <h1 className={`display text-[clamp(2.2rem,5vw,3.8rem)] ${typeof title === 'string' ? '' : 'leading-[1.14]'}`}>{title}</h1>
        {children && <div className="mt-3 max-w-2xl text-[15px] leading-relaxed text-soft">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  )
}

export function Container({ children, className = '', wide = false }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={`mx-auto w-full px-5 sm:px-8 ${wide ? 'max-w-[1500px]' : 'max-w-[1240px]'} ${className}`}>{children}</div>
}

/* --------------------------------------------------------------- motion bits */
export function Reveal({ children, delay = 0, y = 22, className = '' }: { children: ReactNode; delay?: number; y?: number; className?: string }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '0px 0px -12% 0px' })
  return (
    <motion.div ref={ref} className={className} initial={reduce ? false : { opacity: 0, y }} animate={inView || reduce ? { opacity: 1, y: 0 } : undefined} transition={{ duration: 0.7, delay, ease: [0.2, 0.9, 0.2, 1] }}>
      {children}
    </motion.div>
  )
}

/** Ticks a number toward `value`. Formats via `format`. */
export function CountUp({ value, format = (n: number) => n.toFixed(0), duration = 0.9, className = '' }: { value: number; format?: (n: number) => string; duration?: number; className?: string }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(0)
  const inView = useInView(ref, { once: true })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // A tab that is not showing (opened in the background) never runs animation frames or reports intersections:
    // print the real number at once instead of leaving 0 until someone looks.
    if (reduce || document.hidden) {
      el.textContent = format(value)
      prev.current = value
      return
    }
    if (!inView && prev.current === 0) {
      el.textContent = format(0)
      return
    }
    const c = animate(prev.current, value, {
      duration,
      ease: [0.2, 0.9, 0.2, 1],
      onUpdate: (v) => {
        el.textContent = format(v)
      },
      onComplete: () => {
        prev.current = value
      },
    })
    return () => c.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, inView, reduce])
  return (
    <span ref={ref} className={`num ${className}`}>
      {format(reduce || (typeof document !== 'undefined' && document.hidden) ? value : prev.current)}
    </span>
  )
}

/** Escrow bar: one authorized total split into captured / voided / held. Values in cents. */
export function EscrowBar({ total, captured, voided, refunded = 0, height = 18, className = '', labels = false, onPaper = false }: { total: number; captured: number; voided: number; refunded?: number; height?: number; className?: string; labels?: boolean; onPaper?: boolean }) {
  const t = Math.max(total, 1)
  const held = Math.max(total - captured - voided - refunded, 0)
  const pct = (n: number) => `${(n / t) * 100}%`
  const seg = [
    { k: 'captured', v: captured, c: 'bg-lime', t: 'text-ink' },
    { k: 'held', v: held, c: 'bg-amber', t: 'text-ink' },
    { k: 'refunded', v: refunded, c: 'bg-soft', t: 'text-ink' },
    { k: 'voided', v: voided, c: 'bg-coral', t: 'text-ink' },
  ]
  return (
    <div className={className}>
      <div className={`flex w-full gap-[3px] overflow-hidden rounded-md p-[3px] ${onPaper ? 'bg-pink/80' : 'bg-ink-3'}`} style={{ height }} role="img" aria-label={`Escrow split: captured ${(captured / 100).toFixed(2)}, held ${(held / 100).toFixed(2)}, voided ${(voided / 100).toFixed(2)} of ${(total / 100).toFixed(2)} dollars`}>
        {seg.map((s) => (
          <motion.div key={s.k} className={`${s.c} rounded-[3px]`} initial={false} animate={{ width: pct(s.v), opacity: s.v ? 1 : 0 }} transition={{ type: 'spring', stiffness: 220, damping: 28 }} />
        ))}
      </div>
      {labels && (
        <div className={`mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] ${onPaper ? 'text-pink' : 'text-soft'}`}>
          {seg
            .filter((s) => s.v > 0)
            .map((s) => (
              <span key={s.k} className="inline-flex items-center gap-1.5">
                <span className={`size-2 rounded-sm ${s.c}`} aria-hidden />
                {s.k} ${(s.v / 100).toFixed(2)}
              </span>
            ))}
        </div>
      )}
    </div>
  )
}
