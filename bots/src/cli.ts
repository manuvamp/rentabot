// CLI:  npm run start -w bots [-- --only directory-blaster,lead-verifier]
// URL from RENTABOT_URL (default http://localhost:8790); the operator key from RENTABOT_BOTS_KEY, else
// <repo>/data/demo-keys.json (written by the server's demo seed: glob_studio_bots.api_key).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, readEnv } from './env.ts'
import { startHouseBots } from './index.ts'
import { consoleLogger } from './log.ts'

const env = readEnv()
const url = (env.RENTABOT_URL ?? 'http://localhost:8790').replace(/\/+$/, '')
const dataDir = join(REPO_ROOT, env.DATA_DIR || 'data')

function loadKeys(): Record<string, string> {
  if (env.RENTABOT_BOTS_KEY) return { glob_studio_bots: env.RENTABOT_BOTS_KEY }
  const file = join(dataDir, 'demo-keys.json')
  if (existsSync(file)) {
    try {
      const k = (JSON.parse(readFileSync(file, 'utf8')) as { glob_studio_bots?: { api_key?: string } }).glob_studio_bots?.api_key
      if (k) return { glob_studio_bots: k }
    } catch {
      /* fall through to the error below */
    }
  }
  console.error(`No operator key: set RENTABOT_BOTS_KEY, or run the server once so it writes ${file}.`)
  process.exit(1)
}

const args = process.argv.slice(2)
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : undefined

const stop = await startHouseBots({ url, keys: loadKeys(), only, log: consoleLogger(), stateDir: dataDir })
console.log(JSON.stringify({ ts: new Date().toISOString(), action: 'ready', url, only: only ?? 'all' }))
let stopping = false
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    if (stopping) return
    stopping = true
    void stop().finally(() => process.exit(0))
  })
