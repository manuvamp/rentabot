// The bots' only door into the marketplace: the public MCP endpoint, seller toolset.
//   <url>/mcp?toolsets=seller  with  Authorization: Bearer <key>
// `RabClient.call(name, args)` returns the tool's structured result or throws a RabError carrying the
// server's error code, hint and next_actions. Transient failures (network, rate_limited, internal) are
// retried with backoff; a dropped MCP session is re-established once.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Job, Message, NextAction, Role } from '@rentabot/shared'
import { registerSecret } from './log.ts'
import { lockerClient, type LockerKey } from '@rentabot/shared'

/**
 * The credential locker for a bot: register a key, hand over accounts the bot created (end-to-end for the buyer's keys,
 * else sealed), open access items. See docs/SECURITY.md. Never log or post what open() returns.
 */
export const lockerFor = (client: RabClient) => lockerClient((name, args) => client.call(name, args))
export type { LockerKey }
export { lockerClient, sealForRecipients, openWithPrivateKey, generateLockerKeyPair, exportPublicJwk, newLockerItemId, secretAsString } from '@rentabot/shared'

export class RabError extends Error {
  readonly code: string
  readonly hint: string
  readonly nextActions: NextAction[]
  constructor(code: string, message: string, hint = '', nextActions: NextAction[] = []) {
    super(message)
    this.code = code
    this.hint = hint
    this.nextActions = nextActions
  }
  /** Worth retrying later with the same input. */
  get transient(): boolean {
    return this.code === 'rate_limited' || this.code === 'internal' || this.code === 'network'
  }
}

export interface JobView {
  job: Job
  your_role: Role
  next_actions: NextAction[]
}

export interface RabClient {
  readonly url: string
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<T> // eslint-disable-line @typescript-eslint/no-explicit-any
  getInstructions(): string | undefined
  close(): Promise<void>
}

export interface ConnectOptions {
  url: string
  key: string
  clientName?: string
  toolsets?: string
  /** Retry transient failures this many times (default 4). */
  retries?: number
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function parseToolError(res: { content?: unknown }): RabError {
  const text = ((res.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? '').join('\n')
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string; hint?: string; next_actions?: NextAction[] } }
    if (body.error) return new RabError(body.error.code ?? 'internal', body.error.message ?? text, body.error.hint ?? '', body.error.next_actions ?? [])
  } catch {
    /* not JSON */
  }
  return new RabError('internal', text.slice(0, 300) || 'tool error')
}

export async function connectRab(opts: ConnectOptions): Promise<RabClient> {
  registerSecret(opts.key)
  const base = opts.url.replace(/\/+$/, '')
  const endpoint = new URL(`${base}/mcp?toolsets=${opts.toolsets ?? 'seller'}`)
  const retries = opts.retries ?? 4
  const sleep = opts.sleep ?? wait
  let client: Client | null = null
  let connecting: Promise<Client> | null = null

  const open = async (): Promise<Client> => {
    const c = new Client({ name: opts.clientName ?? 'rentabot-house-bots', version: '0.1.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${opts.key}` } } })
    await c.connect(transport)
    return c
  }
  const ensure = async (): Promise<Client> => {
    if (client) return client
    connecting ??= open().then(
      (c) => (client = c),
      (e) => {
        connecting = null
        throw e
      },
    )
    return connecting
  }
  const drop = async () => {
    const c = client
    client = null
    connecting = null
    await c?.close().catch(() => {})
  }

  await ensure()

  const callOnce = async (name: string, args: Record<string, unknown>) => {
    const c = await ensure()
    // Long polls need a long request timeout: wait_for_events can hold for 50 s.
    const res = await c.callTool({ name, arguments: args }, undefined, { timeout: name === 'wait_for_events' ? 90_000 : 60_000 })
    if (res.isError) throw parseToolError(res as { content?: unknown })
    if (res.structuredContent) return res.structuredContent
    const text = ((res.content as { text?: string }[] | undefined) ?? [])[0]?.text ?? ''
    const nl = text.indexOf('\n')
    return JSON.parse(nl >= 0 ? text.slice(nl + 1) : text)
  }

  return {
    url: base,
    getInstructions: () => client?.getInstructions(),
    async call(name, args = {}) {
      let lastErr: unknown
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return (await callOnce(name, args)) as never
        } catch (e) {
          lastErr = e
          if (e instanceof RabError) {
            if (!e.transient || attempt === retries) throw e
          } else {
            // Network or session trouble: reconnect and try again.
            await drop()
            if (attempt === retries) throw new RabError('network', `${name}: ${(e as Error).message}`)
          }
          await sleep(Math.min(8000, 400 * 2 ** attempt))
        }
      }
      throw lastErr
    },
    async close() {
      await drop()
    },
  }
}

// ---------- helpers over the tool results ----------

/** Messages of a job's room (the whole room, paged). */
export async function readRoom(rab: RabClient, jobId: string, afterSeq = -1): Promise<Message[]> {
  const out: Message[] = []
  let after = afterSeq
  for (let i = 0; i < 20; i++) {
    const r = await rab.call<{ messages: Message[] }>('get_messages', { job_id: jobId, after_seq: after, limit: 200 })
    out.push(...r.messages)
    if (r.messages.length < 200) break
    after = r.messages[r.messages.length - 1]!.seq
  }
  return out
}
