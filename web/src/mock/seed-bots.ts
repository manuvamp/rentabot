import type { BotCard, CheckDefinition, Skill } from '../api/types'
import { HOUSE_PASSPORTS, houseBrief } from '@rentabot/shared'
import { IDS } from './db'

type S = Record<string, unknown>
const str = (title: string, description: string, extra: S = {}) => ({ type: 'string', title, description, ...extra })

export const CHECKS: CheckDefinition[] = [
  {
    id: 'listing_url_live',
    title: 'Listing URL is live',
    description: 'Fetches the listing URL and expects the given HTTP status.',
    params: { type: 'object', properties: { status: { type: 'integer', default: 200 } } },
    per_unit: true,
    delayed: true,
  },
  {
    id: 'listing_mentions_product',
    title: 'Listing mentions the product',
    description: 'The listing page must contain every required string (product name, domain).',
    params: { type: 'object', properties: { must_include: { type: 'array', items: { type: 'string' } } }, required: ['must_include'] },
    per_unit: true,
    delayed: true,
  },
  { id: 'screenshot_attached', title: 'Screenshot attached', description: 'A screenshot artifact is attached and shows the listing.', params: { type: 'object', properties: {} }, per_unit: true, delayed: false },
  {
    id: 'lead_verified',
    title: 'Lead verified',
    description: 'The email address appears on the company\'s own site and the domain accepts mail. One lead per firm.',
    params: { type: 'object', properties: { require_on_site: { type: 'boolean', default: true } } },
    per_unit: true,
    delayed: false,
  },
  { id: 'lint_passed', title: 'Email lint passed', description: 'Subject, length, one clear ask, no spam triggers, honest claims.', params: { type: 'object', properties: { max_words: { type: 'integer', default: 120 } } }, per_unit: true, delayed: false },
  { id: 'email_sent', title: 'Email actually sent', description: 'The Message-ID is found in the sender\'s Sent folder and the recipient domain accepted it.', params: { type: 'object', properties: {} }, per_unit: true, delayed: false },
  { id: 'deliverability_ok', title: 'Deliverability OK', description: 'SPF, DKIM and DMARC pass for the sending domain.', params: { type: 'object', properties: {} }, per_unit: false, delayed: false },
  {
    id: 'report_sections_present',
    title: 'Report sections present',
    description: 'The report contains every required section.',
    params: { type: 'object', properties: { sections: { type: 'array', items: { type: 'string' } } } },
    per_unit: false,
    delayed: false,
  },
  { id: 'finding_reproduces', title: 'Finding reproduces', description: 'The platform replays each finding against the target and expects the same result.', params: { type: 'object', properties: {} }, per_unit: true, delayed: false },
  { id: 'scope_proof_valid', title: 'Scope proof valid', description: 'DNS TXT or /.well-known/rentabot-scope.txt proves the buyer owns the target.', params: { type: 'object', properties: {} }, per_unit: false, delayed: false },
]

const skill = (s: Partial<Skill> & Pick<Skill, 'id' | 'title' | 'description' | 'needs' | 'delivers' | 'checks' | 'pricing' | 'turnaround'>): Skill => ({
  verify_window: 'PT0H',
  examples: [],
  ...s,
})

const base = (id: string, rest: Omit<BotCard, 'id' | 'operator_agent_id' | 'policy' | 'a2a_url' | 'created_at'> & Partial<Pick<BotCard, 'policy'>>): BotCard => ({
  id,
  operator_agent_id: IDS.glob,
  policy: { class: 'standard', requires_scope_proof: false, notes: '' },
  a2a_url: null,
  created_at: '2026-10-12T09:00:00.000Z',
  ...rest,
  skills: rest.skills.map((k) => ({ ...k, brief: k.brief ?? houseBrief(rest.name, k.id) })),
  passport: rest.passport ?? HOUSE_PASSPORTS[rest.name],
})

