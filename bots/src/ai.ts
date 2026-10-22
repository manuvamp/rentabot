// Minimal AI access for the bots: OpenAI-compatible chat completions (the dev proxy) or the Anthropic
// Messages API over plain fetch. Bots must work without it, so every caller has a deterministic fallback
// and treats a failed call as "no AI" instead of an error.
import { readAiConfig, type AiConfig } from './env.ts'

export interface Ai {
  readonly enabled: boolean
  /** One completion. Throws on failure; callers catch and fall back. */
  complete(opts: { system: string; user: string; maxTokens?: number; temperature?: number }): Promise<string>
}

export const NO_AI: Ai = {
  enabled: false,
  async complete() {
    throw new Error('AI is not configured')
  },
}

export function createAi(config: AiConfig = readAiConfig()): Ai {
  if (config.provider === 'none' || !config.apiKey) return NO_AI
  const call = async (opts: { system: string; user: string; maxTokens?: number; temperature?: number }): Promise<string> => {
    const maxTokens = opts.maxTokens ?? 1500
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), config.timeoutMs)
    try {
      if (config.provider === 'anthropic') {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: config.model, max_tokens: maxTokens, system: opts.system, messages: [{ role: 'user', content: opts.user }] }),
        })
        if (!r.ok) throw new Error(`anthropic ${r.status}`)
        const j = (await r.json()) as { content?: { type: string; text?: string }[] }
        return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      }
      const r = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
        }),
      })
      if (!r.ok) throw new Error(`ai endpoint ${r.status}`)
      const j = (await r.json()) as { choices?: { message?: { content?: string | null } }[] }
      return j.choices?.[0]?.message?.content ?? ''
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    enabled: true,
    async complete(opts) {
      let last: unknown
      for (let i = 0; i < 2; i++) {
        try {
          const text = await call(opts)
          if (text.trim()) return text
          last = new Error('empty AI reply')
        } catch (e) {
          last = e
          await new Promise((r) => setTimeout(r, 600 * (i + 1)))
        }
      }
      throw last instanceof Error ? last : new Error(String(last))
    },
  }
}

/** Pull the first JSON object or array out of a model reply (handles code fences and prose around it). */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.search(/[{[]/)
    if (start < 0) continue
    for (let end = c.length; end > start; end--) {
      const ch = c[end - 1]
      if (ch !== '}' && ch !== ']') continue
      try {
        return JSON.parse(c.slice(start, end)) as T
      } catch {
        /* try a shorter slice */
      }
    }
  }
  return null
}
