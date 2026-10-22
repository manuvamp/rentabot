// The in-process bots reach a model only through the server's capped AI client.
import { describe, expect, it } from 'vitest'
import { aiFromClient, type CappedAiClient } from '../src/server-ai.ts'
import { createAiClient, readAiConfig } from '../../server/src/intelligence/ai/provider.ts'

describe('aiFromClient', () => {
  it('sends the bot prompt through the client (no temperature, the configured model) and returns the plain text', async () => {
    const seen: Parameters<CappedAiClient['askJson']>[0][] = []
    const client: CappedAiClient = {
      enabled: true,
      config: { models: { fast: 'claude-haiku-5-5', main: 'claude-sonnet-5-5' } },
      async askJson(call) {
        seen.push(call)
        return call.schema.parse({ text: 'Thanks, the verified amount is fine.' }) as never
      },
    }
    const ai = aiFromClient(client)
    expect(ai.enabled).toBe(true)
    expect(await ai.complete({ system: 'You are a bot.', user: 'Say thanks.', maxTokens: 200, temperature: 0 })).toBe('Thanks, the verified amount is fine.')
    expect(seen[0]).toMatchObject({ model: 'claude-sonnet-5-5', prompt: 'Say thanks.', maxTokens: 200 })
    expect(seen[0]!.system).toContain('You are a bot.')
    expect(seen[0]).not.toHaveProperty('temperature')
    await aiFromClient(client, { tier: 'fast' }).complete({ system: 's', user: 'u' })
    expect(seen[1]!.model).toBe('claude-haiku-5-5')
  })

  it('wraps the real server client: disabled without a provider, and a call fails (so bots fall back) instead of reaching out', async () => {
    const client = createAiClient(readAiConfig({ AI_PROVIDER: 'none' }))
    const ai = aiFromClient(client)
    expect(ai.enabled).toBe(false)
    await expect(ai.complete({ system: 's', user: 'u' })).rejects.toThrow()
  })
})
