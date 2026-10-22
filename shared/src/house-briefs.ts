// Plain-language briefs for the house bots' skills: what each asks for, what it does out in the world,
// and what it hands back. Shared by the server seed and the web mock so both show the same cards.
import { z } from 'zod'
import { BotPassport, SkillBrief } from './protocol.ts'

const RAW: Record<string, z.input<typeof SkillBrief>> = {
  'Directory Blaster': {
    needs: [
      { label: 'Product facts', kind: 'info', why: 'Name, URL, tagline, description, category and the contact email.' },
      { label: 'Logo URL', kind: 'info', why: 'A public logo image URL for the listings (optional).' },
      { label: 'Inbox for verification emails', kind: 'access', sensitive: true, why: 'App password of the mailbox behind contact_email: it reads the confirmation links directories send. Read-only use.' },
      { label: 'OK to create accounts', kind: 'approval', why: 'Some directories need an account before they take a listing. The contract caps every action.' },
    ],
    does: [
      { action: 'create_account', label: 'Creates a directory account, only where one is required', limit: 'one per such directory' },
      { action: 'fill_form', label: 'Fills each submission form', limit: 'up to your listing count' },
      { action: 'browse', label: 'Opens the verification links in your inbox', limit: 'confirmation mails only' },
    ],
    returns: [
      { label: 'Live listing URLs with snapshots', kind: 'proof' },
      { label: 'Logins for the accounts it created', kind: 'credentials', sensitive: true },
    ],
  },
  'Investor Outreach Bot': {
    needs: [
      { label: 'Facts about your company', kind: 'info', why: 'Text every email is written from; only these facts are used.' },
      { label: 'Stage, raise and sectors', kind: 'info', why: 'Who counts as a fit.' },
      { label: 'Send access to your inbox', kind: 'access', sensitive: true, why: 'SMTP-style login (address + app password). Emails go out from your own address and reputation.' },
      { label: 'Your send caps', kind: 'approval', why: 'The contract limits how many emails it may send in total and per day, and to whom.' },
    ],
    does: [
      { action: 'browse', label: 'Reads the investor list and fit-scores it before quoting', limit: 'quotes no more emails than investors that fit' },
      { action: 'write', label: 'Writes one personal email each' },
      { action: 'send_email', label: 'Sends from your inbox, logging each send first', limit: 'up to 200 a job, within your caps' },
      { action: 'analyze', label: 'Reads bounce notices and swaps the address' },
    ],
    returns: [
      { label: 'Sent proof: Message-ID and delivery record', kind: 'proof' },
      { label: 'Every email it sent', kind: 'file' },
      { label: 'Replies, re-checked by the platform for days', kind: 'proof' },
    ],
  },
  'Lead Verifier': {
    needs: [{ label: 'Your lead list (JSONL)', kind: 'file', why: 'Email, company, domain and the page you found it on. At least 60 leads: a job settles only at $5.00 or more, so a few failures still clear it.' }],
    does: [
      { action: 'browse', label: 'Reads the public page you cite', limit: 'read-only' },
      { action: 'call_api', label: 'Looks up MX records', limit: 'read-only' },
    ],
    returns: [{ label: 'A ✓ or ✗ per lead, with evidence', kind: 'data' }],
  },
  // Lead Verifier's second skill, find_leads: briefs are per bot, so this one is keyed "bot/skill" and read through houseBrief().
  'Lead Verifier/find_leads': {
    needs: [
      { label: 'Your target companies', kind: 'info', why: '1 to 10 company domains, e.g. acme.com, named in your request or sent as an input. No account of yours is needed: the bot brings its own Hunter.io.' },
      { label: 'How many leads', kind: 'info', why: 'At most 10 per domain. At least 18 leads: a job settles only at $5.00 or more, so a few failures still clear it.' },
      { label: 'A department or seniority (optional)', kind: 'info', why: 'For example marketing, or senior and executive.' },
      { label: 'Role addresses or named people (optional)', kind: 'info', why: 'Asking for role addresses (in the request, or type "generic") gives only info@, admissions@, press@ and the like: addresses that look personal are left out and counted, not delivered.' },
    ],
    does: [
      { action: 'call_api', label: 'Searches each domain on its own Hunter.io account', limit: '1 search a domain, 10 leads a search, 50 searches a month' },
      { action: 'browse', label: 'Opens the source page Hunter gives for each address, your own domain\'s pages first', limit: 'read-only, 2 requests a second' },
      { action: 'call_api', label: 'Looks up MX records', limit: 'read-only' },
    ],
    returns: [{ label: 'Verified leads: address, name, role and the page it is on', kind: 'data' }],
  },
  'Budget Lead Verifier': {
    needs: [{ label: 'Your lead list (JSONL)', kind: 'file', why: 'Email, company, domain and the page you found it on. At least 90 leads: a job settles only at $5.00 or more, so a few failures still clear it.' }],
    does: [
      { action: 'browse', label: 'Reads the public page you cite', limit: '1 request a second' },
      { action: 'call_api', label: 'Looks up MX records', limit: 'read-only' },
    ],
    returns: [{ label: 'A ✓ or ✗ per lead, with evidence', kind: 'data' }],
  },
  'Agent-Readiness Auditor': {
    needs: [{ label: 'Your website URL', kind: 'info', why: 'Public pages only.' }],
    does: [
      { action: 'browse', label: 'Crawls your public pages', limit: 'read-only' },
      { action: 'analyze', label: 'Checks llms.txt, schema, MCP, robots' },
    ],
    returns: [
      { label: 'Markdown report with a score', kind: 'report' },
      { label: 'Findings the platform re-checks', kind: 'proof' },
      { label: 'Fixes to paste in', kind: 'file' },
    ],
  },
  'Cold Email Writer': {
    needs: [
      { label: 'Facts about you', kind: 'info', why: 'What the emails may claim.' },
      { label: 'Recipients and why them', kind: 'info', why: 'Name, company, angle. At least 12: a job settles only at $5.00 or more, so a couple of misses still clear it.' },
    ],
    does: [
      { action: 'write', label: 'Writes one email per recipient', limit: 'never sends' },
      { action: 'analyze', label: 'Lints each one' },
    ],
    returns: [{ label: 'Ready-to-send emails that pass lint', kind: 'file' }],
  },
  'Account Setup Bot': {
    needs: [
      { label: 'Product facts', kind: 'info', why: 'Name, URL, a short and a longer bio, and a public logo URL.' },
      { label: 'Inbox for verification emails', kind: 'access', sensitive: true, why: "App password of the mailbox behind contact_email: it reads each service's verification mail. Read-only use." },
      { label: 'OK to create accounts', kind: 'approval', why: "One account per service, in your product's name. The contract caps every action." },
    ],
    does: [
      { action: 'create_account', label: 'Signs up on each service with a unique strong password', limit: 'one account per service' },
      { action: 'browse', label: 'Opens the verification link in your inbox', limit: 'confirmation mails only' },
      { action: 'fill_form', label: 'Fills the profile: name, logo, bio, link', limit: 'one profile per account' },
    ],
    returns: [
      { label: 'A live public profile per account', kind: 'proof' },
      { label: 'The login for every account', kind: 'credentials', sensitive: true },
    ],
  },
  'Application Filler': {
    needs: [
      { label: 'Facts about your company', kind: 'info', why: 'Text every answer is written from; only these facts are used.' },
      { label: 'Applicant name and email', kind: 'info', why: 'Who the applications are in the name of; confirmations go here.' },
      { label: 'OK to fill forms in your name', kind: 'approval', why: 'The contract caps how many forms it may fill.' },
      { label: 'Your approval before each submit', kind: 'approval', why: 'It posts a preview of every filled form and submits only the ones you approve.' },
    ],
    does: [
      { action: 'write', label: "Writes each answer from your facts, within the form's limits" },
      { action: 'fill_form', label: 'Fills every step and uploads a one-pager PDF', limit: 'up to your application count' },
      { action: 'fill_form', label: 'Submits only the forms you approved', limit: 'never before your approval' },
    ],
    returns: [
      { label: 'A preview of every filled form, before submit', kind: 'report' },
      { label: 'Confirmation ID and receipt page per application', kind: 'proof' },
    ],
  },
  'Agent Red Team': {
    needs: [
      { label: 'Proof you own the target', kind: 'approval', why: 'An ownership token bound to this job; the platform checks it before any money moves.' },
      { label: 'The agent to test', kind: 'info', why: 'Demo mode: the Sandbox practice agent Rent-A-Bot hosts. Nothing else can be targeted.' },
    ],
    does: [
      { action: 'call_api', label: 'Runs five robustness probes on your agent', limit: 'owned target only' },
      { action: 'analyze', label: 'Rates each weakness and writes a fix' },
    ],
    returns: [
      { label: 'Redacted findings report', kind: 'report' },
      { label: 'One verified finding per weakness, confirmed by the target', kind: 'proof' },
    ],
  },
  'Landing Page Bot': {
    needs: [{ label: 'Product facts', kind: 'info', why: 'Name, URL, one-liner and three to six features.' }],
    does: [
      { action: 'write', label: 'Writes the hero, features and call to action', limit: 'from your facts only' },
      { action: 'post_content', label: 'Builds and publishes the page', limit: 'one page' },
    ],
    returns: [
      { label: 'Live page URL', kind: 'proof' },
      { label: 'The HTML file', kind: 'file' },
    ],
  },
  'Deliverability Doctor': {
    needs: [
      { label: 'Your domains', kind: 'info', why: 'Plain domain names, one per line. At least 6: a job settles only at $5.00 or more, so a failure still clears it.' },
      { label: 'DKIM selectors', kind: 'info', why: 'Optional: the selectors your mail is signed with. The common ones are always tried.' },
    ],
    does: [
      { action: 'call_api', label: 'Asks DNS through two resolvers (system and DNS-over-HTTPS)', limit: 'read-only' },
      { action: 'analyze', label: 'Applies fixed rules to MX, SPF, DMARC, DKIM, MTA-STS, TLS-RPT, BIMI' },
      { action: 'write', label: 'Writes a plain-English explanation', limit: 'from the findings only' },
    ],
    returns: [
      { label: 'A findings report per domain', kind: 'report' },
      { label: 'The exact DNS records to add or replace', kind: 'file' },
      { label: 'Claims the platform re-resolves itself', kind: 'proof' },
    ],
  },
  'Broken Link Hunter': {
    needs: [
      { label: 'Your site URL', kind: 'info', why: 'One public http(s) URL. The crawl starts here and stays on this host.' },
      { label: 'Page cap', kind: 'info', why: 'Optional: the most pages to crawl (default 40, at most 100).' },
    ],
    does: [
      { action: 'browse', label: 'Crawls your public pages politely', limit: 'robots.txt obeyed, 2 requests a second' },
      { action: 'call_api', label: 'Checks every link with a HEAD, then a GET', limit: 'read-only' },
      { action: 'analyze', label: 'Takes a second look at anything that looks broken' },
    ],
    returns: [
      { label: 'Each broken link: source page, anchor text, status', kind: 'proof' },
      { label: 'A crawl report', kind: 'report' },
    ],
  },
  'Web Data Extractor': {
    needs: [
      { label: 'The pages', kind: 'info', why: 'One public http(s) URL per line. At least as many as you hire (minimum 30: a job settles only at $5.00 or more).' },
      { label: 'The fields', kind: 'info', why: 'One per line, e.g. title, price, contact_email. Built in: title, description, h1, emails, phones, prices.' },
    ],
    does: [
      { action: 'browse', label: 'Reads your public pages politely', limit: 'robots.txt obeyed, 2 requests a second' },
      { action: 'analyze', label: 'Extracts the fields by rules, or with AI for fields you name', limit: 'a quote from the page for every value' },
    ],
    returns: [
      { label: 'A JSONL row per page, a quote for every value', kind: 'file' },
      { label: 'Each quote re-found on the page by the platform', kind: 'proof' },
    ],
  },
}

