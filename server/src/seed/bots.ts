// House bots from docs/BOT_CATALOG.md, operated by the "Glob Studio Bots" agent.
// Check ids are coordinated by name with the check library; ids registered later (house-bot
// checks such as lead_verified) simply produce `error` results until they exist.
import { HOUSE_PASSPORTS, houseBrief, withoutHunter, type BotCard, type Skill } from '@rentabot/shared'

export type SeedBot = Omit<BotCard, 'id' | 'operator_agent_id' | 'reputation' | 'created_at'>

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required })
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra })

const skill = (s: Omit<Skill, 'examples' | 'verify_window'> & Partial<Pick<Skill, 'examples' | 'verify_window'>>): Skill => ({ verify_window: 'PT0H', examples: [], ...s })

/** Skills that need the server's Hunter.io key (HUNTER_API_KEY): "bot/skill". */
const NEEDS_HUNTER = new Set(['Lead Verifier/find_leads'])

export const hunterConfigured = (env: Record<string, string | undefined> = process.env) => !!env.HUNTER_API_KEY?.trim()

/**
 * A seed bot as the shelf shows it: briefs and passport filled in from the code, and, while the server has no Hunter.io key, without
 * the skills and the passport connection that need it (a card must not offer a connection the bot does not have; it comes back
 * with the key, the next time the cards are refreshed at boot). Used by the seed, backfillHouseBriefs and the tests.
 */
export function authoredCard(b: SeedBot, env: Record<string, string | undefined> = process.env): SeedBot {
  const withHunter = hunterConfigured(env)
  const passport = b.passport ?? HOUSE_PASSPORTS[b.name]
  return {
    ...b,
    description: withHunter ? b.description : b.description.replace(/ It can also find leads:.*$/, ''),
    skills: b.skills.filter((k) => withHunter || !NEEDS_HUNTER.has(`${b.name}/${k.id}`)).map((k) => ({ ...k, brief: k.brief ?? houseBrief(b.name, k.id) })),
    ...(passport ? { passport: withHunter ? passport : withoutHunter(passport) } : {}),
  }
}

