// Model access behind one interface, two backends:
//  - openai:    any OpenAI-compatible /chat/completions endpoint (dev: the local proxy)
//  - anthropic: the Anthropic Messages API through the official SDK (production). Claude models go
//    there; other models (e.g. a cross-provider juror) go to the OpenAI-compatible endpoint if one
//    is configured. Paid calls are priced and capped by the spend ledger (spend.ts).
// Every call asks for one JSON object, parses it leniently (code fences, prose around it),
// validates it with zod and retries once with the validation error when it doesn't fit.
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { SpendLedger, SpendCapReached } from './spend.ts'

export type ProviderKind = 'openai' | 'anthropic' | 'none'

export interface AiConfig {
  provider: ProviderKind
  baseUrl: string
  apiKey: string
  anthropicKey: string
  timeoutMs: number
  /** Thinking depth for Claude 5.5 models (thinking is always on there; effort is the control). */
  effort: 'low' | 'medium' | 'high'
  /** Monthly cap on paid (Anthropic) spend, USD. */
  spendCapUsd: number
  spendFile: string | null
  models: { fast: string; main: string; mediator: string; jury: string[] }
}

export class AiUnavailable extends Error {}

export interface JsonCall<T> {
  model: string
  system: string
  prompt: string
  schema: z.ZodType<T>
  maxTokens?: number
  /** Override the configured timeout for this call. */
  timeoutMs?: number
}

export interface AiClient {
  config: AiConfig
  enabled: boolean
  askJson<T>(call: JsonCall<T>): Promise<T>
  /** One tool-calling turn (the AG Studio analyst). Same provider, same spend ledger and cap as askJson. */
  chat?(req: ChatRequest): Promise<ChatResult>
  /** Paid spend so far this month (empty when only the dev proxy is used). */
  spend?(): ReturnType<SpendLedger['snapshot']>
}

// ---------- tool-calling chat (provider-neutral shapes) ----------

export interface ChatToolCall {
  id: string
  name: string
  /** JSON text, as the model produced it. */
  arguments: string
}
export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; tool_calls?: ChatToolCall[]; /** Opaque provider reasoning (Anthropic thinking blocks) to hand back with this turn. */ reasoning?: string | null }
  | { role: 'tool'; tool_call_id: string; content: string }
export interface ChatTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}
export interface ChatRequest {
  model?: string
  system: string
  messages: ChatMessage[]
  tools: ChatTool[]
  tool_choice?: 'auto' | 'none' | 'required' | { name: string }
  maxTokens?: number
}
export interface ChatResult {
  id: string
  model: string
  text: string
  tool_calls: ChatToolCall[]
  reasoning: string | null
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
  /** Paid spend after this call (Anthropic only). */
  spend?: { usd: number; cap_usd: number }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

export function readAiConfig(env: NodeJS.ProcessEnv): AiConfig {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase()
  const anthropicKey = (env.ANTHROPIC_API_KEY ?? '').trim()
  const apiKey = env.AI_API_KEY ?? ''
  let provider: ProviderKind
  if (raw === 'openai' || raw === 'anthropic' || raw === 'none') provider = raw
  else provider = anthropicKey ? 'anthropic' : env.AI_BASE_URL ? 'openai' : 'none'
  if (provider === 'anthropic' && !anthropicKey) provider = 'none'
  if (provider === 'openai' && !env.AI_BASE_URL) provider = 'none'
  // Three different models per juror. The dev proxy offers three providers; with only an Anthropic
  // key the jury is three Claude tiers (and a cross-provider juror joins if AI_BASE_URL is also set).
  const defaultJury = provider === 'anthropic' ? 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5' : 'claude-sonnet-5-5,gemini-3-flash,gpt-oss-120b-medium'
  const jury = (env.JURY_MODELS || defaultJury)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    provider,
    baseUrl: (env.AI_BASE_URL ?? '').replace(/\/$/, ''),
    apiKey,
    anthropicKey,
    timeoutMs: Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : 90_000,
    effort: env.AI_EFFORT === 'medium' || env.AI_EFFORT === 'high' ? env.AI_EFFORT : 'low',
    spendCapUsd: Number(env.AI_SPEND_CAP_USD) > 0 ? Number(env.AI_SPEND_CAP_USD) : 20,
    spendFile: env.AI_SPEND_FILE === 'off' ? null : resolve(REPO_ROOT, env.DATA_DIR || 'data', 'ai-spend.json'),
    models: {
      fast: env.AI_MODEL_FAST || 'claude-haiku-5-5',
      main: env.AI_MODEL_MAIN || 'claude-sonnet-5-5',
      mediator: env.AI_MODEL_MEDIATOR || 'claude-opus-5-5',
      jury,
    },
  }
}

/** Pull the first JSON object out of a model answer (tolerates ```json fences and surrounding prose). */
export function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1]! : text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`no JSON object in answer: ${text.slice(0, 120)}`)
  return JSON.parse(raw.slice(start, end + 1))
}

