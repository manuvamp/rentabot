// AgLlmAdapter for Rent-A-Bot: every model turn goes to POST /api/analyst/turn on our own server, which holds the provider key,
// checks who is asking, rate-limits and counts the call against the AI spend cap. The server answers a whole turn as JSON
// (no streaming), so this adapter replays it to Studio as the AG-UI events a streaming provider would have produced.
// The wire shape is provider-neutral: user / assistant / tool messages with tool calls; the server maps it to Anthropic
// Messages (production) or an OpenAI-compatible chat endpoint (dev).
import type { AgAiConversationItem, AgAiEvent, AgAiOutputItem, AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgLlmResponseHandler } from 'ag-studio'

interface WireCall {
  id: string
  name: string
  arguments: string
}
type WireMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; tool_calls?: WireCall[]; reasoning?: string | null }
  | { role: 'tool'; tool_call_id: string; content: string }
interface WireResult {
  id: string
  model: string
  text: string
  tool_calls: WireCall[]
  reasoning: string | null
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}

/** A reasoning item whose id carries the provider's opaque thinking blocks, so they survive the round trip through Studio's history. */
const REASONING_PREFIX = 'rab-r:'
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)))
const unb64 = (s: string) => decodeURIComponent(escape(atob(s)))

export function encodeConversation(items: AgAiConversationItem[]): WireMessage[] {
  const out: WireMessage[] = []
  const assistant = (): Extract<WireMessage, { role: 'assistant' }> => {
    const last = out.at(-1)
    if (last?.role === 'assistant') return last
    const a: Extract<WireMessage, { role: 'assistant' }> = { role: 'assistant' }
    out.push(a)
    return a
  }
  for (const it of items) {
    if (it.type === 'function_call_output') out.push({ role: 'tool', tool_call_id: it.callId, content: it.output })
    else if (it.kind === 'input' && it.type === 'message') {
      const text = it.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n').trim()
      out.push({ role: 'user', text: it.role === 'system' ? `[system] ${text}` : text })
    } else if (it.kind === 'output' && it.type === 'message') {
      const a = assistant()
      const text = it.content.map((c) => (c.type === 'text' ? c.text : c.refusal)).join('')
      if (text) a.text = a.text ? `${a.text}\n${text}` : text
    } else if (it.kind === 'output' && it.type === 'function_call') {
      const a = assistant()
      ;(a.tool_calls ??= []).push({ id: it.callId, name: it.name, arguments: it.arguments || '{}' })
    } else if (it.kind === 'output' && it.type === 'reasoning' && it.id.startsWith(REASONING_PREFIX)) {
      try {
        assistant().reasoning = unb64(it.id.slice(REASONING_PREFIX.length))
      } catch {
        /* unreadable blob: dropped */
      }
    }
  }
  return out.filter((m) => m.role !== 'user' || m.text)
}

function chunks(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

export function rabAdapter(opts: { endpoint: string }): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options): AgLlmResponseHandler {
      const signal = options?.signal
      let system = request.instructions ?? ''
      if (request.responseFormat?.type === 'json') system += `\n\nReply with ONLY one JSON object matching this JSON Schema:\n${JSON.stringify(request.responseFormat.schema)}`
      const tools = (request.tools ?? []).filter((t) => t.kind !== 'provided').map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
      const choice = request.toolChoice
      const body = {
        system,
        messages: encodeConversation(request.input),
        tools,
        ...(tools.length && choice ? { tool_choice: typeof choice === 'string' ? choice : { name: choice.name } } : {}),
      }
      // Start the request now: whether Studio reads the stream first or awaits `complete`, the turn runs once.
      const result: Promise<WireResult> = fetch(opts.endpoint, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal }).then(async (res) => {
        const text = await res.text()
        let json: unknown = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          /* not JSON */
        }
        if (!res.ok) {
          const e = (json as { error?: { message?: string; hint?: string } } | null)?.error
          throw new Error(e?.message ? `${e.message}${e.hint ? ` ${e.hint}` : ''}` : `The analyst endpoint answered ${res.status}.`)
        }
        return json as WireResult
      })
      void result.catch(() => {})

      const reasoningText = (r: WireResult): string => {
        try {
          return (JSON.parse(r.reasoning ?? '[]') as { thinking?: string }[]).map((b) => b.thinking ?? '').join('\n').trim()
        } catch {
          return ''
        }
      }
      const outputOf = (r: WireResult): AgAiOutputItem[] => [
        ...(r.reasoning ? [{ id: REASONING_PREFIX + b64(r.reasoning), kind: 'output' as const, type: 'reasoning' as const, summary: [], content: [{ type: 'text' as const, text: reasoningText(r) }] }] : []),
        ...(r.text ? [{ id: `msg_${r.id}`, kind: 'output' as const, type: 'message' as const, role: 'assistant' as const, status: 'completed' as const, content: [{ type: 'text' as const, text: r.text, annotations: [] }] }] : []),
        ...r.tool_calls.map((c) => ({ id: `fc_${c.id}`, kind: 'output' as const, type: 'function_call' as const, callId: c.id, name: c.name, arguments: c.arguments, status: 'completed' as const })),
      ]

      async function* events(): AsyncGenerator<AgAiEvent> {
        // A failed turn is reported once, through `complete`; the stream just ends.
        const r = await result.catch(() => null)
        if (!r) return
        if (r.reasoning) {
          const messageId = REASONING_PREFIX + b64(r.reasoning)
          yield { type: 'REASONING_MESSAGE_START', messageId, role: 'reasoning' }
          yield { type: 'REASONING_MESSAGE_CONTENT', messageId, delta: reasoningText(r) || '…' }
          yield { type: 'REASONING_MESSAGE_END', messageId }
        }
        if (r.text) {
          const messageId = `msg_${r.id}`
          yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' }
          for (const delta of chunks(r.text, 28)) {
            yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta }
            await pause(6, signal)
          }
          yield { type: 'TEXT_MESSAGE_END', messageId }
        }
        for (const c of r.tool_calls) {
          yield { type: 'TOOL_CALL_START', toolCallId: c.id, toolCallName: c.name }
          yield { type: 'TOOL_CALL_ARGS', toolCallId: c.id, delta: c.arguments }
          yield { type: 'TOOL_CALL_END', toolCallId: c.id }
        }
      }

      const complete: Promise<AgLlmResponse> = result.then((r) => ({
        id: r.id,
        createdAt: Date.now(),
        model: r.model,
        status: 'completed' as const,
        output: outputOf(r),
        usage: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, totalTokens: r.usage.input_tokens + r.usage.output_tokens },
      }))
      void complete.catch(() => {})
      const stream = events()
      return { stream: { [Symbol.asyncIterator]: () => stream }, complete }
    },
  }
}