export const HOUSE_BOTS: SeedBot[] = [
  {
    name: 'Directory Blaster',
    tagline: 'Gets your product listed on startup, AI and SaaS directories, and proves every listing.',
    description:
      'Submits your product to AI, SaaS, startup and MCP directories with your approved copy. Where a directory needs an account it creates one (a unique strong password each), verifies it from your inbox, and hands the login to you through the encrypted locker once that listing is paid. Hands back a live URL, a snapshot and a receipt per listing. You pay only for listings the platform verifies itself. Demo mode submits to Sandbox Web directories.',
    capability_class: 'real_world_action',
    skills: [
      skill({
        id: 'directory_submission',
        title: 'Submit a product to directories',
        description: 'One unit = one live listing that mentions your product, with a snapshot. If its directory needed an account, the login is in your locker once the listing is paid. Listings in moderation are re-checked until the verify window ends.',
        needs: obj({
          product_name: str('Product name'),
          url: str('Product URL', { format: 'uri' }),
          tagline_60: str('Tagline, max 60 characters', { maxLength: 60 }),
          description_300: str('Description, max 300 characters', { maxLength: 300 }),
          category: str('Directory category, e.g. Productivity'),
          contact_email: str('Contact email', { format: 'email' }),
          logo_artifact_id: str('Artifact id of a 512px PNG logo'),
        }),
        delivers: obj({ url: str('Live listing URL', { format: 'uri' }), directory: str('Directory name'), screenshot_artifact_id: str('Screenshot artifact id') }, ['url', 'directory']),
        checks: ['url_live', 'page_mentions', 'artifact_attached'],
        pricing: { model: 'per_unit', currency: 'USD', price: '1.50', unit: 'verified_listing', min_units: 20, max_units: 120 },
        turnaround: 'P7D',
        verify_window: 'P14D',
        examples: ['Get ORANO listed on 40 AI and productivity directories before launch.'],
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Free directories only; no fake reviews.' },
    a2a_url: null,
    mode: 'demo',
    status: 'listed',
  },
  {
    name: 'Investor Outreach Bot',
    tagline: 'Fit-scored investor list, personal emails, sent from your own inbox.',
    description:
      'Builds a fit-scored investor list for your stage and sector, writes personal emails that pass a deliverability linter, and sends them from YOUR inbox through its own login (your address and reputation, never ours), reporting every send against the caps you signed and stopping at them. No follow-ups: one email per investor. It checks how many investors fit before it quotes and accepts no more emails than that. Demo mode sends to Sandbox Web persona inboxes.',
    capability_class: 'reach',
    skills: [
      skill({
        id: 'investor_outreach',
        title: 'Investor outreach campaign',
        description: 'One unit = one delivered personal email to an investor whose thesis fits, sent from your own address, with its Message-ID and the sandbox delivery record.',
        needs: obj({ facts_kit: str('Facts about the company (artifact id or text)'), stage: str('Stage, e.g. pre-seed'), raise: str('Amount raising'), sectors: { type: 'array', items: { type: 'string' } } }),
        delivers: obj({ to: str('Recipient email'), firm: str('Firm'), message_id: str('RFC Message-ID of the sent email'), subject: str('Subject') }),
        checks: ['json_schema_valid', 'email_delivered', 'artifact_attached'],
        pricing: { model: 'per_unit', currency: 'USD', price: '2.00', unit: 'sent_email', min_units: 3, max_units: 200 },
        turnaround: 'P5D',
        verify_window: 'P3D',
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Sends only from the buyer\'s own inbox login, within the send caps in the contract; no follow-ups.' },
    a2a_url: null,
    mode: 'demo',
    status: 'listed',
  },
  {
    name: 'Lead Verifier',
    tagline: 'Checks that every lead’s email is really on the company’s own site and accepts mail.',
    description:
      'Takes a JSONL list of leads and verifies each one: the address appears on the source page you cite and the domain has MX records. You pay per lead the platform re-verifies itself. Minimum 60 leads ($6.00): a job settles only once the verified leads reach the $5.00 minimum settlement, so a few failures still settle. It can also find leads: name 1 to 10 company domains and it searches them on its own Hunter.io account (at most 10 leads per domain, $0.35 a lead, minimum 18, $6.30), delivering only addresses it has checked on a source page.',
    capability_class: 'real_world_action',
    skills: [
      skill({
        id: 'verify_leads',
        title: 'Verify a lead list',
        description: 'One unit = one lead with a verdict; only leads the platform re-verifies are paid.',
        needs: obj({
          leads_jsonl: str('JSONL, one lead per line: {to, company, domain, email_source_url, country}'),
        }),
        delivers: obj({ to: str('Email address'), verified: { type: 'boolean' }, why: str('Evidence summary') }),
        checks: ['lead_verified'],
        pricing: { model: 'per_unit', currency: 'USD', price: '0.10', unit: 'verified_lead', min_units: 60, max_units: 500 },
        turnaround: 'PT2H',
      }),
      skill({
        id: 'find_leads',
        title: 'Find verified leads at your target companies',
        description:
          'One unit = one lead found through the bot’s own Hunter.io account at one of your 1 to 10 company domains (at most 10 per domain), with the page it is on. Only leads the platform re-verifies are paid; a lead that does not pass is not delivered. Ask for role addresses (info@, admissions@, press@) in the request or as type "generic": addresses that look personal are left out and counted. Domains named in the request are used when you send none. Pages on your domains come first; a lead found only elsewhere is flagged third_party_source. Listed only while the bot’s Hunter.io key is set.',
        needs: obj(
          {
            domains: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: '1 to 10 company domains, e.g. acme.com' },
            department: str('Optional Hunter department filter, e.g. marketing, sales, finance'),
            seniority: str('Optional: junior, senior, executive'),
            type: str('Optional: "personal" (named people) or "generic" (role addresses only, such as info@, admissions@, press@)'),
          },
          ['domains'],
        ),
        delivers: obj({ to: str('Email address'), company: str('Company'), domain: str('Searched domain'), email_source_url: str('Page the address is on', { format: 'uri' }), verified: { type: 'boolean' }, first_name: str('First name'), last_name: str('Last name'), position: str('Role') }, ['to', 'domain', 'email_source_url']),
        checks: ['lead_verified'],
        pricing: { model: 'per_unit', currency: 'USD', price: '0.35', unit: 'verified_lead', min_units: 18, max_units: 100 },
        turnaround: 'PT2H',
        examples: ['Find 20 marketing leads at acme.com, globex.com and initech.com.'],
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Public business addresses only.' },
    a2a_url: null,
    mode: 'live',
    status: 'listed',
  },
  {
    // Same skill and the same checks as Lead Verifier, so the two compete on open jobs: this one is cheaper per lead and slower
    // because it fetches at half the request rate (1 per second) and works through a queue.
    name: 'Budget Lead Verifier',
    tagline: 'The same lead check at a lower price per lead, delivered the next working day.',
    description:
      'Runs the identical rule as Lead Verifier (the address is on the source page you cite and the domain has MX records) at $0.07 per lead instead of $0.10, in exchange for a slower turnaround: it fetches at one request per second and queues jobs. You pay per lead the platform re-verifies itself. Minimum 90 leads ($6.30): a job settles only once the verified leads reach the $5.00 minimum settlement, so a few failures still settle.',
    capability_class: 'real_world_action',
    skills: [
      skill({
        id: 'verify_leads',
        title: 'Verify a lead list (budget)',
        description: 'One unit = one lead with a verdict; only leads the platform re-verifies are paid. Slower and cheaper than Lead Verifier.',
        needs: obj({
          leads_jsonl: str('JSONL, one lead per line: {to, company, domain, email_source_url, country}'),
        }),
        delivers: obj({ to: str('Email address'), verified: { type: 'boolean' }, why: str('Evidence summary') }),
        checks: ['lead_verified'],
        pricing: { model: 'per_unit', currency: 'USD', price: '0.07', unit: 'verified_lead', min_units: 90, max_units: 500 },
        turnaround: 'PT10H',
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Public business addresses only.' },
    a2a_url: null,
    mode: 'live',
    status: 'listed',
  },
  {
    name: 'Agent-Readiness Auditor',
    tagline: 'Can AI agents use your site? An audit with claims the platform re-checks.',
    description:
      'Audits whether a website is usable by AI agents: llms.txt, /.well-known/agent.json and mcp.json, OpenAPI, schema.org Product/Offer data, robots rules for AI crawlers, and checkout discoverability. Delivers a markdown report plus findings, each a URL claim the platform re-fetches.',
    capability_class: 'code',
    skills: [
      skill({
        id: 'agent_readiness_audit',
        title: 'Agent-readiness audit',
        description: 'A report (markdown artifact) plus findings; each finding is a unit {url, claim, expected_status?, must_contain?} that the platform re-fetches.',
        needs: obj({ site_url: str('Website to audit', { format: 'uri' }) }),
        delivers: obj({ url: str('URL the claim is about', { format: 'uri' }), claim: str('What is true about it'), expected_status: { type: 'integer' }, must_contain: str('Text the page must contain') }, ['url', 'claim']),
        checks: ['report_sections_present', 'http_claim_holds'],
        pricing: { model: 'fixed', currency: 'USD', price: '9.00' },
        turnaround: 'PT1H',
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Reads public pages only.' },
    a2a_url: null,
    mode: 'live',
    status: 'listed',
  },
  {
    name: 'Cold Email Writer',
    tagline: 'Short, personal cold emails that pass a strict linter. Pay per email that passes.',
    description: 'Writes one email per recipient from your facts kit: subject ≤ 60 characters, 50–150 words, exactly one ask, no spam words, no unfilled placeholders, and it mentions the recipient’s company. Minimum 12 emails ($6.00): a job settles only once the passing emails reach the $5.00 minimum settlement, so a couple of misses still settle.',
    capability_class: 'reach',
    skills: [
      skill({
        id: 'write_cold_emails',
        title: 'Write cold emails',
        description: 'One unit = one email {to, subject, body} that passes email_lint.',
        needs: obj({ facts_kit: str('Facts about the sender (artifact id or text)'), recipients: { type: 'array', items: obj({ name: str('Name'), company: str('Company'), angle: str('Why them') }) } }),
        delivers: obj({ to: str('Recipient'), subject: str('Subject line', { maxLength: 60 }), body: str('Email body') }),
        checks: ['email_lint'],
        pricing: { model: 'per_unit', currency: 'USD', price: '0.50', unit: 'email', min_units: 12 },
        turnaround: 'PT1H',
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Writes only; never sends.' },
    a2a_url: null,
    mode: 'live',
    status: 'listed',
  },
  {
    name: 'Account Setup Bot',
    tagline: 'Opens the accounts your product needs and hands you every login.',
    description:
      'Creates accounts for your product on analytics, newsletter, social-profile, status-page and community services: a unique strong password each, the email verified from your inbox, the profile filled in (name, logo, bio, link), and every login handed to you through the encrypted locker once the account is paid. A unit is a working account: the platform opens its public profile and checks that it names your product. Demo mode uses Sandbox Web services.',
    capability_class: 'real_world_action',
    skills: [
      skill({
        id: 'account_setup',
        title: 'Set up product accounts',
        description: 'One unit = one working account: a live public profile that names your product and links to it. Its login arrives in your locker once the unit is paid.',
        needs: obj(
          {
            product_name: str('Product name'),
            url: str('Product URL', { format: 'uri' }),
            tagline_60: str('Tagline, max 60 characters', { maxLength: 60 }),
            description_300: str('Description / bio, max 300 characters', { maxLength: 300 }),
            contact_email: str('Contact email (accounts are created with it; verification mail is read here)', { format: 'email' }),
            logo_url: str('Public URL of the logo image', { format: 'uri' }),
            handle: str('Preferred handle (default: the product name)'),
          },
          ['product_name', 'url', 'tagline_60', 'description_300', 'contact_email', 'logo_url'],
        ),
        delivers: obj({ url: str('Public profile URL', { format: 'uri' }), service: str('Service name'), handle: str('Handle') }, ['url', 'service']),
        checks: ['url_live', 'page_mentions'],
        pricing: { model: 'per_unit', currency: 'USD', price: '1.25', unit: 'working_account', min_units: 4, max_units: 5 },
        turnaround: 'PT2H',
        verify_window: 'PT2H',
        examples: ['Open ORANO accounts on analytics, a newsletter tool, a social profile, a status page and a forum.'],
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Accounts only in the buyer\'s product name and contact email; no fake engagement.' },
    a2a_url: null,
    mode: 'demo',
    status: 'listed',
  },
  {
    name: 'Application Filler',
    tagline: 'Fills long application forms from your facts, then waits for your OK before it submits.',
    description:
      'Fills multi-step application forms (a fake accelerator, grants and launch directories on Sandbox Web) from your facts kit: every answer within the form\'s limits, the file upload built for you. It stops before submitting, posts a preview of each filled form in the Job Room and submits only the ones you approve. The proof is the confirmation ID plus the receipt page, which the platform checks exists.',
    capability_class: 'real_world_action',
    skills: [
      skill({
        id: 'application_filling',
        title: 'Fill and submit applications',
        description: 'One unit = one submitted application with its confirmation ID and receipt page. The bot fills each form from your facts, posts a preview, and submits only what you approve.',
        needs: obj(
          {
            facts_kit: str('Facts about the company (text; every answer is written from these facts only)'),
            applicant_name: str('Applicant name'),
            applicant_email: str('Applicant email (confirmations arrive here)', { format: 'email' }),
            applicant_role: str('Applicant role, e.g. Founder'),
            programs: str('Optional: comma-separated programme ids'),
            amount_usd: { type: 'integer', description: 'Optional: amount to request on grant forms, USD' },
          },
          ['facts_kit', 'applicant_name', 'applicant_email'],
        ),
        delivers: obj({ url: str('Receipt page URL', { format: 'uri' }), program: str('Programme id'), confirmation_id: str('Confirmation ID') }, ['url', 'program', 'confirmation_id']),
        checks: ['application_confirmed', 'url_live', 'page_mentions'],
        pricing: { model: 'per_unit', currency: 'USD', price: '4.00', unit: 'submitted_application', min_units: 2, max_units: 6 },
        turnaround: 'P1D',
        verify_window: 'P2D',
        examples: ['Apply ORANO to an accelerator, a grant and a launch directory; I approve each form first.'],
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Never submits before the buyer approves; facts-only answers.' },
    a2a_url: null,
    mode: 'demo',
    status: 'listed',
  },
  {
    name: 'Agent Red Team',
    tagline: 'Authorized robustness testing of your own AI agent, with proof of ownership. Paid per verified finding.',
    description:
      'Tests your own AI agent for weaknesses before a real attacker finds them: whether it can be steered off its instructions, whether it reveals what it should not, whether it respects its tool limits, and whether it keeps its role and scope. It runs only after you prove you own the target (an ownership token bound to the job, checked by the platform before funding), and it hands back a redacted findings report with a severity, what the agent did, a reproduction note and a suggested fix per finding. You pay only for findings the target itself confirms it reproduced. Demo mode tests only the deliberately weak practice agent that Rent-A-Bot hosts in Sandbox Web; it cannot be pointed at anything else.',
    capability_class: 'security',
    skills: [
      skill({
        id: 'agent_red_team',
        title: 'Red-team your own AI agent',
        description: 'One unit = one verified finding {category, severity, what the agent did, suggested fix}, confirmed by the target’s own log. Runs only after the ownership gate passes.',
        needs: obj({
          target_endpoint: str('The agent to test. Demo mode: the Sandbox practice agent, <platform>/sandbox/redteam/agent', { format: 'uri' }),
          ownership_token: str('Ownership token from POST /sandbox/redteam/claim (proves you control the target)'),
          scope_proof_url: str('Scope-proof URL from POST /sandbox/redteam/scope; it lists this job id', { format: 'uri' }),
        }),
        delivers: obj({ finding_id: str('Finding id the target logged'), category: str('Probe category'), severity: str('low|medium|high|critical'), behavior: str('What the agent did'), suggested_fix: str('Suggested fix') }, ['finding_id', 'category', 'severity']),
        checks: ['finding_reproduced', 'report_sections_present'],
        pricing: { model: 'per_unit', currency: 'USD', price: '2.50', unit: 'verified_finding', min_units: 2, max_units: 5 },
        turnaround: 'PT1H',
        examples: ['Red-team the Sandbox practice agent: up to 5 verified findings, paid per finding the target confirms.'],
      }),
    ],
    policy: { class: 'restricted', requires_scope_proof: true, notes: 'Authorized testing of the buyer’s own agent only, after proof of ownership. Demo mode: only the Sandbox practice agent.' },
    a2a_url: null,
    mode: 'demo',
    status: 'listed',
  },
  {
    name: 'Landing Page Bot',
    tagline: 'A one-page site for your product, written, built and live at a URL in minutes.',
    description:
      'Takes your product facts and builds a one-page site (hero, features, call to action) as a single self-contained HTML file, then publishes it and hands back the live URL. The copy is written by the server’s AI from your facts only (a plain template when the AI is off). The platform opens the page itself and checks it names your product and your key copy before you pay. Demo mode hosts the page on Sandbox Web.',
    capability_class: 'code',
    skills: [
      skill({
        id: 'landing_page',
        title: 'Build and publish a landing page',
        description: 'One unit = one published page that is live and names your product and its key copy. The HTML file is attached as an artifact.',
        needs: obj(
          {
            product_name: str('Product name'),
            url: str('Product URL (the call to action links here)', { format: 'uri' }),
            one_liner: str('One-line description (the hero line)', { maxLength: 140 }),
            features: str('Three to six features, one per line'),
            cta_label: str('Call-to-action button text, e.g. "Try it free"'),
            audience: str('Who it is for'),
          },
          ['product_name', 'url', 'one_liner', 'features'],
        ),
        delivers: obj({ url: str('Live page URL', { format: 'uri' }), title: str('Page title') }, ['url']),
        checks: ['url_live', 'page_mentions'],
        pricing: { model: 'fixed', currency: 'USD', price: '6.00' },
        turnaround: 'PT1H',
        examples: ['A launch page for ORANO with three features and a "Try it free" button.'],
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Writes only from the facts you give; no invented claims or testimonials.' },
    a2a_url: null,
    mode: 'demo',
    status: 'listed',
  },
  {
    name: 'Deliverability Doctor',
    tagline: 'Why your mail lands in spam: a live DNS audit with the exact records to fix it.',
    description:
      'Audits the email authentication of each domain you list from live DNS, asked through two resolvers (the system resolver and DNS-over-HTTPS): MX, SPF (syntax, the 10-lookup limit, the all qualifier), DMARC (policy, reports), DKIM (the selectors you name plus the common ones), MTA-STS, TLS-RPT and BIMI. Delivers the findings and the exact DNS records to add or replace, produced by fixed rules (the AI only words the plain-English explanation). You pay per domain whose every claim the platform re-resolves itself and finds true. Minimum 6 domains ($7.50): a job settles only once the verified domains reach the $5.00 minimum settlement, so a failure still settles.',
    capability_class: 'real_world_action',
    skills: [
      skill({
        id: 'deliverability_audit',
        title: 'Audit email deliverability',
        description: 'One unit = one domain audited: MX, SPF, DMARC, DKIM, MTA-STS, TLS-RPT and BIMI facts, the findings, and the DNS records to add or replace. The platform re-resolves the domain and recomputes the findings and records before paying.',
        needs: obj(
          {
            domains: str('The domains to audit, one per line or comma-separated (plain names, e.g. oranoai.com)'),
            dkim_selectors: str('Optional: DKIM selectors your mail is signed with, comma-separated. The common ones are always tried.'),
          },
          ['domains'],
        ),
        delivers: obj({ domain: str('Domain audited'), facts: { type: 'object' }, findings: { type: 'array' }, fixes: { type: 'array' } }, ['domain', 'facts', 'findings', 'fixes']),
        checks: ['dns_claims_hold', 'artifact_attached'],
        pricing: { model: 'per_unit', currency: 'USD', price: '1.25', unit: 'audited_domain', min_units: 6, max_units: 50 },
        turnaround: 'PT1H',
        verify_window: 'PT1H',
        examples: ['Audit the mail setup of my six domains and give me the DNS records to fix SPF, DMARC and DKIM.'],
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Reads public DNS only; never changes anything.' },
    a2a_url: null,
    mode: 'live',
    status: 'listed',
  },
  {
    name: 'Broken Link Hunter',
    tagline: 'Finds every broken link on your site, with source page, anchor text and status, each re-checked by the platform.',
    description:
      'A polite crawl of one site: it reads robots.txt first and obeys it, stays on your host, stops at your page cap, sends at most 2 requests a second and announces itself. Every link target is checked with a HEAD, then a GET, and anything that looks broken gets a second look before it is reported. You get each broken link with its source page, anchor text and HTTP status or error. The platform re-fetches the source page, confirms the link is on it, then re-fetches the link and confirms it is still broken before you pay. Hire it with two deliverables: the broken links ($0.25 each) and the crawl report ($5.00 flat, so a clean site still settles). With only the links, a job settles once 20 are verified. No headless browser: links that only exist after JavaScript runs are not seen.',
    capability_class: 'real_world_action',
    skills: [
      skill({
        id: 'broken_link_audit',
        title: 'Hunt broken links on a site',
        description:
          'D1: one unit = one broken link {source_page, link_url, anchor_text, status}, paid per link the platform re-confirms ($0.25; at least 20 to settle on its own). D2 (optional, quantity 1): the crawl report, $5.00 flat, so a site with few broken links still settles. Checks: broken_link_confirmed (D1), report_sections_present (Summary, Findings).',
        needs: obj(
          {
            site_url: str('The site to crawl: one public http(s) URL. The crawl starts here and stays on this host.', { format: 'uri' }),
            max_pages: { type: 'integer', minimum: 5, maximum: 100, description: 'Optional: the most pages to crawl (default 40, at most 100).' },
            check_external: { type: 'boolean', description: 'Optional: also check links to other sites (default true); they are checked, never crawled.' },
          },
          ['site_url'],
        ),
        delivers: obj({ source_page: str('The page the link is on', { format: 'uri' }), link_url: str('The broken link', { format: 'uri' }), anchor_text: str('The link text'), status: { type: 'integer' } }, ['source_page', 'link_url']),
        checks: ['broken_link_confirmed', 'report_sections_present'],
        pricing: {
          model: 'per_unit',
          currency: 'USD',
          price: '0.25',
          unit: 'verified_broken_link',
          min_units: 24,
          max_units: 200,
          extras: [
            {
              id: 'crawl_report',
              title: 'Crawl report',
              price: '5.00',
              description: 'One report of the crawl with Summary and Findings sections. Flat price, so a site with few broken links still settles.',
              checks: ['report_sections_present'],
              recommended: true,
            },
          ],
        },
        turnaround: 'PT1H',
        verify_window: 'PT1H',
        examples: ['Crawl oranoai.com and list every broken link with its source page: D1 the broken links, D2 the crawl report.'],
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Public pages only; obeys robots.txt; at most 2 requests a second; no logins.' },
    a2a_url: null,
    mode: 'live',
    status: 'listed',
  },
  {
    name: 'Web Data Extractor',
    tagline: 'Pages in, structured rows out: every value comes with a quote the platform finds on the page.',
    description:
      'Give it the pages and the fields you want (title, description, h1, emails, phones, prices, or any field you name). It reads each public page politely (robots.txt obeyed, at most 2 requests a second), extracts the fields and delivers one JSONL row per page where every value carries a quote copied from the page. The built-in fields are read by fixed rules; other fields by an AI model, and a value the AI cannot back with a quote on the page is dropped. You pay per page whose row the platform re-checks itself: it fetches the page, finds each quote on it, finds the value inside the quote and checks the shape of the built-in fields. A page counts when at least half of your fields are filled. Minimum 30 pages ($6.00): a job settles only once the verified pages reach the $5.00 minimum settlement, so a few failures still settle. No headless browser: content that only exists after JavaScript runs is not seen.',
    capability_class: 'real_world_action',
    skills: [
      skill({
        id: 'web_extraction',
        title: 'Extract fields from web pages',
        description:
          'One unit = one page: a row {url, data, quotes} with a source quote for every non-null value. The platform fetches the page and checks the quote is on it, the value is in the quote, the built-in fields have the right shape and at least half of the requested fields are filled.',
        needs: obj(
          {
            urls: str('The pages to read, one public http(s) URL per line (at most 300). Give at least as many as the quantity you hire.'),
            fields: str('One field per line as "name" or "name: what it means" (at most 12). Built in: title, description, h1, emails, phones, prices. Others are read by AI.'),
          },
          ['urls', 'fields'],
        ),
        delivers: obj({ url: str('The page', { format: 'uri' }), data: { type: 'object' }, quotes: { type: 'object' } }, ['url', 'data', 'quotes']),
        checks: ['page_extraction_verified', 'artifact_attached'],
        pricing: { model: 'per_unit', currency: 'USD', price: '0.20', unit: 'extracted_page', min_units: 30, max_units: 300 },
        turnaround: 'PT1H',
        verify_window: 'PT1H',
        examples: ['Read the 30 product pages in my list: give me title, price and the contact email of each.'],
      }),
    ],
    policy: { class: 'standard', requires_scope_proof: false, notes: 'Public pages only; obeys robots.txt; at most 2 requests a second; no logins; no personal data of private individuals.' },
    a2a_url: null,
    mode: 'live',
    status: 'listed',
  },
]
