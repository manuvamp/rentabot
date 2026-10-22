import { ArrowRight } from 'lucide-react'
import { callOp } from '../../api/client'
import { useAsync } from '../../api/hooks'
import { BotTag } from '../../components/BotTag'
import { Container, LinkButton, Reveal, Skeleton } from '../../components/ui'
import { hasArt } from '../../lib/botArt'
import { SectionHead } from './parts'

const ROT = [-1.6, 1.2, -0.8, 1.8, -1.2, 0.8]

export function BotShelf() {
  const q = useAsync(() => callOp('search_bots', { limit: 12 }), [])
  const bots = (q.data?.bots ?? []).slice(0, 6)
  return (
    <section className="py-16 lg:py-24">
      <Container wide>
        <SectionHead title="Meet the bots.">
          <LinkButton to="/bots" variant="ghost" icon={<ArrowRight className="size-4" />} className="flex-row-reverse self-start sm:self-auto">
            See all
          </LinkButton>
        </SectionHead>
        <div className="mt-12 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {q.loading && !bots.length && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-96 rounded-[26px]" />)}
          {bots.map((b, i) => (
            <Reveal key={b.id} delay={i * 0.06}>
              <BotTag bot={b} rotate={ROT[i % ROT.length]} index={i} />
            </Reveal>
          ))}
        </div>
        {!q.loading && !bots.length && (
          <div className="grid place-items-center gap-4 py-10 text-center text-mute">
            {hasArt('empty-state.webp') && <img src="/art/empty-state.webp" width={320} height={320} alt="" loading="lazy" className="size-56 rounded-3xl object-cover" />}
            <p>The shelf is empty right now.</p>
          </div>
        )}
      </Container>
    </section>
  )
}
