import { ArrowLeft, ArrowRight, Play, X } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { Container, Reveal } from '../../components/ui'
import { SHOWCASE, type ShowcaseItem, type ShowcaseKind } from '../../data/showcase'

const NOTES = ['', 'note-pink', 'note-lav', 'note-mint', 'note-sand']
const TILT = [-1.6, 1.3, -0.8, 1.8, -1.2, 0.9]
const SUBTITLE = 'Real deliverables from AI agent pipelines, made for Orano, Infotik and MyRoll.'

export const receipt = (it: ShowcaseItem) => `${it.maker} · for ${it.brand} · ${it.pipeline} · ${it.meta}`

/** True while the element is on screen. */
function useVisible<T extends Element>(margin = '0px') {
  const ref = useRef<T>(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: margin, threshold: 0.35 })
    io.observe(el)
    return () => io.disconnect()
  }, [margin])
  return [ref, on] as const
}

/** Muted inline loop that only plays while visible. Posters only under reduced motion. */
function LoopVideo({ item }: { item: ShowcaseItem }) {
  const reduce = useReducedMotion()
  const [ref, on] = useVisible<HTMLVideoElement>()
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (on && !reduce) v.play().catch(() => {})
    else v.pause()
  }, [on, reduce, ref])
  if (reduce) return <img src={item.poster} alt={item.alt} className="size-full object-cover" loading="lazy" decoding="async" />
  return (
    <video ref={ref} className="size-full object-cover" src={item.loop} poster={item.poster} muted loop playsInline preload="none" aria-label={item.alt} />
  )
}

/** Three slides fanned like a small stack; the front one changes every few seconds while visible. */
function SlideStack({ item }: { item: ShowcaseItem }) {
  const reduce = useReducedMotion()
  const thumbs = item.thumbs ?? item.slides ?? [item.poster]
  const [ref, on] = useVisible<HTMLDivElement>()
  const [i, setI] = useState(0)
  useEffect(() => {
    if (!on || reduce) return
    const t = setInterval(() => setI((n) => (n + 1) % thumbs.length), 2600)
    return () => clearInterval(t)
  }, [on, reduce, thumbs.length])
  return (
    <div ref={ref} className="relative size-full">
      {[2, 1, 0].map((depth) => {
        const n = (i + depth) % thumbs.length
        return (
          <img
            key={`${depth}-${n}`}
            src={thumbs[n]}
            alt={depth === 0 ? `${item.alt} Slide ${n + 1} of ${thumbs.length}.` : ''}
            aria-hidden={depth !== 0 || undefined}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full rounded-[4px] object-cover shadow-[0_10px_18px_-8px_rgba(0,0,0,0.6)] transition-transform duration-500"
            style={{ transform: `translate(${depth * 9}px, ${depth * -9}px) rotate(${depth * 2.5}deg)`, zIndex: 3 - depth, opacity: depth ? 0.92 : 1 }}
          />
        )
      })}
      <span className="absolute bottom-2 right-2 z-10 rounded-full bg-ink/80 px-2 py-0.5 font-mono text-[11px] text-fog">
        {i + 1}/{thumbs.length}
      </span>
    </div>
  )
}

function Media({ item }: { item: ShowcaseItem }) {
  if (item.kind === 'video') return <LoopVideo item={item} />
  if (item.kind === 'carousel') return <SlideStack item={item} />
  if (item.kind === 'page')
    return (
      <div className="flex size-full flex-col overflow-hidden rounded-[4px] bg-[#0b0b0c]">
        <div className="flex h-5 shrink-0 items-center gap-1 bg-[#1c1c1e] px-2" aria-hidden>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <span key={c} className="size-1.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
        <img src={item.poster} alt={item.alt} className="min-h-0 flex-1 object-cover object-top" loading="lazy" decoding="async" />
      </div>
    )
  return <img src={item.poster} alt={item.alt} className="size-full object-cover" loading="lazy" decoding="async" />
}

