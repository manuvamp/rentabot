// Deterministic cold-email lint. One implementation, two users: the platform's `email_lint` check
// (server/src/housebots/checks.ts) and the Cold Email Writer bot, which self-lints with the exact
// same function before it delivers. Pure code, no I/O, no dependencies.
//
// Rules (from our own outreach writing rules: short, one ask, no spam triggers, personal):
//   subject_length   subject is 1-60 characters
//   body_words       body is 50-150 words
//   one_question     at most one question mark in the body (one ask)
//   placeholder      no unfilled {placeholders} or [brackets] in subject or body
//   company_mention  the recipient's company is named in the subject or body
//   spam_words       no spam-trigger phrase from SPAM_PHRASES
//   shouting         no ALL-CAPS word longer than 4 letters (acronyms and brands on the allow list excepted)

export interface LintInput {
  subject: string
  body: string
  /** The recipient's company, as the buyer's recipient list names it. */
  company: string
}

export interface LintViolation {
  rule: 'subject_length' | 'body_words' | 'one_question' | 'placeholder' | 'company_mention' | 'spam_words' | 'shouting'
  message: string
}

export interface LintResult {
  ok: boolean
  violations: LintViolation[]
  stats: { subject_chars: number; body_words: number; question_marks: number }
}

export const SUBJECT_MAX = 60
export const BODY_MIN_WORDS = 50
export const BODY_MAX_WORDS = 150

/** Short on purpose: phrases that mail filters and readers treat as spam. Plain "free" is allowed. */
export const SPAM_PHRASES = [
  'act now',
  'buy now',
  'click here',
  'limited time',
  'risk-free',
  'risk free',
  '100% free',
  'free money',
  'make money fast',
  'earn extra cash',
  'guaranteed',
  'no obligation',
  'once in a lifetime',
  'congratulations',
  'you have been selected',
  'dear friend',
  'urgent',
  'winner',
  'cash bonus',
  'miracle',
  'viagra',
] as const

/** All-caps words that are fine: well-known acronyms and brands. Longer than 4 letters only matters here. */
export const CAPS_ALLOWED = ['ORANO', 'NVIDIA', 'OPENAI', 'PAYPAL', 'GITHUB', 'HTTPS', 'OAUTH', 'SAAS', 'WEBHOOK', 'GOOGLE'] as const

/** Trailing words dropped when matching a company by its short name ("Lattice Harbor Capital" -> "Lattice Harbor"). */
const GENERIC_TAIL = new Set(['capital', 'ventures', 'venture', 'partners', 'fund', 'vc', 'labs', 'lab', 'group', 'holdings', 'seed', 'angels', 'inc', 'ltd', 'llc', 'limited', 'plc', 'corp', 'co', 'gmbh', 'studio', 'studios'])

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/** Names that count as "mentioning the company": the full name, and the name without generic trailing words. */
export function companyNames(company: string): string[] {
  const full = company.trim().replace(/\s+/g, ' ')
  if (!full) return []
  const words = full.split(' ')
  const names = [full]
  let end = words.length
  while (end > 1 && GENERIC_TAIL.has(words[end - 1]!.toLowerCase().replace(/[^a-z]/g, ''))) end--
  if (end < words.length) names.push(words.slice(0, end).join(' '))
  return names
}

export function mentionsCompany(text: string, company: string): boolean {
  const hay = text.toLowerCase()
  return companyNames(company).some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u').test(hay))
}

export function lintEmail(input: LintInput, opts: { allowCaps?: string[] } = {}): LintResult {
  const subject = (input.subject ?? '').trim()
  const body = (input.body ?? '').trim()
  const company = (input.company ?? '').trim()
  const violations: LintViolation[] = []
  const add = (rule: LintViolation['rule'], message: string) => violations.push({ rule, message })

  if (subject.length < 1 || subject.length > SUBJECT_MAX) add('subject_length', `subject is ${subject.length} characters; it must be 1-${SUBJECT_MAX}`)

  const words = countWords(body)
  if (words < BODY_MIN_WORDS || words > BODY_MAX_WORDS) add('body_words', `body is ${words} words; it must be ${BODY_MIN_WORDS}-${BODY_MAX_WORDS}`)

  const questions = (body.match(/\?/g) ?? []).length
  if (questions > 1) add('one_question', `body has ${questions} question marks; ask exactly one thing`)

  const holes = [...`${subject}\n${body}`.matchAll(/\{[^{}\n]{1,80}\}|\[[^\[\]\n]{1,80}\]/g)].map((m) => m[0])
  if (holes.length) add('placeholder', `unfilled placeholder(s): ${[...new Set(holes)].slice(0, 4).join(' ')}`)

  if (!company) add('company_mention', "no company given to check against (unit.meta.company is empty)")
  else if (!mentionsCompany(`${subject}\n${body}`, company)) add('company_mention', `the email never mentions the recipient's company "${company}"`)

  const lower = `${subject}\n${body}`.toLowerCase()
  const spam = SPAM_PHRASES.filter((p) => new RegExp(`(^|[^a-z0-9])${escapeRe(p)}($|[^a-z0-9])`).test(lower))
  if (spam.length) add('spam_words', `spam-trigger phrase(s): ${spam.slice(0, 4).join(', ')}`)

  const allowed = new Set<string>([...CAPS_ALLOWED, ...(opts.allowCaps ?? [])].map((w) => w.toUpperCase()))
  for (const w of company.split(/[^\p{L}\p{N}]+/u)) if (w) allowed.add(w.toUpperCase())
  const shouting = [...new Set(`${subject}\n${body}`.match(/\b[A-Z]{5,}\b/g) ?? [])].filter((w) => !allowed.has(w))
  if (shouting.length) add('shouting', `ALL-CAPS word(s): ${shouting.slice(0, 4).join(', ')}`)

  return { ok: violations.length === 0, violations, stats: { subject_chars: subject.length, body_words: words, question_marks: questions } }
}
