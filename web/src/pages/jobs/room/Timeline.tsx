import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Link2Off, Radio, ShieldCheck } from 'lucide-react'
import type { Job, Message, Role } from '../../../api/types'
import { dateTime, shortHash, timeAgo } from '../../../lib/format'
import { KEY_TYPES, renderBody, SystemLine, TYPE_LABEL } from './renderers'

const ROLE_STYLE: Record<string, string> = {
  buyer: 'border-lime/40 bg-lime/10 text-lime',
  seller: 'border-amber/40 bg-amber/10 text-amber',
  mediator: 'border-paper/50 bg-paper/10 text-paper',
  arbiter: 'border-coral/40 bg-coral/10 text-coral',
  platform: 'border-line bg-ink-3 text-soft',
}
const DOT_STYLE: Record<string, string> = {
  buyer: 'bg-lime',
  seller: 'bg-amber',
  mediator: 'bg-paper',
  arbiter: 'bg-coral',
  platform: 'bg-mute',
}

type Item = { kind: 'one'; m: Message } | { kind: 'run'; ms: Message[] }

function HashTick({ hash }: { hash: string }) {
  return (
    <span tabIndex={0} className="group relative cursor-help rounded font-mono text-[10px] text-mute outline-offset-2 hover:text-soft focus:text-soft" aria-label={`Message hash ${hash}`}>
      {shortHash(hash, 0)}
      <span role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 hidden w-max max-w-[min(90vw,34rem)] break-all rounded-md border border-line bg-ink-2 px-2 py-1.5 text-[10.5px] text-fog shadow-xl group-hover:block group-focus:block">
        {hash}
      </span>
    </span>
  )
}

function Meta({ m, mine }: { m: Message; mine: boolean }) {
  const r = m.from.role
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`inline-flex items-center rounded-full border px-2 py-px font-mono text-[10.5px] font-semibold uppercase tracking-wider ${ROLE_STYLE[r] ?? ROLE_STYLE.platform}`}>{r}</span>
      {mine && <span className="rounded-full bg-fog px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wider text-ink">you</span>}
      <span className="font-mono text-[11px] text-mute">{TYPE_LABEL[m.type] ?? m.type}</span>
      <span className="ml-auto flex items-center gap-2">
        <time dateTime={m.ts} title={dateTime(m.ts)} className="text-[11px] text-mute">
          {timeAgo(m.ts)}
        </time>
        <span className="font-mono text-[10px] text-mute" title={`Message ${m.seq}`}>
          #{m.seq}
        </span>
        <HashTick hash={m.hash} />
      </span>
    </div>
  )
}

function Row({ children, dot, fresh, id }: { children: ReactNode; dot: string; fresh: boolean; id?: string }) {
  const reduce = useReducedMotion()
  return (
    <motion.li id={id} className="relative pl-9 sm:pl-11" initial={fresh && !reduce ? { opacity: 0, y: 14 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.2, 0.9, 0.2, 1] }}>
      <span className={`absolute left-[7px] top-2 size-[11px] rounded-full ring-4 ring-ink sm:left-[11px] ${dot}`} aria-hidden />
      {children}
    </motion.li>
  )
}

