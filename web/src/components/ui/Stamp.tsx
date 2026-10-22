import { motion, useReducedMotion } from 'motion/react'
import type { CSSProperties, ReactNode } from 'react'

export type StampKind = 'verified' | 'captured' | 'held' | 'voided' | 'ruled' | 'flagged' | 'paid' | 'open' | 'refunded'

const TONE: Record<StampKind, 'lime' | 'amber' | 'coral' | 'ink'> = {
  verified: 'lime',
  captured: 'lime',
  paid: 'lime',
  held: 'amber',
  open: 'amber',
  voided: 'coral',
  flagged: 'coral',
  ruled: 'ink',
  refunded: 'ink',
}

interface Props {
  kind: StampKind
  children?: ReactNode
  /** Rotation in degrees. */
  rotate?: number
  /** Surface the stamp sits on. paper = darker inks, ink = brand signal colours. */
  on?: 'paper' | 'ink'
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** Slam in when mounted (or when `show` flips true). */
  animate?: boolean
  delay?: number
  className?: string
  style?: CSSProperties
}

const SIZE = { xs: 'text-[10px]', sm: 'text-xs', md: 'text-base', lg: 'text-2xl' }

export function Stamp({ kind, children, rotate = -6, on = 'paper', size = 'md', animate = true, delay = 0, className = '', style }: Props) {
  const reduce = useReducedMotion()
  const tone = TONE[kind]
  const cls = `stamp stamp-${tone} ${on === 'ink' ? 'on-ink' : ''} ${SIZE[size]} ${className}`
  const label = children ?? kind.toUpperCase()
  if (!animate || reduce) {
    return (
      <span className={cls} style={{ transform: `rotate(${rotate}deg)`, ...style }} role="img" aria-label={typeof label === 'string' ? label : kind}>
        {label}
      </span>
    )
  }
  return (
    <motion.span
      className={cls}
      style={style}
      initial={{ scale: 2.4, opacity: 0, rotate: rotate - 14 }}
      animate={{ scale: 1, opacity: 1, rotate }}
      transition={{ type: 'spring', stiffness: 700, damping: 26, mass: 0.7, delay }}
      role="img"
      aria-label={typeof label === 'string' ? label : kind}
    >
      {label}
    </motion.span>
  )
}
