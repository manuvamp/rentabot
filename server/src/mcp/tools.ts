// MCP tools generated from the operation catalog (one tool per op whose surfaces include "mcp").
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { randomBytes } from 'node:crypto'
import { OpError, type Principal } from '../core/types.ts'
import { toOpError, type AnyOp, type Gateway } from '../http/gateway.ts'
import { summarize } from './content.ts'

/** Per-connection state. `principal` is mutable: register_agent upgrades it. */
export interface McpSession {
  id: string
  principal: Principal
  /** The Authorization header value the principal was resolved from (to notice a changed key). */
  credential: string | null
  ip: string
  lastSeen: number
  setPrincipal(p: Principal): void
}

export const reqId = () => 'req_' + randomBytes(6).toString('hex')

export function errorResult(err: OpError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.toBody()) }] }
}

export function successResult(op: AnyOp, out: unknown, note = ''): CallToolResult {
  const text = `${summarize(op, out)}${note ? ' ' + note : ''}\n${JSON.stringify(out)}`
  return { content: [{ type: 'text', text }], structuredContent: out as Record<string, unknown> }
}

/**
 * Register every enabled op as a tool, then take over tools/call so that errors keep their structured
 * OpError body (the SDK default flattens invalid input into a plain string) and so register_agent can
 * upgrade the session. tools/list still comes from the SDK registry (JSON Schema from the zod shapes).
 */
export function registerTools(mcp: McpServer, sess: McpSession, gw: Gateway, ops: AnyOp[], log?: { warn(o: unknown, m?: string): void }): void {
  const enabled = new Map(ops.map((o) => [o.name, o]))
  for (const op of ops) {
    mcp.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        inputSchema: op.input.shape,
        outputSchema: op.output.shape,
        annotations: { title: op.title, ...op.annotations },
      },
      // Never reached: tools/call is handled below.
      async () => errorResult(new OpError('internal', 'unreachable', '')),
    )
  }

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name
    const requestId = reqId()
    const op = enabled.get(name)
    if (!op) {
      return errorResult(new OpError('not_found', `Unknown tool "${name}".`, 'Call tools/list. A tool can also be hidden by this connection\'s toolsets or readonly setting.'))
    }
    sess.lastSeen = Date.now()
    try {
      gw.limit(sess.principal, sess.ip)
      const out = await gw.run(op, request.params.arguments ?? {}, { principal: sess.principal, surface: 'mcp', requestId, ip: sess.ip })
      let note = ''
      if (op.name === 'register_agent') {
        const agent = (out as { agent?: { id?: string; owner_id?: string | null } }).agent
        if (agent?.id) {
          sess.setPrincipal({ kind: 'agent', agent_id: agent.id, owner_id: agent.owner_id ?? null })
          note = `This session is now authenticated as ${agent.id}: no reconnect needed. Save api_key to reconnect later.`
        }
      }
      return successResult(op, out, note)
    } catch (e) {
      const err = toOpError(e, requestId)
      if (err.code === 'internal') log?.warn({ op: name, request_id: requestId, err: e instanceof Error ? e.message : String(e) }, 'mcp tool failed')
      return errorResult(err)
    }
  })
}
