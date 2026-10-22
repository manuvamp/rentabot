// Demo data: three personas (owner Manu, an arbiter, the house-bot operator), the ORANO Growth
// Agent with an active mandate (simulated rail only), and the house bots.
// API keys for the seeded agents go to DATA_DIR/demo-keys.json (DATA_DIR is gitignored), never to logs.
import { BotCard, type Mandate } from '@rentabot/shared'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Services } from '../core/services.ts'
import { emptyStats } from '../core/stats.ts'
import { newId } from '../core/util.ts'
import { SimulatedRail } from '../rails/simulated.ts'
import { authoredCard, HOUSE_BOTS } from './bots.ts'

export function isSeeded(s: Services) {
  return !!s.d.db.get("SELECT id FROM users WHERE persona = 'owner'")
}

/** House bots that were listed once and are replaced by a real one; the old row is delisted at boot. */
const RETIRED_HOUSE_BOTS = ['Accelerator Application Bot']

/** The fields of a house bot that come from the code (the seed list, the briefs, the passports), not from the database. */
const authored = (b: BotCard) => JSON.stringify({ tagline: b.tagline, description: b.description, capability_class: b.capability_class, skills: b.skills, policy: b.policy, passport: b.passport })

/**
 * Keeps an existing database in step with the house bots in the code, with no reset: house bots that are new get a row, the
 * briefs, passports, descriptions and skills of existing ones are refreshed when the code changed them, and retired
 * placeholders are delisted. Only the operator "Glob Studio Bots" is touched; reputation, status, ids and stats stay as they are.
 */
export function backfillHouseBriefs(s: Services) {
  const agents = s.d.db.all<{ id: string; data: string }>('SELECT id, data FROM agents')
  const operator = agents.find((a) => (JSON.parse(a.data) as { name?: string }).name === 'Glob Studio Bots')
  if (!operator) return
  const rows = s.d.db.all<{ id: string; data: string }>('SELECT id, data FROM bots WHERE operator_agent_id = ?', operator.id)
  const byName = new Map(rows.map((r) => [(JSON.parse(r.data) as BotCard).name, r]))
  const now = s.d.nowIso()
  for (const seedBot of HOUSE_BOTS) {
    const card = authoredCard(seedBot)
    const row = byName.get(seedBot.name)
    if (!row) {
      const bot = BotCard.parse({
        ...card,
        id: newId('bot'),
        operator_agent_id: operator.id,
        reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null },
        created_at: now,
      })
      s.d.db.run('INSERT INTO bots (id, operator_agent_id, status, data, stats, created_at) VALUES (?, ?, ?, ?, ?, ?)', bot.id, bot.operator_agent_id, bot.status, JSON.stringify(bot), JSON.stringify(emptyStats()), now)
      continue
    }
    const current = JSON.parse(row.data) as BotCard
    const fresh = BotCard.parse({ ...current, ...card, id: current.id, operator_agent_id: current.operator_agent_id, reputation: current.reputation, created_at: current.created_at, status: current.status })
    if (authored(fresh) !== authored(current)) s.d.db.run('UPDATE bots SET data = ? WHERE id = ?', JSON.stringify(fresh), row.id)
  }
  for (const name of RETIRED_HOUSE_BOTS) {
    const row = byName.get(name)
    if (!row || HOUSE_BOTS.some((b) => b.name === name)) continue
    const bot = JSON.parse(row.data) as BotCard
    if (bot.status === 'delisted') continue
    bot.status = 'delisted'
    s.d.db.run('UPDATE bots SET data = ?, status = ? WHERE id = ?', JSON.stringify(bot), 'delisted', row.id)
  }
}

export function seed(s: Services) {
  const { d, auth } = s
  const now = d.nowIso()
  const manu = auth.createUser({ name: 'Manu', email: 'manu@oranoai.example', roles: ['owner'], persona: 'owner' })
  auth.createUser({ name: 'Arbiter', roles: ['arbiter'], persona: 'arbiter' })
  const op = auth.createUser({ name: 'Glob Studio', roles: ['owner'], persona: 'seller' })

  const orano = auth.createAgent({ name: 'ORANO Growth Agent', description: 'Hires specialist bots for ORANO’s launch: directories, outreach, audits.', owner_id: manu.id })
  const operator = auth.createAgent({
    name: 'Glob Studio Bots',
    description: 'Operator of the Rent-A-Bot house bots.',
    owner_id: op.id,
    payout_email: process.env.SEED_PAYOUT_EMAIL?.trim() || 'bots@globstudio.example',
  })
  auth.setActAs(manu.id, orano.agent.id)
  auth.setActAs(op.id, operator.agent.id)

  const bots: Record<string, string> = {}
  for (const b of HOUSE_BOTS) {
    const bot = BotCard.parse({
      ...authoredCard(b),
      id: newId('bot'),
      operator_agent_id: operator.agent.id,
      reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null },
      created_at: now,
    })
    d.db.run('INSERT INTO bots (id, operator_agent_id, status, data, stats, created_at) VALUES (?, ?, ?, ?, ?, ?)', bot.id, bot.operator_agent_id, bot.status, JSON.stringify(bot), JSON.stringify(emptyStats()), now)
    bots[bot.name] = bot.id
  }

  // The owner approved a mandate earlier; only the simulated rail can mint its payment token offline.
  let mandate_id: string | null = null
  if (d.rail instanceof SimulatedRail) {
    const m: Omit<Mandate, 'spent_this_month'> = {
      id: newId('mdt'),
      agent_id: orano.agent.id,
      owner_id: manu.id,
      status: 'active',
      monthly_cap: { value: '200.00', currency: 'USD' },
      per_job_cap: { value: '80.00', currency: 'USD' },
      categories: ['real_world_action', 'reach', 'compute_media', 'code'],
      expires_at: new Date(d.nowMs() + 90 * 86_400_000).toISOString(),
      approval_url: null,
      rail: 'simulated',
      created_at: now,
    }
    s.escrow.seedActiveMandate(m, d.rail.seedPaymentToken())
    mandate_id = m.id
  }

  writeDemoKeys(d.cfg.dataDir, {
    note: 'Demo API keys for the seeded agents. Regenerated by demo reset. Do not commit.',
    rail: d.rail.kind,
    orano_growth_agent: { agent_id: orano.agent.id, api_key: orano.api_key, mandate_id },
    glob_studio_bots: { agent_id: operator.agent.id, api_key: operator.api_key },
    bots,
  })
}

export function writeDemoKeys(dataDir: string, data: unknown) {
  mkdirSync(dataDir, { recursive: true })
  // Keep everything in DATA_DIR out of git even if the root .gitignore misses it.
  writeFileSync(join(dataDir, '.gitignore'), '*\n')
  writeFileSync(join(dataDir, 'demo-keys.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}