export function createAiClient(config: AiConfig): AiClient {
  const enabled = config.provider !== 'none'
  const ledger = new SpendLedger({ capUsd: config.spendCapUsd, file: config.spendFile })
  const sdk = config.provider === 'anthropic' ? new Anthropic({ apiKey: config.anthropicKey, maxRetries: 2 }) : null

  async function complete(model: string, system: string, prompt: string, maxTokens: number, timeoutMs: number): Promise<string> {
    if (config.provider === 'anthropic' && model.startsWith('claude-')) return anthropic(sdk!, ledger, config, model, system, prompt, maxTokens, timeoutMs)
    if (config.baseUrl) return openai(config, model, system, prompt, maxTokens, timeoutMs)
    if (config.provider === 'anthropic') throw new AiUnavailable(`model ${model} needs AI_BASE_URL (not a Claude model)`)
    throw new AiUnavailable('AI provider disabled (AI_PROVIDER=none)')
  }

  async function askJson<T>(call: JsonCall<T>): Promise<T> {
    const maxTokens = call.maxTokens ?? 4000
    const timeoutMs = call.timeoutMs ?? config.timeoutMs
    let prompt = call.prompt
    let lastError = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await complete(call.model, call.system, prompt, maxTokens, timeoutMs)
      try {
        const parsed = call.schema.safeParse(parseJsonObject(text))
        if (parsed.success) return parsed.data
        lastError = parsed.error.issues
          .slice(0, 6)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')
      } catch (e) {
        lastError = (e as Error).message
      }
      prompt = `${call.prompt}\n\nYour previous answer was rejected: ${lastError.slice(0, 600)}\nReply again with ONLY one JSON object that matches the required shape exactly.`
    }
    throw new Error(`model ${call.model} returned invalid JSON twice: ${lastError.slice(0, 300)}`)
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const model = req.model || config.models.main
    if (config.provider === 'anthropic' && model.startsWith('claude-')) return anthropicChat(sdk!, ledger, config, model, req)
    if (config.baseUrl) return openaiChat(config, model, req)
    throw new AiUnavailable(config.provider === 'anthropic' ? `model ${model} needs AI_BASE_URL (not a Claude model)` : 'AI provider disabled (AI_PROVIDER=none)')
  }

  return { config, enabled, askJson, chat, spend: () => ledger.snapshot() }
}

/** A tool-call id that survives both providers (Anthropic: ^[a-zA-Z0-9_-]+$). */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'call'

/** JSON Schema without the keywords providers choke on (Studio marks "undefined" as { not: {} } inside anyOf; $schema is noise). */
export function cleanToolSchema(schema: unknown): Record<string, unknown> {
  const isUndefinedSentinel = (s: unknown) => !!s && typeof s === 'object' && Object.keys(s as object).length === 1 && 'not' in (s as object) && Object.keys((s as { not: object }).not ?? {}).length === 0
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(o)) {
        if (k === '$schema') continue
        if (k === 'anyOf' && Array.isArray(x)) {
          const kept = x.filter((b) => !isUndefinedSentinel(b))
          if (kept.length === 1) Object.assign(out, walk(kept[0]) as object)
          else out.anyOf = kept.map(walk)
        } else out[k] = walk(x)
      }
      return out
    }
    return v
  }
  const s = (walk(schema) ?? {}) as Record<string, unknown>
  return s.type === 'object' || s.properties ? { type: 'object', ...s } : { type: 'object', properties: {} }
}

const parseArgs = (text: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(text || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** OpenAI-compatible /chat/completions with tools. */
export function toOpenAiMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [{ role: 'system', content: req.system }]
  for (const m of req.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text })
    else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: safeId(m.tool_call_id), content: m.content })
    else
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((c) => ({ id: safeId(c.id), type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) } : {}),
      })
  }
  return out
}

