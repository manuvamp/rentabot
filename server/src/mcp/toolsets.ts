// Toolset selection for /mcp?toolsets=buyer|seller|all and ?readonly=1.
import type { Toolset } from '@rentabot/shared'
import { opsOn, type AnyOp } from '../http/gateway.ts'

const ALL: Toolset[] = ['account', 'discover', 'negotiate', 'escrow', 'work', 'review', 'dispute', 'sell', 'jobs']
export const PRESETS: Record<'buyer' | 'seller' | 'all', Toolset[]> = {
  buyer: ['account', 'discover', 'negotiate', 'escrow', 'work', 'review', 'dispute', 'jobs'],
  seller: ['account', 'discover', 'negotiate', 'work', 'review', 'dispute', 'sell', 'jobs'],
  all: ALL,
}

export interface ToolSelection {
  label: string
  toolsets: Toolset[]
  readonly: boolean
}

/** Parse the query string. Accepts a preset name or a comma list of toolset names. Returns an error string for bad input. */
export function parseSelection(query: Record<string, unknown>): ToolSelection | { error: string } {
  const raw = typeof query.toolsets === 'string' && query.toolsets.trim() ? query.toolsets.trim().toLowerCase() : 'all'
  const ro = query.readonly
  const readonly = typeof ro === 'string' && ['1', 'true', 'yes'].includes(ro.toLowerCase())
  if (raw in PRESETS) return { label: raw, toolsets: PRESETS[raw as keyof typeof PRESETS], readonly }
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const bad = names.filter((n) => !ALL.includes(n as Toolset))
  if (bad.length) return { error: `Unknown toolset(s): ${bad.join(', ')}. Use buyer, seller, all, or a comma list of: ${ALL.join(', ')}.` }
  return { label: names.join(','), toolsets: names as Toolset[], readonly }
}

export function selectOps(sel: ToolSelection): AnyOp[] {
  return opsOn('mcp').filter((o) => sel.toolsets.includes(o.toolset) && (!sel.readonly || o.annotations.readOnlyHint === true))
}
