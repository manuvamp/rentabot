// The Studio Agent Framework wiring. Studio's own five agents (lead, data, page, widget, planning) keep their jobs; we add one
// agent of ours, the "analyst", with one tool, explain_net_dip, and teach the lead to hand it the "why did X move" questions
// before asking the page agent to place an escrow waterfall for the period it found. All model turns go to our server through
// rabAdapter. With the AI off, the same chat panel opens an agent that says so.
import { createAiHarness, directLlmRunner } from 'ag-studio'
import type { AgAiEvent, AgAiHarness, AgAiAgentContext, AgAiTool, AgStudioApi, AgAiAgentRunner } from 'ag-studio'
import { EvidenceTable } from './EvidenceTable'
import { PERIOD_FORMS, explainNetChange, resolvePeriod } from './analysis'
import type { NetExplanation } from './analysis'
import { rabAdapter } from './adapter'
import type { Row } from './data'

export const ANALYST_ENDPOINT = '/api/analyst/turn'

export const PROMPT_STARTERS = [
  { label: 'Why did platform net dip last week?', prompt: 'Why did platform net dip last week? Show me on the dashboard.' },
  { label: 'Which bot fails url_live most?', prompt: 'Which bot fails the url_live check most often, and how much is that costing in disputes?' },
  { label: 'Where does the money go?', prompt: 'Walk me through where an escrow dollar goes on this platform, and what we keep after PayPal fees.' },
  { label: 'Add a take-rate trend', prompt: 'Add a line chart of take rate by week to the Money page.' },
]

const ANALYST_INSTRUCTIONS = `You are the Rent-A-Bot platform analyst. You explain why the platform's money moved, using evidence from the job ledger, never guesses.

Rent-A-Bot is a marketplace where buyers fund a job into PayPal escrow, a bot does it, and the platform keeps a commission (15 percent, minimum $3.00) plus a flat mediation fee on disputes, minus the PayPal capture and payout fees. "Platform net" is that margin. Captures under $5.00 are voided, so nothing is earned on them. Disputes settle by agreement between the bots or, failing that, by the arbiter.

How to work:
1. For any question about why platform net rose, fell or dipped, call explain_net_dip with the period (for "last week" pass "last_week"). Report the biggest drivers with their dollar impact and name one or two example jobs from the evidence.
2. For questions about bots or checks, use viewSchema and executeQuery on the bots and checks tables.
3. Use only numbers returned by your tools. If a tool fails, say so.
4. When you finish, call complete_task with: the finding in two or three sentences, the exact period (from and to dates), and the placement request, worded as an instruction: "Add a NEW escrow-waterfall widget to the Money page titled 'Escrow waterfall: FROM to TO' (even though one already exists), and give that widget alone a widget filter on jobs.date between FROM and TO. Do not add a page filter." Do not place widgets yourself.`

const LEAD_ROUTING = `

Rent-A-Bot routing: questions about WHY platform net, the take rate or the fees moved, or about which bot or check is failing, go to the "analyst" agent through delegate_to. Put the reader's question, word for word, in its "question" parameter; never send a generic request. When it returns a period, delegate to "page" to add a NEW widget of type escrow-waterfall to the Money page, even though the page already has one: the new one is for this period and gets the period's title. Then delegate to "widget" to give that new widget alone a widget filter on jobs.date between the period's start and end dates (never a page filter, which would change every other widget). Finally tell the reader what you found in plain words and which widget to look at. Use the other agents for everything else.`

export interface AnalystTools {
  explainNetDip: (period: string) => NetExplanation | { error: string }
}

