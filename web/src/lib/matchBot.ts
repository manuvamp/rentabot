// Pick the house bot a plain-language goal most likely belongs to, from the shelf's own text (no hard-coded bot names).
import type { BotSummary } from '../api/types'

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'have', 'need', 'want', 'get', 'can', 'you', 'your', 'our', 'are', 'all', 'any', 'out', 'who', 'what', 'how', 'its', 'was', 'but', 'not', 'off', 'per', 'make', 'help', 'please', 'before', 'after', 'about', 'every', 'each'])

/** Lower-case word stems: words of 3+ letters, cut to 5 characters so "directories" meets "directory". */
const stems = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => w.replace(/(ies|ing|ed|es|s)$/, '').slice(0, 5))

export interface BotMatch {
  bot: BotSummary
  score: number
}

/** Bots ranked by how many of the goal's word stems appear in their name, tagline and skill titles. Score 0 means no real match. */
export function rankBots(goal: string, bots: BotSummary[]): BotMatch[] {
  const want = new Set(stems(goal))
  return bots
    .map((bot) => {
      const hay = new Set(stems([bot.name, bot.tagline, ...bot.skills.map((s) => s.title)].join(' ')))
      let score = 0
      for (const w of want) if (hay.has(w)) score += 1
      return { bot, score }
    })
    .sort((a, b) => b.score - a.score)
}

export const hireUrl = (botId: string, goal: string) => `/hire/${botId}?goal=${encodeURIComponent(goal.slice(0, 1000))}`
