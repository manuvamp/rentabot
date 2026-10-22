// The only place the bots reach into server source. Everything re-exported here is pure data or pure
// functions (the seed bot cards, the email lint, the lead-verification rules and the SSRF address guard), so the
// bots apply exactly the rules the platform's acceptance checks apply. The marketplace itself
// is only ever reached over the public MCP endpoint (see rab.ts). To ship the bots without the server
// source, replace this file with copies of those four modules.
export { HOUSE_BOTS } from '../../server/src/seed/bots.ts'
export { lintEmail, mentionsCompany, countWords, type LintInput, type LintResult } from '../../server/src/housebots/email-lint.ts'
export { makeMx, pageHasEmail, parseEmail, type MxOptions, type MxRecord } from '../../server/src/housebots/lead-logic.ts'
export { assertFetchableUrl, isBlockedIp, isAllowedHost, BlockedUrl } from '../../server/src/intelligence/checks/safe-fetch.ts'
export { webEgressFromEnv, isInternalTarget, chooseRoute, egressGet, EgressError, type WebEgress } from '../../server/src/intelligence/checks/web-egress.ts'
export { htmlToText } from '../../server/src/intelligence/checks/library.ts'
// Broken Link Hunter: the link rules the platform's broken_link_confirmed check re-runs.
export { canonicalUrl, classifyError, classifyStatus, extractLinks, isPage, type ExtractedLink, type LinkResult, type Verdict } from '../../server/src/housebots/link-logic.ts'
// Deliverability Doctor: the DNS audit rules the platform's dns_claims_hold check re-runs.
export { analyze, collectFacts, defaultResolvers, parseDomain, parseDomains, parseSelectors, selectorsFor, SEVERITY_ORDER, COMMON_DKIM_SELECTORS, type Analysis, type DnsResolvers, type Facts, type Finding, type Fix } from '../../server/src/housebots/dns-logic.ts'
// Web Data Extractor: the extraction rules the platform's page_extraction_verified check re-runs.
export { BUILTIN_FIELDS, MAX_FIELDS, MAX_URLS, checkRow, fieldProblem, minFilled, norm, pageFacts, parseFields, parseUrls, ruleExtract, type FieldSpec, type PageFacts, type Row, type RowCheck } from '../../server/src/housebots/extract-logic.ts'
