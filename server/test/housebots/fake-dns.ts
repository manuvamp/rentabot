// A scripted DNS for the Deliverability Doctor tests: both resolvers answer from a zone map (the DoH one from its own map when given,
// to simulate a change still propagating), a name can be made to fail on both, and every query is counted.
import type { DnsAnswer, DnsResolvers, Resolver, RType } from '../../src/housebots/dns-logic.ts'

export type Zone = Record<string, { MX?: string[]; TXT?: string[] }>

function answer(zone: Zone, name: string, type: RType): DnsAnswer {
  const n = name.toLowerCase().replace(/\.$/, '')
  const rec = zone[n]
  if (rec) {
    const r = rec[type] ?? []
    return { status: r.length ? 'ok' : 'nodata', records: [...r] }
  }
  // The name has no records: NODATA when its domain exists in the zone, else NXDOMAIN.
  const exists = Object.keys(zone).some((k) => n === k || n.endsWith(`.${k}`))
  return { status: exists ? 'nodata' : 'nxdomain', records: [] }
}

export interface FakeDns extends DnsResolvers {
  queries: { resolver: string; name: string; type: RType }[]
  /** Make both resolvers fail (SERVFAIL / timeout) for these names from now on; pass [] to heal. */
  breakNames(names: string[]): void
}

export function fakeDns(zone: Zone, opts: { dohZone?: Zone } = {}): FakeDns {
  const queries: FakeDns['queries'] = []
  let broken = new Set<string>()
  const make = (id: Resolver['id'], z: Zone): Resolver => ({
    id,
    async resolve(name, type) {
      queries.push({ resolver: id, name, type })
      if (broken.has(name.toLowerCase())) return { status: 'error', records: [] }
      return answer(z, name, type)
    },
  })
  return { system: make('system', zone), doh: make('doh', opts.dohZone ?? zone), queries, breakNames: (names) => void (broken = new Set(names.map((x) => x.toLowerCase()))) }
}

/** A base64 DKIM public key of about the size of an RSA key with this many bits (the audit estimates the size from its length). */
export const dkimKey = (bits: 1024 | 2048): string => Buffer.alloc(bits === 2048 ? 294 : 162, 7).toString('base64')

/** A mail setup with nothing to fix except the optional extras. */
export const goodZone = (d: string): Zone => ({
  [d]: { MX: [`10 mx1.${d}`, `20 mx2.${d}`], TXT: [`v=spf1 include:_spf.${d} ~all`] },
  [`_spf.${d}`]: { TXT: ['v=spf1 ip4:203.0.113.0/24 -all'] },
  [`_dmarc.${d}`]: { TXT: [`v=DMARC1; p=reject; rua=mailto:dmarc@${d}`] },
  [`selector1._domainkey.${d}`]: { TXT: [`v=DKIM1; k=rsa; p=${dkimKey(2048)}`] },
  [`_mta-sts.${d}`]: { TXT: ['v=STSv1; id=20260101'] },
  [`_smtp._tls.${d}`]: { TXT: [`v=TLSRPTv1; rua=mailto:tls@${d}`] },
})

/** Everything wrong at once: permissive SPF twice over, monitoring-only DMARC, a weak DKIM key, one MX. */
export const messyZone = (d: string): Zone => ({
  [d]: { MX: [`10 mail.${d}`], TXT: ['v=spf1 +all', `v=spf1 mx include:_spf.${d}`] },
  [`_spf.${d}`]: { TXT: ['v=spf1 ip4:198.51.100.7 -all'] },
  [`_dmarc.${d}`]: { TXT: ['v=DMARC1; p=none'] },
  [`google._domainkey.${d}`]: { TXT: [`v=DKIM1; k=rsa; p=${dkimKey(1024)}`] },
})
