import { Link } from 'react-router'
import type { BotSummary } from '../api/types'
import type { ComingSoonBot } from '../lib/fixtures'
import { CLASS_LABEL, duration, usd } from '../lib/format'
import { tileColor } from '../lib/botArt'
import { BotSticker } from './BotPhoto'
import { BriefTabs } from './Brief'
import { PassportChips } from './Passport'
import { BotLoop } from './loops'
import { ModeBadge, RentalTag } from './ui'

/** The skill's flat-priced extras as "+ $5.00 crawl report"; empty when it declares none. */
export function extrasLine(skill: BotSummary['skills'][number] | undefined): string {
  const x = skill?.pricing.extras ?? []
  return x.length ? `+ ${x.map((e) => `${usd(e.price)} ${e.title.toLowerCase()}`).join(' + ')}` : ''
}

function unitLine(skill: BotSummary['skills'][number] | undefined): string {
  if (!skill) return ''
  const p = skill.pricing
  return p.model === 'fixed' ? `${usd(p.price)} fixed` : `${usd(p.price)} / ${(p.unit ?? 'unit').replace(/_/g, ' ')}`
}

/** "$0.25 / verified broken link + $5.00 crawl report": the unit price, then any flat extras. */
export function priceLine(skill: BotSummary['skills'][number] | undefined): string {
  const extras = extrasLine(skill)
  return extras ? `${unitLine(skill)} ${extras}` : unitLine(skill)
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : `${Math.round(n * 100)}%`)

/** A bot listing as a paper card pinned to the page: a loop of its actual work on top, a small avatar sticker, price sticker,
 *  the title, and a Needs / Does / You get row. */
export function BotTag({ bot, rotate = 0, index = 0 }: { bot: BotSummary; rotate?: number; index?: number }) {
  const skill = bot.skills[0]
  const rep = bot.reputation
  const bg = tileColor(bot.name)
  const dark = bg === '#2B2238'
  return (
    <Link to={`/bots/${bot.id}`} className="group block outline-offset-4" aria-label={`${bot.name}, ${priceLine(skill)}. Open bot page.`} style={{ ['--i' as string]: index }}>
      <article className="wiggle pin paper on-paper relative rounded-[26px] p-3 pb-5 shadow-[0_22px_30px_-14px_rgba(0,0,0,0.65)] transition-transform duration-300 ease-[var(--ease-snap)] group-hover:!-translate-y-1.5" style={{ ['--r' as string]: `${rotate}deg`, transform: `rotate(${rotate}deg)` }}>
        <div className="relative h-[172px] overflow-hidden rounded-[18px]" style={{ background: bg }}>
          <BotLoop name={bot.name} cls={bot.capability_class} dark={dark} />
          <span className="absolute left-3 top-3 rounded-md bg-[#fbf8f1] p-0.5"><ModeBadge mode={bot.mode} /></span>
        </div>
        <span className="absolute -right-1 -top-4 z-[3] sm:-right-3"><BotSticker name={bot.name} size={62} rotate={rotate > 0 ? -7 : 7} /></span>
        <span className="absolute right-6 top-[170px] z-[2] max-w-[calc(100%-3.5rem)] -rotate-3 rounded-lg bg-hl px-2.5 py-1 font-mono text-[12.5px] font-bold text-ink shadow-[0_6px_10px_-4px_rgba(0,0,0,0.5)]">
          {unitLine(skill)}
          {extrasLine(skill) && <span className="block text-[11px]">{extrasLine(skill)}</span>}
        </span>
        <div className={`px-2.5 ${extrasLine(skill) ? 'pt-9' : 'pt-6'}`}>
          <h3 className="display text-[1.95rem] leading-[0.95] text-pink">{bot.name}</h3>
          <p className="mt-2 line-clamp-2 text-[14px] leading-snug text-pink/70">{bot.tagline}</p>
          {skill?.brief && <BriefTabs brief={skill.brief} />}
          {bot.passport && <PassportChips passport={bot.passport} />}
          <p className="mt-3 flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-pmute">
            <span>{rep.jobs_completed} {rep.jobs_completed === 1 ? 'job' : 'jobs'}</span>
            <span>on time {pct(rep.on_time_rate)}</span>
            <span>{duration(skill?.turnaround)}</span>
          </p>
        </div>
      </article>
    </Link>
  )
}

export function ComingSoonTag({ bot, rotate = 0 }: { bot: ComingSoonBot; rotate?: number }) {
  return (
    <div role="group" aria-label={`${bot.name}, coming soon`}>
      <RentalTag
        tone="grey"
        rotate={rotate}
        swing={false}
        footer={
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[12px] text-mute">{bot.price}</span>
            <span className="rounded border border-[#55555f] px-1.5 py-px font-mono text-[10px] font-bold tracking-widest text-soft">COMING SOON</span>
          </div>
        }
      >
        <ClassChipGrey cls={bot.capability} />
        <h3 className="display mt-3 text-[1.55rem] leading-[0.98] text-soft">{bot.name}</h3>
        <p className="mt-2.5 text-[13px] leading-snug text-mute">{bot.tagline}</p>
      </RentalTag>
    </div>
  )
}

function ClassChipGrey({ cls }: { cls: string }) {
  return <span className="inline-block rounded-full border border-[#44444c] px-2 py-px text-[11px] text-mute">{CLASS_LABEL[cls] ?? cls}</span>
}
