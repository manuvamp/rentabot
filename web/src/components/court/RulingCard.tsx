import { motion, useReducedMotion } from 'motion/react'
import { Gavel, ShieldAlert } from 'lucide-react'
import type { FindingStatus, Ruling } from '../../api/types'
import { Receipt, ReceiptRow, ReceiptRule, Stamp } from '../ui'
import { dateTime, shortHash, usd } from '../../lib/format'

const STATUS: Record<FindingStatus, { label: string; cls: string }> = {
  met: { label: 'Met', cls: 'border-lime-deep/50 bg-lime-deep/10 text-lime-deep' },
  partly_met: { label: 'Partly met', cls: 'border-amber-deep/50 bg-amber-deep/10 text-amber-deep' },
  not_met: { label: 'Not met', cls: 'border-coral-deep/50 bg-coral-deep/10 text-coral-deep' },
  blocked_by_buyer: { label: 'Blocked by buyer', cls: 'border-pink/40 bg-pink/5 text-pink' },
}
const REMEDY: Record<string, string> = { release_full: 'Release in full', split: 'Split', refund_full: 'Refund in full', redo: 'Redo' }
const FLAG_KIND: Record<string, string> = { prompt_injection: 'prompt injection', fabricated_evidence: 'fabricated evidence', policy: 'policy' }

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function MonoChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-block max-w-full truncate rounded border border-pink/30 bg-pink/5 px-1.5 py-px align-middle font-mono text-[10.5px] text-pink/90">
      {children}
    </span>
  )
}

