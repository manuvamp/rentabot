import { Globe, Mail, ScanSearch, Send, ShieldCheck, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router'
import { callOp } from '../../api/client'
import { useAsync } from '../../api/hooks'
import { Container, Reveal } from '../../components/ui'
import { EXAMPLES, type ExampleIcon, type ExampleJob } from '../../lib/examples'
import { hireUrl } from '../../lib/matchBot'

const ICONS: Record<ExampleIcon, LucideIcon> = { globe: Globe, send: Send, shield: ShieldCheck, scan: ScanSearch, mail: Mail }
/** One sticky-note colour per kind of job. */
const CHIP: Record<ExampleIcon, string> = { globe: 'bg-hl', send: 'bg-lav', shield: 'bg-rose', scan: 'bg-sand', mail: 'bg-mint' }

function Row({ jobs, ids, reverse, seconds }: { jobs: ExampleJob[]; ids: Map<string, string>; reverse?: boolean; seconds: number }) {
  const loop = [...jobs, ...jobs]
  return (
    <div className="marquee marquee-x overflow-hidden py-2" role="list">
      <div className="marquee-track items-center gap-3 pr-3" style={{ animationDuration: `${seconds}s`, animationDirection: reverse ? 'reverse' : 'normal' }}>
        {loop.map((j, i) => {
          const Icon = ICONS[j.icon]
          const id = ids.get(j.bot)
          const dup = i >= jobs.length
          return (
            <Link
              key={i}
              role={dup ? undefined : 'listitem'}
              aria-hidden={dup || undefined}
              tabIndex={dup ? -1 : undefined}
              to={id ? hireUrl(id, j.text) : '/bots'}
              className="group flex shrink-0 items-center gap-3 rounded-full border border-line bg-ink-1 py-2 pl-2 pr-6 transition-colors hover:border-hl hover:bg-ink-2"
            >
              <span className={`grid size-10 place-items-center rounded-full text-ink transition-transform group-hover:-rotate-12 ${CHIP[j.icon]}`}>
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="font-display text-[18px] font-semibold tracking-tight text-fog">{j.text}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

/** Two rows of example jobs drifting in opposite directions. Each opens the matching bot's hire page with the goal filled in. */
export function ExampleJobs() {
  const bots = useAsync(() => callOp('search_bots', { limit: 50 }), [])
  const ids = new Map((bots.data?.bots ?? []).map((b) => [b.name, b.id]))
  const half = Math.ceil(EXAMPLES.length / 2)
  return (
    <section className="py-16 lg:py-24" aria-labelledby="examples-h">
      <Container wide>
        <Reveal>
          <h2 id="examples-h" className="display text-center text-[clamp(2rem,4.4vw,3.4rem)]">
            Jobs bots take today.
          </h2>
        </Reveal>
      </Container>
      <div className="mt-9 space-y-1 [mask-image:linear-gradient(90deg,transparent,#000_6%,#000_94%,transparent)]">
        <Row jobs={EXAMPLES.slice(0, half)} ids={ids} seconds={70} />
        <Row jobs={EXAMPLES.slice(half)} ids={ids} seconds={80} reverse />
      </div>
    </section>
  )
}
