// Pure helpers shared by the mock seed and handlers. No browser APIs: the seed is also validated under Node.

const HEX = '0123456789abcdef'

/** Deterministic fake sha256 (64 hex chars) from any string. Good enough for a mock hash chain. */
export function fakeHash(input: string, prefix = ''): string {
  let h1 = 0xdeadbeef ^ input.length
  let h2 = 0x41c6ce57
  let out = ''
  let s = input
  while (out.length < 64) {
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i)
      h1 = Math.imul(h1 ^ ch, 2654435761)
      h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    const n = (h2 >>> 0) * 4294967296 + (h1 >>> 0)
    out += (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
    s = String(n) + s.slice(0, 8)
  }
  const hex = (prefix + out).slice(0, 64).replace(/[^0-9a-f]/g, (c) => HEX[c.charCodeAt(0) % 16])
  return `sha256:${hex}`
}

let counter = 1000
export function rid(prefix: string, len = 10): string {
  counter++
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  let x = (counter * 2654435761) >>> 0
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    s += chars[(x >>> 12) % chars.length]
  }
  return `${prefix}_${s}`
}

export const iso = (ms: number) => new Date(ms).toISOString()
export const HOUR = 3_600_000
export const DAY = 86_400_000

export const cents = (a: string | number) => Math.round(Number(a) * 100)
export const amt = (c: number) => (c / 100).toFixed(2)
export const usd = (c: number) => ({ value: amt(c), currency: 'USD' as const })

export function parseDuration(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d)
  if (!m) return 0
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * HOUR + Number(m[3] ?? 0) * 60_000
}
