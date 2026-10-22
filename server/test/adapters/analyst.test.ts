// POST /api/analyst/turn: who may call it, the rate limit, the body limits, AI off, the spend cap, and the provider mappings.
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAnalyst } from '../../src/http/analyst.ts'
import { OpError, type Core } from '../../src/core/types.ts'
import { AiUnavailable, cleanToolSchema, toAnthropicMessages, toOpenAiMessages, type ChatRequest } from '../../src/intelligence/ai/provider.ts'

type Persona = 'arbiter' | 'owner' | 'seller'
const users: Record<string, { role: Persona; roles: ('owner' | 'arbiter')[]; id: string }> = {
  arb: { role: 'arbiter', roles: ['arbiter'], id: 'usr_arb' },
  own: { role: 'owner', roles: ['owner'], id: 'usr_own' },
  sel: { role: 'seller', roles: ['owner'], id: 'usr_sel' },
}

function fakeCore(opts: { demoMode?: boolean; ai?: 'on' | 'off' | 'capped'; calls?: ChatRequest[] } = {}): Core {
  const calls = opts.calls ?? []
  return {
    config: { publicUrl: 'http://x', paymentRail: 'simulated', aiProvider: opts.ai === 'off' ? 'none' : 'openai', demoMode: opts.demoMode ?? true },
    auth: {
      agentFromApiKey: async () => null,
      userFromSession: async (t: string) => (users[t] ? { kind: 'user' as const, user_id: users[t]!.id, name: t, roles: users[t]!.roles, act_as: 'agt_x' } : null),
      session: async (p: { kind: string; user_id?: string }) => {
        const u = Object.values(users).find((x) => x.id === p.user_id)
        return { user: u ? { id: u.id, name: u.id, role: u.role } : null, agents: [] }
      },
    },
    analyst: {
      enabled: opts.ai !== 'off',
      chat: async (req: ChatRequest) => {
        calls.push(req)
        if (opts.ai === 'capped') throw new AiUnavailable('AI spend cap reached: $20.00 of $20.00 this month')
        return { id: 'chat_1', model: 'm', text: 'ok', tool_calls: [], reasoning: null, stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    },
  } as unknown as Core
}

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
  while (apps.length) await apps.pop()!.close()
})

async function serve(core: Core, limits: { burst: number; perSecond: number } | false = false) {
  const app = Fastify({ logger: false })
  app.setErrorHandler((e, _req, reply) => (e instanceof OpError ? reply.code(e.status).send(e.toBody()) : reply.code(500).send({ error: { code: 'internal' } })))
  registerAnalyst(app, core, limits)
  apps.push(app)
  return app
}

const body = (extra: Record<string, unknown> = {}) => ({ system: 'You analyse.', messages: [{ role: 'user', text: 'hi' }], tools: [], ...extra })
const turn = (app: Awaited<ReturnType<typeof serve>>, who: string | null, payload: unknown = body()) =>
  app.inject({ method: 'POST', url: '/api/analyst/turn', payload: payload as object, headers: who ? { cookie: `rab_session=${who}` } : {} })