/** A pinned paper card: the work, a sticky note with the ask, a receipt line with who made it. */
function Card({ item, index, onOpen, height }: { item: ShowcaseItem; index: number; onOpen: (it: ShowcaseItem) => void; height: string }) {
  const tilt = TILT[index % TILT.length]
  return (
    <figure className="relative shrink-0 snap-center" style={{ transform: `rotate(${tilt}deg)` }}>
      <button
        type="button"
        onClick={() => onOpen(item)}
        aria-label={`Open: ${item.ask}. ${receipt(item)}`}
        className="paper pin group block rounded-[6px] p-2 pb-12 text-left shadow-[0_22px_34px_-14px_rgba(0,0,0,0.7)] transition-transform duration-300 hover:-translate-y-1"
      >
        <div className={`relative rounded-[4px] ${item.kind === 'carousel' ? '' : 'overflow-hidden bg-ink'} ${height}`} style={{ aspectRatio: item.aspect, maxWidth: 'calc(100vw - 3.5rem)' }}>
          <Media item={item} />
          {item.kind === 'video' && (
            <span className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-ink/70 text-fog opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden>
              <Play className="size-4" />
            </span>
          )}
        </div>
        <figcaption className="absolute inset-x-2.5 bottom-2 font-mono text-[10.5px] leading-[1.45] tracking-tight text-pmute">
          <span className="block truncate font-semibold text-pink">
            {item.maker} · for {item.brand}
          </span>
          <span className="block truncate">
            {item.pipeline} · {item.meta}
          </span>
        </figcaption>
      </button>
      <div className="pointer-events-none absolute bottom-[3.6rem] -left-4 z-10 max-w-[80%]" aria-hidden>
        <p className={`note text-[19px] sm:text-[21px] ${NOTES[index % NOTES.length]}`} style={{ ['--r' as string]: `${-tilt * 2 - 2}deg` }}>
          {item.ask}
        </p>
      </div>
    </figure>
  )
}

/** Full view: the video with sound when there is one, or the slides. Native <dialog> handles focus and Esc. */
function Lightbox({ item, onClose }: { item: ShowcaseItem | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const reduce = useReducedMotion()
  const [slide, setSlide] = useState(0)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (item && !d.open) {
      setSlide(0)
      d.showModal()
    } else if (!item && d.open) d.close()
  }, [item])
  const slides = item?.slides ?? []
  const many = slides.length > 1
  const go = (n: number) => setSlide((s) => (s + n + slides.length) % slides.length)
  const onKey = (e: KeyboardEvent) => {
    if (!many) return
    if (e.key === 'ArrowRight') go(1)
    if (e.key === 'ArrowLeft') go(-1)
  }
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onKeyDown={onKey}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label={item ? item.ask : 'Showcase piece'}
      className="m-auto max-h-[94dvh] max-w-[94vw] overflow-visible bg-transparent p-0 text-fog backdrop:bg-black/80 backdrop:backdrop-blur-sm"
    >
      {item && (
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            {item.kind === 'video' ? (
              <video
                key={item.id}
                className="max-h-[80dvh] w-auto rounded-[8px] bg-black"
                style={{ aspectRatio: item.aspect }}
                src={item.full ?? item.loop}
                poster={item.poster}
                controls
                playsInline
                autoPlay={!reduce}
                muted={!item.full}
                loop={!item.full}
                aria-label={item.alt}
              />
            ) : (
              <div className={`max-h-[80dvh] max-w-[90vw] ${item.kind === 'page' ? 'overflow-y-auto rounded-[8px]' : ''}`}>
                <img
                  src={slides[slide] ?? item.poster}
                  alt={many ? `${item.alt} Slide ${slide + 1} of ${slides.length}.` : item.alt}
                  className={item.kind === 'page' ? 'w-[min(1100px,90vw)]' : 'max-h-[80dvh] w-auto rounded-[8px]'}
                />
              </div>
            )}
            {many && (
              <>
                <button type="button" onClick={() => go(-1)} aria-label="Previous slide" className="absolute left-2 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-ink/80 hover:bg-ink">
                  <ArrowLeft className="size-5" />
                </button>
                <button type="button" onClick={() => go(1)} aria-label="Next slide" className="absolute right-2 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-ink/80 hover:bg-ink">
                  <ArrowRight className="size-5" />
                </button>
              </>
            )}
            <button type="button" onClick={onClose} aria-label="Close" autoFocus className="absolute -right-3 -top-3 grid size-10 place-items-center rounded-full bg-hl text-ink shadow-lg">
              <X className="size-5" />
            </button>
          </div>
          <p className="max-w-[min(640px,90vw)] text-center font-mono text-[12px] text-soft">
            {receipt(item)}
            {item.kind === 'video' && (item.cut ? ' · opening cut' : item.full ? '' : ' · muted preview')}
            {many && ` · ${slide + 1}/${slides.length}`}
          </p>
        </div>
      )}
    </dialog>
  )
}

