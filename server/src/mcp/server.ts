// The MCP endpoint: Streamable HTTP at /mcp (POST/GET/DELETE), stateful sessions, one McpServer per session.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { type Principal } from '../core/types.ts'
import { SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from '../discovery/meta.ts'
import { bearerFrom, resolvePrincipal } from '../http/auth.ts'
import { toOpError, type Gateway } from '../http/gateway.ts'
import { INSTRUCTIONS } from './content.ts'
import { registerPrompts } from './prompts.ts'
import { registerResources, Subscriptions } from './resources.ts'
import { parseSelection, selectOps } from './toolsets.ts'
import { registerTools, reqId, type McpSession } from './tools.ts'

export interface McpMountOptions {
  /** Close sessions with no request and no open stream for this long. Default 60 minutes. */
  idleMs?: number
  sweepMs?: number
}

interface Entry {
  sess: McpSession
  mcp: McpServer
  transport: StreamableHTTPServerTransport
  subs: Subscriptions
  openStreams: number
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null })

export function mountMcp(app: FastifyInstance, gw: Gateway, opts: McpMountOptions = {}): { sessionCount(): number } {
  const core = gw.core
  const sessions = new Map<string, Entry>()
  const idleMs = opts.idleMs ?? 60 * 60_000

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, e] of sessions) {
      if (e.openStreams === 0 && now - e.sess.lastSeen > idleMs) {
        sessions.delete(id)
        e.subs.closeAll()
        void e.transport.close().catch(() => {})
      }
    }
  }, opts.sweepMs ?? 60_000)
  sweep.unref()

  app.addHook('onClose', async () => {
    clearInterval(sweep)
    const all = [...sessions.values()]
    sessions.clear()
    for (const e of all) {
      e.subs.closeAll()
      await e.transport.close().catch(() => {})
    }
  })

  const reject = (reply: FastifyReply, status: number, code: number, message: string, extra: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(extra)) reply.header(k, v)
    return reply.code(status).send(rpcError(code, message))
  }

  /** Change the session identity when the request carries a different key than the one it started with. */
  async function refreshPrincipal(e: Entry, headers: Record<string, unknown>): Promise<boolean> {
    const cred = bearerFrom(headers as never)
    if (cred && cred !== e.sess.credential) {
      const p = await resolvePrincipal(core, headers as never)
      e.sess.credential = cred
      e.sess.setPrincipal(p)
    }
    return true
  }

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const sid = req.headers['mcp-session-id']
      try {
        if (typeof sid === 'string' && sid) {
          const e = sessions.get(sid)
          if (!e) return reject(reply, 404, -32001, 'Session not found or expired. Send a new initialize request.')
          await refreshPrincipal(e, req.headers)
          e.sess.lastSeen = Date.now()
          reply.hijack()
          if (req.method === 'GET') {
            e.openStreams++
            reply.raw.on('close', () => {
              e.openStreams--
              e.sess.lastSeen = Date.now()
            })
          }
          await e.transport.handleRequest(req.raw, reply.raw, req.body)
          return reply
        }

        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          return reject(reply, 400, -32000, 'No session. Start with a POST /mcp initialize request (Accept: application/json, text/event-stream).')
        }

        const sel = parseSelection(req.query as Record<string, unknown>)
        if ('error' in sel) return reject(reply, 400, -32602, sel.error)

        let principal: Principal
        try {
          principal = await resolvePrincipal(core, req.headers)
        } catch (err) {
          const oe = toOpError(err, req.id)
          return reject(reply, 401, -32001, `${oe.message} ${oe.hint}`, { 'www-authenticate': 'Bearer realm="rent-a-bot"' })
        }

        const mcp = new McpServer(
          { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
          {
            instructions: INSTRUCTIONS,
            capabilities: { tools: {}, resources: { subscribe: true, listChanged: false }, prompts: {} },
          },
        )
        let subs!: Subscriptions
        const sess: McpSession = {
          id: '',
          principal,
          credential: bearerFrom(req.headers),
          ip: req.ip,
          lastSeen: Date.now(),
          setPrincipal(p) {
            this.principal = p
            subs?.rebind()
          },
        }
        registerTools(mcp, sess, gw, selectOps(sel), req.log)
        registerResources(mcp, sess, gw)
        registerPrompts(mcp)
        subs = new Subscriptions(mcp, sess, gw)

        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sess.id = id
            sessions.set(id, { sess, mcp, transport, subs, openStreams: 0 })
          },
        })
        transport.onclose = () => {
          if (sess.id) sessions.delete(sess.id)
          subs.closeAll()
        }
        await mcp.connect(transport)
        reply.hijack()
        await transport.handleRequest(req.raw, reply.raw, req.body)
        return reply
      } catch (err) {
        const id = reqId()
        req.log.error({ request_id: id, err: err instanceof Error ? err.message : String(err) }, 'mcp request failed')
        if (!reply.sent && !reply.raw.headersSent) {
          if (reply.raw.writableEnded) return reply
          const oe = toOpError(err, id)
          return reject(reply, oe.code === 'unauthenticated' ? 401 : 500, -32603, oe.message)
        }
        return reply
      }
    },
  })

  return { sessionCount: () => sessions.size }
}
