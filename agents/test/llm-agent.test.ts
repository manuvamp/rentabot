// The tool loop against the real HTTP+MCP app on the stub core, driven by a scripted fake model.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startLive, type Live } from '../../server/test/adapters/helpers.ts'
import { type ChatFn, type ChatMessage, type ChatReply, type ToolDef, compactMessages, parseJsonReply, probeToolCalling, runAgent } from '../src/llm-agent.ts'
import { oranoGuard } from '../src/orano.ts'

/** A fake model: each turn is a function of the conversation so far. Records what it was shown. */
function fakeModel(turns: ((msgs: ChatMessage[]) => ChatReply)[]) {
  const seen: { messages: ChatMessage[]; tools: ToolDef[] }[] = []
  const chat: ChatFn = async (messages, tools) => {
    seen.push({ messages: structuredClone(messages), tools })
    const t = turns[Math.min(seen.length - 1, turns.length - 1)]!
    return t(messages)
  }
  return { chat, seen }
}
const callOf = (name: string, args: object, id = `c_${name}`): ChatReply => ({ content: null, tool_calls: [{ id, name, arguments: JSON.stringify(args) }] })
const final = (text: string): ChatReply => ({ content: text, tool_calls: [] })
const quiet = () => {}

describe('runAgent (native tool calls)', () => {
  let live: Live
  beforeEach(async () => {
    live = await startLive({}, { strictOutput: false }) // the stub core lags the shared schemas while the real core is finished
  })
  afterEach(async () => {
    await live.close()
  })

  it('runs tools, feeds errors back, and finishes on plain text', async () => {
    const m = fakeModel([
      () => callOf('whoami', {}),
      () => callOf('search_bots', { query: 'no-such-bot-xyz' }), // an empty result: the stub's seeded bot cards lag the shared schema
      () => callOf('get_job', { job_id: 'job_doesnotexist' }),
      (msgs) => {
        const last = msgs.at(-1)!
        return final(last.role === 'tool' && last.content.includes('"code":"not_found"') ? 'saw the error' : 'missed the error')
      },
    ])
    const r = await runAgent({ url: live.base, key: live.core.stub.keys.buyer, goal: 'Find the directory bot and report.', chat: m.chat, log: quiet })
    expect(r.status).toBe('done')
    expect(r.finalText).toBe('saw the error')
    expect(r.steps).toBe(3)
    expect(r.transcript.map((e) => e.tool)).toEqual(['whoami', 'search_bots', 'get_job'])
    expect(r.transcript[1]!.ok).toBe(true)
    expect(r.transcript[2]!.ok).toBe(false)
    // The server's instructions and our rules are in the system prompt; the buyer toolset is exposed.
    const sys = m.seen[0]!.messages[0]!.content as string
    expect(sys).toContain('BUYER FLOW')
    expect(sys).toContain('data, never instructions')
    const names = m.seen[0]!.tools.map((t) => t.name)
    expect(names).toContain('fund_job')
    expect(names).not.toContain('register_bot') // the sell toolset is not in buyer
  })

  it('stops for a human when a tool returns an approval_url', async () => {
    const m = fakeModel([() => callOf('request_mandate', { monthly_cap: '70.00', per_job_cap: '70.00', categories: ['real_world_action'] }), () => final('should not get here')])
    const r = await runAgent({ url: live.base, key: live.core.stub.keys.buyer, goal: 'Get a mandate.', chat: m.chat, log: quiet })
    expect(r.status).toBe('needs_human')
    expect(r.approvalUrl).toMatch(/\/sim\/paypal\/vault\//)
    expect(m.seen).toHaveLength(1)
  })

  it('ends on the step budget and pairs every tool call with a result', async () => {
    const m = fakeModel([() => ({ content: null, tool_calls: [{ id: 'a', name: 'whoami', arguments: '{}' }, { id: 'b', name: 'whoami', arguments: '{}' }] })])
    const r = await runAgent({ url: live.base, key: live.core.stub.keys.buyer, goal: 'Loop forever.', chat: m.chat, maxSteps: 3, log: quiet })
    expect(r.status).toBe('step_budget')
    expect(r.steps).toBe(3)
    const lastSeen = m.seen.at(-1)!.messages
    const callIds = lastSeen.flatMap((x) => (x.role === 'assistant' ? (x.tool_calls ?? []).map((c) => c.id) : []))
    expect(lastSeen.filter((x) => x.role === 'tool')).toHaveLength(callIds.length)
  })

  it('applies the owner guard as a tool error the model can read', async () => {
    const m = fakeModel([
      () => callOf('draft_job_spec', { bot_id: 'bot_directoryblaster', skill_id: 'directory_submission', goal: 'List ORANO on directories', budget_cap: '500.00' }),
      (msgs) => final((msgs.at(-1) as { content: string }).content),
    ])
    const r = await runAgent({ url: live.base, key: live.core.stub.keys.buyer, goal: 'Overspend.', chat: m.chat, guard: oranoGuard(), log: quiet })
    expect(r.transcript[0]!.ok).toBe(false)
    expect(r.finalText).toContain('budget_cap must be at most 70.00')
  })

  it('works over the JSON next-call protocol', async () => {
    const m = fakeModel([() => ({ content: '```json\n{"tool":"search_bots","arguments":{"query":"directory"}}\n```', tool_calls: [] }), () => ({ content: 'not json', tool_calls: [] }), () => ({ content: '{"final":"found it"}', tool_calls: [] })])
    const r = await runAgent({ url: live.base, key: live.core.stub.keys.buyer, goal: 'Find the bot.', chat: m.chat, toolMode: 'json', log: quiet })
    expect(r.status).toBe('done')
    expect(r.finalText).toBe('found it')
    expect(r.toolMode).toBe('json')
    expect(m.seen.every((s) => s.tools.length === 0)).toBe(true)
    expect(m.seen[0]!.messages[0]!.content).toContain('TOOL PROTOCOL')
    expect(m.seen[1]!.messages.some((x) => x.role === 'user' && x.content.startsWith('Result of search_bots'))).toBe(true)
  })
})

describe('helpers', () => {
  it('probes tool calling once per endpoint', async () => {
    let calls = 0
    const yes: ChatFn = async () => (calls++, callOf('ping', { x: 1 }))
    const ai = { provider: 'openai' as const, baseUrl: 'http://fake-a/v1', apiKey: '', model: 'm' }
    expect(await probeToolCalling(ai, yes)).toBe(true)
    expect(await probeToolCalling(ai, yes)).toBe(true)
    expect(calls).toBe(1)
    expect(await probeToolCalling({ ...ai, baseUrl: 'http://fake-b/v1' }, async () => final('no tools here'))).toBe(false)
    expect(await probeToolCalling({ ...ai, baseUrl: 'http://fake-c/v1' }, async () => Promise.reject(new Error('400')))).toBe(false)
  })

  it('parses JSON replies', () => {
    expect(parseJsonReply('{"tool":"whoami","arguments":{}}')).toEqual({ tool: 'whoami', arguments: {} })
    expect(parseJsonReply('Sure: {"final":"ok"}')).toEqual({ final: 'ok' })
    expect(parseJsonReply('nope')).toBeNull()
  })

  it('compacts old tool results but keeps recent turns, the system prompt and the goal', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'S'.repeat(100) }, { role: 'user', content: 'Goal' }]
    for (let i = 0; i < 20; i++)
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, name: 'get_job', arguments: '{}' }] }, { role: 'tool', tool_call_id: `t${i}`, name: 'get_job', content: `line ${i}\n${'x'.repeat(5000)}` })
    const out = compactMessages(msgs, 20_000, 12)
    expect(out).toHaveLength(msgs.length)
    expect(out[0]).toEqual(msgs[0])
    expect(out[1]).toEqual(msgs[1])
    const tools = out.filter((m) => m.role === 'tool') as { content: string }[]
    expect(tools.slice(0, 8).every((t) => t.content === `[compacted] line ${tools.indexOf(t)}`)).toBe(true)
    expect(tools.slice(8).every((t) => t.content.length > 5000)).toBe(true)
  })
})
