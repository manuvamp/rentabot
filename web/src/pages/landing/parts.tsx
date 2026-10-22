import type { ReactNode } from 'react'
import { BotPhoto } from '../../components/BotPhoto'

/** A white-bordered snapshot of a bot, slightly turned, like a photo stuck to the page. */
export function Polaroid({ name, rotate = 3, className = '', size = 'size-32' }: { name: string; rotate?: number; className?: string; size?: string }) {
  return (
    <div className={`rounded-[10px] bg-[#fbf8f1] p-1.5 shadow-[0_14px_24px_-10px_rgba(0,0,0,0.55)] ${className}`} style={{ transform: `rotate(${rotate}deg)` }}>
      <BotPhoto name={name} className={size} rounded="rounded-[6px]" sizes="160px" />
    </div>
  )
}

export function SectionHead({ title, line, children }: { title: ReactNode; line?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="display text-[clamp(2.2rem,5.2vw,4.2rem)]">{title}</h2>
        {line && <p className="mt-3 max-w-xl text-lg text-soft">{line}</p>}
      </div>
      {children}
    </div>
  )
}
