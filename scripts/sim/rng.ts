// Seeded PRNG (mulberry32) so a run is reproducible from --seed and a job from (seed, index).
export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0 || 1
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(lo: number, hi: number) {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }
  chance(p: number) {
    return this.next() < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!
  }
  weighted<T extends string>(w: Record<T, number>): T {
    const entries = Object.entries(w) as [T, number][]
    const total = entries.reduce((s, [, v]) => s + v, 0)
    let r = this.next() * total
    for (const [k, v] of entries) if ((r -= v) < 0) return k
    return entries[entries.length - 1]![0]
  }
}
export const jobRng = (seed: number, idx: number) => new Rng((seed * 2654435761 + idx * 40503 + 7) >>> 0)