async function openaiChat(cfg: AiConfig, model: string, req: ChatRequest): Promise<ChatResult> {
  const choice = req.tool_choice
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      max_tokens: Math.max(req.maxTokens ?? 4000, 4000),
      messages: toOpenAiMessages(req),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: cleanToolSchema(t.parameters) } })),
            tool_choice: choice && typeof choice === 'object' ? { type: 'function', function: { name: choice.name } } : (choice ?? 'auto'),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  if (!res.ok) throw new AiUnavailable(`model endpoint ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const body = (await res.json()) as {
    id?: string
    model?: string
    choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const msg = body.choices?.[0]?.message
  const tool_calls = (msg?.tool_calls ?? []).map((c) => ({ id: safeId(c.id), name: c.function.name, arguments: c.function.arguments || '{}' }))
  if (!msg || (!msg.content && !tool_calls.length)) throw new AiUnavailable(`model ${model} returned an empty answer`)
  return {
    id: body.id ?? `chat_${Date.now()}`,
    model: body.model ?? model,
    text: msg.content ?? '',
    tool_calls,
    reasoning: null,
    stop_reason: body.choices?.[0]?.finish_reason ?? 'stop',
    usage: { input_tokens: body.usage?.prompt_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0 },
  }
}

/** Anthropic Messages: tool results travel in user turns, and thinking blocks go back with the assistant turn that used tools. */
export function toAnthropicMessages(req: ChatRequest, opts: { keepReasoning?: boolean } = {}): { role: 'user' | 'assistant'; content: unknown[] }[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(block)
    else out.push({ role, content: [block] })
  }
  for (const m of req.messages) {
    if (m.role === 'user') push('user', { type: 'text', text: m.text })
    else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: safeId(m.tool_call_id), content: m.content })
    else {
      if (m.reasoning && opts.keepReasoning !== false) {
        try {
          for (const b of JSON.parse(m.reasoning) as unknown[]) push('assistant', b)
        } catch {
          /* a reasoning blob we cannot read is dropped */
        }
      }
      if (m.text) push('assistant', { type: 'text', text: m.text })
      for (const c of m.tool_calls ?? []) push('assistant', { type: 'tool_use', id: safeId(c.id), name: c.name, input: parseArgs(c.arguments) })
    }
  }
  return out
}

async function anthropicChat(client: Anthropic, ledger: SpendLedger, cfg: AiConfig, model: string, req: ChatRequest): Promise<ChatResult> {
  try {
    ledger.assertBudget()
  } catch (e) {
    if (e instanceof SpendCapReached) throw new AiUnavailable(e.message)
    throw e
  }
  const fallback = FALLBACK_MODELS.has(model)
  const choice = req.tool_choice
  let res: Anthropic.Beta.BetaMessage
  const call = (keepReasoning: boolean) =>
    client.beta.messages.create(
      {
        model,
        max_tokens: Math.max(req.maxTokens ?? 6000, 8000),
        system: req.system,
        messages: toAnthropicMessages(req, { keepReasoning }) as Anthropic.Beta.BetaMessageParam[],
        output_config: { effort: cfg.effort },
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: cleanToolSchema(t.parameters) })) as Anthropic.Beta.BetaToolUnion[],
              tool_choice: (choice === 'none' ? { type: 'none' } : choice === 'required' ? { type: 'any' } : choice && typeof choice === 'object' ? { type: 'tool', name: choice.name } : { type: 'auto' }) as Anthropic.Beta.BetaToolChoice,
            }
          : {}),
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { timeout: cfg.timeoutMs },
    )
  try {
    try {
      res = await call(true)
    } catch (e) {
      // A replayed thinking block can be rejected (its signature is bound to the exact model and request that produced it, and
      // a browser-run agent loop may hand it back after a fallback or a reshuffle). Thinking is only a hint here: retry once without it.
      const bad = e instanceof Anthropic.APIError && e.status === 400 && /thinking|signature/i.test(e.message) && req.messages.some((m) => m.role === 'assistant' && m.reasoning)
      if (!bad) throw e
      res = await call(false)
    }
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new AiUnavailable(`Anthropic ${e.status ?? ''}: ${e.message.slice(0, 160)}`)
    throw e
  }
  ledger.record(model, res.usage)
  if (res.stop_reason === 'refusal') throw new AiUnavailable(`model ${model} declined (${res.stop_details?.category ?? 'no category'})`)
  const thinking = res.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
  const snap = ledger.snapshot()
  return {
    id: res.id,
    model: res.model,
    text: res.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    tool_calls: res.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: safeId(b.id), name: b.name, arguments: JSON.stringify(b.input ?? {}) }] : [])),
    reasoning: thinking.length ? JSON.stringify(thinking) : null,
    stop_reason: res.stop_reason ?? 'end_turn',
    usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
    spend: { usd: snap.usd, cap_usd: snap.cap_usd },
  }
}

async function openai(cfg: AiConfig, model: string, system: string, prompt: string, maxTokens: number, timeoutMs: number) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      // Gateway models may reason hidden and spend max_tokens on it; leave generous headroom.
      max_tokens: Math.max(maxTokens, 4000),
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new AiUnavailable(`model endpoint ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
  const text = body.choices?.[0]?.message?.content ?? ''
  if (!text) throw new AiUnavailable(`model ${model} returned an empty answer`)
  return text
}

// Claude 5.5 models: thinking is always on (effort controls depth and it counts against max_tokens),
// and temperature is rejected, so neither is sent. Opus/Sonnet get the "default" server-side
// fallbacks so a classifier refusal is re-run on a fallback model inside the same call.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])

async function anthropic(
  client: Anthropic,
  ledger: SpendLedger,
  cfg: AiConfig,
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
) {
  try {
    ledger.assertBudget()
  } catch (e) {
    if (e instanceof SpendCapReached) throw new AiUnavailable(e.message)
    throw e
  }
  const fallback = FALLBACK_MODELS.has(model)
  let res: Anthropic.Beta.BetaMessage
  try {
    res = await client.beta.messages.create(
      {
        model,
        max_tokens: Math.max(maxTokens, 8000),
        system,
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort: cfg.effort },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { timeout: timeoutMs },
    )
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new AiUnavailable(`Anthropic ${e.status ?? ''}: ${e.message.slice(0, 160)}`)
    throw e
  }
  ledger.record(model, res.usage)
  if (res.stop_reason === 'refusal') throw new AiUnavailable(`model ${model} declined (${res.stop_details?.category ?? 'no category'})`)
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  if (!text) throw new AiUnavailable(`model ${model} returned an empty answer (stop: ${res.stop_reason})`)
  return text
}
