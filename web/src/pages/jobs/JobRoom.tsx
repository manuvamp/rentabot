import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { callOp } from '../../api/client'
import type { Escrow, Job, Message, NextAction, Role } from '../../api/types'
import { openEventStream } from '../../api/stream'
import { Chip, Container, CopyButton, ErrorBox, Skeleton, StateBadge } from '../../components/ui'
import { BotPhoto } from '../../components/BotPhoto'
import { Timeline } from './room/Timeline'
import { ContractPanel } from './sidebar/ContractPanel'
import { EscrowLedger } from './sidebar/EscrowLedger'
import { FulfilmentPanel } from './sidebar/Fulfilment'
import { LockerPanel } from './sidebar/LockerPanel'
import { MediationPanel } from './sidebar/MediationPanel'
import { RulingSummary } from './sidebar/RulingSummary'
import { YourMove } from './sidebar/YourMove'
import { useMediaQuery } from './sidebar/useNow'

interface Room {
  job: Job
  role: Role
  actions: NextAction[]
  escrow: Escrow
  messages: Message[]
  chainValid: boolean | undefined
}

const botLabel = (id: string) => id.replace(/^bot_/, '').replace(/([a-z])([A-Z])/g, '$1 $2')

async function loadMessages(jobId: string, from: number): Promise<{ messages: Message[]; chain_valid: boolean }> {
  const all: Message[] = []
  let after = from
  let valid = true
  for (let guard = 0; guard < 20; guard++) {
    const r = await callOp('get_messages', { job_id: jobId, after_seq: after, limit: 50 })
    all.push(...r.messages)
    valid = r.chain_valid
    if (r.messages.length < 50) break
    after = r.messages[r.messages.length - 1].seq
  }
  return { messages: all, chain_valid: valid }
}

function useRoom(jobId: string) {
  const [room, setRoom] = useState<Room | null>(null)
  const [error, setError] = useState<unknown>()
  const [live, setLive] = useState(false)
  const [lockerTick, setLockerTick] = useState(0)
  const lastSeq = useRef(-1)
  const inflight = useRef(false)
  const again = useRef(false)

  const refresh = useCallback(async () => {
    if (inflight.current) {
      again.current = true
      return
    }
    inflight.current = true
    try {
      const [j, esc, msgs] = await Promise.all([callOp('get_job', { job_id: jobId }), callOp('get_escrow', { job_id: jobId }).catch(() => null), loadMessages(jobId, lastSeq.current)])
      if (msgs.messages.length) lastSeq.current = msgs.messages[msgs.messages.length - 1].seq
      setRoom((prev) => {
        const seen = new Set((prev?.messages ?? []).map((m) => m.seq))
        const merged = [...(prev?.messages ?? []), ...msgs.messages.filter((m) => !seen.has(m.seq))]
        return { job: j.job, role: j.your_role, actions: j.next_actions, escrow: esc?.escrow ?? j.job.escrow, messages: merged, chainValid: msgs.chain_valid }
      })
      setError(undefined)
    } catch (e) {
      setError(e)
    } finally {
      inflight.current = false
      if (again.current) {
        again.current = false
        void refresh()
      }
    }
  }, [jobId])

  useEffect(() => {
    lastSeq.current = -1
    setRoom(null)
    setError(undefined)
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const close = openEventStream(
      { jobId },
      (ev) => {
        if (ev.type === 'secret') setLockerTick((n) => n + 1)
        clearTimeout(timer)
        timer = setTimeout(() => void refresh(), 150)
      },
      setLive,
    )
    // safety net in case the stream drops: reconcile every 20 s
    const poll = setInterval(() => void refresh(), 20_000)
    return () => {
      close()
      clearTimeout(timer)
      clearInterval(poll)
    }
  }, [jobId, refresh])

  return { room, error, live, refresh, lockerTick }
}