export function Timeline({ messages, job, role, chainValid, live, onChanged }: { messages: Message[]; job: Job; role: Role; chainValid: boolean | undefined; live?: boolean; onChanged?: () => void }) {
  const [keyOnly, setKeyOnly] = useState(false)
  const redactedCount = messages.filter((m) => m.redacted).length
  const seen = useRef<Set<string> | null>(null)
  const nearBottom = useRef(true)
  const endRef = useRef<HTMLDivElement>(null)
  const prevLen = useRef(messages.length)

  // ids present on first render are not animated; later ones slide in
  if (seen.current === null) seen.current = new Set(messages.map((m) => m.id))
  const fresh = (id: string) => !seen.current!.has(id)

  useEffect(() => {
    const onScroll = () => {
      nearBottom.current = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) < 320
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (messages.length > prevLen.current && nearBottom.current) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    prevLen.current = messages.length
  }, [messages.length])

  const items = useMemo<Item[]>(() => {
    const list = keyOnly ? messages.filter((m) => KEY_TYPES.has(m.type)) : messages
    const out: Item[] = []
    for (const m of list) {
      const last = out[out.length - 1]
      if (m.type === 'system' && last?.kind === 'run') last.ms.push(m)
      else if (m.type === 'system') out.push({ kind: 'run', ms: [m] })
      else out.push({ kind: 'one', m })
    }
    return out
  }, [messages, keyOnly])

  return (
    <section aria-label="Job Room timeline">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {chainValid === false ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-coral/50 bg-coral/10 px-3 py-1 text-[12px] font-semibold text-coral">
              <Link2Off className="size-3.5" aria-hidden /> Chain broken: a message was altered
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold ${chainValid ? 'border-lime/40 bg-lime/10 text-lime' : 'border-line text-mute'}`}>
              <ShieldCheck className="size-3.5" aria-hidden /> {chainValid ? `Chain valid: ${messages.length} messages hash-linked${redactedCount ? `, ${redactedCount} with personal data removed` : ''}` : 'Verifying chain…'}
            </span>
          )}
          {live && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-mute">
              <Radio className="size-3.5 text-lime live-dot" aria-hidden /> Live
            </span>
          )}
        </div>
        <div role="group" aria-label="Filter messages" className="inline-flex rounded-lg border border-line bg-ink-1 p-0.5 text-[12.5px]">
          {[
            [false, 'Everything'],
            [true, 'Money and verdicts only'],
          ].map(([v, l]) => (
            <button key={String(l)} type="button" aria-pressed={keyOnly === v} onClick={() => setKeyOnly(v as boolean)} className={`rounded-md px-2.5 py-1 font-medium transition-colors ${keyOnly === v ? 'bg-fog text-ink' : 'text-soft hover:text-fog'}`}>
              {l as string}
            </button>
          ))}
        </div>
      </div>

      <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-[12px] before:top-2 before:w-px before:bg-gradient-to-b before:from-line before:via-line before:to-transparent sm:before:left-[16px]" aria-live="polite" aria-relevant="additions">
        {items.map((it) => {
          if (it.kind === 'run') {
            const f = it.ms[0]
            return (
              <Row key={f.id} dot="bg-mute" fresh={it.ms.some((m) => fresh(m.id))}>
                <div className="rounded-xl border border-line bg-ink-1/70 px-3.5 py-2.5">
                  <ul className="space-y-2.5">
                    {it.ms.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 sm:flex-nowrap">
                        <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                          <SystemLine message={m} />
                        </div>
                        <time dateTime={m.ts} title={dateTime(m.ts)} className="shrink-0 pt-0.5 text-[11px] text-mute">
                          {timeAgo(m.ts)}
                        </time>
                        <HashTick hash={m.hash} />
                      </li>
                    ))}
                  </ul>
                </div>
              </Row>
            )
          }
          const m = it.m
          const mine = m.from.role === role
          return (
            <Row key={m.id} id={`msg-${m.seq}`} dot={DOT_STYLE[m.from.role] ?? 'bg-mute'} fresh={fresh(m.id)}>
              <Meta m={m} mine={mine} />
              {m.from.role === 'mediator' && !['mediator_question', 'ruling'].includes(m.type) ? (
                <div className="border-l-2 border-paper/60 pl-3">{renderBody({ job, role, message: m, messages, onChanged })}</div>
              ) : (
                renderBody({ job, role, message: m, messages, onChanged })
              )}
              {m.redacted && (
                <p className="mt-2 rounded-md border border-line bg-ink-1/70 px-2.5 py-1.5 text-[12px] text-soft">
                  Personal data removed by Rent-A-Bot on {dateTime(m.redacted.at)}: {m.redacted.reason} This message keeps its place in the chain; its content can no longer be checked against its hash.
                </p>
              )}
            </Row>
          )
        })}
        {items.length === 0 && <li className="pl-11 text-sm text-mute">Nothing here yet.</li>}
      </ol>
      <div ref={endRef} />
    </section>
  )
}
