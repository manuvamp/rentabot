// Entry point: start the house bots against a Rent-A-Bot server.
//   startHouseBots({ url, keys, only? }) -> stop()
// `keys` maps a bot slug ("directory-blaster") or a shared label ("glob_studio_bots", "default") to the API
// key of the operator agent that owns the bot. All the bots belong to "Glob Studio Bots", so one key is enough;
// bots that share a key share one event loop. The bots reach the marketplace only through its public MCP endpoint.
import { createAi, type Ai } from './ai.ts'
import { accountSetup } from './bots/account-setup.ts'
import { applicationFiller } from './bots/application-filler.ts'
import { agentRedTeam } from './bots/agent-red-team.ts'
import { auditor } from './bots/auditor.ts'
import { brokenLinkHunter } from './bots/broken-link-hunter.ts'
import { coldEmailWriter } from './bots/cold-email-writer.ts'
import { deliverabilityDoctor } from './bots/deliverability-doctor.ts'
import { directoryBlaster } from './bots/directory-blaster.ts'
import { webDataExtractor } from './bots/web-data-extractor.ts'
import { investorOutreach } from './bots/investor-outreach.ts'
import { landingPage } from './bots/landing-page.ts'
import { leadFinder } from './bots/lead-finder.ts'
import { leadVerifier } from './bots/lead-verifier.ts'
import type { HunterOptions } from './hunter.ts'
import { consoleLogger, type Logger } from './log.ts'
import { SellerHost, type SellerBot } from './runtime.ts'
import type { DnsResolvers, MxOptions } from './server-shared.ts'

export { SellerHost, buildQuote, NeedInput } from './runtime.ts'
export type { SellerBot, WorkJob, WorkTools, WorkResult } from './runtime.ts'

export const BOT_SLUGS = ['directory-blaster', 'investor-outreach', 'lead-verifier', 'lead-finder', 'budget-lead-verifier', 'agent-readiness-auditor', 'cold-email-writer', 'account-setup-bot', 'application-filler', 'landing-page-bot', 'agent-red-team', 'deliverability-doctor', 'broken-link-hunter', 'web-data-extractor'] as const

export interface StartOptions {
  url: string
  keys: Record<string, string>
  /** Slugs to run; default all of them. */
  only?: string[]
  /** Sandbox Web base for the demo-mode bots (default <url>/sandbox). */
  sandboxUrl?: string
  ai?: Ai
  log?: Logger
  /** Persist event cursors in this directory (one file per operator key). */
  stateDir?: string
  pollSeconds?: number
  /** Extra hosts live bots may fetch even though they are not public (local fixtures only). */
  allowHosts?: string[]
  /** Tuning for the Directory Blaster (tests use short intervals). */
  directoryBlaster?: { pollMs?: number; settleMs?: number; retryCapMs?: number }
  /** Tuning for the Account Setup Bot (tests use short intervals). */
  accountSetup?: { pollMs?: number; settleMs?: number; retryCapMs?: number }
  /** Tuning for the Application Filler (tests use short intervals). */
  applicationFiller?: { pollMs?: number; approvalWaitMs?: number }
  /** DNS overrides for the Lead Verifier (tests). */
  mx?: MxOptions
  /** The Lead Verifier's Hunter.io account for find_leads (tests inject a mock fetch; default: HUNTER_API_KEY from the environment). */
  hunter?: HunterOptions
  /** Resolvers for the Deliverability Doctor (tests). */
  dns?: DnsResolvers
  /** Tuning for the Broken Link Hunter (tests use a short pause before the second look). */
  brokenLinkHunter?: { retryDelayMs?: number; maxCrawlMs?: number }
  /** Private keys for end-to-end locker items (house bots: the server-run key sealed in DATA_DIR). */
  lockerKeys?: () => Promise<import('@rentabot/shared').LockerKey[]>
}

