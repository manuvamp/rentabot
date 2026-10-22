// Structured log: one JSON line per action. API keys and secrets never reach it: every sink goes through
// a redactor that masks the registered secret strings.
export interface LogEntry {
  level?: 'info' | 'warn' | 'error'
  bot?: string
  job?: string
  action: string
  ok?: boolean
  ms?: number
  detail?: string
  [k: string]: unknown
}

export type Logger = (entry: LogEntry) => void

const secrets = new Set<string>()

/** Register a string (an API key, a sealed secret value) that must never appear in a log line. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) secrets.add(value)
}

export function redact(text: string): string {
  let out = text
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('[redacted]')
  return out
}

export function consoleLogger(opts: { quiet?: boolean } = {}): Logger {
  return (entry) => {
    if (opts.quiet) return
    const line = redact(JSON.stringify({ ts: new Date().toISOString(), level: 'info', ...entry }))
    if (entry.level === 'error') console.error(line)
    else console.log(line)
  }
}

export const silentLogger: Logger = () => {}

/** Collects entries in memory (tests assert on them). */
export function memoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const fn = ((e: LogEntry) => void entries.push(JSON.parse(redact(JSON.stringify(e))) as LogEntry)) as Logger & { entries: LogEntry[] }
  fn.entries = entries
  return fn
}
