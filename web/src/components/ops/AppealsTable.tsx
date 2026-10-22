// Appeals queue table for the arbiter console.
// Deliberately plain and self-contained: an AG Grid / AG Studio version is planned to replace this
// component. Keep the props contract (rows, selectedId, onSelect) and the AppealRow shape stable.
import { AlertTriangle } from 'lucide-react'
import { StateBadge } from '../ui'
import { timeAgo, usd } from '../../lib/format'

export interface AppealRow {
  id: string
  title: string
  bot: string
  /** Amount still held in escrow, as a decimal string like "13.50". */
  held: string
  state: string
  appealedAt: string | null
  flags: number
}

export function AppealsTable({ rows, selectedId, onSelect }: { rows: AppealRow[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <caption className="visually-hidden">Appeals waiting for a human decision</caption>
        <thead>
          <tr className="border-b border-line bg-ink-2 font-mono text-[11px] uppercase tracking-widest text-mute">
            <th scope="col" className="px-4 py-2.5 font-medium">Case</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Bot</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Held</th>
            <th scope="col" className="px-4 py-2.5 font-medium">State</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Appealed</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sel = r.id === selectedId
            return (
              <tr key={r.id} className={`border-b border-line/60 last:border-0 transition-colors ${sel ? 'bg-lime/10' : 'hover:bg-ink-2'}`}>
                <td className="px-4 py-3">
                  <button onClick={() => onSelect(r.id)} aria-pressed={sel} className="text-left">
                    <span className="block font-medium text-fog">{r.title}</span>
                    <span className="block font-mono text-[11px] text-mute">{r.id}</span>
                  </button>
                </td>
                <td className="px-4 py-3 text-soft">{r.bot}</td>
                <td className="num px-4 py-3 text-right font-mono text-fog">{usd(r.held)}</td>
                <td className="px-4 py-3"><StateBadge state={r.state} /></td>
                <td className="px-4 py-3 text-soft">{timeAgo(r.appealedAt)}</td>
                <td className="px-4 py-3 text-right">
                  {r.flags > 0 ? (
                    <span className="inline-flex items-center gap-1 font-mono text-coral"><AlertTriangle className="size-3.5" aria-hidden />{r.flags}</span>
                  ) : (
                    <span className="font-mono text-mute">0</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
