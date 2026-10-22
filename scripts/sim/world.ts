// World setup: demo sessions (owner, arbiter), seller agents with bots, buyer agents (claimed with a
// mandate, claimed without one, unclaimed), and a stranger for the non-party probes.
import { randomUUID } from 'node:crypto'
import { Api, http, type Json, type Stats, type Surface } from './client.ts'
import { c } from './fees.ts'
import type { Rng } from './rng.ts'
import type { Actor } from './invariants.ts'

export interface World {
  base: string
  stats: Stats
  owner: Api
  arbiter: Api
  sellers: (Actor & { bot_id: string; cls: string })[]
  /** Scripted bots that bid on open jobs (the same objects as `sellers` unless --house-bots). */
  bidders: (Actor & { bot_id: string; cls: string })[]
  buyers: Actor[]
  stranger: Actor
  investors: string[]
  houseBots: Json[]
}

export const SKILLS = {
  web: { id: 'web_pages', checks: ['url_live', 'page_mentions'], price: '1.50', model: 'per_unit' as const },
  shots: { id: 'screenshots', checks: ['artifact_attached'], price: '2.00', model: 'per_unit' as const },
  email: { id: 'outreach_emails', checks: ['email_delivered', 'email_lint'], price: '3.00', model: 'per_unit' as const },
  audit: { id: 'http_audit', checks: ['http_claim_holds'], price: '9.00', model: 'fixed' as const },
  // Delayed checks: an investor reply arrives after a (scaled) delay, so units stay pending through the verify window.
  replies: { id: 'investor_replies', checks: ['email_delivered', 'reply_received'], price: '3.00', model: 'per_unit' as const, verify_window: 'PT24H' },
}
export type SkillKey = keyof typeof SKILLS

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required })

function skillCard(k: SkillKey) {
  const s = SKILLS[k]
  return {
    id: s.id,
    title: `Sim ${k}`,
    description: `Simulation skill ${k}: delivers units verified by ${s.checks.join(', ')}.`,
    needs: obj({ product_name: { type: 'string' } }, ['product_name']),
    delivers: obj({ url: { type: 'string' } }),
    checks: s.checks,
    pricing: { model: s.model, currency: 'USD', price: s.price, ...(s.model === 'per_unit' ? { unit: 'unit' } : {}) },
    turnaround: 'P7D',
    verify_window: 'verify_window' in s ? s.verify_window : 'PT0H',
    examples: [],
  }
}

async function signIn(base: string, persona: 'owner' | 'arbiter'): Promise<string> {
  const r = await http(base, 'POST', '/api/session/demo', { body: { persona } })
  if (r.status !== 200) throw new Error(`demo sign-in ${persona} failed: ${r.status}`)
  const set = r.headers.get('set-cookie') ?? ''
  const m = /rab_session=([^;]+)/.exec(set)
  if (!m) throw new Error('no session cookie')
  return `rab_session=${m[1]}`
}

async function register(w: { base: string; stats: Stats }, name: string, surface: Surface, payout?: string): Promise<{ agent_id: string; key: string; claim_code: string; api: Api }> {
  const pub = new Api(name, w.base, {}, 'rest', w.stats)
  const r = await pub.call('register_agent', { name, description: `Simulation agent ${name}`, ...(payout ? { payout_email: payout } : {}) })
  if (!r.ok) throw new Error(`register_agent ${name}: ${r.code} ${r.message}`)
  return { agent_id: r.data.agent.id, key: r.data.api_key, claim_code: r.data.claim_code, api: new Api(name, w.base, { key: r.data.api_key }, surface, w.stats) }
}