/**
 * Briefs by house-bot name, or "bot/skill" for a bot's further skills. The two lead verifiers share a skill id, so a bot's first skill
 * is keyed by the bot, not the skill. Read them through houseBrief().
 */
export const HOUSE_BRIEFS: Record<string, SkillBrief> = Object.fromEntries(Object.entries(RAW).map(([name, b]) => [name, SkillBrief.parse(b)]))

/** The brief of one skill of a house bot: its own "bot/skill" entry when it has one, else the bot's. */
export const houseBrief = (botName: string, skillId: string): SkillBrief | undefined => HOUSE_BRIEFS[`${botName}/${skillId}`] ?? HOUSE_BRIEFS[botName]

// Passports, declared from what the code in bots/src/bots/*.ts really does. Models: the house bots call the server's
// AI client at its "main" tier (AI_MODEL_MAIN, default claude-sonnet-5-5) and fall back to templates without it.
// verified: true because the platform itself runs these bots.
const SONNET = 'claude-sonnet-5-5'
const FETCH = { name: 'Web fetcher (HTTP)', kind: 'other', owner: 'bot', verified: true } as const
const DNS = { name: 'DNS MX lookup', kind: 'data_api', owner: 'bot', purpose: 'System DNS, with Google DNS-over-HTTPS as fallback.', verified: true } as const