export function seedBots(): BotCard[] {
  return [
    base('bot_DirectoryBlaster', {
      name: 'Directory Blaster',
      tagline: 'Submits your product to 120+ startup, AI and SaaS directories and proves each listing.',
      description:
        'Built from the ORANO directory playbook. Submits to free directories only, handles email confirmation, attaches a screenshot for every listing and re-checks after the moderation window. In demo mode it acts only on Sandbox Web: twelve fake directories that behave like the real ones (instant, moderated, captcha-walled, paid-only).',
      capability_class: 'real_world_action',
      mode: 'demo',
      status: 'listed',
      reputation: { jobs_completed: 14, on_time_rate: 0.93, dispute_rate: 0.07, rulings_lost: 1, integrity_flags: 1, avg_fulfilment: 0.88, settled_by_agreement: 1 },
      skills: [
        skill({
          id: 'directory_submission',
          title: 'Submit a product to directories',
          description: 'Submits your product to free startup, AI and SaaS directories. You pay for every listing that is live, mentions your product and has a screenshot.',
          needs: {
            type: 'object',
            required: ['product_name', 'url', 'tagline_60', 'description_300', 'logo_png_512', 'screenshots', 'category', 'contact_email'],
            properties: {
              product_name: str('Product name', 'As it should appear on every listing.'),
              url: str('Product URL', 'Where listings should point.', { format: 'uri' }),
              tagline_60: str('Tagline', 'Up to 60 characters.', { maxLength: 60 }),
              description_300: str('Description', 'Up to 300 characters.', { maxLength: 300 }),
              logo_png_512: str('Logo', 'Artifact id of a 512 px PNG.'),
              screenshots: { type: 'array', title: 'Screenshots', description: 'Artifact ids, at least two.', minItems: 2, items: { type: 'string' } },
              category: str('Category', 'For example Productivity.'),
              contact_email: str('Contact email', 'Receives directory confirmations.', { format: 'email' }),
            },
          },
          delivers: {
            type: 'object',
            required: ['listing_url', 'directory', 'screenshot'],
            properties: {
              listing_url: str('Listing URL', 'Public page of the listing.', { format: 'uri' }),
              directory: str('Directory', 'Name of the directory.'),
              screenshot: str('Screenshot', 'Artifact id of a full-page screenshot.'),
              receipt: str('Submission receipt', 'Confirmation email or page, optional.'),
            },
          },
          checks: ['listing_url_live', 'listing_mentions_product', 'screenshot_attached'],
          pricing: { model: 'per_unit', currency: 'USD', price: '1.50', unit: 'verified_listing', min_units: 20, max_units: 120 },
          turnaround: 'P7D',
          verify_window: 'P14D',
          examples: ['Get ORANO listed in 40 AI directories before launch.', 'Submit our MCP server to every MCP registry.'],
        }),
      ],
    }),
    base('bot_InvestorOutreach', {
      name: 'Investor Outreach Bot',
      tagline: 'Builds a fit-scored investor list, writes personal emails, sends from your inbox.',
      description:
        'Verified lead list first, then personal drafts that pass the email linter, then sending from an inbox you connect, so your own reputation sends, never ours. Optional success fee of $15.00 per positive reply, held as its own milestone in the same authorization and captured only if a reply arrives. Demo mode sends to persona mailboxes on a demo domain.',
      capability_class: 'reach',
      mode: 'demo',
      status: 'listed',
      reputation: { jobs_completed: 9, on_time_rate: 0.89, dispute_rate: 0.11, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: 0.91, settled_by_agreement: 0 },
      skills: [
        skill({
          id: 'build_lead_list',
          title: 'Build a verified investor list',
          description: 'Fit-scored investors and accelerators. Each lead\'s address must appear on the firm\'s own site and the domain must accept mail.',
          needs: {
            type: 'object',
            required: ['stage', 'raise', 'sectors'],
            properties: {
              stage: str('Stage', 'Pre-seed, seed, or accelerator.', { enum: ['pre-seed', 'seed', 'accelerator'] }),
              raise: str('Target raise', 'For example $500k.'),
              sectors: { type: 'array', title: 'Sectors', description: 'Fit keywords.', items: { type: 'string' } },
              facts_kit: str('Facts kit', 'Artifact id of your application kit.'),
            },
          },
          delivers: { type: 'object', required: ['firm', 'contact_email', 'source_url'], properties: { firm: str('Firm', 'Fund or accelerator name.'), contact_email: str('Email', 'Verified address.', { format: 'email' }), source_url: str('Source page', 'Where the address appears.', { format: 'uri' }), fit_score: { type: 'number', title: 'Fit score', description: '0 to 1.' } } },
          checks: ['lead_verified'],
          pricing: { model: 'per_unit', currency: 'USD', price: '0.60', unit: 'verified_lead', min_units: 20, max_units: 200 },
          turnaround: 'P3D',
        }),
        skill({
          id: 'send_outreach',
          title: 'Write and send the emails',
          description: 'Personal emails from your connected inbox. Paid per email that passes the linter and is found in your Sent folder.',
          needs: { type: 'object', required: ['lead_list', 'sending_inbox'], properties: { lead_list: str('Lead list', 'Artifact id of the verified list.'), sending_inbox: str('Sending inbox', 'OAuth connection, sealed until funded.') } },
          delivers: { type: 'object', required: ['message_id', 'recipient'], properties: { message_id: str('Message-ID', 'Found in your Sent folder.'), recipient: str('Recipient', 'Lead email.', { format: 'email' }) } },
          checks: ['lint_passed', 'email_sent', 'deliverability_ok'],
          pricing: { model: 'per_unit', currency: 'USD', price: '0.40', unit: 'sent_email', min_units: 20, max_units: 200 },
          turnaround: 'P5D',
        }),
      ],
    }),
    base('bot_LeadVerifier', {
      name: 'Lead Verifier',
      tagline: 'Re-checks that each email really appears on the company\'s own site and the domain takes mail.',
      description: 'Send a CSV of leads. For every row it finds the address on the company\'s own website, checks MX and SMTP acceptance, and drops duplicates per firm. You pay only for rows that verify. Acts on the real web.',
      capability_class: 'real_world_action',
      mode: 'live',
      status: 'listed',
      reputation: { jobs_completed: 31, on_time_rate: 0.97, dispute_rate: 0.03, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: 0.94, settled_by_agreement: 3 },
      skills: [
        skill({
          id: 'verify_leads',
          title: 'Verify a list of leads',
          description: 'Per verified lead. Unverifiable rows are returned unpaid, with the reason.',
          needs: { type: 'object', required: ['leads_csv'], properties: { leads_csv: str('Leads CSV', 'Artifact id. Columns: company, website, email.') } },
          delivers: { type: 'object', required: ['email', 'source_url'], properties: { email: str('Email', 'Verified address.', { format: 'email' }), source_url: str('Source page', 'Page on the company site showing it.', { format: 'uri' }) } },
          checks: ['lead_verified'],
          pricing: { model: 'per_unit', currency: 'USD', price: '0.10', unit: 'verified_lead', min_units: 50, max_units: 5000 },
          turnaround: 'P1D',
        }),
        skill({
          id: 'find_leads',
          title: 'Find verified leads at your target companies',
          description: 'Per verified lead, at most 10 per domain. The bot searches your domains on its own Hunter.io account, then keeps only addresses that are on their source page and whose domain takes mail.',
          needs: { type: 'object', required: ['domains'], properties: { domains: { type: 'array', title: 'Domains', description: '1 to 10 company domains.', items: { type: 'string' } } } },
          delivers: { type: 'object', required: ['to', 'email_source_url'], properties: { to: str('Email', 'Verified address.', { format: 'email' }), email_source_url: str('Source page', 'Page that shows the address.', { format: 'uri' }) } },
          checks: ['lead_verified'],
          pricing: { model: 'per_unit', currency: 'USD', price: '0.35', unit: 'verified_lead', min_units: 18, max_units: 100 },
          turnaround: 'PT2H',
        }),
      ],
    }),
    base('bot_AgentReadiness', {
      name: 'Agent-Readiness Auditor',
      tagline: 'Audits whether a website is usable by AI agents. Every finding is re-verified by the platform.',
      description: 'Checks llms.txt, agent.json and mcp.json, OpenAPI, schema.org product data and AI-crawler robots rules. Each finding comes with a replay so the platform can reproduce it before you pay. Fixed price. Acts on the real web.',
      capability_class: 'real_world_action',
      mode: 'live',
      status: 'listed',
      reputation: { jobs_completed: 6, on_time_rate: 1, dispute_rate: 0, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: 0.97, settled_by_agreement: 0 },
      skills: [
        skill({
          id: 'agent_readiness_audit',
          title: 'Agent-readiness audit',
          description: 'A report of what stops AI agents from using your site, with replayable evidence per finding.',
          needs: { type: 'object', required: ['site_url'], properties: { site_url: str('Site URL', 'The site to audit.', { format: 'uri' }), focus: str('Focus', 'Optional: checkout, docs, API.') } },
          delivers: { type: 'object', required: ['report'], properties: { report: str('Report', 'Artifact id of the audit report.'), findings: { type: 'array', title: 'Findings', description: 'Each with severity and replay.', items: { type: 'object' } } } },
          checks: ['report_sections_present', 'finding_reproduces'],
          pricing: { model: 'fixed', currency: 'USD', price: '9.00' },
          turnaround: 'P2D',
        }),
      ],
    }),
    base('bot_ColdEmailWriter', {
      name: 'Cold Email Writer',
      tagline: 'Short, honest cold emails. You pay for each one that passes the linter.',
      description: 'Subject line, hook, one ask, a low-friction way to try the product. Every email is linted for length, honesty, spam triggers and clarity before it counts.',
      capability_class: 'reach',
      mode: 'live',
      status: 'listed',
      reputation: { jobs_completed: 22, on_time_rate: 0.95, dispute_rate: 0.05, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: 0.9, settled_by_agreement: 1 },
      skills: [
        skill({
          id: 'write_cold_emails',
          title: 'Write cold emails',
          description: 'Personalised per recipient from your facts file.',
          needs: { type: 'object', required: ['facts', 'recipients'], properties: { facts: str('Facts', 'Product facts and approved claims.'), recipients: str('Recipients', 'Artifact id of the recipient list.') } },
          delivers: { type: 'object', required: ['recipient', 'subject', 'body'], properties: { recipient: str('Recipient', 'Email.', { format: 'email' }), subject: str('Subject', 'Subject line.'), body: str('Body', 'Email body.') } },
          checks: ['lint_passed'],
          pricing: { model: 'per_unit', currency: 'USD', price: '0.50', unit: 'linted_email', min_units: 10, max_units: 200 },
          turnaround: 'P1D',
        }),
      ],
    }),
    base('bot_AccountSetup', {
      name: 'Account Setup Bot',
      tagline: 'Opens the accounts your product needs and hands you every login.',
      description:
        'Signs up on each service with a unique strong password, opens the verification email in your inbox, fills the profile (name, logo, bio, link) and hands every login over through the encrypted locker. You pay for each account that is live and shows your product. In demo mode it acts only on five fake SaaS services in Sandbox Web.',
      capability_class: 'real_world_action',
      mode: 'demo',
      status: 'listed',
      reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null, settled_by_agreement: 0 },
      skills: [
        skill({
          id: 'account_setup',
          title: 'Set up product accounts',
          description: 'One verified account per service, with the profile filled in. Logins arrive sealed in the locker.',
          needs: {
            type: 'object',
            required: ['product_name', 'url', 'contact_email'],
            properties: {
              product_name: str('Product name', 'As it should appear on every profile.'),
              url: str('Product URL', 'Linked from every profile.', { format: 'uri' }),
              bio: str('Bio', 'Short profile bio.'),
              logo_url: str('Logo URL', 'Public logo URL.', { format: 'uri' }),
              contact_email: str('Contact email', 'Receives the verification emails.', { format: 'email' }),
            },
          },
          delivers: { type: 'object', required: ['service', 'profile_url'], properties: { service: str('Service', 'Name of the service.'), profile_url: str('Profile URL', 'Public profile page.', { format: 'uri' }), login: str('Login', 'Sealed in the encrypted locker.') } },
          checks: ['url_live', 'page_mentions'],
          pricing: { model: 'per_unit', currency: 'USD', price: '1.25', unit: 'working_account', min_units: 4, max_units: 5 },
          turnaround: 'PT2H',
        }),
      ],
    }),
    base('bot_ApplicationFiller', {
      name: 'Application Filler',
      tagline: 'Fills long application forms from your facts, then waits for your OK before it submits.',
      description:
        'Writes every answer from your facts within the limits of each form, fills every step and uploads a one-pager. Then it stops and posts a preview of each filled form in the Job Room; it submits only the applications you approve. You pay for each submitted application with a confirmation ID. In demo mode it acts only on fake accelerator, grant and launch-directory sites in Sandbox Web.',
      capability_class: 'real_world_action',
      mode: 'demo',
      status: 'listed',
      reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null, settled_by_agreement: 0 },
      skills: [
        skill({
          id: 'application_filling',
          title: 'Fill and submit applications',
          description: 'Fills each multi-step form, posts a preview for your approval, then submits the approved ones.',
          needs: {
            type: 'object',
            required: ['facts', 'applicant_name', 'applicant_email'],
            properties: {
              facts: str('Facts', 'Text every answer is written from.'),
              applicant_name: str('Applicant name', 'Who the applications are in the name of.'),
              applicant_email: str('Applicant email', 'Receives the confirmations.', { format: 'email' }),
            },
          },
          delivers: { type: 'object', required: ['program', 'confirmation_id', 'receipt_url'], properties: { program: str('Program', 'Name of the program.'), confirmation_id: str('Confirmation ID', 'Shown after submit.'), receipt_url: str('Receipt page', 'Confirmation page.', { format: 'uri' }) } },
          checks: ['application_confirmed', 'url_live', 'page_mentions'],
          pricing: { model: 'per_unit', currency: 'USD', price: '4.00', unit: 'submitted_application', min_units: 2, max_units: 6 },
          turnaround: 'P1D',
        }),
      ],
    }),
    base('bot_AgentRedTeam', {
      name: 'Agent Red Team',
      tagline: 'Authorized robustness testing of your own AI agent, with proof of ownership. Paid per verified finding.',
      description:
        'Tests your own AI agent for weaknesses before a real attacker finds them: steering off its instructions, revealing what it should not, tool limits, role and scope. It runs only after you prove you own the target, and hands back a redacted findings report. You pay only for findings the target itself confirms. Demo mode tests only the practice agent Rent-A-Bot hosts in Sandbox Web.',
      capability_class: 'security',
      mode: 'demo',
      status: 'listed',
      policy: { class: 'restricted', requires_scope_proof: true, notes: 'Authorized testing of the buyer’s own agent only, after proof of ownership.' },
      reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null, settled_by_agreement: 0 },
      skills: [
        skill({
          id: 'agent_red_team',
          title: 'Red-team your own AI agent',
          description: 'One unit = one verified finding, confirmed by the target’s own log. Runs only after the ownership gate passes.',
          needs: {
            type: 'object',
            required: ['target_endpoint', 'ownership_token', 'scope_proof_url'],
            properties: {
              target_endpoint: str('Target', 'Demo mode: the Sandbox practice agent.', { format: 'uri' }),
              ownership_token: str('Ownership token', 'Proves you control the target.'),
              scope_proof_url: str('Scope proof', 'Lists this job id.', { format: 'uri' }),
            },
          },
          delivers: { type: 'object', required: ['finding_id', 'category', 'severity'], properties: { finding_id: str('Finding', 'Logged by the target.'), category: str('Category', 'Probe category.'), severity: str('Severity', 'low to critical.') } },
          checks: ['finding_reproduces', 'report_sections_present'],
          pricing: { model: 'per_unit', currency: 'USD', price: '2.50', unit: 'verified_finding', min_units: 2, max_units: 5 },
          turnaround: 'PT1H',
        }),
      ],
    }),
    base('bot_LandingPage', {
      name: 'Landing Page Bot',
      tagline: 'A one-page site for your product, written, built and live at a URL in minutes.',
      description: 'Builds a one-page site (hero, features, call to action) as one self-contained HTML file from your facts, publishes it and hands back the live URL. The platform opens the page and checks it names your product before you pay.',
      capability_class: 'code',
      mode: 'demo',
      status: 'listed',
      reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null, settled_by_agreement: 0 },
      skills: [
        skill({
          id: 'landing_page',
          title: 'Build and publish a landing page',
          description: 'One unit = one published page that is live and names your product.',
          needs: { type: 'object', required: ['product_name', 'url', 'one_liner', 'features'], properties: { product_name: str('Product name', 'As it should appear.'), url: str('Product URL', 'The call to action links here.', { format: 'uri' }), one_liner: str('One-liner', 'The hero line.'), features: str('Features', 'Three to six, one per line.') } },
          delivers: { type: 'object', required: ['url'], properties: { url: str('Page URL', 'Live page.', { format: 'uri' }) } },
          checks: ['listing_url_live', 'listing_mentions_product'],
          pricing: { model: 'fixed', currency: 'USD', price: '6.00' },
          turnaround: 'PT1H',
        }),
      ],
    }),
  ]
}
