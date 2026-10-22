// The in-process house bots (started by the server) must not call a model on their own: they use the server's
// intelligence AI client (server/src/intelligence/ai/provider.ts), which prices every paid call into the monthly
// spend ledger (AI_SPEND_CAP_USD) and speaks the Anthropic 5.5 API correctly (no temperature, output_config.effort,
// server-side fallbacks). Past the cap the client throws and every bot falls back to its deterministic path.
// The standalone CLI keeps ai.ts (plain fetch).
import { z } from 'zod'
import type { Ai } from './ai.ts'

/** The part of the server's AiClient the bots use (structural: the bots do not import the server's source). */
export interface CappedAiClient {
  readonly enabled: boolean
  readonly config: { models: { fast: string; main: string } }
  askJson<T>(call: { model: string; system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number; timeoutMs?: number }): Promise<T>
}

const Reply = z.object({ text: z.string() })

/** Wrap the server's AI client as the bots' `Ai`. `tier` picks the configured model: "main" (default) or "fast". */
export function aiFromClient(client: CappedAiClient, opts: { tier?: 'main' | 'fast' } = {}): Ai {
  const model = client.config.models[opts.tier ?? 'main']
  return {
    enabled: client.enabled,
    async complete({ system, user, maxTokens }) {
      // The client returns validated JSON, so the bot's plain text travels in one field. Temperature is not sent (5.5 models reject it).
      const r = await client.askJson({
        model,
        system: `${system}\n\nReply with ONLY one JSON object of the form {"text": "<your reply as plain text>"}.`,
        prompt: user,
        schema: Reply,
        maxTokens: maxTokens ?? 1500,
      })
      return r.text
    },
  }
}
