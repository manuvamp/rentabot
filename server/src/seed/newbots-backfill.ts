// Existing production databases get the Landing Page Bot and the real Agent Red Team with no reset, and the coming-soon
// placeholders that can't run on the free server are delisted. Runs at boot before the generic house-bot backfill; idempotent.
import { BotCard, HOUSE_BRIEFS, HOUSE_PASSPORTS } from '@rentabot/shared'
import type { Services } from '../core/services.ts'
import { emptyStats } from '../core/stats.ts'
import { newId } from '../core/util.ts'
import { HOUSE_BOTS } from './bots.ts'

/** House bots added or made real in this release. */
const NEW_BOTS = ['Agent Red Team', 'Landing Page Bot', 'Deliverability Doctor', 'Broken Link Hunter', 'Web Data Extractor']
/** Coming-soon placeholders removed from the shelf: they can't run on the free server. */
const RETIRED = ['Upgrade Bot', 'Launch Video Bot', 'Dubbing Bot']

export function backfillNewBots(s: Services) {
  const operator = s.d.db.all<{ id: string; data: string }>('SELECT id, data FROM agents').find((a) => (JSON.parse(a.data) as { name?: string }).name === 'Glob Studio Bots')
  if (!operator) return
  const rows = s.d.db.all<{ id: string; data: string }>('SELECT id, data FROM bots WHERE operator_agent_id = ?', operator.id)
  const byName = new Map(rows.map((r) => [(JSON.parse(r.data) as BotCard).name, { id: r.id, bot: JSON.parse(r.data) as BotCard }]))
  const now = s.d.nowIso()
  for (const name of NEW_BOTS) {
    const seedBot = HOUSE_BOTS.find((b) => b.name === name)
    if (!seedBot) continue
    const authored = { ...seedBot, skills: seedBot.skills.map((k) => ({ ...k, brief: k.brief ?? HOUSE_BRIEFS[name] })), passport: seedBot.passport ?? HOUSE_PASSPORTS[name] }
    const row = byName.get(name)
    if (!row) {
      const bot = BotCard.parse({ ...authored, id: newId('bot'), operator_agent_id: operator.id, reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null }, created_at: now })
      s.d.db.run('INSERT INTO bots (id, operator_agent_id, status, data, stats, created_at) VALUES (?, ?, ?, ?, ?, ?)', bot.id, bot.operator_agent_id, bot.status, JSON.stringify(bot), JSON.stringify(emptyStats()), now)
      continue
    }
    // The old coming-soon card (paused, "Coming soon." in its description) becomes the real listing once. A later
    // operator pause is kept: by then the description no longer says "Coming soon."
    if (!/Coming soon\./.test(row.bot.description)) continue
    const bot = BotCard.parse({ ...row.bot, ...authored, id: row.bot.id, operator_agent_id: row.bot.operator_agent_id, reputation: row.bot.reputation, created_at: row.bot.created_at })
    s.d.db.run('UPDATE bots SET data = ?, status = ? WHERE id = ?', JSON.stringify(bot), bot.status, row.id)
  }
  for (const name of RETIRED) {
    const row = byName.get(name)
    if (!row || row.bot.status === 'delisted' || HOUSE_BOTS.some((b) => b.name === name)) continue
    s.d.db.run('UPDATE bots SET data = ?, status = ? WHERE id = ?', JSON.stringify({ ...row.bot, status: 'delisted' }), 'delisted', row.id)
  }
}
