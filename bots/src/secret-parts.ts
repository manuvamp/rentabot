// The strings inside a locker secret that must never reach a log line (mirrors the server's redact-guard).
import type { LockerSecret } from '@rentabot/shared'

export function secretParts(s: LockerSecret): string[] {
  switch (s.kind) {
    case 'login':
      return [s.password]
    case 'api_key':
      return [s.key]
    case 'recovery_codes':
      return s.codes
    case 'note':
      return [s.text]
    case 'secret':
      return [s.value]
  }
}