export function createBots(opts: Pick<StartOptions, 'url' | 'sandboxUrl' | 'allowHosts' | 'directoryBlaster' | 'accountSetup' | 'applicationFiller' | 'mx' | 'hunter' | 'dns' | 'brokenLinkHunter'>): Record<(typeof BOT_SLUGS)[number], SellerBot> {
  const sandboxUrl = (opts.sandboxUrl ?? `${opts.url.replace(/\/+$/, '')}/sandbox`).replace(/\/+$/, '')
  return {
    'directory-blaster': directoryBlaster({ sandboxUrl, ...opts.directoryBlaster }),
    'investor-outreach': investorOutreach({ sandboxUrl }),
    'lead-verifier': leadVerifier({ allowHosts: opts.allowHosts, mx: opts.mx }),
    'lead-finder': leadFinder({ allowHosts: opts.allowHosts, mx: opts.mx, hunter: opts.hunter }),
    'budget-lead-verifier': leadVerifier({ allowHosts: opts.allowHosts, mx: opts.mx, variant: 'budget' }),
    'agent-readiness-auditor': auditor({ allowHosts: opts.allowHosts }),
    'cold-email-writer': coldEmailWriter(),
    'landing-page-bot': landingPage({ sandboxUrl }),
    'agent-red-team': agentRedTeam({ sandboxUrl }),
    'account-setup-bot': accountSetup({ sandboxUrl, ...opts.accountSetup }),
    'application-filler': applicationFiller({ sandboxUrl, ...opts.applicationFiller }),
    'deliverability-doctor': deliverabilityDoctor({ dns: opts.dns }),
    'broken-link-hunter': brokenLinkHunter({ allowHosts: opts.allowHosts, ...opts.brokenLinkHunter }),
    'web-data-extractor': webDataExtractor({ allowHosts: opts.allowHosts }),
  }
}

export function keyFor(keys: Record<string, string>, slug: string): string | undefined {
  return keys[slug] ?? keys.glob_studio_bots ?? keys.default ?? keys['*']
}

/** Start the bots; resolves once every host has connected. Returns a function that stops them. */
export async function startHouseBots(opts: StartOptions): Promise<() => Promise<void>> {
  const log = opts.log ?? consoleLogger()
  const ai = opts.ai ?? createAi()
  const all = createBots(opts)
  const slugs = (opts.only?.length ? opts.only : [...BOT_SLUGS]) as (typeof BOT_SLUGS)[number][]
  const unknown = slugs.filter((s) => !(s in all))
  if (unknown.length) throw new Error(`unknown bot(s): ${unknown.join(', ')}. Known: ${BOT_SLUGS.join(', ')}`)

  // Bots with the same key share a host (one wait_for_events loop for the whole operator).
  const byKey = new Map<string, SellerBot[]>()
  for (const slug of slugs) {
    const key = keyFor(opts.keys, slug)
    if (!key) throw new Error(`no API key for ${slug}: pass keys.${slug} or keys.glob_studio_bots`)
    byKey.set(key, [...(byKey.get(key) ?? []), all[slug]])
  }
  const hosts: SellerHost[] = []
  let n = 0
  try {
    for (const [key, bots] of byKey) {
      const host = new SellerHost({
        url: opts.url,
        key,
        bots,
        ai,
        log,
        pollSeconds: opts.pollSeconds,
        ...(opts.lockerKeys ? { lockerKeys: opts.lockerKeys } : {}),
        ...(opts.stateDir ? { cursorFile: `${opts.stateDir.replace(/[\\/]+$/, '')}/bots-cursor-${++n}.json` } : {}),
      })
      await host.start()
      hosts.push(host)
    }
  } catch (e) {
    await Promise.all(hosts.map((h) => h.stop()))
    throw e
  }
  log({ action: 'house_bots_running', ok: true, detail: slugs.join(', ') })
  return async () => {
    await Promise.all(hosts.map((h) => h.stop()))
  }
}
