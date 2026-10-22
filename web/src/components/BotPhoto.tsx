import { botArt, tileColor } from '../lib/botArt'

/** A bot's robot photo, or (until that photo exists) a sticky-note tile with its initial. Always square. */
export function BotPhoto({ name, className = '', sizes = '(min-width: 1024px) 360px, 90vw', eager = false, rounded = 'rounded-[22px]', tiny = false }: { name: string; className?: string; sizes?: string; eager?: boolean; rounded?: string; tiny?: boolean }) {
  const art = botArt(name)
  const bg = tileColor(name)
  const dark = bg === '#2B2238'
  return (
    <div className={`relative aspect-square overflow-hidden ${rounded} ${className}`} style={{ background: bg }}>
      {art ? (
        <img src={art.src} srcSet={art.srcSet} sizes={art.srcSet ? sizes : undefined} width={1024} height={1024} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} className="size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center">
          {tiny ? <span className="font-display text-[13px] font-extrabold text-ink">{name.trim().slice(0, 1).toUpperCase()}</span> : (
          <span className={`note !grid size-[46%] place-items-center !font-display !text-[clamp(2.4rem,9vw,4.6rem)] font-extrabold`} style={{ ['--r' as string]: '-4deg', ['--note' as string]: dark ? '#C9B8FF' : '#F4EEE1' }}>
            {name.trim().slice(0, 1).toUpperCase()}
          </span>
          )}
        </div>
      )}
    </div>
  )
}

/** A small die-cut sticker of the bot: its robot photo, or a logo-style monogram until that photo exists. */
export function BotSticker({ name, size = 60, rotate = 6, className = '' }: { name: string; size?: number; rotate?: number; className?: string }) {
  const art = botArt(name)
  const bg = tileColor(name)
  const dark = bg === '#2B2238'
  return (
    <span
      className={`block overflow-hidden rounded-[30%] border-[3px] border-[#fbf8f1] shadow-[0_6px_10px_-4px_rgba(0,0,0,0.6)] ${className}`}
      style={{ width: size, height: size, background: bg, transform: `rotate(${rotate}deg)` }}
      aria-hidden
    >
      {art ? (
        <img src={art.src} width={size} height={size} alt="" loading="lazy" decoding="async" draggable={false} className="size-full scale-[1.35] object-cover object-[50%_30%]" />
      ) : (
        <span className={`grid size-full place-items-center font-display font-extrabold ${dark ? 'text-lav' : 'text-ink'}`} style={{ fontSize: size * 0.48 }}>
          {name.trim().slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  )
}
