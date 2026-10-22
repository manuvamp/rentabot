// Deterministic prompt-injection scanner for party-supplied text (messages, delivery notes, unit metadata).
// Three signal groups:
//  A. classic jailbreak / role-play markers ("ignore previous instructions", fake system turns)
//  B. text addressed to the adjudicator ("Note to the mediator:", "Dear AI judge,")
//  C. payout commands ("release all remaining funds", "rule in favour of the seller")
// Plus hidden-text tricks (zero-width, bidi overrides, Unicode tag characters).
// C alone only counts in work products (delivery, progress, artifacts): in a dispute statement a party
// may legitimately ask for its money back. A, B and hidden text count everywhere.

export type Party = 'buyer' | 'seller'

export interface ScanItem {
  party: Party
  message_id: string | null
  /** Where the text came from, e.g. "delivery.note" or "message:statement". */
  source: string
  text: string
  /** Arguments (statements, answers) may demand money; work products may not address the judge at all. */
  argument: boolean
}

export interface InjectionHit {
  party: Party
  message_id: string | null
  source: string
  rule: string
  excerpt: string
}

// Zero-width, word joiners, BOM, bidi embeddings/overrides/isolates, Unicode tag characters.
const HIDDEN_SRC = '[\\u200B-\\u200F\\u2060-\\u2064\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]|[\\u{E0000}-\\u{E007F}]'
const HIDDEN = new RegExp(HIDDEN_SRC, 'u')
const HIDDEN_G = new RegExp(HIDDEN_SRC, 'gu')

const ADJ =
  '(?:ai|a\\.i\\.|mediators?|judges?|arbiters?|arbitrators?|jury|jurors?|model|llm|language model|assistant|grader|evaluator|reviewer bot|ruling engine)'
const B = '\\b'

