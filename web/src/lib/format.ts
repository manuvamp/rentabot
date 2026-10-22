import type { Money } from '../api/types'

export const cents = (a: string | number | undefined | null) => Math.round(Number(a ?? 0) * 100)
export const toAmount = (c: number) => (c / 100).toFixed(2)

/** "46.50" or Money -> "$46.50" */
export function usd(a: string | Money | number | undefined | null, opts: { sign?: boolean } = {}): string {
  const v = typeof a === 'object' && a !== null ? a.value : a
  const n = Number(v ?? 0)
  const s = n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  return opts.sign && n > 0 ? `+${s}` : s
}

export function money(a: string | Money | undefined | null): string {
  const v = typeof a === 'object' && a !== null ? a.value : a
  return Number(v ?? 0).toFixed(2)
}

export const shortHash = (h: string | null | undefined, n = 8) => (h ? `${h.slice(0, 7 + n)}…${h.slice(-4)}` : '')

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const s = Math.round((now - new Date(iso).getTime()) / 1000)
  const abs = Math.abs(s)
  const fut = s < 0
  let v: string
  if (abs < 45) v = 'just now'
  else if (abs < 3600) v = `${Math.round(abs / 60)}m`
  else if (abs < 86400) v = `${Math.round(abs / 3600)}h`
  else v = `${Math.round(abs / 86400)}d`
  if (v === 'just now') return v
  return fut ? `in ${v}` : `${v} ago`
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** "P7D" -> "7 days", "PT48H" -> "48 hours" */
export function duration(d: string | undefined | null): string {
  if (!d) return ''
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d)
  if (!m) return d
  const [, days, hours, mins] = m
  const parts: string[] = []
  if (days) parts.push(`${days} day${days === '1' ? '' : 's'}`)
  if (hours && Number(hours) > 0) parts.push(`${hours} hour${hours === '1' ? '' : 's'}`)
  if (mins && Number(mins) > 0) parts.push(`${mins} min`)
  return parts.join(' ') || 'none'
}

export function countdown(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return 'expired'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h >= 1) return `${h}h ${m}m`
  return `${m}m`
}

export const CLASS_LABEL: Record<string, string> = {
  real_world_action: 'Real-world action',
  reach: 'Reach',
  compute_media: 'Compute / media',
  open_weights: 'Open weights',
  security: 'Security',
  human_in_loop: 'Human in the loop',
  code: 'Code',
}

export const STATE_LABEL: Record<string, string> = {
  NEGOTIATING: 'Negotiating',
  AGREED: 'Agreed',
  AWAITING_APPROVAL: 'Needs PayPal approval',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DELIVERED: 'Delivered',
  CURE: 'Cure window',
  DISPUTED: 'Disputed',
  RULED: 'Ruled',
  APPEALED: 'Appealed',
  SETTLED: 'Settled',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
}

/** Server prose carries raw ISO timestamps and "37.50 USD"; show them the way the rest of the UI does. */
export const prettyText = (s: string) =>
  s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => dateTime(iso)).replace(/\b(\d+(?:\.\d{1,2})?) USD\b/g, (_, n: string) => usd(n))
