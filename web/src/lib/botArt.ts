// Robot photos live in public/art. __ART__ lists the files that exist, so a missing photo never costs a 404:
// callers get null and draw a coloured sticky-note tile with the bot's initial instead.
const FILES = new Set<string>(typeof __ART__ === 'undefined' ? [] : __ART__)

export const hasArt = (path: string) => FILES.has(path)

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** Backdrop colour of each house bot's photo, also the fallback tile colour. */
const TILE: Record<string, string> = {
  'agent-red-team': '#2B2238',
  'landing-page-bot': '#C9B8FF',
  'directory-blaster': '#FFD84D',
  'investor-outreach': '#C9B8FF',
  'agent-readiness-auditor': '#E9DFCB',
  'lead-verifier': '#FF9BB3',
  'cold-email-writer': '#8BE3B4',
  'lead-verifier-budget': '#2B2238',
  'budget-lead-verifier': '#2B2238',
  'account-setup': '#8BE3B4',
  'application-filler': '#FF9BB3',
  'deliverability-doctor': '#C9B8FF',
  'broken-link-hunter': '#FFD84D',
  'web-data-extractor': '#E9DFCB',
  'uptime-watch': '#8BE3B4',
}
const PALETTE = ['#FFD84D', '#C9B8FF', '#E9DFCB', '#FF9BB3', '#8BE3B4']

export function botSlug(name: string): string {
  const s = slugOf(name)
  if (TILE[s]) return s
  const bare = s.replace(/-bot$/, '')
  return TILE[bare] ? bare : s
}

export interface BotArt {
  src: string
  srcSet?: string
}

/** The robot photo for a bot (by name or slug), or null while that photo has not been generated. */
export function botArt(nameOrSlug: string): BotArt | null {
  const slug = botSlug(nameOrSlug)
  const file = `bots/${slug}.webp`
  if (!FILES.has(file)) return null
  const big = `bots/${slug}-1200.webp`
  return { src: `/art/${file}`, srcSet: FILES.has(big) ? `/art/${file} 1024w, /art/${big} 1200w` : undefined }
}

export function tileColor(nameOrSlug: string): string {
  const slug = botSlug(nameOrSlug)
  if (TILE[slug]) return TILE[slug]
  let h = 0
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
