import { useEffect, useRef, useState } from 'react'

const reducedQuery = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Drives a function loop as a step counter: 0..frames-1, then holds the last frame for `hold` ticks and starts over.
 * Ticks only while the scene is on screen. Under prefers-reduced-motion it always returns the final frame.
 */
export function useLoop(frames: number, ms = 700, hold = 4) {
  const ref = useRef<HTMLDivElement>(null)
  const [still, setStill] = useState(reducedQuery)
  const [visible, setVisible] = useState(false)
  const [t, setT] = useState(0)

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setStill(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '80px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (still || !visible) return
    const id = setInterval(() => setT((x) => (x + 1) % (frames + hold)), ms)
    return () => clearInterval(id)
  }, [still, visible, frames, hold, ms])

  return { ref, step: still ? frames - 1 : Math.min(t, frames - 1), still }
}

/** Shared transition for loop pieces: transform and opacity only. */
export const MOVE = 'transition-[transform,opacity] duration-500 ease-[var(--ease-snap)] motion-reduce:transition-none'

/** Visible-or-not style for a piece that pops in at a given step. */
export const pop = (on: boolean, from = 'scale(1.7)') => ({ opacity: on ? 1 : 0, transform: on ? 'none' : from })
