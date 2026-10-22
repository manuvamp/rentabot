/**
 * "Made by bots": real finished work that AI agent pipelines made for the owner's own brands.
 * None of it was bought on Rent-A-Bot. Each piece names the agent that made it; `bot_id` stays empty
 * until a real listing on the marketplace sells that kind of work, then the card can link to it.
 * Media lives in web/public/showcase/ (loops are muted 540x960 H.264; `full` is a 720p cut with sound).
 */
export type ShowcaseKind = 'video' | 'carousel' | 'image' | 'page'
export type ShowcaseBrand = 'Orano' | 'Infotik' | 'MyRoll'

export interface ShowcaseItem {
  id: string
  kind: ShowcaseKind
  brand: ShowcaseBrand
  /** Who made it, e.g. "Video agent". Not a marketplace listing. */
  maker: string
  /** Optional Rent-A-Bot listing id that sells this kind of work. Empty for now. */
  bot_id?: string
  /** The brief, in a few words. */
  ask: string
  pipeline: string
  /** Short alt text describing what is on screen. */
  alt: string
  /** Muted preview loop (videos). */
  loop?: string
  /** Click-to-play version with sound (videos). */
  full?: string
  /** True when `full` is a cut of a longer film rather than the whole piece. */
  cut?: boolean
  poster: string
  /** Slides (carousels) or a larger view (images, pages). */
  slides?: string[]
  /** Small slide images for the card stack. */
  thumbs?: string[]
  /** Width / height of the media. */
  aspect: number
  /** "37s film", "7 slides", "1600x1200". */
  meta: string
}

const S = '/showcase/'
const slides = Array.from({ length: 7 }, (_, i) => `${S}orano-carousel-0${i + 1}.webp`)

export const SHOWCASE: ShowcaseItem[] = [
  {
    id: 'orano-black-hole',
    kind: 'video',
    brand: 'Orano',
    maker: 'Video agent',
    ask: 'Launch film: your saved folder is a black hole',
    pipeline: 'HyperFrames',
    alt: 'Saved reels spiral into a black hole while a counter reads 200 in, 000 out.',
    loop: `${S}orano-black-hole-loop.mp4`,
    full: `${S}orano-black-hole-720.mp4`,
    cut: true,
    poster: `${S}orano-black-hole-poster.webp`,
    aspect: 9 / 16,
    meta: '37s film',
  },
  {
    id: 'orano-carousel',
    kind: 'carousel',
    brand: 'Orano',
    maker: 'Carousel agent',
    ask: '7 slides: 100+ reels saved, now use them',
    pipeline: 'Nano Banana 2 + carousel system',
    alt: 'Instagram carousel with an owl mascot: 100+ reels saved, later never came, share it to Orano, start using what you save.',
    poster: `${S}orano-carousel-01-sm.webp`,
    slides,
    thumbs: slides.map((s) => s.replace('.webp', '-sm.webp')),
    aspect: 4 / 5,
    meta: '7 slides',
  },
  {
    id: 'orano-last-save',
    kind: 'video',
    brand: 'Orano',
    maker: 'Story agent',
    ask: 'Episode 1 of a comic story series',
    pipeline: 'Nano Banana 2 + ElevenLabs + HyperFrames',
    alt: 'Illustrated comic panels: a hand holds a brass key tagged 30, then a locked phone at 2 a.m.',
    loop: `${S}orano-last-save-loop.mp4`,
    full: `${S}orano-last-save-720.mp4`,
    poster: `${S}orano-last-save-poster.webp`,
    aspect: 9 / 16,
    meta: '92s episode',
  },
  {
    id: 'infotik-screentime',
    kind: 'video',
    brand: 'Infotik',
    maker: 'Ad agent',
    ask: 'UGC ad: beat yesterday’s screen time',
    pipeline: 'HyperFrames',
    alt: 'A hand holds a phone showing the Infotik Beat Yesterday You screen with a 30 minute YouTube limit.',
    loop: `${S}infotik-screentime-loop.mp4`,
    poster: `${S}infotik-screentime-poster.webp`,
    aspect: 9 / 16,
    meta: '13s ad',
  },
  {
    id: 'orano-seedbank',
    kind: 'video',
    brand: 'Orano',
    maker: 'Video agent',
    ask: 'Launch film: every save is a seed',
    pipeline: 'HyperFrames',
    alt: 'Field-notes style drawing of a seed on cream paper: most never get planted.',
    loop: `${S}orano-seedbank-loop.mp4`,
    full: `${S}orano-seedbank-720.mp4`,
    cut: true,
    poster: `${S}orano-seedbank-poster.webp`,
    aspect: 9 / 16,
    meta: '36s film',
  },
  {
    id: 'myroll-landing',
    kind: 'page',
    brand: 'MyRoll',
    maker: 'Web agent',
    ask: 'Landing page for an AI video editor',
    pipeline: 'Static HTML + CSS',
    alt: 'MyRoll landing page: Your footage. Automatically matched. Lime and charcoal.',
    poster: `${S}myroll-landing.webp`,
    slides: [`${S}myroll-landing-long.webp`],
    aspect: 16 / 10,
    meta: 'one-page site',
  },
  {
    id: 'orano-quadrant',
    kind: 'video',
    brand: 'Orano',
    maker: 'Video agent',
    ask: 'Feature reel in a 4-quadrant grid',
    pipeline: 'HyperFrames',
    alt: 'Cream grid collage: saving isn’t the same as doing, then Turn saves into action.',
    loop: `${S}orano-quadrant-loop.mp4`,
    full: `${S}orano-quadrant-720.mp4`,
    cut: true,
    poster: `${S}orano-quadrant-poster.webp`,
    aspect: 9 / 16,
    meta: '34s film',
  },
  {
    id: 'orano-ad-later',
    kind: 'image',
    brand: 'Orano',
    maker: 'Ad agent',
    ask: 'Static ad: from “I’ll come back to this” to done',
    pipeline: 'HTML render + real app UI',
    alt: 'Dark ad with a red rule: I’ll come back to this. To done. Beside an Orano task list.',
    poster: `${S}orano-ad-later-to-done.webp`,
    slides: [`${S}orano-ad-later-to-done.webp`],
    aspect: 4 / 3,
    meta: '1600x1200 ad',
  },
  {
    id: 'orano-brand-motion',
    kind: 'video',
    brand: 'Orano',
    maker: 'Video agent',
    ask: 'Logo build for the brand reel',
    pipeline: 'HyperFrames',
    alt: 'The Orano wordmark draws itself letter by letter in white and red lines on black.',
    loop: `${S}orano-brand-motion-loop.mp4`,
    full: `${S}orano-brand-motion-720.mp4`,
    cut: true,
    poster: `${S}orano-brand-motion-poster.webp`,
    aspect: 9 / 16,
    meta: '30s reel',
  },
]