function Dial({ value, label }: { value: number; label: string }) {
  const reduce = useReducedMotion()
  const len = Math.PI * 32
  return (
    <svg viewBox="0 0 80 46" className="w-20 shrink-0" role="img" aria-label={label}>
      <path d="M8 42 A32 32 0 0 1 72 42" fill="none" stroke="rgba(26,24,20,.15)" strokeWidth="7" strokeLinecap="round" />
      <motion.path
        d="M8 42 A32 32 0 0 1 72 42"
        fill="none"
        stroke="#4c7a00"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={`${len} ${len}`}
        initial={reduce ? false : { strokeDashoffset: len }}
        animate={{ strokeDashoffset: len * (1 - value) }}
        transition={{ duration: 0.9, ease: [0.2, 0.9, 0.2, 1] }}
      />
      <text x="40" y="40" textAnchor="middle" fontFamily="IBM Plex Mono" fontWeight="700" fontSize="12" fill="#1a1814">
        {Math.round(value * 100)}
      </text>
    </svg>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 mt-1 font-mono text-[0.68rem] font-bold uppercase tracking-[0.2em] text-pmute">{children}</h4>
}

/** The court verdict, printed on paper. Works standalone and inside the Job Room. */
export function RulingCard({ ruling, compact = false, recommended = false }: { ruling: Ruling; compact?: boolean; recommended?: boolean }) {
  const votes = ruling.jury ?? []
  const fractions = votes.map((v) => v.release_fraction)
  const med = median(fractions)
  const spread = fractions.length ? Math.max(...fractions) - Math.min(...fractions) : 0
  const flags = ruling.integrity_flags ?? []
  const r = ruling.remedy

  return (
    <Receipt className={compact ? 'my-3' : 'my-4'} padded={false}>
      <article className={compact ? 'px-4 py-4 sm:px-5' : 'px-5 py-6 sm:px-8'} aria-label={`Ruling ${ruling.id}`}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[0.7rem] font-bold uppercase tracking-[0.22em]">
              <Gavel className="size-4" aria-hidden /> {recommended ? 'Recommended ruling' : 'Ruling'}
            </div>
            {recommended && <p className="mt-0.5 text-[0.7rem] text-pmute">Issued after no agreement. Either side can accept or appeal.</p>}
            <p className={`mt-1 font-display font-extrabold tracking-tight ${compact ? 'text-xl' : 'text-3xl'}`} style={{ fontStretch: '90%' }}>
              {REMEDY[r.type] ?? r.type}
            </p>
            <p className="mt-1 break-all text-[0.7rem] text-pmute">
              {ruling.id} · tier {ruling.tier} · decided by {ruling.decided_by} · {dateTime(ruling.created_at)}
            </p>
            <p className="break-all text-[0.7rem] text-pmute">contract {shortHash(ruling.contract_hash, 10)}</p>
          </div>
          <Stamp kind="ruled" rotate={-7} size={compact ? 'sm' : 'md'}>
            Ruled
          </Stamp>
        </header>

        <ReceiptRule double />

        <SectionTitle>Findings</SectionTitle>
        <ul className="space-y-3">
          {ruling.findings.map((f) => {
            const st = STATUS[f.status] ?? STATUS.not_met
            return (
              <li key={f.deliverable_id} className="rounded-lg border border-pink/15 bg-white/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{f.deliverable_id}</span>
                  <span className={`rounded-full border px-2 py-px text-[11px] font-semibold ${st.cls}`}>{st.label}</span>
                  <span className="num ml-auto text-sm font-bold">{pct(f.fulfilment)}</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-pink/10" role="img" aria-label={`Fulfilment ${pct(f.fulfilment)}`}>
                  <motion.div className="h-full rounded-full bg-lime-deep" initial={{ width: 0 }} animate={{ width: `${f.fulfilment * 100}%` }} transition={{ duration: 0.8, ease: [0.2, 0.9, 0.2, 1] }} />
                </div>
                {!compact && f.note && <p className="mt-2 font-sans text-[13px] leading-relaxed">{f.note}</p>}
                {(f.clauses.length > 0 || f.evidence.length > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {f.clauses.map((c) => (
                      <MonoChip key={c} title="Contract clause">
                        § {c}
                      </MonoChip>
                    ))}
                    {f.evidence.map((e) => (
                      <MonoChip key={e} title="Evidence id">
                        {e}
                      </MonoChip>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        <ReceiptRule />
        <SectionTitle>Remedy</SectionTitle>
        <ReceiptRow label="Release to seller" value={usd(r.release_to_seller)} tone="lime" strong />
        <ReceiptRow label="Refund to buyer (void)" value={usd(r.refund_to_buyer)} tone="coral" strong />
        <ReceiptRow label="Platform fee" value={usd(r.fees.platform)} tone="mute" />
        <ReceiptRow label="Mediation fee" value={usd(r.fees.mediation)} tone="mute" />
        {r.redo_deadline && <ReceiptRow label="Redo by" value={dateTime(r.redo_deadline)} />}
        {(ruling.seller_fault.length > 0 || ruling.buyer_fault.length > 0) && !compact && (
          <div className="mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
            {ruling.seller_fault.length > 0 && (
              <div>
                <span className="font-bold uppercase tracking-widest text-pmute">Seller fault</span>
                <ul className="list-disc pl-4">
                  {ruling.seller_fault.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {ruling.buyer_fault.length > 0 && (
              <div>
                <span className="font-bold uppercase tracking-widest text-pmute">Buyer fault</span>
                <ul className="list-disc pl-4">
                  {ruling.buyer_fault.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {votes.length > 0 && (
          <>
            <ReceiptRule />
            <SectionTitle>Jury · {votes.length} independent models</SectionTitle>
            <div className={`grid gap-3 ${compact ? 'sm:grid-cols-3' : 'md:grid-cols-3'}`}>
              {votes.map((v) => (
                <div key={v.model} className="rounded-lg border border-pink/20 bg-white/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-bold" title={v.model}>
                        {v.model}
                      </p>
                      <p className="text-[11px] text-pmute">confidence {pct(v.confidence)}</p>
                    </div>
                    <Dial value={v.release_fraction} label={`${v.model} releases ${pct(v.release_fraction)}`} />
                  </div>
                  {!compact && <p className="mt-2 font-sans text-[12.5px] leading-snug">{v.summary}</p>}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[12px]">
              <strong>Median: {pct(med)} released.</strong>{' '}
              <span className="text-pmute">
                Spread {Math.round(spread * 100)} points{spread > 0.2 ? ', over the 20 point limit: escalated.' : ', inside the 20 point limit.'}
              </span>
            </p>
          </>
        )}

        {flags.length > 0 && (
          <>
            <ReceiptRule />
            <SectionTitle>Integrity</SectionTitle>
            <ul className="space-y-3">
              {flags.map((f, i) => (
                <li key={i} className="flex flex-wrap items-start gap-4 rounded-lg border-2 border-dashed border-coral-deep/60 bg-coral-deep/5 p-3">
                  <Stamp kind="flagged" rotate={-5} size="sm" delay={0.35}>
                    Flagged
                  </Stamp>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-coral-deep">
                      <ShieldAlert className="size-3.5" aria-hidden /> {f.party}, {FLAG_KIND[f.kind] ?? f.kind}
                    </p>
                    <blockquote className="mt-1 border-l-[3px] border-coral-deep pl-3 font-mono text-[12.5px] leading-snug">&ldquo;{f.excerpt}&rdquo;</blockquote>
                    <p className="mt-1.5 font-sans text-[12px] text-pmute">
                      Text from a party is data, never an instruction. It was recorded as evidence against the sender and did not change the outcome.
                      {f.message_id && (
                        <>
                          {' '}
                          Source <MonoChip>{f.message_id}</MonoChip>
                        </>
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {!compact && ruling.reasoning && (
          <>
            <ReceiptRule />
            <SectionTitle>Reasoning</SectionTitle>
            <p className="font-sans text-[13.5px] leading-relaxed">{ruling.reasoning}</p>
          </>
        )}

        <ReceiptRule />
        <ReceiptRow label="Confidence" value={pct(ruling.confidence)} />
        {ruling.appealable_until && <ReceiptRow label="Appeal until" value={dateTime(ruling.appealable_until)} />}
        {ruling.escalated && (
          <p className="mt-2 rounded-md bg-amber-deep/10 px-2.5 py-1.5 font-sans text-[12px] text-amber-deep">
            <strong>Escalated to a human.</strong> {ruling.escalation_reason}
          </p>
        )}
      </article>
    </Receipt>
  )
}