export default function JobRoom() {
  const { id = '' } = useParams()
  const { room, error, live, refresh, lockerTick } = useRoom(id)
  const wide = useMediaQuery('(min-width: 1024px)')
  const sellerId = room?.job.seller_bot_id
  const [botName, setBotName] = useState<string | null>(null)
  useEffect(() => {
    if (!sellerId) return
    let off = false
    callOp('get_bot', { bot_id: sellerId })
      .then((r) => !off && setBotName(r.bot.name))
      .catch(() => {})
    return () => {
      off = true
    }
  }, [sellerId])

  if (!room) {
    return (
      <Container wide className="py-10">
        <Link to="/jobs" className="mb-6 inline-flex items-center gap-1.5 text-sm text-soft hover:text-hl">
          <ArrowLeft className="size-4" aria-hidden /> All jobs
        </Link>
        {error ? (
          <ErrorBox error={error} title="Could not open this room" onRetry={() => void refresh()} />
        ) : (
          <div className="space-y-4" role="status" aria-label="Loading the Job Room">
            <Skeleton className="h-12 w-2/3" />
            <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
              <Skeleton className="h-[480px]" />
              <Skeleton className="h-[480px]" />
            </div>
          </div>
        )}
      </Container>
    )
  }

  const { job, role, actions, escrow, messages, chainValid } = room
  const bot = botName ?? botLabel(job.seller_bot_id)
  const rulingSeq = [...messages].reverse().find((m) => m.type === 'ruling')?.seq
  const move = <YourMove key={job.id} job={job} role={role} actions={actions} approvalUrl={escrow.approval_url} messages={messages} onDone={() => void refresh()} />
  const panels = (
    <>
      <ContractPanel job={job} botName={bot} />
      <MediationPanel job={job} role={role} />
      <EscrowLedger escrow={escrow} />
      <LockerPanel key={job.id} job={job} role={role} refreshKey={`${lockerTick}:${job.state}:${escrow.status}:${messages.length}`} />
      <FulfilmentPanel job={job} />
      <RulingSummary job={job} rulingSeq={rulingSeq} />
      {job.policy.reasons.length > 0 || job.policy.class !== 'standard' ? (
        <section className={`rounded-xl border p-3 text-[13px] ${job.policy.class === 'standard' ? 'border-line bg-ink-1 text-fog' : 'border-amber/40 bg-amber/10 text-amber'}`} aria-label="Policy">
          <p className="font-semibold">Policy: {job.policy.class}</p>
          {job.policy.reasons.map((r) => (
            <p key={r} className="mt-0.5 text-soft">
              {r}
            </p>
          ))}
        </section>
      ) : (
        <p className="px-1 font-mono text-[11px] text-mute">Policy gate: standard, no flags.</p>
      )}
    </>
  )

  return (
    <Container wide className="py-8">
      <Link to="/jobs" className="mb-5 inline-flex items-center gap-1.5 text-sm text-soft hover:text-hl">
        <ArrowLeft className="size-4" aria-hidden /> All jobs
      </Link>

      <header className="mb-7">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={job.state} />
          <Chip mono>you are the {role}</Chip>
          {job.origin && (
            <Link to={`/explore/${job.origin.open_job_id}`} className="rounded-full focus-visible:outline-offset-2">
              <Chip tone="amber">Won in an open job</Chip>
            </Link>
          )}
          {!live && <Chip>Reconnecting</Chip>}
        </div>
        <h1 className={`display mt-3 line-clamp-3 ${job.title.length > 70 ? 'text-[clamp(1.5rem,2.8vw,2.2rem)] leading-[1.12]' : job.title.length > 36 ? 'text-[clamp(1.8rem,3.4vw,2.8rem)]' : 'text-[clamp(2rem,4.2vw,3.4rem)]'}`} title={job.title}>
          <span className="hl-block">{job.title}</span>
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-soft">
          <span className="inline-flex items-center gap-2">
            <BotPhoto name={bot} className="size-7" rounded="rounded-full" sizes="28px" tiny />
            Bot:{' '}
            <Link className="text-fog underline decoration-line underline-offset-2 hover:text-hl" to={`/bots/${job.seller_bot_id}`}>
              {bot}
            </Link>
          </span>
          <span className="inline-flex items-center gap-1 font-mono text-[12px] text-mute">
            {job.id}
            <CopyButton text={job.id} label="Copy id" />
          </span>
        </div>
      </header>
      <ErrorBox className="mb-5" error={error} title="Live refresh failed" onRetry={() => void refresh()} />

      {wide ? (
        <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(380px,1fr)] items-start gap-8">
          <Timeline messages={messages} job={job} role={role} chainValid={chainValid} live={live} onChanged={() => void refresh()} />
          <aside aria-label="Contract, escrow and your move" className="sticky top-20 -mr-2 max-h-[calc(100dvh-6rem)] space-y-5 overflow-y-auto pb-10 pr-2 [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)] [scrollbar-color:var(--color-soft)_transparent] [scrollbar-width:thin]">
            {move}
            {panels}
          </aside>
        </div>
      ) : (
        <div className="space-y-6">
          {move}
          <Timeline messages={messages} job={job} role={role} chainValid={chainValid} live={live} onChanged={() => void refresh()} />
          <div className="space-y-5">{panels}</div>
        </div>
      )}
    </Container>
  )
}
