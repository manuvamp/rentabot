// Shared test plumbing: a live Fastify instance on a random port over the stub core, and an MCP client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance } from 'fastify'
import { buildApp, type AppOptions } from '../../src/http/app.ts'
import { createStubCore, type StubCore, type StubOptions } from './stub-core.ts'

export interface Live {
  base: string
  app: FastifyInstance
  core: StubCore
  clients: Client[]
  /** Connect an MCP client; `query` is appended to /mcp, `key` becomes the Bearer header. */
  mcp(opts?: { key?: string; query?: string }): Promise<Client>
  close(): Promise<void>
}

export async function startLive(stub: StubOptions = {}, appOpts: AppOptions = {}): Promise<Live> {
  const core = createStubCore(stub)
  const app = await buildApp(core, { logger: false, strictOutput: true, ...appOpts })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  ;(core.config as { publicUrl: string }).publicUrl = base
  const clients: Client[] = []
  return {
    base,
    app,
    core,
    clients,
    async mcp({ key, query = '' } = {}) {
      const client = new Client({ name: 'adapter-test', version: '0.0.0' }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp${query}`), key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : {})
      await client.connect(transport)
      clients.push(client)
      return client
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
      await app.close()
    },
  }
}

/** Parse the JSON body of a tool result (error text, or the JSON line after the summary). */
export function toolJson(res: CallToolResult): any {
  const text = (res.content as { type: string; text: string }[])[0]!.text
  const nl = text.indexOf('\n')
  return JSON.parse(res.isError ? text : text.slice(nl + 1))
}

export const post = (base: string, op: string, body: unknown, key?: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/ops/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: JSON.stringify(body) })
