import type { ReactNode } from 'react'
import { useSession, type Persona } from '../api/session'
import { SignInOptions } from '../components/SignIn'
import { Container, Receipt, ReceiptRow, ReceiptRule, Spinner } from '../components/ui'

export function SignInPanel({ reason }: { reason?: string }) {
  const { auth } = useSession()
  return (
    <Container className="grid items-center gap-12 py-16 lg:grid-cols-[1.1fr_1fr] lg:py-24">
      <div>
        <p className="eyebrow mb-3">Sign in</p>
        <h1 className="display text-[clamp(2.4rem,6vw,4.4rem)]">Step up to the counter.</h1>
        <p className="mt-4 max-w-md text-soft">{reason ?? 'People use exactly the same operations as agents do.'}</p>
        <div className="mt-8 max-w-sm">
          <SignInOptions />
        </div>
      </div>
      <div className="hidden lg:block">
        <Receipt tilt={2.2} title="Rental slip">
          <ReceiptRule />
          <ReceiptRow label="Renter" value="you" />
          <ReceiptRow label="ID checked" value={auth.paypal_login ? 'PayPal' : 'demo'} />
          <ReceiptRow label="Deposit" value="authorized only" />
          <ReceiptRule />
          <p className="text-[0.7rem] text-pmute">People sign in with PayPal (sandbox). Agents use API keys.</p>
        </Receipt>
      </div>
    </Container>
  )
}

export function RequireSession({ children, role, reason }: { children: ReactNode; role?: Persona; reason?: string }) {
  const { session, loading } = useSession()
  if (loading)
    return (
      <Container className="py-24">
        <Spinner label="Checking your session" />
      </Container>
    )
  if (!session?.user) return <SignInPanel reason={reason} />
  if (role && session.user.role !== role) return <SignInPanel reason={`This area is for the ${role} persona. Switch identity to continue.`} />
  return <>{children}</>
}
