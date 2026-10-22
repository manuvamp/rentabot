import { motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * Luggage-style rental tag: clipped corners, punched hole, string, perforated tear-off at the bottom.
 * Swings from the hole on hover/focus. `tone="grey"` is the coming-soon variant.
 */
export function RentalTag({
  children,
  footer,
  tone = 'paper',
  rotate = 0,
  className = '',
  swing = true,
  stringColor,
}: {
  children: ReactNode
  footer?: ReactNode
  tone?: 'paper' | 'grey'
  rotate?: number
  className?: string
  swing?: boolean
  stringColor?: string
}) {
  const reduce = useReducedMotion()
  const grey = tone === 'grey'
  const color = stringColor ?? (grey ? '#55555f' : '#c8b98d')
  return (
    <motion.div
      className={`relative pt-12 origin-[50%_62px] ${className}`}
      style={{ rotate, transformOrigin: '50% 62px' }}
      whileHover={swing && !reduce ? { rotate: rotate + 3.2 } : undefined}
      whileFocus={swing && !reduce ? { rotate: rotate - 2.4 } : undefined}
      transition={{ type: 'spring', stiffness: 160, damping: 5.5 }}
    >
      {/* string */}
      <svg className="absolute left-1/2 top-0 -translate-x-1/2 pointer-events-none" width="56" height="64" viewBox="0 0 56 64" fill="none" aria-hidden>
        <path d="M28 62 C 28 40, 6 36, 10 14 C 12 4, 26 -2, 34 4" stroke={color} strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="28" cy="62" r="5.5" stroke={color} strokeWidth="2.6" />
      </svg>
      <div className="drop-shadow-[0_14px_16px_rgba(0,0,0,0.55)]">
        <div
          className={`tag-shape flex flex-col ${grey ? 'bg-[#2a2a31] text-mute' : 'paper text-pink'} on-paper`}
          style={{ ['--hole-y' as string]: '14px' }}
        >
          <div className="px-5 pt-8 pb-3 flex-1">{children}</div>
          {footer && <div className={`tag-perf mx-0 px-5 py-3 text-[0.78rem] ${grey ? 'border-t-[#44444c]' : ''}`}>{footer}</div>}
        </div>
      </div>
    </motion.div>
  )
}
