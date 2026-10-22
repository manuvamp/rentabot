// Config for the buyer agents: <repo>/.env (no dependency) under real env vars, the AI endpoint and the buyer key.
// Keys are only ever returned to callers; nothing here prints or logs a value.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

export type Env = Record<string, string | undefined>

/** Parse KEY=VALUE lines (comments, blank lines, optional quotes and `export ` prefix allowed). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]!] = v
  }
  return out
}

/** The repo .env merged under process.env: a real env var always wins. */
export function loadEnv(path = join(REPO_ROOT, '.env'), env: Env = process.env): Env {
  const file = existsSync(path) ? parseDotEnv(readFileSync(path, 'utf8')) : {}
  const merged: Env = { ...file }
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') merged[k] = v
  return merged
}

export interface AiConfig {
  provider: 'openai' | 'anthropic'
  baseUrl: string
  apiKey: string
  model: string
}

export function loadAiConfig(env: Env = loadEnv()): AiConfig {
  const provider = (env.AI_PROVIDER ?? 'openai').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai'
  const baseUrl = (env.AI_BASE_URL || (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '')
  const apiKey = (provider === 'anthropic' ? env.ANTHROPIC_API_KEY || env.AI_API_KEY : env.AI_API_KEY || env.ANTHROPIC_API_KEY) ?? ''
  return { provider, baseUrl, apiKey, model: env.AI_MODEL_MAIN || 'claude-sonnet-5-5' }
}

export function rentabotUrl(env: Env = loadEnv()): string {
  return (env.RENTABOT_URL || 'http://localhost:8790').replace(/\/+$/, '')
}

/** RENTABOT_KEY, else data/demo-keys.json (written by the real core's seed). Never prints the key. */
export function loadBuyerKey(env: Env = loadEnv(), repoRoot = REPO_ROOT): string {
  if (env.RENTABOT_KEY) return env.RENTABOT_KEY
  const file = join(repoRoot, 'data', 'demo-keys.json')
  if (existsSync(file)) {
    try {
      const key = JSON.parse(readFileSync(file, 'utf8'))?.orano_growth_agent?.api_key
      if (typeof key === 'string' && key) return key
    } catch {
      throw new Error(`${file} is not valid JSON. Re-run the server seed (demo reset), or set RENTABOT_KEY.`)
    }
    throw new Error(`${file} has no orano_growth_agent.api_key. Re-run the server seed (demo reset), or set RENTABOT_KEY.`)
  }
  throw new Error('No buyer key: set RENTABOT_KEY (in the environment or .env), or start the real server once so it writes data/demo-keys.json.')
}
