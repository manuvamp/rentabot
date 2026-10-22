// 25 fake investors on demo-vc.sandbox. The reply style is hidden from the public listing.
//
// Personalisation rule (the whole "positive reply" logic): a persona whose style is `positive` answers
// positively only if the email (subject + body) contains at least one of its `keywords`, matched
// case-insensitively on word boundaries. Keywords are words that appear in the persona's public
// thesis, so an email that actually engages with the thesis matches. Any other email gets a polite
// decline from that persona.

export const MAIL_DOMAIN = 'demo-vc.sandbox'

export type ReplyStyle = 'positive' | 'polite_decline' | 'no_reply' | 'bounce'

export interface Persona {
  id: string
  name: string
  firm: string
  address: string
  thesis: string
  keywords: string[]
  check_size: string
  stage: string
  style: ReplyStyle
}

type Row = [name: string, firm: string, thesis: string, keywords: string[], check: string, stage: string, style: ReplyStyle]

const ROWS: Row[] = [
  ['Maya Okafor', 'Northwind Ventures', 'Developer tools and infrastructure for AI agents, with early open-source traction.', ['developer tools', 'agents', 'open-source', 'infrastructure'], '$500K-$1.5M', 'Seed', 'positive'],
  ['Daniel Reyes', 'Lattice Harbor Capital', 'Vertical SaaS for regulated industries such as healthcare, insurance and legal operations.', ['vertical saas', 'healthcare', 'insurance', 'legal', 'regulated'], '$1M-$3M', 'Seed to Series A', 'polite_decline'],
  ['Priya Raman', 'Kiln Seed Fund', 'Marketplaces and two-sided platforms where trust and payments are the product.', ['marketplace', 'marketplaces', 'two-sided', 'payments', 'trust'], '$250K-$1M', 'Pre-seed to Seed', 'positive'],
  ['Tomas Berg', 'Fjordline Partners', 'Climate hardware, grid software and energy storage.', ['climate', 'energy', 'grid', 'storage'], '$2M-$5M', 'Series A', 'no_reply'],
  ['Aisha Khan', 'Ledgerlight VC', 'Fintech infrastructure: payments, escrow, ledgers and compliance tooling for software builders.', ['fintech', 'payments', 'escrow', 'ledger', 'ledgers', 'compliance'], '$500K-$2M', 'Seed', 'positive'],
  ['Jonas Meyer', 'Copperline Capital', 'Consumer subscription apps in wellness and fitness.', ['wellness', 'fitness', 'subscription'], '$750K-$2M', 'Seed', 'bounce'],
  ['Sofia Marino', 'Bellwether Angels', 'Founder-led growth for B2B software: distribution, outreach and go-to-market tooling.', ['distribution', 'outreach', 'go-to-market', 'b2b', 'growth'], '$100K-$500K', 'Pre-seed', 'positive'],
  ["Liam O'Connor", 'Greenwire Ventures', 'Cybersecurity for cloud and AI systems: red teaming, detection and secure agents.', ['security', 'cybersecurity', 'red teaming', 'red team', 'prompt injection'], '$1M-$4M', 'Seed to Series A', 'polite_decline'],
  ['Hana Sato', 'Origami Ventures', 'Creative tools and generative media: video, voice and design workflows.', ['video', 'voice', 'generative', 'creative', 'design'], '$500K-$1.5M', 'Seed', 'positive'],
  ['Marcus Webb', 'Foundry Row', 'Biotech platform companies and lab automation.', ['biotech', 'lab', 'bio'], '$3M-$8M', 'Series A', 'no_reply'],
  ['Elena Petrova', 'Polar Stack Capital', 'Commercial open-source companies and data infrastructure.', ['open-source', 'open source', 'data infrastructure', 'database'], '$1M-$3M', 'Seed', 'polite_decline'],
  ['Ravi Menon', 'Monsoon Labs Fund', 'AI-native workflow automation for small businesses and operators.', ['automation', 'workflow', 'small business', 'ai-native', 'operators'], '$250K-$1M', 'Pre-seed to Seed', 'positive'],
  ['Clara Dubois', 'Atelier Ventures', 'Edtech and learning platforms for schools and lifelong learners.', ['edtech', 'learning', 'schools'], '$500K-$1.5M', 'Seed', 'bounce'],
  ['Noah Fischer', 'Brickyard Seed', 'Hardware and robotics for logistics and warehouses.', ['robotics', 'warehouse', 'warehouses', 'logistics'], '$1M-$2M', 'Seed', 'polite_decline'],
  ['Zara Ahmed', 'Oasis Frontier', 'Mobile-first fintech and commerce for emerging markets.', ['mobile-first', 'emerging markets', 'commerce', 'fintech'], '$300K-$1.2M', 'Pre-seed to Seed', 'positive'],
  ['Ben Carter', 'Tenfold Capital', 'Gaming studios and interactive entertainment.', ['gaming', 'games', 'entertainment'], '$1M-$3M', 'Seed', 'no_reply'],
  ['Ingrid Larsen', 'Nordlicht VC', 'Enterprise AI governance, evaluation and trust tooling.', ['governance', 'evaluation', 'trust', 'enterprise', 'ai safety'], '$1M-$3M', 'Seed to Series A', 'positive'],
  ['Omar Haddad', 'Caravan Partners', 'Real estate technology and proptech.', ['proptech', 'real estate'], '$1M-$4M', 'Seed to Series A', 'polite_decline'],
  ['Mei Lin', 'Jade Gate Ventures', 'Agentic commerce: AI agents that buy, pay and negotiate on behalf of people and businesses.', ['agentic', 'commerce', 'negotiate', 'negotiation', 'agents'], '$500K-$2M', 'Seed', 'positive'],
  ['Lucas Almeida', 'Sertao Capital', 'Mobility and automotive software.', ['mobility', 'automotive', 'vehicles'], '$1M-$3M', 'Seed', 'bounce'],
  ['Grace Adeyemi', 'Baobab Fund', 'Developer marketplaces and APIs for the long tail of specialist services.', ['marketplace', 'api', 'apis', 'specialist', 'developer'], '$250K-$1M', 'Pre-seed to Seed', 'positive'],
  ['Hugo Laurent', 'Pylon Capital', 'Media, newsletters and creator-economy platforms.', ['creator', 'newsletter', 'newsletters', 'media'], '$500K-$1.5M', 'Seed', 'polite_decline'],
  ['Ethan Brooks', 'Redwood Signal', 'Space and defense technology.', ['space', 'defense', 'satellite'], '$3M-$10M', 'Series A', 'no_reply'],
  ['Nina Kovac', 'Danube Ventures', 'Healthtech: clinical workflow and diagnostics AI.', ['clinical', 'diagnostics', 'healthtech', 'patients'], '$1M-$3M', 'Seed to Series A', 'polite_decline'],
  ['Sam Patel', 'Quorum Seed', 'Generalist pre-seed bets on first-time founders.', ['first-time founders', 'pre-seed'], '$100K-$400K', 'Pre-seed', 'no_reply'],
]

const slugName = (name: string) => name.toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, '.')

export const PERSONAS: Persona[] = ROWS.map(([name, firm, thesis, keywords, check_size, stage, style]) => ({
  id: slugName(name),
  name,
  firm,
  address: `${slugName(name)}@${MAIL_DOMAIN}`,
  thesis,
  keywords,
  check_size,
  stage,
  style,
}))

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Keywords of the persona's thesis that the email text mentions (case-insensitive, word boundaries). */
export function matchedKeywords(p: Persona, text: string): string[] {
  const hay = text.toLowerCase()
  return p.keywords.filter((k) => new RegExp(`(^|[^a-z0-9])${escapeRe(k.toLowerCase())}($|[^a-z0-9])`).test(hay))
}
