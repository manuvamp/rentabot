// Tiny deterministic helpers: everything Sandbox Web invents comes from a seed string.

/** FNV-1a 32-bit hash of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 PRNG seeded from a string; returns floats in [0, 1). */
export function rng(seed: string): () => number {
  let a = hash32(seed)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(r: () => number, items: readonly T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

export const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!

/** Integer in [min, max]. */
export const between = (r: () => number, min: number, max: number): number => min + Math.floor(r() * (max - min + 1))

export const hex = (n: number, len = 8): string => n.toString(16).padStart(len, '0').slice(-len)
