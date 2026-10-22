// Credential guard for everything that leaves the platform toward a model, and for text parties post.
//  - a process-wide registry of the live server-sealed locker values (the locker fills it at boot and on every put,
//    and forgets a value when its item is shredded). End-to-end values are never known to the server.
//  - credentialPattern(): heuristics for credentials nobody registered ("password: hunter22", sk-…, AKIA…, PEM keys).
//  - guardAiClient(): wraps the one AiClient so every system prompt, prompt and chat message is scrubbed before any
//    provider sees it. It is a last line of defence: the room and delivery guards reject such text before it is stored.
import type { AiClient, ChatMessage } from './provider.ts'

const MIN_LEN = 6
const values = new Map<string, number>() // value -> reference count (the same value may sit in several items)

export function registerLockerValue(v: string) {
  if (typeof v !== 'string' || v.length < MIN_LEN) return
  values.set(v, (values.get(v) ?? 0) + 1)
}
export function forgetLockerValue(v: string) {
  const n = values.get(v)
  if (n === undefined) return
  if (n <= 1) values.delete(v)
  else values.set(v, n - 1)
}
// Credentials the PLATFORM holds for its own bots (the Lead Verifier's Hunter.io key). They are not in any job's locker, but they must
// never appear in a prompt, a message, a delivery, an artifact or an input either: the AI scrub and the locker's text guard check them.
const platformSecrets = new Set<string>()
export function registerPlatformSecret(v: string | undefined | null) {
  const t = v?.trim()
  if (t && t.length >= MIN_LEN) platformSecrets.add(t)
}
/** Test hook: forget every platform secret. */
export const clearPlatformSecrets = () => platformSecrets.clear()
export function containsPlatformSecret(text: string): boolean {
  for (const v of platformSecrets) if (text.includes(v)) return true
  return false
}

/** Test hook: how many distinct values are registered (never the values). */
export const registeredLockerValueCount = () => values.size

/** The strings inside a locker secret that must never be shown outside the locker. */
export function secretParts(s: { kind: string } & Record<string, unknown>): string[] {
  const out: string[] = []
  const add = (x: unknown) => {
    if (typeof x === 'string' && x.length >= MIN_LEN) out.push(x)
  }
  switch (s.kind) {
    case 'login':
      add(s.password)
      break
    case 'api_key':
      add(s.key)
      break
    case 'recovery_codes':
      for (const c of (s.codes as unknown[]) ?? []) add(c)
      break
    case 'note':
      add(s.text)
      break
    case 'secret':
      add(s.value)
      break
  }
  return out
}

const PATTERNS: { name: string; re: RegExp }[] = [
  // Keyword patterns need a separator ("password: …", "api_key=…") and a value with a digit, so prose such as
  // "password: required" or "API key authentication" passes. Real values without digits can slip through (SECURITY.md).
  { name: 'a password', re: /\b(?:pass(?:word|wd|phrase|code)?|pwd)\b["']?\s*[:=]\s*["']?(?!\[|<|\*{3})(?=[^\s"',;]*\d)[^\s"',;]{6,}/i },
  { name: 'an API key or token', re: /\b(?:api[_ -]?key|secret[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret)\b["']?\s*[:=]\s*["']?(?!\[|<)(?=[A-Za-z0-9_\-./+=]*\d)[A-Za-z0-9_\-./+=]{16,}/i },
  { name: 'a bearer token', re: /\bbearer\s+(?=[A-Za-z0-9_\-.=]*\d)[A-Za-z0-9_\-.=]{20,}/i },
  { name: 'an OpenAI/Anthropic-style key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'an AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'a Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'a private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
]

/** The first credential-looking thing in `text` (its kind, never the match), or null. */
export function credentialPattern(text: string): string | null {
  for (const p of PATTERNS) if (p.re.test(text)) return p.name
  return null
}

/** Is one of `known` (or a registered value, when `known` is omitted) inside `text`? */
export function containsKnownValue(text: string, known?: Iterable<string>): boolean {
  for (const v of known ?? values.keys()) if (v.length >= MIN_LEN && text.includes(v)) return true
  return false
}

const WITHHELD = '[withheld: credential]'

/** Replace registered locker values and credential-looking strings. */
export function scrubForAi(text: string): string {
  if (!text) return text
  let out = text
  for (const v of values.keys()) if (out.includes(v)) out = out.split(v).join(WITHHELD)
  for (const v of platformSecrets) if (out.includes(v)) out = out.split(v).join(WITHHELD)
  for (const p of PATTERNS) out = out.replace(new RegExp(p.re.source, p.re.flags + 'g'), WITHHELD)
  return out
}

function scrubMessage(m: ChatMessage): ChatMessage {
  if (m.role === 'user') return { ...m, text: scrubForAi(m.text) }
  if (m.role === 'tool') return { ...m, content: scrubForAi(m.content) }
  return m.text !== undefined ? { ...m, text: scrubForAi(m.text) } : m
}

/** Every call to a model goes through here: system, prompt and chat messages are scrubbed first. */
export function guardAiClient(ai: AiClient): AiClient {
  const guarded: AiClient = {
    get config() {
      return ai.config
    },
    get enabled() {
      return ai.enabled
    },
    askJson: (call) => ai.askJson({ ...call, system: scrubForAi(call.system), prompt: scrubForAi(call.prompt) }),
  }
  if (ai.chat) {
    const chat = ai.chat.bind(ai)
    guarded.chat = (req) => chat({ ...req, system: scrubForAi(req.system), messages: req.messages.map(scrubMessage) })
  }
  if (ai.spend) guarded.spend = ai.spend.bind(ai)
  return guarded
}
