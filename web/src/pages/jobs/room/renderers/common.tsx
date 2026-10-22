import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FileText, X } from 'lucide-react'
import type { Job, Message, Role } from '../../../../api/types'
import { MOCK } from '../../../../api/client'
import { artifactSrc } from '../../../../lib/artifacts'

export interface RenderCtx {
  job: Job
  role: Role
  message: Message
  messages: Message[]
  /** Reload the room (job, escrow, messages) after something changed it, e.g. an answer to a proposal. */
  onChanged?: () => void
}

export const asArr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
export const asStr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d)
export const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Chat-style bubble on the ink surface. */
export function Bubble({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: 'neutral' | 'amber' | 'coral' | 'lime'; className?: string }) {
  const t = {
    neutral: 'border-line bg-ink-2',
    amber: 'border-amber/40 bg-amber/[0.07]',
    coral: 'border-coral/40 bg-coral/[0.07]',
    lime: 'border-lime/35 bg-lime/[0.06]',
  }[tone]
  return <div className={`rounded-2xl rounded-tl-md border px-4 py-3 text-[14px] leading-relaxed text-fog ${t} ${className}`}>{children}</div>
}

/** Plain paper card (no torn edge): for small forms and slips. */
export function PaperCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`paper on-paper rounded-xl px-4 py-3.5 shadow-[0_10px_24px_-14px_rgba(0,0,0,.7)] ${className}`}>{children}</div>
}

export function Label({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-mute">{children}</p>
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-xl border border-line bg-[#0a0a0c] p-3 text-[12px] leading-relaxed text-soft" tabIndex={0}>
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function KV({ data }: { data: Record<string, unknown> }) {
  const rows = Object.entries(data)
  if (!rows.length) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[12.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-mute">{k}</dt>
          <dd className="min-w-0 break-words text-fog">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Short compact params like `status=200 must_include=[ORANO]` */
export function paramsText(p: unknown): string {
  if (!isRec(p)) return ''
  return Object.entries(p)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ')
}

/* ---------------------------------------------------------- artifact thumbs */
// Reports (markdown, text, JSON, HTML) are artifacts too: they get a document tile and open as plain text,
// never as an <img> (which shows a broken image) and never rendered as HTML.
type ArtKind = 'image' | 'text' | 'file'
const kindOf = (mime: string): ArtKind =>
  mime.startsWith('image/') ? 'image' : /^(text\/|application\/(json|xml|x-ndjson))/.test(mime) ? 'text' : 'file'

function useArtifactKinds(ids: string[]): Record<string, ArtKind> {
  const [kinds, setKinds] = useState<Record<string, ArtKind>>({})
  const key = ids.join(',')
  useEffect(() => {
    if (MOCK) return
    let live = true
    for (const id of ids) {
      fetch(artifactSrc(id), { method: 'HEAD', credentials: 'same-origin' })
        .then((r) => live && setKinds((k) => ({ ...k, [id]: kindOf(r.headers.get('content-type') ?? '') })))
        .catch(() => {})
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return kinds
}

function ArtifactText({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    fetch(artifactSrc(id), { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((t) => live && setText(t.length > 200_000 ? t.slice(0, 200_000) + '\n…' : t))
      .catch(() => live && setText('Could not load this file.'))
    return () => {
      live = false
    }
  }, [id])
  return (
    <pre className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-paper p-4 font-mono text-[12.5px] leading-relaxed text-ink" tabIndex={0}>
      {text ?? 'Loading…'}
    </pre>
  )
}

export function ArtifactThumbs({ ids, job }: { ids: string[]; job: Job }) {
  const [open, setOpen] = useState<string | null>(null)
  const dlg = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const kinds = useArtifactKinds(ids)
  useEffect(() => {
    const d = dlg.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  if (!ids.length) return null
  const label = (id: string) => job.id.slice(4) + ' ' + id.replace(/^art_/, '')
  const kind = (id: string): ArtKind => (MOCK ? 'image' : (kinds[id] ?? 'image'))
  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-2">
        {ids.map((id) => (
          <li key={id}>
            <button
              type="button"
              onClick={(e) => {
                opener.current = e.currentTarget
                setOpen(id)
              }}
              className="group block overflow-hidden rounded-lg border border-line bg-ink-2 transition hover:border-hl"
              aria-label={kind(id) === 'image' ? `Open screenshot ${id}` : `Open file ${id}`}
            >
              {kind(id) === 'image' ? (
                <img src={artifactSrc(id, label(id))} alt={`Evidence ${id}`} loading="lazy" className="h-20 w-32 object-cover transition group-hover:scale-105 sm:h-24 sm:w-40" />
              ) : (
                <span className="paper on-paper flex h-20 w-32 flex-col gap-1.5 px-3 py-2.5 sm:h-24 sm:w-40" aria-hidden="true">
                  <FileText className="size-4 text-ink/70" />
                  <span className="h-1.5 w-4/5 rounded bg-ink/25" />
                  <span className="h-1.5 w-3/5 rounded bg-ink/15" />
                  <span className="h-1.5 w-2/3 rounded bg-ink/15" />
                  <span className="mt-auto font-mono text-[9px] font-bold uppercase tracking-widest text-ink/60">{kind(id) === 'text' ? 'report' : 'file'}</span>
                </span>
              )}
              <span className="block truncate border-t border-line px-2 py-1 text-left font-mono text-[10px] text-mute">{id}</span>
            </button>
          </li>
        ))}
      </ul>
      <dialog
        ref={dlg}
        onClose={() => {
          setOpen(null)
          opener.current?.focus()
        }}
        onClick={(e) => {
          if (e.target === dlg.current) setOpen(null)
        }}
        className="m-auto max-w-[min(92vw,900px)] rounded-2xl border border-line bg-ink-1 p-0 text-fog backdrop:bg-black/80"
        aria-label="Artifact preview"
      >
        {open && (
          <div className="p-3">
            <div className="mb-2 flex items-center justify-between gap-4">
              <span className="font-mono text-xs text-soft">{open}</span>
              <button type="button" autoFocus onClick={() => setOpen(null)} className="grid size-8 place-items-center rounded-lg border border-line hover:border-hl" aria-label="Close preview">
                <X className="size-4" />
              </button>
            </div>
            {kind(open) === 'image' ? (
              <img src={artifactSrc(open, label(open))} alt={`Evidence ${open}`} className="max-h-[75vh] w-full rounded-lg bg-paper object-contain" />
            ) : kind(open) === 'text' ? (
              <ArtifactText id={open} />
            ) : (
              <a href={artifactSrc(open)} download className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:border-hl">
                <FileText className="size-4" /> Download {open}
              </a>
            )}
          </div>
        )}
      </dialog>
    </>
  )
}
