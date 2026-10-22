// Config from the environment and the repo-root .env (gitignored). Real env vars win over the file.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function loadDotEnv(file = join(REPO_ROOT, '.env')): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(file)) return out
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) continue
    let v = line.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[line.slice(0, i).trim()] = v
  }
  return out
}

/** process.env layered over .env. */
export function readEnv(): Record<string, string | undefined> {
  return { ...loadDotEnv(), ...process.env }
}

export interface AiConfig {
  provider: 'openai' | 'anthropic' | 'none'
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export function readAiConfig(env: Record<string, string | undefined> = readEnv()): AiConfig {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase()
  const anthropicKey = (env.ANTHROPIC_API_KEY ?? '').trim()
  let provider: AiConfig['provider'] = raw === 'openai' || raw === 'anthropic' || raw === 'none' ? raw : anthropicKey ? 'anthropic' : env.AI_BASE_URL ? 'openai' : 'none'
  if (provider === 'anthropic' && !anthropicKey) provider = 'none'
  if (provider === 'openai' && !env.AI_BASE_URL) provider = 'none'
  return {
    provider,
    baseUrl: (env.AI_BASE_URL ?? '').replace(/\/+$/, ''),
    apiKey: provider === 'anthropic' ? anthropicKey : (env.AI_API_KEY ?? ''),
    model: env.AI_MODEL_MAIN || 'claude-sonnet-5-5',
    timeoutMs: Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : 90_000,
  }
}
