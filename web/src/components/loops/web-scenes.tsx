// Function loops for the four web bots (Deliverability Doctor, Broken Link Hunter, Web Data Extractor, Uptime Watch), in the style of
// scenes.tsx. Transform/opacity only; under prefers-reduced-motion useLoop shows the final frame.
import { Check, FileText, Link2, Mail, X } from 'lucide-react'
import type { SceneProps } from './scenes'
import { MOVE, pop, useLoop } from './useLoop'

const CARD = 'rounded-md bg-[#fbf8f1] text-ink shadow-[0_3px_6px_-3px_rgba(0,0,0,0.45)]'
const TAG = 'rounded bg-ink px-1.5 py-px font-mono text-[10.5px] font-bold text-hl'
const tag = (dark?: boolean) => (dark ? 'rounded bg-fog px-1.5 py-px font-mono text-[10.5px] font-bold text-ink' : TAG)

// ---------- Deliverability Doctor: DNS records are read one by one (ok / needs a fix), then the fixes are written out ----------
const DNS_ROWS: [string, string, boolean][] = [
  ['MX', '2 servers', true],
  ['SPF', '11/10 lookups', false],
  ['DKIM', 'selector1', true],
  ['DMARC', 'p=none', false],
]
export function DoctorScene({ dark }: SceneProps) {
  const { ref, step } = useLoop(DNS_ROWS.length + 2, 640)
  const read = Math.min(step, DNS_ROWS.length)
  const bad = DNS_ROWS.slice(0, read).filter(([, , ok]) => !ok).length
  return (
    <div ref={ref} className="absolute inset-0 flex gap-2.5 px-3 pb-6 pt-10" aria-hidden>
      <div className="flex w-[22%] flex-col items-center gap-1 pt-1">
        <Mail className={`size-10 ${dark ? 'text-fog' : 'text-ink/80'}`} strokeWidth={1.6} />
        <span className="rounded bg-ink px-1 font-mono text-[8.5px] font-bold text-hl">2 resolvers</span>
      </div>
      <ul className={`${CARD} flex-1 divide-y divide-ink/10 px-1.5 py-0.5`}>
        {DNS_ROWS.map(([k, v, ok], i) => {
          const on = step > i
          return (
            <li key={k} className="flex h-[17px] items-center gap-1.5 font-mono text-[9.5px]">
              <span className="w-9 shrink-0 font-bold">{k}</span>
              <span className="min-w-0 flex-1 truncate text-ink/70">{v}</span>
              <span className={`${MOVE} grid size-3.5 place-items-center rounded-full ${ok ? 'bg-mint-deep' : 'bg-coral-deep'} text-white`} style={pop(on)}>
                {ok ? <Check className="size-2.5" strokeWidth={3.5} /> : <X className="size-2.5" strokeWidth={3.5} />}
              </span>
            </li>
          )
        })}
        <li className={`${MOVE} flex h-[17px] items-center gap-1 font-mono text-[9px] font-bold text-ink`} style={pop(step >= DNS_ROWS.length + 1, 'translateY(6px)')}>
          <span className="rounded bg-hl px-1 ring-1 ring-ink/60">+ TXT</span>
          <span className="truncate text-ink/70">v=DMARC1; p=quarantine</span>
        </li>
      </ul>
      <span className={`absolute bottom-2 left-3 ${tag(dark)}`}>
        {read} read · {bad} to fix
      </span>
    </div>
  )
}

// ---------- Broken Link Hunter: links on a page are checked one by one (200 / 404), the broken ones are collected into the report ----------
const LINK_ROWS: [string, string, number][] = [
  ['/pricing', 'Pricing', 200],
  ['/team', 'Meet the team', 404],
  ['/docs/api', 'API reference', 200],
  ['/blog/2019', 'Launch post', 410],
  ['/status', 'Status page', 500],
]
export function LinkHunterScene({ dark }: SceneProps) {
  const { ref, step } = useLoop(LINK_ROWS.length + 1, 600)
  const checked = Math.min(step, LINK_ROWS.length)
  const broken = LINK_ROWS.slice(0, checked).filter(([, , code]) => code >= 400).length
  return (
    <div ref={ref} className="absolute inset-0 flex gap-2.5 px-3 pb-6 pt-10" aria-hidden>
      <div className="flex w-[22%] flex-col items-center gap-1 pt-1">
        <Link2 className={`size-10 ${dark ? 'text-fog' : 'text-ink/80'}`} strokeWidth={1.6} />
        <span className="rounded bg-ink px-1 font-mono text-[8.5px] font-bold text-hl">2 req/s</span>
      </div>
      <ul className={`${CARD} flex-1 divide-y divide-ink/10 px-1.5 py-0.5`}>
        {LINK_ROWS.map(([href, text, code], i) => {
          const on = step > i
          const ok = code < 400
          return (
            <li key={href} className="flex h-[17px] items-center gap-1.5 font-mono text-[9.5px]">
              <span className="w-[52px] shrink-0 truncate font-bold">{href}</span>
              <span className="min-w-0 flex-1 truncate text-ink/70">{text}</span>
              <span className={`${MOVE} rounded px-1 text-[9px] font-bold text-white ${ok ? 'bg-mint-deep' : 'bg-coral-deep'}`} style={pop(on)}>
                {code}
              </span>
            </li>
          )
        })}
      </ul>
      <span className={`absolute bottom-2 left-3 ${tag(dark)}`}>
        {checked} checked · {broken} broken
      </span>
    </div>
  )
}

// ---------- Web Data Extractor: a page is read, fields are pulled out with a quote each, and the platform finds each quote ----------
const EXTRACT_ROWS: [string, string][] = [
  ['title', 'Widget Pro | Acme'],
  ['price', '$1,299.00'],
  ['email', 'sales@acme.test'],
  ['plan', 'Pro Annual'],
]
export function ExtractorScene({ dark }: SceneProps) {
  const { ref, step } = useLoop(EXTRACT_ROWS.length + 1, 640)
  const found = Math.min(step, EXTRACT_ROWS.length)
  return (
    <div ref={ref} className="absolute inset-0 flex gap-2.5 px-3 pb-6 pt-10" aria-hidden>
      <div className="flex w-[22%] flex-col items-center gap-1 pt-1">
        <FileText className={`size-10 ${dark ? 'text-fog' : 'text-ink/80'}`} strokeWidth={1.6} />
        <span className="rounded bg-ink px-1 font-mono text-[8.5px] font-bold text-hl">1 page</span>
      </div>
      <ul className={`${CARD} flex-1 divide-y divide-ink/10 px-1.5 py-0.5`}>
        {EXTRACT_ROWS.map(([k, v], i) => {
          const on = step > i
          return (
            <li key={k} className="flex h-[17px] items-center gap-1.5 font-mono text-[9.5px]">
              <span className="w-9 shrink-0 font-bold">{k}</span>
              <span className={`${MOVE} min-w-0 flex-1 truncate text-ink/70`} style={pop(on, 'translateX(-6px)')}>
                {v}
              </span>
              <span className={`${MOVE} grid size-3.5 place-items-center rounded-full bg-mint-deep text-white`} style={pop(on)}>
                <Check className="size-2.5" strokeWidth={3.5} />
              </span>
            </li>
          )
        })}
      </ul>
      <span className={`absolute bottom-2 left-3 ${tag(dark)}`}>
        {found} quoted · {found} on the page
      </span>
    </div>
  )
}
