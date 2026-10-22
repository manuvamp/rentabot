import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPS } from '@rentabot/shared'
import { startLive, type Live } from './helpers.ts'

let live: Live
beforeAll(async () => {
  live = await startLive({ publicUrl: 'https://rentabot.example' })
})
afterAll(async () => {
  await live.close()
})

const mcpOps = OPS.filter((o) => (o.surfaces as readonly string[]).includes('mcp'))
const restOps = OPS.filter((o) => (o.surfaces as readonly string[]).includes('rest'))
const getText = async (path: string) => {
  const r = await fetch(`${live.base}${path}`)
  expect(r.status, path).toBe(200)
  return { text: await r.text(), type: r.headers.get('content-type') ?? '' }
}

describe('discovery files', () => {
  it('llms.txt explains MCP and REST with URLs built from the public URL', async () => {
    const { text, type } = await getText('/llms.txt')
    expect(type).toContain('text/plain')
    expect(text.startsWith('# Rent-A-Bot')).toBe(true)
    for (const needle of ['https://rentabot.example/mcp', 'claude mcp add --transport http rentabot', 'toolsets=buyer', 'wait_for_events', 'https://rentabot.example/openapi.json', 'register_agent', '/api/ops/'])
      expect(text, needle).toContain(needle)
    expect(text).not.toContain('127.0.0.1')
  })

  it('llms-full.txt lists every op with its description and input schema', async () => {
    const { text } = await getText('/llms-full.txt')
    for (const op of OPS) {
      expect(text, op.name).toContain(`### ${op.name}:`)
      expect(text, op.name).toContain(op.description.slice(0, 40))
    }
    expect((text.match(/Input JSON Schema:/g) ?? []).length).toBe(OPS.length)
  })

  it('openapi.json is a valid OpenAPI 3.1 document for the REST surface', async () => {
    const { text, type } = await getText('/openapi.json')
    expect(type).toContain('application/json')
    const doc = JSON.parse(text)
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.servers[0].url).toBe('https://rentabot.example')
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' })
    expect(doc.components.securitySchemes.cookie).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'rab_session' })
    expect(doc.components.schemas.Error.properties.error).toBeTruthy()
    for (const op of restOps) {
      const item = doc.paths[`/api/ops/${op.name}`]
      expect(item?.post?.operationId, op.name).toBe(op.name)
      expect(item.post.responses['200'].content['application/json'].schema.type).toBe('object')
      expect(item.post.responses['401']).toBeTruthy()
      if (op.annotations.readOnlyHint) expect(item.get, op.name).toBeTruthy()
      else expect(item.get, op.name).toBeUndefined()
    }
    expect(doc.paths['/api/ops/register_agent'].post.security).toContainEqual({})
    expect(doc.paths['/api/ops/fund_job'].post.security).toEqual([{ bearer: [] }, { cookie: [] }])
    expect(doc.paths['/api/ops/wait_for_events'].get.parameters.map((p: any) => p.name)).toContain('after_cursor')
    expect(doc.paths['/api/events/stream']).toBeTruthy()
    // every $ref resolves
    const refs = [...text.matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1]!.split('/'))
    for (const ref of refs) expect(ref.reduce((o: any, k) => o?.[k], doc), ref.join('/')).toBeTruthy()
  })

  it('agent.json is an A2A AgentCard with one skill per toolset', async () => {
    const card = JSON.parse((await getText('/.well-known/agent.json')).text)
    for (const k of ['name', 'description', 'url', 'version', 'capabilities', 'skills', 'provider', 'securitySchemes', 'defaultInputModes']) expect(card[k], k).toBeTruthy()
    expect(card.url).toBe('https://rentabot.example/mcp')
    expect(card.skills.map((s: any) => s.id).sort()).toEqual(['account', 'discover', 'dispute', 'escrow', 'jobs', 'negotiate', 'review', 'sell', 'work'])
    expect(card.skills.every((s: any) => s.examples.length > 0 && s.description)).toBe(true)
    expect(JSON.parse((await getText('/.well-known/agent-card.json')).text)).toEqual(card)
  })

  it('mcp.json describes the server and matches what the live MCP server exposes', async () => {
    const card = JSON.parse((await getText('/.well-known/mcp.json')).text)
    expect(card).toMatchObject({ name: 'rent-a-bot', transport: 'streamable-http', endpoint: 'https://rentabot.example/mcp', tool_count: mcpOps.length })
    expect(card.authentication).toMatchObject({ type: 'bearer', self_onboarding_tool: 'register_agent' })
    expect(Object.keys(card.toolsets).sort()).toEqual(['all', 'buyer', 'seller'])
    expect(card.toolsets.all.tools).toHaveLength(mcpOps.length)
    const c = await live.mcp({ key: live.core.stub.keys.buyer })
    for (const t of ['buyer', 'seller'] as const) {
      const c2 = await live.mcp({ query: `?toolsets=${t}` })
      expect(card.toolsets[t].tools.sort(), t).toEqual((await c2.listTools()).tools.map((x) => x.name).sort())
    }
    const live_ = (await c.listResources()).resources.map((r) => r.uri)
    for (const r of card.resources) expect(live_, r.uri).toContain(r.uri)
    expect((await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(card.resource_templates.map((t: any) => t.uriTemplate).sort())
    expect((await c.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(card.prompts.map((p: any) => p.name).sort())
  }, 30_000) // opens four MCP sessions; takes 6 to 7 s on a loaded machine, over vitest's 5 s default
})
