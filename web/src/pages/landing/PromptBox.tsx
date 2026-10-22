import { motion, useReducedMotion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, type NavigateFunction } from 'react-router'
import { callOp } from '../../api/client'
import type { BotSummary } from '../../api/types'
import { PLACEHOLDERS } from '../../lib/examples'
import { hireUrl, rankBots } from '../../lib/matchBot'

export type RouteOutcome = { kind: 'navigated' } | { kind: 'pick'; bots: BotSummary[] } | { kind: 'error'; message: string }

/**
 * The hero's one routing decision: take the goal text and send the visitor on.
 * Best-matching house bot -> its hire page with the goal pre-filled (the Spec Copilot drafts it there).
 * No obvious match -> the caller shows a bot picker. Add other destinations (e.g. posting to all bots) here.
 */
export async function routeGoal(text: string, navigate: NavigateFunction): Promise<RouteOutcome> {
  try {
    const { bots } = await callOp('search_bots', { limit: 50 })
    const ranked = rankBots(text, bots)
    if (ranked[0]?.score) {
      navigate(hireUrl(ranked[0].bot.id, text))
      return { kind: 'navigated' }
    }
    return bots.length ? { kind: 'pick', bots: bots.slice(0, 6) } : { kind: 'error', message: 'The shelf is empty right now.' }
  } catch {
    return { kind: 'error', message: 'Could not reach the shelf. Browse the bots instead.' }
  }
}

/** Types each real house-bot job into the box, holds it, deletes it, and moves to the next. Static (rotating) under reduced motion. */
function useTypewriter(phrases: string[], run: boolean, reduce: boolean) {
  const [i, setI] = useState(0)
  const [n, setN] = useState(0)
  const [erasing, setErasing] = useState(false)
  useEffect(() => {
    if (!run) return
    if (reduce) {
      const t = setInterval(() => setI((x) => (x + 1) % phrases.length), 4200)
      return () => clearInterval(t)
    }
    const full = phrases[i]
    let t: ReturnType<typeof setTimeout>
    if (!erasing && n < full.length) t = setTimeout(() => setN(n + 1), 34)
    else if (!erasing) t = setTimeout(() => setErasing(true), 1900)
    else if (n > 0) t = setTimeout(() => setN(n - 1), 14)
    else
      t = setTimeout(() => {
        setErasing(false)
        setI((x) => (x + 1) % phrases.length)
      }, 250)
    return () => clearTimeout(t)
  }, [i, n, erasing, run, reduce, phrases])
  return { i, text: reduce || !run ? phrases[i] : phrases[i].slice(0, n) }
}

/** "What should a bot do for you?" The goal goes to the hire flow of the best-matching bot, where the Spec Copilot drafts it. */
export function PromptBox() {
  const reduce = useReducedMotion() ?? false
  const navigate = useNavigate()
  const id = useId()
  const [goal, setGoal] = useState('')
  const [focus, setFocus] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState<BotSummary[] | null>(null)
  const [error, setError] = useState('')
  const { i, text: typed } = useTypewriter(PLACEHOLDERS, !goal && !focus, reduce)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const text = goal.trim() || PLACEHOLDERS[i].replace(/\.$/, '')
    setBusy(true)
    setError('')
    setPick(null)
    const out = await routeGoal(text, navigate)
    if (out.kind === 'pick') {
      setGoal(text)
      setPick(out.bots)
    } else if (out.kind === 'error') setError(out.message)
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-9 w-full max-w-3xl" aria-label="Post a job">
      <div className={`relative rounded-[30px] border bg-ink-1 p-2 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)] transition-[border-color,box-shadow] duration-200 ${focus ? 'border-hl shadow-[0_0_0_4px_rgba(255,216,77,0.16),0_30px_60px_-30px_rgba(0,0,0,0.8)]' : 'border-line hover:border-[#55555a]'}`}>
        <label htmlFor={id} className="sr-only">
          What should a bot do for you?
        </label>
        <div className="relative rounded-[22px] bg-[#202022] shadow-[inset_0_2px_8px_rgba(0,0,0,0.45)]">
          <textarea
            id={id}
            rows={3}
            maxLength={1000}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            className="block w-full resize-none rounded-[22px] bg-transparent px-6 pb-4 pt-5 text-left text-[18px] leading-snug text-fog caret-hl outline-none sm:text-[20px]"
          />
          {!goal && (
            <div className="pointer-events-none absolute inset-x-6 top-5 text-left text-[18px] leading-snug text-mute sm:text-[20px]" aria-hidden>
              {typed}
              {!reduce && !focus && <motion.span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-hl" animate={{ opacity: [1, 1, 0, 0] }} transition={{ duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1] }} />}
            </div>
          )}
        </div>
      </div>
      <div className="mt-7 flex justify-center">
        <button type="submit" disabled={busy} className="inline-flex h-14 items-center gap-2.5 rounded-full bg-hl px-9 text-[17px] font-bold text-ink shadow-[0_1px_0_rgba(255,255,255,.55)_inset,0_14px_30px_-12px_rgba(255,216,77,.7)] transition hover:-translate-y-0.5 hover:bg-[#ffe27a] active:translate-y-px disabled:opacity-60">
          {busy ? 'Finding a bot…' : 'Post a job'} <ArrowRight className="size-5" aria-hidden />
        </button>
      </div>
      <div aria-live="polite">
        {error && (
          <p className="mt-4 text-center text-sm text-coral">
            {error}{' '}
            <Link to="/bots" className="underline underline-offset-4">
              Browse bots
            </Link>
          </p>
        )}
        {pick && (
          <div className="mx-auto mt-5 max-w-xl rounded-2xl border border-line bg-ink-1/80 p-4 text-left">
            <p className="text-sm text-soft">No bot fits that on sight. Which one takes it?</p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {pick.map((b) => (
                <li key={b.id}>
                  <Link to={hireUrl(b.id, goal)} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ink-2 px-3.5 py-1.5 text-[13px] text-fog transition hover:border-hl hover:text-hl">
                    {b.name} <ArrowRight className="size-3" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </form>
  )
}