describe('POST /api/analyst/turn', () => {
  it('answers the arbiter, and the owner persona in demo mode only', async () => {
    const calls: ChatRequest[] = []
    const app = await serve(fakeCore({ calls }))
    const r = await turn(app, 'arb')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ text: 'ok', tool_calls: [] })
    expect(r.headers['cache-control']).toBe('no-store')
    expect(calls[0]!.system).toBe('You analyse.')
    expect((await turn(app, 'own')).statusCode).toBe(200)
    expect((await turn(app, 'sel')).statusCode).toBe(403)
    const prod = await serve(fakeCore({ demoMode: false }))
    expect((await turn(prod, 'own')).statusCode).toBe(403)
    expect((await turn(prod, 'arb')).statusCode).toBe(200)
  })

  it('refuses anonymous callers and bad cookies', async () => {
    const app = await serve(fakeCore())
    expect((await turn(app, null)).statusCode).toBe(401)
    expect((await turn(app, 'nobody')).statusCode).toBe(401)
  })

  it('says so when AI is off, and when the monthly spend cap is reached', async () => {
    const off = await serve(fakeCore({ ai: 'off' }))
    const r = await turn(off, 'arb')
    expect(r.statusCode).toBe(409)
    expect(r.json().error.message).toMatch(/AI is off/)
    const capped = await serve(fakeCore({ ai: 'capped' }))
    const c = await turn(capped, 'arb')
    expect(c.statusCode).toBe(409)
    expect(c.json().error.message).toMatch(/spend cap reached/)
  })

  it('rate-limits per person', async () => {
    const app = await serve(fakeCore(), { burst: 2, perSecond: 0.001 })
    expect((await turn(app, 'arb')).statusCode).toBe(200)
    expect((await turn(app, 'arb')).statusCode).toBe(200)
    const limited = await turn(app, 'arb')
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error.code).toBe('rate_limited')
    expect((await turn(app, 'own')).statusCode).toBe(200) // another person has their own bucket
  })

  it('rejects malformed or oversized turns before any model call', async () => {
    const calls: ChatRequest[] = []
    const app = await serve(fakeCore({ calls }))
    expect((await turn(app, 'arb', { system: 'x' })).statusCode).toBe(400)
    expect((await turn(app, 'arb', body({ messages: [] }))).statusCode).toBe(400)
    expect((await turn(app, 'arb', body({ tools: [{ name: 'bad name!', description: 'x', parameters: {} }] }))).statusCode).toBe(400)
    expect((await turn(app, 'arb', body({ messages: [{ role: 'user', text: 'x'.repeat(60_001) }] }))).statusCode).toBe(400)
    const many = Array.from({ length: 11 }, () => ({ role: 'user', text: 'x'.repeat(59_000) }))
    expect((await turn(app, 'arb', body({ messages: many }))).statusCode).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('provider message mapping', () => {
  const req: ChatRequest = {
    system: 'S',
    tools: [],
    messages: [
      { role: 'user', text: 'why?' },
      { role: 'assistant', text: 'Checking.', tool_calls: [{ id: 'call.1', name: 'explain_net_dip', arguments: '{"period":"last_week"}' }], reasoning: JSON.stringify([{ type: 'thinking', thinking: 'hm', signature: 'sig' }]) },
      { role: 'tool', tool_call_id: 'call.1', content: '{"ok":true}' },
      { role: 'user', text: 'and?' },
    ],
  }

  it('anthropic: thinking first, tool_use input as an object, tool results merged into the next user turn', () => {
    const m = toAnthropicMessages(req)
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user'])
    expect(m[1]!.content).toEqual([
      { type: 'thinking', thinking: 'hm', signature: 'sig' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'explain_net_dip', input: { period: 'last_week' } },
    ])
    expect(m[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' }, { type: 'text', text: 'and?' }])
  })

  it('anthropic: keepReasoning false drops thinking blocks (retry path after a rejected signature)', () => {
    const m = toAnthropicMessages(req, { keepReasoning: false })
    expect(m[1]!.content).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'explain_net_dip', input: { period: 'last_week' } },
    ])
  })

  it('openai: system first, tool_calls with ids that match their results', () => {
    const m = toOpenAiMessages(req) as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]
    expect(m.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(m[2]!.tool_calls![0]!.id).toBe('call_1')
    expect(m[3]!.tool_call_id).toBe('call_1')
  })

  it('tool schemas lose the "undefined" sentinel and $schema, keeping $defs', () => {
    const s = cleanToolSchema({ $schema: 'x', type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { not: {} }] }, b: { $ref: '#/$defs/B' } }, $defs: { B: { type: 'number' } } })
    expect(s).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { $ref: '#/$defs/B' } }, $defs: { B: { type: 'number' } } })
    expect(cleanToolSchema(null)).toEqual({ type: 'object', properties: {} })
  })
})
