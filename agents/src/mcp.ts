// Thin MCP client plumbing shared by the LLM agent and the scripted buyer: connect, call, and log compactly.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { lockerClient } from '@rentabot/shared'

export type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

/** Locker helpers for agents (end-to-end put/open, key registration): docs/SECURITY.md. */
export { lockerClient, sealForRecipients, openWithPrivateKey, generateLockerKeyPair, exportPublicJwk, newLockerItemId, makeRecoveryKit, openRecoveryKit } from '@rentabot/shared'
export type { LockerKey, LockerSecret } from '@rentabot/shared'

/** The locker over an MCP client: `lockerFor(client).put({...})` encrypts for the seller's keys when it has any. */
export const lockerFor = (client: Client) => lockerClient(async (name, args) => {
  const out = await callTool(client, name, args)
  if (!out.ok) throw new Error(out.summary)
  return out.data
})

export async function connectBuyer(url: string, key: string, toolset = 'buyer', name = 'orano-growth-agent'): Promise<Client> {
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} })
  const endpoint = new URL(`${url.replace(/\/+$/, '')}/mcp`)
  if (toolset) endpoint.searchParams.set('toolsets', toolset)
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }))
  return client
}

export interface ToolOutcome {
  ok: boolean
  /** The full text block (summary line + JSON, or the JSON error body). */
  text: string
  /** structuredContent on success, the parsed error body on failure. */
  data: Json
  /** One line for transcripts. */
  summary: string
}

export function readOutcome(res: CallToolResult): ToolOutcome {
  const text = ((res.content ?? []) as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  let data: Json = res.structuredContent ?? null
  if (res.isError || data === null) {
    try {
      data = JSON.parse(res.isError ? text : text.slice(text.indexOf('\n') + 1))
    } catch {
      data = null
    }
  }
  const summary = res.isError ? `ERROR ${data?.error?.code ?? ''}: ${data?.error?.message ?? text}`.trim() : (text.split('\n')[0] ?? '')
  return { ok: !res.isError, text, data, summary: clip(summary, 200) }
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<ToolOutcome> {
  try {
    const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult
    return readOutcome(res)
  } catch (err) {
    // Transport or protocol failure: shape it like a tool error so callers (and models) can react.
    const message = err instanceof Error ? err.message : String(err)
    const body = { error: { code: 'internal', message, hint: 'Retry once; if it fails again, stop and report.', next_actions: [] } }
    return { ok: false, text: JSON.stringify(body), data: body, summary: clip(`ERROR transport: ${message}`, 200) }
  }
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + '...' : s)

/** Compact args for a transcript line; secret values are never shown. */
export function compactArgs(name: string, args: Record<string, unknown>, n = 160): string {
  const shown = { ...args }
  for (const k of ['value', 'secret', 'ciphertext', 'wraps'] as const) if (k in shown && (name === 'share_secret' || name === 'put_locker_item')) shown[k] = '<redacted>'
  return clip(JSON.stringify(shown, (_k, v) => (typeof v === 'string' && v.length > 60 ? v.slice(0, 57) + '...' : v)), n)
}

export interface TranscriptEntry {
  step: number
  tool: string
  args: string
  ok: boolean
  summary: string
}

export function formatEntry(e: TranscriptEntry): string {
  return `[${String(e.step).padStart(2, '0')}] ${e.tool} ${e.args}\n     ${e.ok ? '->' : '!!'} ${e.summary}`
}
