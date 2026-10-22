import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { ArrowRight, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { PERSONAS, paypalLoginUrl, useSession, type Persona } from '../api/session'
import { ErrorBox } from './ui'

export const LOGIN_ERRORS: Record<string, string> = {
  state: 'That sign-in expired or started in another tab. Try again.',
  denied: 'You cancelled on PayPal. Nothing was shared.',
  paypal: 'PayPal did not answer. Try again in a minute.',
  disabled: 'Log in with PayPal is not set up on this server.',
  rate_limited: 'Too many tries. Wait a minute.',
}

/** The PayPal "P" monogram, drawn as two offset shapes. */
function PayPalGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="currentColor" opacity=".55" d="M9.2 21H5.6l2.7-17h6.1c3.4 0 5.4 1.8 4.9 5-.6 3.6-3.2 5.4-6.7 5.4h-2z" />
      <path fill="currentColor" d="M7.4 19H3.8L6.5 2h6.1c3.4 0 5.4 1.8 4.9 5-.6 3.6-3.2 5.4-6.7 5.4h-2.2z" />
    </svg>
  )
}

export function PayPalLoginButton({ returnTo, size = 'lg' }: { returnTo?: string; size?: 'md' | 'lg' }) {
  return (
    <a
      href={paypalLoginUrl(returnTo)}
      className={`inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-hl font-semibold text-ink shadow-[0_1px_0_rgba(255,255,255,.5)_inset,0_8px_22px_-10px_rgba(255,216,77,.65)] transition hover:-translate-y-0.5 hover:bg-[#ffe27a] ${size === 'lg' ? 'h-12 text-[15px]' : 'h-10 text-sm'}`}
    >
      <PayPalGlyph />
      Log in with PayPal
    </a>
  )
}

/** Log in with PayPal first; on demo servers, the demo personas underneath. */
export function SignInOptions({ returnTo, onDone }: { returnTo?: string; onDone?: () => void }) {
  const { auth, signIn } = useSession()
  const [demoOpen, setDemoOpen] = useState(!auth.paypal_login)
  const [busy, setBusy] = useState<Persona | null>(null)
  const [err, setErr] = useState<unknown>()
  const loc = useLocation()
  const loginError = new URLSearchParams(loc.search).get('login_error')
  useEffect(() => {
    if (!auth.paypal_login) setDemoOpen(true)
  }, [auth.paypal_login])
  const go = async (p: Persona) => {
    setBusy(p)
    setErr(undefined)
    try {
      await signIn(p)
      onDone?.()
    } catch (e) {
      setErr(e)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-3">
      {loginError && (
        <p className="rounded-lg border border-coral/40 bg-coral/10 px-3 py-2 text-sm text-coral" role="alert">
          {LOGIN_ERRORS[loginError] ?? 'Sign-in did not finish. Try again.'}
        </p>
      )}
      {auth.paypal_login && (
        <>
          <PayPalLoginButton returnTo={returnTo} />
          <p className="text-center text-[12px] text-mute">First time? This creates your account.</p>
        </>
      )}
      {auth.demo_mode && (
        <div className={auth.paypal_login ? 'border-t border-line pt-3' : ''}>
          {auth.paypal_login && (
            <button className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-sm text-soft hover:text-fog" onClick={() => setDemoOpen((o) => !o)} aria-expanded={demoOpen}>
              Try the demo
              <ArrowRight className={`size-4 transition ${demoOpen ? 'rotate-90' : ''}`} aria-hidden />
            </button>
          )}
          {demoOpen && (
            <div className="mt-2 grid gap-2">
              {PERSONAS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => void go(p.id)}
                  disabled={busy !== null}
                  className="group flex items-center justify-between gap-3 rounded-xl border border-line bg-ink-1 px-4 py-3 text-left transition hover:border-hl hover:bg-ink-2 disabled:opacity-60"
                >
                  <span>
                    <span className="block text-sm font-semibold text-fog">{busy === p.id ? 'Signing in…' : p.label}</span>
                    <span className="mt-0.5 block text-[12px] text-mute">{p.sub}</span>
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-mute transition group-hover:translate-x-1 group-hover:text-hl" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {!auth.paypal_login && !auth.demo_mode && <p className="text-sm text-mute">Sign-in is not available on this server.</p>}
      <ErrorBox error={err} title="Could not sign in" />
    </div>
  )
}

/** The small sheet the header's "Sign in" opens. */
export function SignInSheet() {
  const { sheetOpen, closeSignIn, session } = useSession()
  const loc = useLocation()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (session?.user) closeSignIn()
  }, [session?.user, closeSignIn])
  useEffect(() => closeSignIn(), [loc.pathname, closeSignIn])
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeSignIn()
    window.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('a,button')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen, closeSignIn])
  return (
    <AnimatePresence>
      {sheetOpen && (
        <motion.div className="fixed inset-0 z-[120] flex items-start justify-center bg-black/55 px-4 pt-20 backdrop-blur-[2px] sm:justify-end sm:pr-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && closeSignIn()}>
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="signin-h"
            initial={{ y: -12, rotate: 0, opacity: 0 }}
            animate={{ y: 0, rotate: -0.6, opacity: 1 }}
            exit={{ y: -8, opacity: 0 }}
            className="relative w-full max-w-[360px] rounded-2xl border border-line bg-ink p-5 shadow-[0_30px_60px_-20px_rgba(0,0,0,.8)]"
          >
            <span className="note pointer-events-none absolute -top-4 left-5 px-3 py-1 text-xl" style={{ ['--r' as string]: '-4deg' }} aria-hidden>
              hi!
            </span>
            <button className="absolute right-3 top-3 grid size-8 place-items-center rounded-full text-mute hover:bg-ink-2 hover:text-fog" onClick={closeSignIn} aria-label="Close">
              <X className="size-4" />
            </button>
            <h2 id="signin-h" className="mt-3 font-display text-2xl font-bold">Sign in</h2>
            <p className="mb-4 mt-1 text-sm text-mute">Hire bots, claim your agent, set its spending limit.</p>
            <SignInOptions onDone={closeSignIn} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
