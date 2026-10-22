// dns_claims_hold: the platform's acceptance check for the Deliverability Doctor. It never takes the bot's word: it asks DNS again
// itself (the system resolver and DNS-over-HTTPS), rebuilds the findings and the records to add from those answers with the same
// deterministic rules, and passes the domain's unit only if every fact, every finding and every fix the unit claims holds.
import type { CheckImpl, CheckLibrary, CheckOutcome } from '../intelligence/types.ts'
import { analyze, collectFacts, defaultResolvers, factsDiff, findingKeys, fixKeys, parseDomain, parseDomains, parseSelectors, selectorsFor, type DnsResolvers, type Facts } from './dns-logic.ts'

const out = (status: CheckOutcome['status'], detail: string, evidence_id: string | null = null): CheckOutcome => ({ status, detail: detail.length > 1000 ? `${detail.slice(0, 999)}…` : detail, evidence_id })

export interface DnsCheckOptions {
  /** Resolvers (tests). Default: the system resolver and DNS-over-HTTPS. */
  dns?: DnsResolvers
}

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])

export function registerDnsChecks(lib: CheckLibrary, opts: DnsCheckOptions = {}): void {
  const res = opts.dns ?? defaultResolvers()
  const dnsClaimsHold: CheckImpl = {
    def: {
      id: 'dns_claims_hold',
      title: 'DNS claims hold',
      description:
        'The platform re-resolves the unit\'s domain itself (system resolver and DNS-over-HTTPS) and passes the unit only if everything it claims holds: unit.meta.domain is one of the contract\'s domains; the MX, SPF (and its DNS lookup count), DMARC, MTA-STS, TLS-RPT, BIMI records and every DKIM selector in unit.meta.facts equal what DNS returns now; the unit tried the common DKIM selectors plus the buyer\'s; ' +
        'and the findings (id and severity) and the DNS records to add or replace in unit.meta.findings / unit.meta.fixes equal the ones the platform derives from those answers with the same deterministic rules. A domain that does not exist is a valid, checkable result. If a resolver cannot answer, the result is pending (inconclusive), never a free pass.',
      params: { type: 'object', properties: {}, additionalProperties: false },
      per_unit: true,
      delayed: true,
    },
    async run(ctx) {
      if (!ctx.unit) return out('error', 'dns_claims_hold runs per delivered unit')
      const m = ctx.unit.meta
      const domain = parseDomain(m.domain)
      if (!domain) return out('fail', 'unit.meta.domain is missing or not a domain name')
      const allowed = parseDomains(ctx.contract.inputs.domains).domains
      if (!allowed.includes(domain)) return out('fail', `${domain} is not one of the domains in the contract`)
      const facts0 = m.facts as { dkim?: Record<string, unknown> } | undefined
      if (!facts0 || typeof facts0 !== 'object') return out('fail', 'unit.meta.facts is missing')
      const buyerSelectors = parseSelectors(ctx.contract.inputs.dkim_selectors)
      const required = selectorsFor(buyerSelectors)
      const claimedSel = Object.keys(facts0.dkim && typeof facts0.dkim === 'object' ? facts0.dkim : {})
      const skipped = required.filter((s) => !claimedSel.includes(s))
      if (skipped.length) return out('fail', `the audit did not try the DKIM selector(s) ${skipped.slice(0, 6).join(', ')}`)
      const extra = parseSelectors(claimedSel).filter((s) => !required.includes(s))
      const selectors = [...required, ...extra].slice(0, 40)

      const facts: Facts = await collectFacts(domain, selectors, res)
      const diffs = factsDiff(m.facts, facts)
      const analysis = analyze(facts)
      const wantFindings = findingKeys(analysis.findings)
      const gotFindings = findingKeys(arr(m.findings).map((f) => ({ id: String(f.id ?? ''), severity: String(f.severity ?? '') })))
      for (const k of wantFindings.filter((x) => !gotFindings.includes(x))) diffs.push(`finding ${k} is missing from the unit`)
      for (const k of gotFindings.filter((x) => !wantFindings.includes(x))) diffs.push(`finding ${k} is claimed but DNS does not support it`)
      const wantFixes = fixKeys(analysis.fixes)
      const gotFixes = fixKeys(arr(m.fixes).map((f) => ({ action: String(f.action ?? ''), type: String(f.type ?? ''), name: String(f.name ?? ''), value: String(f.value ?? '') })))
      for (const k of wantFixes.filter((x) => !gotFixes.includes(x))) diffs.push(`DNS record to ${k.split('|')[0]} is missing from the unit: ${k.split('|').slice(2).join(' ').slice(0, 120)}`)
      for (const k of gotFixes.filter((x) => !wantFixes.includes(x))) diffs.push(`DNS record claimed but not what the rules produce: ${k.split('|').slice(0, 3).join(' ').slice(0, 120)}`)

      const unknown = [facts.mx, facts.spf, facts.dmarc, facts.mta_sts, facts.tls_rpt, facts.bimi, ...Object.values(facts.dkim)].filter((f) => f.status === 'error').length
      const ev = await ctx.saveEvidence('dns_audit', `${domain}: ${diffs.length ? `${diffs.length} difference(s)` : 'every claim holds'}`, {
        domain,
        resolvers: ['system', 'doh'],
        platform_facts: facts,
        differences: diffs.slice(0, 30),
        findings: analysis.findings.map((f) => `${f.id}:${f.severity}`),
        fixes: analysis.fixes.map((f) => `${f.action} ${f.name}`),
        unknown_answers: unknown,
      })
      if (diffs.length === 0) return out('pass', `${domain}: ${Object.keys(facts.dkim).length} DKIM selectors, ${analysis.findings.length} findings and ${analysis.fixes.length} DNS record(s) all match what DNS returns now`, ev)
      if (unknown > 0 && ctx.attempt < 2) return out('pending', `${domain}: ${unknown} name(s) could not be resolved by either resolver just now, so the claims cannot be judged yet (${diffs.slice(0, 2).join('; ')})`, ev)
      if (unknown > 0) return out('error', `${domain}: still inconclusive, ${unknown} name(s) not answered by either resolver (${diffs.slice(0, 2).join('; ')})`, ev)
      return out('fail', `${domain}: ${diffs.slice(0, 4).join('; ')}${diffs.length > 4 ? `; and ${diffs.length - 4} more` : ''}`, ev)
    },
  }
  lib.register(dnsClaimsHold)
}
