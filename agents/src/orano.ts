// ORANO Growth Agent: an LLM buyer that hires a directory bot on Rent-A-Bot, inside a hard budget and the mandate.
//   npm run orano -w agents -- "<goal>" [--max-steps N] [--url http://localhost:8790] [--scripted]
// Exit codes: 0 done, 2 needs a human (approval URL printed), 1 step budget ran out or an error.
import { pathToFileURL } from 'node:url'
import { loadAiConfig, loadBuyerKey, loadEnv, rentabotUrl } from './env.ts'
import { loadOranoFacts, type OranoFacts } from './facts.ts'
import { runAgent, type ToolGuard } from './llm-agent.ts'
import type { Json } from './mcp.ts'
import { CONTACT_EMAIL, DEFAULT_GOAL, FORWARD_SECRET, cents, printReport, runScriptedBuyer, shareableAccess } from './scripted.ts'

export const BUDGET_CAP = '70.00'

export function oranoSystemExtra(facts: OranoFacts, cap = BUDGET_CAP): string {
  return `ORANO FACTS (the only product copy you may use, as draft_job_spec context and in provide_inputs):
${facts.text}
OWNER POLICY
- Hard budget: $${cap} total. Pass budget_cap "${cap}" to draft_job_spec. Never fund a quote above $${cap}.
- Inputs come only from the facts: product_name, url, tagline_60, description_300, category, contact_email. The contact email is always ${CONTACT_EMAIL}. Skip a logo input if the seller marks it optional; never invent one.
- Answer seller questions only with these facts. No personal names, phone numbers or addresses.
- share_secret is allowed only for a read-only inbox_verification access request, with the value "${FORWARD_SECRET}". Never share a password or any other credential.
- Provide inputs first, then accept_contract with the CURRENT contract_hash from get_job (re-accept if it changes).
- fund_job idempotency_key: "fund-<job_id>-v<contract version>".
- After delivery: run_checks. Accept if at least 90% of units passed (accept pays only the units that passed). Otherwise reject once, naming the failing unit refs and checks, and allow one cure round. Open a dispute only if the seller redelivers nothing after the cure window. Never appeal (a human decides that).`
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
const overCap = (v: unknown, cap: string) => typeof v === 'string' && cents(v) > cents(cap)

/** Code-level enforcement of the policy above; the model sees a refusal as a tool error and adjusts. */
export function oranoGuard(cap = BUDGET_CAP): ToolGuard {
  return async (name, args: Json, ctx) => {
    switch (name) {
      case 'draft_job_spec':
        return overCap(args.budget_cap, cap) ? `budget_cap must be at most ${cap}.` : null
      case 'create_job':
        return overCap(args.spec?.budget_cap?.value, cap) ? `spec.budget_cap must be at most ${cap}.` : null
      case 'request_mandate':
        return overCap(args.per_job_cap, cap) || overCap(args.monthly_cap, cap) ? `Ask for caps of at most ${cap}; the task needs no more.` : null
      case 'provide_inputs':
      case 'send_message': {
        const bad = strings(args).flatMap((s) => s.match(EMAIL) ?? []).filter((e) => e.toLowerCase() !== CONTACT_EMAIL)
        const emailKeys = Object.entries(args.inputs ?? {}).filter(([k, v]) => /email/i.test(k) && v !== CONTACT_EMAIL)
        return bad.length || emailKeys.length ? `The only contact email is ${CONTACT_EMAIL}.` : null
      }
      case 'share_secret': {
        if (args.value !== FORWARD_SECRET) return `The only secret you may share is "${FORWARD_SECRET}" for a read-only inbox verification request.`
        const j = await ctx.call('get_job', { job_id: args.job_id })
        const access = (j.data?.job?.contract?.requirements?.access ?? []).find((a: Json) => a.id === args.access_id)
        return shareableAccess(access) ? null : `${args.access_id} is not a read-only inbox_verification request.`
      }
      case 'fund_job': {
        const j = await ctx.call('get_job', { job_id: args.job_id })
        const total = j.data?.job?.contract?.quote?.total_max?.value
        if (!j.ok || typeof total !== 'string') return 'Could not read the contract total; call get_job first.'
        return cents(total) > cents(cap) ? `The contract total $${total} is over the $${cap} budget.` : null
      }
      case 'appeal_ruling':
        return 'Appeals cost a bond; a human decides whether to appeal.'
      default:
        return null
    }
  }
}

function parseArgs(argv: string[]) {
  const out: { goal?: string; maxSteps: number; url?: string; scripted: boolean } = { maxSteps: 60, scripted: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--scripted') out.scripted = true
    else if (a === '--max-steps') out.maxSteps = Number(argv[++i])
    else if (a === '--url') out.url = argv[++i]
    else rest.push(a)
  }
  if (rest.length) out.goal = rest.join(' ')
  if (!Number.isInteger(out.maxSteps) || out.maxSteps < 1) throw new Error('--max-steps needs a positive integer.')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const url = args.url ?? rentabotUrl(env)
  const key = loadBuyerKey(env)
  const goal = args.goal ?? DEFAULT_GOAL
  const facts = loadOranoFacts()

  if (args.scripted) {
    const r = await runScriptedBuyer({ url, key, goal, facts })
    printReport(r)
    return r.status === 'done' ? 0 : r.status === 'needs_human' ? 2 : 1
  }

  const ai = loadAiConfig(env)
  console.log(`ORANO Growth Agent -> ${url}  model ${ai.model} (${ai.provider})  max ${args.maxSteps} steps`)
  console.log(`goal: ${goal}\n`)
  const r = await runAgent({ url, key, goal, ai, maxSteps: args.maxSteps, systemExtra: oranoSystemExtra(facts), guard: oranoGuard() })
  console.log(`\n=== final report (${r.status}, ${r.steps} tool calls) ===\n${r.finalText}`)
  if (r.status === 'needs_human') {
    console.log(`\nHUMAN APPROVAL NEEDED: open ${r.approvalUrl}`)
    return 2
  }
  return r.status === 'done' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    },
  )
