import { useState } from 'react'

/**
 * Brand mark: a small tilted sticky note with a pink offset shadow.
 * The artwork lives in /brand/mark.svg (swappable without touching code); until that file loads, the inline
 * sticky-note below is drawn, so the site never shows a broken image.
 */
function FallbackMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="6" y="7" width="21" height="21" rx="3" fill="#FF9BB3" transform="rotate(5 16 16)" />
      <g transform="rotate(-7 16 16)">
        <rect x="4" y="4" width="22" height="22" rx="3" fill="#FFD84D" />
        <path d="M8.5 11h13M8.5 15.5h13M8.5 20h7" stroke="#1A1814" strokeWidth="1.9" strokeLinecap="round" />
      </g>
    </svg>
  )
}

export function LogoMark({ className = 'size-8', src = '/brand/mark.svg' }: { className?: string; src?: string }) {
  const [ok, setOk] = useState(false)
  return (
    <span className={`relative inline-block shrink-0 ${className}`} aria-hidden>
      {!ok && <FallbackMark className="absolute inset-0 size-full" />}
      <img src={src} alt="" width={32} height={32} onLoad={() => setOk(true)} onError={() => setOk(false)} className={`absolute inset-0 size-full ${ok ? '' : 'opacity-0'}`} draggable={false} />
    </span>
  )
}

/** Mark + wordmark. `lockup` uses /brand/logo.svg as one image when you have the full artwork. */
export function Logo({ className = '', markClass = 'size-8', lockup = false }: { className?: string; markClass?: string; lockup?: boolean }) {
  const [lockOk, setLockOk] = useState(lockup)
  if (lockup && lockOk) return <img src="/brand/logo.svg" alt="rent-a-bot" height={32} onError={() => setLockOk(false)} className={`h-8 w-auto ${className}`} />
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className={markClass} />
      <span className="font-display text-[20px] font-extrabold tracking-[-0.03em]">rent-a-bot</span>
    </span>
  )
}
