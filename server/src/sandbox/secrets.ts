// Passwords in Sandbox Web: stored only as salted scrypt hashes (cheap parameters; this is a fixture, but it still
// never keeps a password in clear), plus the generators for tokens and mailbox app passwords.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const hashWith = (secret: string, salt: string) => scryptSync(secret, salt, 32, { N: 1024, r: 8, p: 1 }).toString('hex')

export function hashSecret(secret: string): { salt: string; hash: string } {
  const salt = randomBytes(12).toString('hex')
  return { salt, hash: hashWith(secret, salt) }
}

export function verifySecret(secret: string, salt: string, hash: string): boolean {
  const a = Buffer.from(hashWith(secret, salt), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export const token = (bytes = 18): string => randomBytes(bytes).toString('hex')

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
/** An app password in the shape mail providers issue them: four groups of four lowercase letters. */
export function newAppPassword(): string {
  const bytes = randomBytes(16)
  const groups: string[] = []
  for (let g = 0; g < 4; g++) groups.push([...bytes.subarray(g * 4, g * 4 + 4)].map((b) => LETTERS[b % 26]).join(''))
  return groups.join('-')
}

export interface PasswordPolicy {
  min: number
}

/** The strength rule every sandbox service enforces. Returns the failures (empty = acceptable). */
export function passwordProblems(password: string, email: string, policy: PasswordPolicy = { min: 12 }): string[] {
  const out: string[] = []
  if (password.length < policy.min) out.push(`at least ${policy.min} characters`)
  if (password.length > 200) out.push('at most 200 characters')
  if (!/[a-z]/.test(password)) out.push('a lowercase letter')
  if (!/[A-Z]/.test(password)) out.push('an uppercase letter')
  if (!/\d/.test(password)) out.push('a digit')
  if (!/[^A-Za-z0-9]/.test(password)) out.push('a symbol')
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  if (local.length >= 4 && password.toLowerCase().includes(local)) out.push('not contain your email name')
  return out
}

/** Parse `Authorization: Basic base64(user:password)`. */
export function basicAuth(header: unknown): { user: string; password: string } | null {
  if (typeof header !== 'string') return null
  const m = header.match(/^Basic\s+(.+)$/i)
  if (!m) return null
  const raw = Buffer.from(m[1]!, 'base64').toString('utf8')
  const i = raw.indexOf(':')
  return i < 0 ? null : { user: raw.slice(0, i), password: raw.slice(i + 1) }
}