export async function buildWorld(base: string, stats: Stats, rng: Rng, o: { buyers: number; sellers: number; houseBots: boolean; bidders?: number }): Promise<World> {
  const owner = new Api('owner', base, { cookie: await signIn(base, 'owner') }, 'rest', stats)
  const arbiter = new Api('arbiter', base, { cookie: await signIn(base, 'arbiter') }, 'rest', stats)
  const w = { base, stats }

  const makeSellers = async (count: number, prefix: string, botPrefix: string): Promise<World['sellers']> => {
    const out: World['sellers'] = []
    for (let i = 0; i < count; i++) {
      const surface: Surface = i % 2 === 0 ? 'mcp' : 'rest'
      const a = await register(w, `${prefix}-${i}`, surface, `${prefix.replace(/\W/g, '')}${i}@sim-payouts.example`)
      // One seller's bot is in a class most mandates don't cover, so funding needs a human approval.
      const cls = i === count - 1 ? 'code' : 'real_world_action'
      const r = await a.api.call('register_bot', {
        name: `${botPrefix} ${i}`,
        tagline: 'Simulation seller for the Rent-A-Bot invariant harness',
        description: 'Builds pages, screenshots, outreach emails and HTTP audits on Sandbox Web for the simulation.',
        capability_class: cls,
        skills: (Object.keys(SKILLS) as SkillKey[]).map(skillCard),
        mode: 'demo',
      })
      if (!r.ok) throw new Error(`register_bot: ${r.code} ${r.message}`)
      if (r.data.bot.status !== 'listed') throw new Error(`bot not listed: ${r.data.bot.status} ${JSON.stringify(r.data.bot.policy)}`)
      out.push({ name: `${prefix}-${i}`, agent_id: a.agent_id, key: a.key, api: a.api, claimed: false, bot_id: r.data.bot.id, cls })
    }
    return out
  }
  const sellers: World['sellers'] = o.houseBots ? [] : await makeSellers(o.sellers, 'sim-seller', 'Sim Bot')
  // Open jobs: the bots that bid. The scripted sellers when there are any; in house-bots mode a few scripted bidders of their own
  // (their skills are not the house bots', so the house bots are never matched by them; sim/openjobs.ts probes the house bots separately).
  const bidders: World['sellers'] = o.houseBots ? await makeSellers(o.bidders ?? 4, 'sim-bidder', 'Sim Bidder') : sellers

  const buyers: Actor[] = []
  for (let i = 0; i < o.buyers; i++) {
    const surface: Surface = i % 5 < 2 ? 'mcp' : 'rest'
    const a = await register(w, `sim-buyer-${i}`, surface)
    // 0..1: unclaimed; 2..4: claimed, no mandate (approval link); rest: claimed with a mandate.
    const kind = i < 2 ? 'unclaimed' : i < 5 ? 'approval' : 'mandate'
    const actor: Actor = { name: `sim-buyer-${i}`, agent_id: a.agent_id, key: a.key, api: a.api, claimed: false, mandate: null }
    if (kind !== 'unclaimed') {
      const cl = await owner.call('claim_agent', { claim_code: a.claim_code })
      if (!cl.ok) throw new Error(`claim_agent: ${cl.code} ${cl.message}`)
      actor.claimed = true
    }
    if (kind === 'mandate') {
      // Varied caps: some jobs will be over the per-job cap or the monthly cap and fall back to approval.
      const perJob = rng.pick(['40.00', '60.00', '80.00', '25.00'])
      const monthly = rng.pick(['150.00', '300.00', '90.00'])
      const m = await a.api.call('request_mandate', { monthly_cap: monthly, per_job_cap: c(perJob) > c(monthly) ? monthly : perJob, categories: ['real_world_action', 'reach'], expires_in_days: 30 })
      if (!m.ok) throw new Error(`request_mandate: ${m.code} ${m.message}`)
      const setup = String(m.data.approval_url).split('/').pop()!
      const ap = await http(base, 'POST', '/api/sim/paypal/approve', { body: { kind: 'mandate', id: setup, approve: true } })
      if (ap.status !== 200) throw new Error(`mandate approval failed ${ap.status} ${ap.text.slice(0, 200)}`)
      const g = await a.api.call('get_mandate', {})
      if (g.data?.mandate?.status !== 'active') throw new Error(`mandate not active: ${g.data?.mandate?.status}`)
      actor.mandate = { id: g.data.mandate.id, per_job: c(g.data.mandate.per_job_cap.value), monthly: c(g.data.mandate.monthly_cap.value) }
    }
    buyers.push(actor)
  }

  const s = await register(w, 'sim-stranger', 'rest')
  const stranger: Actor = { name: 'sim-stranger', agent_id: s.agent_id, key: s.key, api: s.api, claimed: false }

  const inv = await http(base, 'GET', '/sandbox/mail/investors.json')
  const bounce = ['Jonas Meyer', 'Clara Dubois', 'Lucas Almeida']
  const investors = (inv.json?.investors ?? []).filter((x: Json) => !bounce.includes(x.name)).map((x: Json) => x.email)

  let houseBots: Json[] = []
  if (o.houseBots) {
    const r = await owner.call('search_bots', { limit: 50 })
    // The scripted open-job bidders are listed too: they are not house bots.
    houseBots = ((r.data?.bots ?? []) as Json[]).filter((b) => !bidders.some((x) => x.bot_id === b.id))
  }
  void randomUUID
  return { base, stats, owner, arbiter, sellers, bidders, buyers, stranger, investors, houseBots }
}
