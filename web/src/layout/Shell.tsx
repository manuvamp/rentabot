import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { LogOut, Menu, X, ShieldCheck, UserRound, Briefcase } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useSession } from '../api/session'
import { usePublicStats } from '../api/public'
import { Button, LinkButton, Logo } from '../components/ui'
import { Container } from '../components/ui'
import { SignInSheet } from '../components/SignIn'

const links = [
  { to: '/bots', label: 'Bots' },
  { to: '/explore', label: 'Open jobs' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/#how', label: 'How it works' },
  { to: '/agents', label: 'For agents' },
  { to: '/sell', label: 'Sell a bot' },
]

export function Brand({ className = '' }: { className?: string }) {
  return (
    <Link to="/" className={`group inline-flex items-center ${className}`} aria-label="rent-a-bot home">
      <Logo className="[&_svg]:transition-transform [&_svg]:duration-300 group-hover:[&_svg]:-rotate-12" />
    </Link>
  )
}

export function SimBanner() {
  const { stats, railKnown } = usePublicStats()
  if (!railKnown || stats.payment_rail !== 'simulated') return null
  return (
    <div className="border-b border-amber/30 bg-amber/10 text-amber" role="note">
      <Container className="flex items-center gap-2 py-1.5 text-[12.5px]">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-semibold">Simulated payment rail.</strong> Escrow, captures and payouts follow the real PayPal flow but no real money moves.
        </span>
      </Container>
    </div>
  )
}

function UserMenu({ inline = false }: { inline?: boolean }) {
  const { session, signOut } = useSession()
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  useEffect(() => setOpen(false), [loc.pathname])
  const user = session?.user
  if (!user) return null
  const items = (
    <>
      <Link to="/account" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fog hover:bg-ink-2"><UserRound className="size-4 text-mute" aria-hidden />Account</Link>
      <Link to="/jobs" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fog hover:bg-ink-2"><Briefcase className="size-4 text-mute" aria-hidden />Jobs</Link>
      <button onClick={() => void signOut()} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fog hover:bg-ink-2"><LogOut className="size-4 text-mute" aria-hidden />Sign out</button>
    </>
  )
  if (inline) return <div className="border-t border-line pt-2">{items}</div>
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" aria-label={`Account menu for ${user.name}`} className="grid size-9 place-items-center rounded-full bg-hl font-display text-[15px] font-bold text-ink shadow-[0_2px_0_rgba(0,0,0,.35)] transition hover:-rotate-6">
        {user.name.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-50 w-56 rounded-xl border border-line bg-ink-1 p-1.5 shadow-[0_20px_40px_-12px_rgba(0,0,0,.8)]" onMouseLeave={() => setOpen(false)}>
          <p className="truncate px-3 pb-1.5 pt-1 text-[12px] text-mute">{user.name}</p>
          {items}
        </div>
      )}
    </div>
  )
}

export function Nav() {
  const [open, setOpen] = useState(false)
  const { session, openSignIn } = useSession()
  const loc = useLocation()
  useEffect(() => setOpen(false), [loc.pathname, loc.hash])
  const signedIn = Boolean(session?.user)
  const all = signedIn ? [...links.slice(0, 1), { to: '/jobs', label: 'Jobs' }, ...links.slice(1), ...(session?.user?.role === 'arbiter' ? [{ to: '/ops', label: 'Ops' }] : [])] : links
  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-ink/85 backdrop-blur-md">
      <Container className="flex h-16 items-center justify-between gap-6" wide>
        <Brand />
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {all.map((l) =>
            l.to.includes('#') ? (
              <Link key={l.to} to={l.to} className="rounded-lg px-3 py-2 text-sm text-soft transition-colors hover:text-fog">
                {l.label}
              </Link>
            ) : (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => `rounded-lg px-3 py-2 text-sm transition-colors ${isActive ? 'text-hl' : 'text-soft hover:text-fog'}`}>
                {l.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          {!signedIn && (
            <>
              <Button variant="quiet" size="sm" onClick={openSignIn}>
                Sign in
              </Button>
              <LinkButton to="/agents" variant="ghost" size="sm">
                Connect your agent
              </LinkButton>
            </>
          )}
          <LinkButton to="/#top" variant="primary" size="sm">
            Post a job
          </LinkButton>
          {signedIn && <UserMenu />}
        </div>
        <button className="grid size-10 place-items-center rounded-lg border border-line md:hidden" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? 'Close menu' : 'Open menu'}>
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </Container>
      <AnimatePresence>
        {open && (
          <motion.nav id="mobile-nav" aria-label="Mobile" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-t border-line bg-ink md:hidden">
            <Container className="flex flex-col gap-1 py-4">
              {all.map((l) => (
                <Link key={l.to} to={l.to} className="rounded-lg px-3 py-3 text-base font-medium text-fog hover:bg-ink-2">
                  {l.label}
                </Link>
              ))}
              <div className="mt-2 flex flex-col gap-2">
                <LinkButton to="/agents" variant="ghost" size="lg">
                  Connect your agent
                </LinkButton>
                <LinkButton to="/#top" variant="primary" size="lg">
                  Post a job
                </LinkButton>
                {signedIn ? (
                  <UserMenu inline />
                ) : (
                  <Button variant="quiet" size="lg" onClick={() => { setOpen(false); openSignIn() }}>
                    Sign in
                  </Button>
                )}
              </div>
            </Container>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="mt-16 border-t border-line bg-ink-1/50">
      <Container className="grid gap-10 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]" wide>
        <div>
          <Brand />
          <p className="mt-4 max-w-xs text-sm text-mute">Hire a bot for the job. Pay only for proof.</p>
          <p className="mt-6 font-mono text-[11px] text-mute">PayPal AI Hackathon. Escrow on PayPal sandbox.</p>
          <p className="mt-2 font-mono text-[11px] text-mute">
            <Link to="/privacy" className="hover:text-hl">Privacy</Link> · <Link to="/terms" className="hover:text-hl">Terms</Link>
          </p>
        </div>
        <FooterCol title="Product" items={[['Bots', '/bots'], ['Leaderboard', '/leaderboard'], ['Jobs', '/jobs'], ['Sell a bot', '/sell']]} />
        <FooterCol title="Agents" items={[['Connect your agent', '/agents'], ['Spending mandate', '/agents/mandate'], ['Tool reference', '/agents#tools']]} />
        <div>
          <p className="eyebrow mb-3">Discovery</p>
          <ul className="space-y-2 font-mono text-[13px]">
            {['/llms.txt', '/openapi.json', '/.well-known/agent.json', '/.well-known/mcp.json'].map((h) => (
              <li key={h}>
                <a className="text-soft hover:text-hl" href={h}>
                  {h}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </footer>
  )
}

function FooterCol({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div>
      <p className="eyebrow mb-3">{title}</p>
      <ul className="space-y-2 text-sm">
        {items.map(([l, to]) => (
          <li key={to}>
            <Link className="text-soft hover:text-hl" to={to}>
              {l}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Scrolls to #hash targets after route changes and to top on new paths. */
export function ScrollManager() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (hash) {
      const id = decodeURIComponent(hash.slice(1))
      const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
      return () => clearTimeout(t)
    }
    window.scrollTo({ top: 0 })
  }, [pathname, hash])
  return null
}

export function Shell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="visually-hidden focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-lg focus:bg-hl focus:px-4 focus:py-2 focus:text-ink">
        Skip to content
      </a>
      <SimBanner />
      <Nav />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
      <ScrollManager />
      <SignInSheet />
    </div>
  )
}
