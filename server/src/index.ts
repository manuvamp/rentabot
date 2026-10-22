// Boot: intelligence (+ house-bot checks) -> core -> HTTP app (REST + MCP + SSE + discovery + web) -> Sandbox Web
// -> listen -> house bots (MCP clients of this same server), graceful shutdown.
import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { registerHouseBotChecks } from './housebots/checks.ts'
import { registerPlatformSecret } from './intelligence/ai/redact-guard.ts'
import { createIntelligence } from './intelligence/index.ts'
import { settlementFeesFrom } from './intelligence/negotiation/terms.ts'
import { registerSandbox } from './sandbox/index.ts'
import { createCore } from './core/index.ts'
import { buildApp } from './http/app.ts'

const port = Number(process.env.PORT ?? 8790)
const host = process.env.HOST ?? '0.0.0.0'
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')

const appConfig = loadConfig()
// The Lead Verifier's Hunter.io key (optional): kept out of every prompt, message, delivery and input, whatever puts it there.
registerPlatformSecret(process.env.HUNTER_API_KEY)
const intelligence = await createIntelligence({
  publicUrl,
  // Proposals, previews and recommended rulings use the same commission rule the payout uses.
  fees: settlementFeesFrom(appConfig.fees),
  ...(process.env.ALLOW_HOSTS ? { allowHosts: process.env.ALLOW_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
})
const ownHost = (() => {
  const u = new URL(publicUrl)
  return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
})()
registerHouseBotChecks(intelligence.checks, { allowHosts: [ownHost, ...(process.env.ALLOW_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)] })
const core = await createCore({ intelligence })
const app = await buildApp(core)

// Sandbox Web: the fake directories and investor inboxes demo bots act on. Its clock runs in nominal
// minutes × timeScale, so a demo that is DEMO_TIME_SCALE× faster uses 1/DEMO_TIME_SCALE here.
await registerSandbox(app, {
  checks: intelligence.checks,
  publicUrl,
  dataDir: appConfig.dataDir,
  timeScale: appConfig.demoMode ? 1 / appConfig.demoTimeScale : 1,
})

// House bots sell through the public MCP endpoint like any third-party bot. On by default in demo mode.
// They use the operator key the seed writes to DATA_DIR/demo-keys.json; a demo reset re-seeds new keys,
// so the bots restart whenever that file changes.
const keysFile = join(appConfig.dataDir, 'demo-keys.json')
const houseBotsOn = (process.env.HOUSE_BOTS ?? (appConfig.demoMode ? '1' : '0')) === '1'
let stopBots: (() => Promise<void>) | null = null
async function startBots() {
  if (stopBots) await stopBots().catch(() => {})
  stopBots = null
  if (!existsSync(keysFile)) return
  const keys = JSON.parse(readFileSync(keysFile, 'utf8')) as { glob_studio_bots?: { api_key?: string; agent_id?: string } }
  const key = keys.glob_studio_bots?.api_key
  if (!key) return
  // The house bots' locker key: generated once, private half sealed under the server key in DATA_DIR, registered as
  // "server_run" so buyers see that end-to-end items for these bots are opened on Rent-A-Bot's own servers.
  const operator = keys.glob_studio_bots?.agent_id
  const houseKey = operator ? await core.internal.services.locker.ensureServerRunKey(operator) : null
  const { startHouseBots } = await import('../../bots/src/index.ts')
  const { aiFromClient } = await import('../../bots/src/server-ai.ts')
  // The bots' model calls go through the server's capped AI client (AI_SPEND_CAP_USD), not their own fetch.
  stopBots = await startHouseBots({ url: `http://127.0.0.1:${port}`, keys: { glob_studio_bots: key }, stateDir: appConfig.dataDir, ai: aiFromClient(intelligence.aiClient), ...(houseKey ? { lockerKeys: async () => [houseKey] } : {}) })
  app.log.info('house bots started')
}

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'shutting down')
  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()
  try {
    unwatchFile(keysFile)
    if (stopBots) await stopBots().catch(() => {})
    await app.close()
    await core.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ port, host })
app.log.info({ publicUrl, mcp: `${core.config.publicUrl}/mcp` }, 'Rent-A-Bot is up')

if (houseBotsOn) {
  await startBots().catch((e) => app.log.error({ err: String(e) }, 'house bots failed to start'))
  watchFile(keysFile, { interval: 2000 }, () => void startBots().catch((e) => app.log.error({ err: String(e) }, 'house bots restart failed')))
}