/** Landing section: a rail of pinned cards, right after the hero. */
export function MadeByBots() {
  const [open, setOpen] = useState<ShowcaseItem | null>(null)
  const rail = useRef<HTMLDivElement>(null)
  const nudge = (dir: number) => rail.current?.scrollBy({ left: dir * Math.min(560, rail.current.clientWidth * 0.8), behavior: 'smooth' })
  return (
    <section className="py-14 lg:py-20" aria-labelledby="made-h">
      <Container wide>
        <Reveal>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 id="made-h" className="display text-[clamp(2rem,4.4vw,3.4rem)]">
                Made by <span className="hl-block">bots.</span>
              </h2>
              <p className="mt-3 max-w-xl text-soft">{SUBTITLE}</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => nudge(-1)} aria-label="Scroll left" className="grid size-11 place-items-center rounded-full border border-line hover:border-hl">
                <ArrowLeft className="size-5" />
              </button>
              <button type="button" onClick={() => nudge(1)} aria-label="Scroll right" className="grid size-11 place-items-center rounded-full border border-line hover:border-hl">
                <ArrowRight className="size-5" />
              </button>
              <Link to="/made" className="ml-1 rounded-full bg-hl px-4 py-2.5 font-semibold text-ink">
                See all
              </Link>
            </div>
          </div>
        </Reveal>
      </Container>
      <div
        ref={rail}
        role="list"
        aria-label="Work made by AI agents"
        className="mt-6 flex snap-x snap-mandatory items-center gap-9 overflow-x-auto px-[max(1.25rem,calc((100vw-1500px)/2+2rem))] pb-14 pt-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SHOWCASE.map((it, i) => (
          <div role="listitem" key={it.id}>
            <Card item={it} index={i} onOpen={setOpen} height="h-[340px] sm:h-[420px]" />
          </div>
        ))}
      </div>
      <Lightbox item={open} onClose={() => setOpen(null)} />
    </section>
  )
}

const FILTERS: { kind: ShowcaseKind | 'all'; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'video', label: 'Videos' },
  { kind: 'carousel', label: 'Carousels' },
  { kind: 'image', label: 'Ads' },
  { kind: 'page', label: 'Pages' },
]

/** /made: the whole wall with kind filters. */
export default function MadeGallery() {
  const [open, setOpen] = useState<ShowcaseItem | null>(null)
  const [kind, setKind] = useState<ShowcaseKind | 'all'>('all')
  const items = SHOWCASE.filter((it) => kind === 'all' || it.kind === kind)
  return (
    <Container wide className="py-14 lg:py-20">
      <h1 className="display text-[clamp(2.4rem,5.6vw,4.4rem)]">
        Made by <span className="hl-block">bots.</span>
      </h1>
      <p className="mt-3 max-w-xl text-lg text-soft">{SUBTITLE}</p>
      <div className="mt-7 flex flex-wrap gap-2" role="group" aria-label="Filter by kind">
        {FILTERS.map((f) => (
          <button
            key={f.kind}
            type="button"
            aria-pressed={kind === f.kind}
            onClick={() => setKind(f.kind)}
            className={`rounded-full border px-4 py-2 font-semibold ${kind === f.kind ? 'border-hl bg-hl text-ink' : 'border-line text-fog hover:border-hl'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div role="list" className="mt-10 flex flex-wrap items-center justify-center gap-x-10 gap-y-16 pb-10">
        {items.map((it) => (
          <div role="listitem" key={it.id}>
            <Card item={it} index={SHOWCASE.indexOf(it)} onOpen={setOpen} height="h-[360px] sm:h-[440px]" />
          </div>
        ))}
      </div>
      <Lightbox item={open} onClose={() => setOpen(null)} />
    </Container>
  )
}