const RULES: { id: string; group: 'A' | 'B' | 'C'; re: RegExp }[] = [
  // "ignore previous / all / your instructions", but not a buyer's "ignore the previous instructions I sent about the logo"
  {
    id: 'ignore_instructions',
    group: 'A',
    re: new RegExp(
      `${B}(?:ignore|disregard|forget|override|bypass)\\s+(?:all\\s+(?:of\\s+)?(?:the\\s+|your\\s+)?|any\\s+(?:of\\s+)?(?:the\\s+|your\\s+)?|your\\s+|the\\s+above\\s+)?` +
        `(?:previous|prior|earlier|preceding|above|system|original)\\s+(?:instructions?|prompts?|rules?|guidelines|directives?|context)${B}` +
        `|${B}(?:ignore|disregard|forget)\\s+(?:all|any|your)\\s+(?:instructions?|prompts?|rules?|guidelines|directives?)${B}` +
        `|${B}(?:ignore|disregard)\\s+everything\\s+(?:above|before)${B}`,
      'i',
    ),
  },
  {
    id: 'new_instructions',
    group: 'A',
    re: new RegExp(`${B}(?:new|updated|real|actual|hidden|secret)\\s+(?:system\\s+)?(?:instructions?|directives?|orders)\\s*[:\\-]`, 'i'),
  },
  {
    id: 'role_play',
    group: 'A',
    re: new RegExp(
      `${B}(?:you are now|from now on,? you|pretend (?:to be|you are)|act as (?:the|an?) (?:ai|mediator|judge|arbiter|system|admin)|switch(?:ing)? to (?:developer|admin|god) mode|jailbreak|DAN mode)`,
      'i',
    ),
  },
  {
    id: 'fake_turn',
    group: 'A',
    re: new RegExp(
      `(?:<\\|im_(?:start|end)\\|>|<\\|(?:system|assistant|user)\\|>|\\[\\/?(?:system|inst|assistant)\\]|<\\/?(?:system|instructions?|assistant)>` +
        `|^#{1,6}\\s*(?:system|instructions?)(?:\\s+prompt)?\\s*:?\\s*$|${B}(?:system|developer)\\s+(?:prompt|message|override)\\s*:` +
        `|${B}BEGIN (?:SYSTEM|INSTRUCTIONS)${B}|${B}END (?:OF )?(?:DATA|PARTY DATA)${B})`,
      'im',
    ),
  },
  {
    id: 'addressed_to_adjudicator',
    group: 'B',
    re: new RegExp(`${B}(?:note|message|memo|instructions?|attention|reminder|p\\.?s\\.?|important)\\s*(?:to|for)\\s+(?:the\\s+|any\\s+|all\\s+)?${ADJ}${B}`, 'i'),
  },
  {
    id: 'greeting_adjudicator',
    group: 'B',
    re: new RegExp(`(?:^|[\\n.!?]\\s*)(?:dear|hey|hello|hi|attention|to)\\s+(?:the\\s+)?(?:ai\\s+)?${ADJ}\\s*[,:!]`, 'im'),
  },
  {
    id: 'vocative_command',
    group: 'B',
    re: new RegExp(`${B}${ADJ}\\s*[,:]\\s*(?:you\\s+(?:must|should|will|are to)\\s+|please\\s+)?(?:release|rule|award|refund|ignore|decide|pay|approve|find)${B}`, 'i'),
  },
  {
    id: 'release_all_funds',
    group: 'C',
    re: new RegExp(
      `${B}(?:release|pay(?:\\s+out)?|transfer|award|capture)\\s+(?:all\\s+(?:of\\s+)?(?:the\\s+)?(?:remaining\\s+)?|100\\s?%\\s+(?:of\\s+)?(?:the\\s+)?|the\\s+(?:full|entire|whole|remaining)\\s+|every\\s+|full\\s+)` +
        `(?:remaining\\s+)?(?:funds?|payment|money|escrow|amount|balance|budget)${B}`,
      'i',
    ),
  },
  {
    id: 'rule_in_favour',
    group: 'C',
    re: new RegExp(`${B}(?:rule|decide|find|side)\\s+(?:entirely\\s+|fully\\s+)?(?:in\\s+favou?r\\s+of|for|with)\\s+(?:the\\s+)?(?:seller|buyer|me|us)${B}`, 'i'),
  },
  {
    id: 'mark_as_met',
    group: 'C',
    re: new RegExp(
      `${B}(?:mark|treat|record|consider)\\s+(?:all|every|each)\\s+(?:of\\s+the\\s+)?(?:deliverables?|units?|listings?|checks?|items?)\\s+as\\s+(?:met|passed|verified|complete|delivered)${B}`,
      'i',
    ),
  },
]

function excerptAround(text: string, index: number, length: number) {
  const start = Math.max(0, index - 80)
  const end = Math.min(text.length, index + length + 120)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`.replace(/\s+/g, ' ').slice(0, 400)
}

/** Visible form of hidden characters, so humans and models can see them. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN_G, (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`)
}

const pick = (i: ScanItem) => ({ party: i.party, message_id: i.message_id, source: i.source })

export function scanText(item: ScanItem): InjectionHit[] {
  const hits: InjectionHit[] = []
  const raw = item.text ?? ''
  if (!raw) return hits
  if (HIDDEN.test(raw)) {
    const shown = revealHidden(raw)
    hits.push({ ...pick(item), rule: 'hidden_characters', excerpt: excerptAround(shown, shown.indexOf('[U+'), 8) })
  }
  // Scan with hidden characters stripped and Unicode folded, so "re<ZWSP>lease" still matches.
  const text = raw.normalize('NFKC').replace(HIDDEN_G, '')
  const addressed = RULES.some((r) => r.group === 'B' && r.re.test(text))
  for (const r of RULES) {
    // In arguments, a payout demand is fine unless the same text also addresses the judge directly.
    if (r.group === 'C' && item.argument && !addressed) continue
    const m = r.re.exec(text)
    if (m) hits.push({ ...pick(item), rule: r.id, excerpt: excerptAround(text, m.index, m[0].length) })
  }
  return hits
}

export function scanAll(items: ScanItem[]): InjectionHit[] {
  return items.flatMap(scanText)
}