/**
 * The Lead Verifier's own Hunter.io account (find_leads). Listed only while the server has the key, so the shelf never shows a
 * connection the bot does not have: see shelfFor() in server/src/seed/bots.ts, which drops it when HUNTER_API_KEY is unset.
 */
export const HUNTER_CONNECTION_NAME = 'Hunter.io'
export const HUNTER_CONNECTION = {
  name: HUNTER_CONNECTION_NAME,
  kind: 'data_api',
  owner: 'bot',
  purpose: 'Finds the addresses at your target companies. The bot’s own free account: 50 domain searches a month for all buyers, 10 leads a search.',
  verified: true,
} as const

/** A passport as the shelf shows it while the server has no Hunter.io key: without the connection, its tool and its unlock. */
export function withoutHunter(p: BotPassport): BotPassport {
  return {
    ...p,
    connections: p.connections.filter((c) => c.name !== HUNTER_CONNECTION_NAME),
    tools: p.tools.filter((t) => t.name !== 'Lead finder'),
    unlocks: p.unlocks.filter((u) => !/Hunter\.io/.test(u)),
    data_handling: p.data_handling.replace(' The domains you name go to Hunter.io.', ''),
  }
}

const RAW_PASSPORTS: Record<string, z.input<typeof BotPassport>> = {
  'Directory Blaster': {
    models: [],
    connections: [
      { name: 'Sandbox Web directories', kind: 'other', owner: 'bot', purpose: 'Signs up where needed, submits each listing and opens it to prove it is live (demo).', verified: true },
      { name: 'Your contact inbox', kind: 'email', owner: 'buyer', purpose: 'Reads the verification mails directories send, with your app password (demo: Sandbox Web mailbox).', verified: true },
    ],
    tools: [
      { name: 'Account creator', description: 'A unique 24-character password per account, verified by the mail link, handed to you through the locker.' },
      { name: 'Directory submit', description: 'Fills each directory with your approved copy; skips paid and captcha-walled ones.' },
      { name: 'Listing snapshot', description: 'Saves the live page as proof for every listing.' },
    ],
    unlocks: ['Creates the accounts directories demand and hands you the logins', 'Submits to dozens of directories, one proof per listing', 'Clicks the email confirmations for you'],
    runs_on: 'rentabot',
    data_handling: 'Inputs and snapshots stay as job artifacts; new logins go only to your locker. No model sees any of it.',
  },
  'Investor Outreach Bot': {
    models: [{ provider: 'Anthropic', model: SONNET, role: 'Scores investor fit and writes each email' }],
    connections: [
      { name: 'Sandbox Web investor list', kind: 'data_api', owner: 'bot', purpose: 'Investor names, theses and addresses to choose from (demo).', verified: true },
      { name: 'Your inbox (send)', kind: 'email', owner: 'buyer', purpose: 'Sends from your address with your app password, within your caps (demo: Sandbox Web mail).', verified: true },
    ],
    tools: [
      { name: 'Email lint', description: 'The same lint the platform runs; up to two rewrites, then a facts-only template.' },
      { name: 'Consent meter', description: 'Logs every send before it happens and stops at your caps.' },
      { name: 'Bounce swap', description: 'A bounced address is replaced by the next-best investor.' },
    ],
    unlocks: ['Sends from your inbox, with a Message-ID per email', 'Stops cleanly at the caps you signed', 'Writes to each investor’s thesis, not a mail merge'],
    runs_on: 'rentabot',
    data_handling: 'Your facts kit goes to Anthropic to write the emails. Sent emails stay as job artifacts; the app password only goes through your locker.',
  },
  'Lead Verifier': {
    models: [],
    connections: [{ ...FETCH, purpose: 'Reads the public page each lead cites, 2 requests a second.' }, DNS, HUNTER_CONNECTION],
    tools: [
      { name: 'Address finder', description: 'Finds the address in mailto, plain text, "[at]" and Cloudflare-protected forms.' },
      { name: 'Lead finder', description: 'Searches your domains on Hunter.io, then keeps only addresses that pass the same page and MX check.' },
    ],
    unlocks: ['Checks every address on the company’s own page and its mail servers', 'Finds leads through a Hunter.io account your own agent does not have, and pays only for verified ones'],
    runs_on: 'rentabot',
    data_handling: 'Leads and domains are checked in memory; verdicts stay as job artifacts. The domains you name go to Hunter.io. No model sees them.',
  },
  'Budget Lead Verifier': {
    models: [],
    connections: [{ ...FETCH, purpose: 'Reads the public page each lead cites, 1 request a second.' }, DNS],
    tools: [{ name: 'Address finder', description: 'Finds the address in mailto, plain text, "[at]" and Cloudflare-protected forms.' }],
    unlocks: ['The same lead check at a lower price, overnight'],
    runs_on: 'rentabot',
    data_handling: 'Leads are checked in memory; verdicts stay as job artifacts. No model sees them.',
  },
  'Agent-Readiness Auditor': {
    models: [{ provider: 'Anthropic', model: SONNET, role: 'Writes the summary and fix wording; findings come from real fetches' }],
    connections: [{ ...FETCH, purpose: 'Reads robots.txt, llms.txt, agent.json, mcp.json, openapi.json and allowed pages.' }],
    tools: [
      { name: 'Well-known scan', description: 'llms.txt, agent.json, agent-card.json, mcp.json, openapi.json.' },
      { name: 'AI crawler rules', description: 'What robots.txt lets five AI crawlers do.' },
      { name: 'Schema check', description: 'schema.org Product and Offer data on your pages.' },
    ],
    unlocks: ['Reads your site the way AI agents do', 'Every claim is re-fetched by the platform'],
    runs_on: 'rentabot',
    data_handling: 'Fetched pages are summarised by Anthropic; the report stays as a job artifact.',
  },
  'Cold Email Writer': {
    models: [{ provider: 'Anthropic', model: SONNET, role: 'Writes and rewrites each email' }],
    connections: [],
    tools: [{ name: 'Email lint', description: 'Subject, length, one ask, no spam words, no placeholders.' }],
    unlocks: ['Emails that pass a strict linter, or you don’t pay'],
    runs_on: 'rentabot',
    data_handling: 'Your facts kit goes to Anthropic to write the emails. Nothing is sent.',
  },
  'Account Setup Bot': {
    models: [],
    connections: [
      { name: 'Sandbox Web services', kind: 'other', owner: 'bot', purpose: 'Signup, email verification and profile pages of five fake SaaS products (demo).', verified: true },
      { name: 'Your contact inbox', kind: 'email', owner: 'buyer', purpose: 'Reads each verification mail, with your app password (demo: Sandbox Web mailbox).', verified: true },
    ],
    tools: [
      { name: 'Account creator', description: 'A unique 24-character password per account; handles taken handles, rate limits and slow mail.' },
      { name: 'Profile filler', description: "Name, logo, bio and link, trimmed to each service's limits." },
      { name: 'Profile check', description: 'Opens each public profile and keeps it only if it is live and names your product.' },
    ],
    unlocks: ['Opens the accounts your product needs and hands you every login', 'Only live, public profiles count'],
    runs_on: 'rentabot',
    data_handling: 'Logins go only to your locker, released once the account is paid. No model sees your data.',
  },
  'Application Filler': {
    models: [{ provider: 'Anthropic', model: SONNET, role: "Writes each answer from your facts within the form's limits" }],
    connections: [
      { name: 'Sandbox Web application forms', kind: 'other', owner: 'bot', purpose: 'A fake accelerator, grants and launch directories with multi-step forms (demo).', verified: true },
      { name: 'Your applicant inbox', kind: 'email', owner: 'buyer', purpose: 'Reads the confirmation mail of each submitted application when you share it (demo: Sandbox Web mailbox).', verified: true },
    ],
    tools: [
      { name: 'Answer writer', description: 'Facts-only answers; numbers not in your kit are dropped; limits are enforced.' },
      { name: 'One-pager PDF', description: 'Builds the file upload from your facts.' },
      { name: 'Approval gate', description: 'Posts a preview of each filled form and submits only what you approve.' },
    ],
    unlocks: ['Fills long multi-step forms in minutes, then waits for your OK', 'Proof is the confirmation ID plus the receipt page'],
    runs_on: 'rentabot',
    data_handling: 'Your facts kit goes to Anthropic to write the answers. Previews and receipts stay as job artifacts.',
  },
  'Agent Red Team': {
    models: [],
    connections: [
      { name: 'Sandbox practice agent', kind: 'security', owner: 'bot', purpose: 'The only target in demo mode: a deliberately weak agent Rent-A-Bot hosts, reached after the ownership gate.', verified: true },
    ],
    tools: [
      { name: 'Ownership gate', description: 'No probe runs until an ownership token bound to the job passes the platform’s check.' },
      { name: 'Probe library', description: 'Five fixed, high-level robustness categories: instructions, disclosure, tool limits, role, scope.' },
      { name: 'Redacted report', description: 'Severity, what the agent did, a reproduction note and a fix; no secrets or raw internals.' },
    ],
    unlocks: ['Authorized adversarial testing a general assistant would refuse without proof of ownership', 'Pays only for findings the target itself confirms'],
    runs_on: 'rentabot',
    data_handling: 'No model sees the target. The ownership token is never echoed; the redacted report stays as a job artifact.',
  },
  'Landing Page Bot': {
    models: [{ provider: 'Anthropic', model: SONNET, role: 'Writes the page copy from your facts (a plain template without it)' }],
    connections: [{ name: 'Sandbox Web page host', kind: 'storage', owner: 'bot', purpose: 'Publishes the page at a public URL (demo).', verified: true }],
    tools: [
      { name: 'Page builder', description: 'One self-contained HTML file: hero, features, call to action. No outside scripts or fonts.' },
      { name: 'Copy check', description: 'Makes sure the page names your product and the copy your contract asks for.' },
    ],
    unlocks: ['A live page at a URL, not just a draft', 'The platform opens the page itself before you pay'],
    runs_on: 'rentabot',
    data_handling: 'Your facts go to Anthropic through the server’s AI to write the copy. The page and its HTML stay as job artifacts.',
  },
  'Deliverability Doctor': {
    models: [{ provider: 'Anthropic', model: SONNET, role: 'Words the plain-English explanation; findings and records come from fixed rules' }],
    connections: [
      { name: 'System DNS resolver', kind: 'data_api', owner: 'bot', purpose: 'MX, SPF, DMARC, DKIM, MTA-STS, TLS-RPT and BIMI lookups.', verified: true },
      { name: 'DNS-over-HTTPS (Cloudflare, Google)', kind: 'data_api', owner: 'bot', purpose: 'A second, independent answer for every record.', verified: true },
    ],
    tools: [
      { name: 'SPF analyzer', description: 'Syntax, the 10-lookup limit (includes followed), the all qualifier, duplicate records.' },
      { name: 'DMARC and DKIM reader', description: 'Policy, reports, the selectors you name plus the common ones, weak keys.' },
      { name: 'Record generator', description: 'The exact TXT records to add or replace, from fixed rules, never from the AI.' },
    ],
    unlocks: ['Two resolvers and a lookup counter your own agent lacks', 'Exact records to paste, not advice', 'The platform re-resolves and recomputes every claim before you pay'],
    runs_on: 'rentabot',
    data_handling: 'Only domain names and public DNS answers are used. The findings (not your data) go to Anthropic to word the explanation; reports stay as job artifacts.',
  },
  'Broken Link Hunter': {
    models: [],
    connections: [
      { ...FETCH, name: 'Polite web crawler (HTTP)', purpose: 'robots.txt first, one host, at most 2 requests a second, announced as RentABotLinkChecker.' },
      { name: 'Web egress Worker (Cloudflare)', kind: 'other', owner: 'bot', purpose: 'Reaches IPv4-only sites from the IPv6-only server.', verified: true },
    ],
    tools: [
      { name: 'Robots reader', description: 'Obeys robots.txt; a robots.txt it cannot read means no crawl.' },
      { name: 'Link extractor', description: 'Anchors, base href, entities; mailto, tel and fragments skipped.' },
      { name: 'Link judge', description: 'HEAD then GET, a second look, and the same definition of broken the platform uses.' },
    ],
    unlocks: ['A real crawl with state, rate limits and robots rules, which a chat agent cannot run', 'Each broken link re-fetched by the platform before you pay'],
    runs_on: 'rentabot',
    data_handling: 'Only public pages are fetched; no model sees anything. The report stays as a job artifact.',
  },
  'Web Data Extractor': {
    models: [{ provider: 'Anthropic', model: SONNET, role: 'Reads fields you name that are not built in; kept only if quoted from the page' }],
    connections: [
      { ...FETCH, name: 'Polite web fetcher (HTTP)', purpose: 'robots.txt per host, at most 2 requests a second, announced as RentABotExtractor.' },
      { name: 'Web egress Worker (Cloudflare)', kind: 'other', owner: 'bot', purpose: 'Reaches IPv4-only sites from the IPv6-only server.', verified: true },
    ],
    tools: [
      { name: 'Rules extractor', description: 'Title, description, h1, emails, phones and prices read by fixed rules, no AI.' },
      { name: 'Quote verifier', description: 'A value is delivered only if its quote is on the page and the value is inside the quote: the same rule the platform re-runs.' },
    ],
    unlocks: ['Rows you can trust to be on the page, not model guesses', 'The platform re-fetches each page and re-finds every quote before you pay'],
    runs_on: 'rentabot',
    data_handling: 'Only public pages are fetched. The page text of pages with fields that are not built in goes to Anthropic through the server’s AI; the JSONL stays as a job artifact.',
  },
}

/** Passports by house-bot name. */
export const HOUSE_PASSPORTS: Record<string, BotPassport> = Object.fromEntries(Object.entries(RAW_PASSPORTS).map(([name, p]) => [name, BotPassport.parse(p)]))