function makeExplainTool(api: AgStudioApi, getJobs: () => Row[]): AgAiTool {
  return api.defineAiTool({
    name: 'explain_net_dip',
    description:
      "Rank what moved platform net in a period against the average of the four periods before it: captures voided below the $5 minimum, PayPal fees above the estimate, arbiter rulings, refunds that kept fees, and volume. Returns each driver's dollar impact with example jobs, and the date range to filter a waterfall to.",
    params: (s) => s.object({ period: s.string({ description: `The period to explain: ${PERIOD_FORMS}` }) }),
    execute: ({ period }: { period: string }, ctx) => {
      const resolved = resolvePeriod(period)
      if (!resolved) return ctx.error(`Unknown period "${period}". Use ${PERIOD_FORMS}.`)
      const result = explainNetChange(getJobs(), resolved)
      if (result.jobs_in_period === 0) return ctx.error(`There are no jobs between ${resolved.from} and ${resolved.to}.`)
      const lines = result.drivers.map((d) => `${d.label}: ${d.impact_usd >= 0 ? '+' : '-'}$${Math.abs(d.impact_usd).toFixed(2)} (${d.explanation})`)
      const headline =
        result.verdict === 'no_baseline'
          ? `Platform net was $${result.net_period.toFixed(2)} for ${resolved.label}; there is no earlier period to compare with.`
          : `Platform net was $${result.net_period.toFixed(2)} for ${resolved.label} (${resolved.from} to ${resolved.to}) against an average of $${result.net_baseline_avg.toFixed(2)} for the ${result.baseline.periods} period(s) before: a ${result.verdict} of $${Math.abs(result.delta).toFixed(2)}.`
      return ctx.success(`${headline}\nDrivers, largest first:\n${lines.join('\n')}\nTo show it: add a new escrow-waterfall widget to the Money page and give that widget alone a widget filter on jobs.date from ${resolved.from} to ${resolved.to}.`, result)
    },
  })
}

/** The label and expanded body of the analyst's tool in the chat panel. */
export const aiToolDisplay = {
  explain_net_dip: {
    label: ({ args, status, result }: { args: Partial<{ period: string }>; status: string; result?: { success: boolean; data?: unknown } }) => {
      const d = result?.success ? (result.data as NetExplanation | undefined) : undefined
      return {
        text: `Explaining platform net for ${args.period ? args.period.replace(/_/g, ' ') : 'a period'}`,
        ...(d ? { pill: `${d.delta < 0 ? '-' : '+'}$${Math.abs(d.delta).toFixed(2)}` } : status === 'done' ? { pill: 'no result' } : {}),
      }
    },
    detail: EvidenceTable,
  },
}

type Off = Pick<AgAiAgentRunner<undefined>, 'id' | 'name' | 'description' | 'run'>

/** The agent that answers when the server has no model: it says so and points at what still works. */
function offAgent(): Off {
  return {
    id: 'off',
    name: 'Analyst (off)',
    description: 'The AI analyst is switched off on this server.',
    run: async function* (input): AsyncGenerator<AgAiEvent> {
      const messageId = `off_${input.runId}`
      yield { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId }
      yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' }
      yield {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId,
        delta: 'AI is off on this server (AI_PROVIDER is none), so I cannot answer questions. Everything else on this dashboard still works: click a step in the escrow waterfall, filter by event, or sort and group the grids.',
      }
      yield { type: 'TEXT_MESSAGE_END', messageId }
      yield { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId }
    },
  }
}

export function createAnalystHarness(api: AgStudioApi, opts: { aiOn: boolean; getJobs: () => Row[] }): AgAiHarness {
  if (!opts.aiOn) {
    return createAiHarness(api, () => ({ agents: [offAgent() as unknown as AgAiAgentRunner<any>], primary: 'off' }))
  }
  const adapter = rabAdapter({ endpoint: ANALYST_ENDPOINT })
  return createAiHarness(api, ({ builtIn }) => {
    const explain = makeExplainTool(api, opts.getJobs)
    const lead = directLlmRunner({
      ...builtIn.lead,
      adapter,
      instructions: (ctx: AgAiAgentContext, p: unknown) => `${builtIn.lead.instructions?.(ctx, p) ?? ''}${LEAD_ROUTING}`,
      tools: (ctx: AgAiAgentContext, p: unknown) =>
        (builtIn.lead.tools?.(ctx, p) ?? []).map((t) => (t.name === 'delegate_to' ? ctx.tools.delegateTo(['data', 'widget', 'page', 'planning', 'analyst']) : t)),
    })
    const analyst = directLlmRunner({
      id: 'analyst',
      name: 'Platform analyst',
      description: 'Explains why platform net, take rate or fees moved and which bots or checks are failing, from the job ledger. Ask it a question; it returns the finding and the date range to chart.',
      schema: (s) => s.object({ question: s.string({ description: 'What to find out, in plain words.' }) }),
      instructions: () => ANALYST_INSTRUCTIONS,
      tools: (ctx: AgAiAgentContext) => [ctx.studio.viewSchema(), ctx.studio.executeQuery(), explain],
      maxTurns: 10,
      adapter,
    })
    const others = (['data', 'page', 'planning', 'widget'] as const).map((id) => directLlmRunner({ ...builtIn[id], adapter }))
    return {
      agents: [lead, ...others, analyst] as unknown as AgAiAgentRunner<any>[],
      primary: 'lead',
      promptStarters: PROMPT_STARTERS,
    }
  })
}
