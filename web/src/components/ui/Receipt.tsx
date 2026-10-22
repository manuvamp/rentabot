import { motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { shortHash } from '../../lib/format'

/** Paper receipt with torn zig-zag edges. Children are the printed lines. */
export function Receipt({ children, className = '', title, id, tilt = 0, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; id?: string; tilt?: number; padded?: boolean }) {
  return (
    <div className={`receipt-wrap ${className}`} style={tilt ? { transform: `rotate(${tilt}deg)` } : undefined}>
      <div className={`receipt paper on-paper ${padded ? 'px-5 py-5 sm:px-6' : ''}`} id={id}>
        {title && <div className="text-center font-bold tracking-[0.22em] uppercase text-[0.7rem] mb-1">{title}</div>}
        {children}
      </div>
    </div>
  )
}

export const ReceiptRule = ({ double = false }: { double?: boolean }) => <hr className="receipt-rule" style={double ? { borderTopStyle: 'double', borderTopWidth: 4 } : undefined} />

/** label ........ value */
export function ReceiptRow({ label, value, strong, tone, className = '' }: { label: ReactNode; value?: ReactNode; strong?: boolean; tone?: 'lime' | 'amber' | 'coral' | 'mute'; className?: string }) {
  const color = tone === 'lime' ? 'text-lime-deep' : tone === 'amber' ? 'text-amber-deep' : tone === 'coral' ? 'text-coral-deep' : tone === 'mute' ? 'text-pmute' : ''
  return (
    <div className={`flex items-baseline gap-2 ${strong ? 'font-bold' : ''} ${color} ${className}`}>
      {/* Both sides may wrap: a long label with shrink-0 pushed the value off a 390 px screen (Job Room proposal cards). */}
      <span className="min-w-0">{label}</span>
      <span className="dots-leader" aria-hidden />
      <span className="num min-w-0 text-right">{value}</span>
    </div>
  )
}

export function ReceiptHash({ hash, label = 'sha256' }: { hash: string | null | undefined; label?: string }) {
  return (
    <div className="mt-2 text-[0.68rem] text-pmute break-all leading-tight">
      <span className="uppercase tracking-widest">{label}</span> <span title={hash ?? undefined}>{hash ? shortHash(hash, 16) : 'not yet signed'}</span>
      <div className="mt-1.5 h-5 w-full opacity-70" aria-hidden style={{ background: barcode(hash ?? 'unsigned') }} />
    </div>
  )
}

/** A deterministic barcode-like strip from a hash string. */
function barcode(seed: string): string {
  let x = 0
  for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0
  const stops: string[] = []
  let pos = 0
  for (let i = 0; i < 46; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    const w = 1 + (x % 3)
    stops.push(`#1a1814 ${pos}px ${pos + w}px`, `transparent ${pos + w}px ${pos + w + 1 + ((x >> 8) % 3)}px`)
    pos += w + 1 + ((x >> 8) % 3)
  }
  return `repeating-linear-gradient(90deg, ${stops.slice(0, 92).join(',')})`
}

/** A line that "prints" in: used for the receipts that tell the story. */
export function PrintLine({ children, delay = 0, instant = false, className = '' }: { children: ReactNode; delay?: number; instant?: boolean; className?: string }) {
  const reduce = useReducedMotion()
  if (instant || reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: -8, clipPath: 'inset(0 100% 0 0)' }}
      animate={{ opacity: 1, y: 0, clipPath: 'inset(0 0% 0 0)' }}
      transition={{ duration: 0.45, delay, ease: [0.2, 0.9, 0.2, 1] }}
    >
      {children}
    </motion.div>
  )
}
