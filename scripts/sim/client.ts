// One caller interface over both surfaces: REST (POST /api/ops/<name>) and MCP (SDK Client +
// StreamableHTTPClientTransport). Every call is timed, every success is validated against the op's
// output schema from @rentabot/shared, and every error body against OpErrorBody (code, message, hint).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { OpErrorBody, opByName, type OpName } from '../../shared/src/ops.ts'

export type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
export type Surface = 'rest' | 'mcp'

export interface Res {
  ok: boolean
  data: Json
  code: string | null
  message: string
  ms: number
  surface: Surface
}

export class Stats {
  lat = new Map<string, number[]>()
  errors = new Map<string, number>()
  /** Calls whose error was not one the scenario expected (code → samples). */
  unexpected: { op: string; code: string; message: string; job?: string }[] = []
  schema: { op: string; surface: Surface; issues: string }[] = []
  errorShape: { op: string; surface: Surface; body: string }[] = []
  calls = { rest: 0, mcp: 0 }
  rateLimited = 0
  transport: { op: string; surface: Surface; message: string }[] = []

  record(op: string, surface: Surface, ms: number) {
    this.calls[surface]++
    const k = `${op}`
    const a = this.lat.get(k) ?? []
    a.push(ms)
    this.lat.set(k, a)
  }
  error(code: string) {
    this.errors.set(code, (this.errors.get(code) ?? 0) + 1)
  }
}

const REST_ONLY = new Set(['claim_agent', 'arbiter_decide', 'get_platform_ledger'])

export class Api {
  private mcp: Client | null = null
  private connecting: Promise<Client> | null = null
  constructor(
    readonly name: string,
    readonly base: string,
    readonly auth: { key?: string; cookie?: string },
    readonly surface: Surface,
    readonly stats: Stats,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (this.auth.key) h.authorization = `Bearer ${this.auth.key}`
    if (this.auth.cookie) h.cookie = this.auth.cookie
    return h
  }

  private async client(): Promise<Client> {
    if (this.mcp) return this.mcp
    this.connecting ??= (async () => {
      const c = new Client({ name: `sim-${this.name}`, version: '0.1.0' }, { capabilities: {} })
      const url = new URL(`${this.base}/mcp`)
      url.searchParams.set('toolsets', 'all')
      await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: this.auth.key ? { Authorization: `Bearer ${this.auth.key}` } : {} } }))
      // Lets the SDK validate structuredContent against each tool's outputSchema on every call.
      await c.listTools()
      this.mcp = c
      return c
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async close() {
    const c = this.mcp
    this.mcp = null
    if (c) await c.close().catch(() => {})
  }

  /** Call an op; transparently retries rate_limited (counted) up to 8 times. */
  async call(op: OpName, args: Record<string, unknown> = {}): Promise<Res> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.once(op, args)
      if (r.code === 'rate_limited' && attempt < 8) {
        this.stats.rateLimited++
        await sleep(1000 + attempt * 500)
        continue
      }
      return r
    }
  }

  private async once(op: OpName, args: Record<string, unknown>): Promise<Res> {
    const surface: Surface = this.surface === 'mcp' && !REST_ONLY.has(op) ? 'mcp' : 'rest'
    const t0 = performance.now()
    let ok = false
    let data: Json = null
    let errBody: Json = null
    if (surface === 'rest') {
      let status = 0
      let text = ''
      for (let net = 0; ; net++) {
        try {
          const r = await fetch(`${this.base}/api/ops/${op}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(args), signal: AbortSignal.timeout(120_000) })
          status = r.status
          text = await r.text()
          break
        } catch (e) {
          if (net < 2) {
            await sleep(500)
            continue
          }
          this.stats.transport.push({ op, surface, message: e instanceof Error ? e.message : String(e) })
          return { ok: false, data: null, code: 'transport', message: e instanceof Error ? e.message : String(e), ms: performance.now() - t0, surface }
        }
      }
      let body: Json = null
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      if (status >= 200 && status < 300) {
        ok = true
        data = body
      } else errBody = body ?? { raw: text.slice(0, 300) }
    } else {
      try {
        const c = await this.client()
        const timeout = op === 'wait_for_events' ? ((args.timeout_seconds as number | undefined) ?? 25) * 1000 + 30_000 : 120_000
        const res = (await c.callTool({ name: op, arguments: args }, undefined, { timeout })) as Json
        const text = ((res.content ?? []) as Json[]).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n')
        if (res.isError) {
          try {
            errBody = JSON.parse(text)
          } catch {
            errBody = { raw: text.slice(0, 300) }
          }
        } else {
          ok = true
          data = res.structuredContent ?? null
          if (data === null) this.stats.schema.push({ op, surface, issues: 'success without structuredContent' })
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // The SDK throws when structuredContent does not match the tool's declared outputSchema.
        if (/output schema|structured content/i.test(msg)) this.stats.schema.push({ op, surface, issues: `MCP client: ${msg.slice(0, 400)}` })
        else this.stats.transport.push({ op, surface, message: msg.slice(0, 300) })
        await this.close()
        return { ok: false, data: null, code: 'transport', message: msg, ms: performance.now() - t0, surface }
      }
    }
    const ms = performance.now() - t0
    this.stats.record(op, surface, ms)
    if (ok) {
      const def = opByName[op]
      const chk = def.output.safeParse(data)
      if (!chk.success) this.stats.schema.push({ op, surface, issues: chk.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
      return { ok, data, code: null, message: '', ms, surface }
    }
    const parsed = OpErrorBody.safeParse(errBody)
    if (!parsed.success || !parsed.data.error.message.trim() || !parsed.data.error.hint.trim()) this.stats.errorShape.push({ op, surface, body: JSON.stringify(errBody).slice(0, 300) })
    const code = errBody?.error?.code ?? 'malformed_error'
    this.stats.error(code)
    return { ok: false, data: errBody, code, message: String(errBody?.error?.message ?? ''), ms, surface }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Raw HTTP helper for non-op routes (sessions, simulated PayPal, public stats, artifacts). */
export async function http(base: string, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: 'manual',
    })
    const text = await r.text()
    let json: Json = null
    try {
      json = JSON.parse(text)
    } catch {}
    if (r.status === 429 && i < 10) {
      await sleep(1200)
      continue
    }
    return { status: r.status, json, text, headers: r.headers }
  }
}
