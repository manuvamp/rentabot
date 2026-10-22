import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useSearchParams } from 'react-router'
import { Shell } from './layout/Shell'
import { RequireSession } from './layout/RequireSession'
import { Container, Spinner, LinkButton } from './components/ui'

const Landing = lazy(() => import('./pages/landing/Landing'))
const Bots = lazy(() => import('./pages/bots/Bots'))
const BotDetail = lazy(() => import('./pages/bots/BotDetail'))
const Hire = lazy(() => import('./pages/bots/Hire'))
const Sell = lazy(() => import('./pages/bots/Sell'))
const Leaderboard = lazy(() => import('./pages/leaderboard/Leaderboard'))
const Explore = lazy(() => import('./pages/explore/Explore'))
const OpenJobDetail = lazy(() => import('./pages/explore/OpenJobDetail'))
const PostOpenJob = lazy(() => import('./pages/explore/PostOpenJob'))
const Jobs = lazy(() => import('./pages/jobs/Jobs'))
const JobRoom = lazy(() => import('./pages/jobs/JobRoom'))
const Agents = lazy(() => import('./pages/agents/Agents'))
const Mandate = lazy(() => import('./pages/agents/Mandate'))
const Ops = lazy(() => import('./pages/ops/Ops'))
const Studio = lazy(() => import('./pages/ops/Studio'))
const SimPaypal = lazy(() => import('./pages/sim/SimPaypal'))
const Account = lazy(() => import('./pages/account/Account'))
const Privacy = lazy(() => import('./pages/legal/Legal').then((m) => ({ default: m.Privacy })))
const Terms = lazy(() => import('./pages/legal/Legal').then((m) => ({ default: m.Terms })))

/** claim_url from register_agent: /claim?code=XXXX -> the account page with the code filled in. */
function ClaimRedirect() {
  const [q] = useSearchParams()
  const code = (q.get('code') ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20)
  return <Navigate replace to={code ? `/account?claim=${code}` : '/account'} />
}
const Made = lazy(() => import('./pages/landing/MadeByBots'))

function NotFound() {
  return (
    <Container className="py-32 text-center">
      <p className="eyebrow">404</p>
      <h1 className="display mt-3 text-6xl">Nothing on this shelf.</h1>
      <div className="mt-8 flex justify-center">
        <LinkButton to="/bots">Browse bots</LinkButton>
      </div>
    </Container>
  )
}

export default function App() {
  return (
    <Suspense
      fallback={
        <Container className="py-24">
          <Spinner />
        </Container>
      }
    >
      <Routes>
        {/* standalone page: deliberately outside the Rent-A-Bot shell so it never looks like ours */}
        <Route path="/sim/paypal/:kind/:id" element={<SimPaypal />} />
        <Route element={<Shell />}>
          <Route index element={<Landing />} />
          <Route path="bots" element={<Bots />} />
          <Route path="bots/:id" element={<BotDetail />} />
          <Route path="leaderboard" element={<Leaderboard />} />
          <Route path="made" element={<Made />} />
          <Route path="explore" element={<Explore />} />
          <Route path="explore/:openJobId" element={<OpenJobDetail />} />
          <Route path="post" element={<RequireSession reason="Sign in to post a job to every bot."><PostOpenJob /></RequireSession>} />
          <Route path="hire/:botId" element={<RequireSession reason="Sign in to send a job to this bot."><Hire /></RequireSession>} />
          <Route path="jobs" element={<RequireSession reason="Sign in to see your jobs."><Jobs /></RequireSession>} />
          <Route path="jobs/:id" element={<RequireSession reason="Sign in to enter the Job Room."><JobRoom /></RequireSession>} />
          <Route path="agents" element={<Agents />} />
          <Route path="agents/mandate" element={<RequireSession reason="Sign in as the owner to manage spending mandates."><Mandate /></RequireSession>} />
          <Route path="sell" element={<RequireSession reason="Sign in to list a bot."><Sell /></RequireSession>} />
          <Route path="ops" element={<RequireSession role="arbiter" reason="The Ops console is for the human arbiter."><Ops /></RequireSession>} />
          <Route path="ops/studio" element={<Studio />} />
          <Route path="account" element={<Account />} />
          <Route path="claim" element={<ClaimRedirect />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="terms" element={<Terms />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
