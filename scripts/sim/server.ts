// Boots a throwaway Rent-A-Bot server for the simulation: free port, fresh DATA_DIR under
// %TEMP%\agent-scratch\rentabot-sim\<run>, simulated rail (every PAYPAL_* blanked so .env can't leak in),
// deterministic mediator (AI_PROVIDER=none), fast demo clock. Server output goes to a log file that the
// simulator scans for schema mismatches, illegal transitions and background failures.
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..', '..')

export interface BootOptions {
  run: string
  timeScale: number
  houseBots: boolean
  tickMs?: number
}

export interface SimServer {
  base: string
  port: number
  dataDir: string
  scratch: string
  logPath: string
  proc: ChildProcess
  stop(): Promise<void>
  /** Lines in the server log matching the patterns that indicate a platform bug. */
  logFindings(): { kind: string; line: string }[]
}

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => res(p))
    })
  })
}

export function scratchRoot() {
  return join(process.env.TEMP ?? tmpdir(), 'agent-scratch', 'rentabot-sim')
}

export async function bootServer(o: BootOptions): Promise<SimServer> {
  const port = await freePort()
  const scratch = join(scratchRoot(), o.run)
  const dataDir = join(scratch, 'data')
  mkdirSync(dataDir, { recursive: true })
  const logPath = join(scratch, 'server.log')
  const base = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = {}
  // Keep only what a node process needs from the parent environment; nothing payment- or AI-related.
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'ComSpec', 'PATHEXT', 'WINDIR', 'NODE_OPTIONS']) if (process.env[k] !== undefined) env[k] = process.env[k]
  Object.assign(env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_URL: base,
    DATA_DIR: dataDir,
    DEMO_MODE: '1',
    DEMO_TIME_SCALE: String(o.timeScale),
    HOUSE_BOTS: o.houseBots ? '1' : '0',
    TICK_MS: String(o.tickMs ?? 400),
    LOG_LEVEL: 'warn',
    // Mediation rounds of 12 demo-hours (12 s at ×3600) so scripted parties can answer before a round expires.
    MEDIATION_ROUND: 'PT12H',
    // Bid windows follow the fast clock exactly (a few real seconds); production keeps a 5-minute real floor for outside bidders.
    BID_WINDOW_FLOOR_MS: '0',
    // Blank (not unset): config.ts only fills from .env when a variable is undefined.
    PAYPAL_CLIENT_ID: '',
    PAYPAL_CLIENT_SECRET: '',
    PAYPAL_WEBHOOK_ID: '',
    PAYPAL_ENV: 'sandbox',
    AI_PROVIDER: 'none',
    ANTHROPIC_API_KEY: '',
    AI_API_KEY: '',
    AI_BASE_URL: '',
    AI_SPEND_FILE: 'off',
    SEAL_KEY: '',
    ALLOW_HOSTS: '',
    SEED_PAYOUT_EMAIL: '',
    CORS_ORIGINS: '',
    WEB_DIST: join(scratch, 'no-web'),
  })
  const log = createWriteStream(logPath)
  const proc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'server', 'src', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  proc.stdout!.pipe(log)
  proc.stderr!.pipe(log)
  let exited = false
  proc.on('exit', () => (exited = true))

  const deadline = Date.now() + 60_000
  for (;;) {
    if (exited) throw new Error(`server exited during boot; see ${logPath}:\n${readFileSync(logPath, 'utf8').slice(-2000)}`)
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) {
        const h = (await r.json()) as { payment_rail: string; ai_provider: string; demo_mode: boolean }
        if (h.payment_rail !== 'simulated') throw new Error(`refusing to run: payment rail is ${h.payment_rail}`)
        if (h.ai_provider !== 'none') throw new Error(`refusing to run: AI provider is ${h.ai_provider}`)
        break
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('refusing')) {
        proc.kill()
        throw e
      }
    }
    if (Date.now() > deadline) {
      proc.kill()
      throw new Error('server did not come up in 60 s')
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  return {
    base,
    port,
    dataDir,
    scratch,
    logPath,
    proc,
    async stop() {
      if (exited) return
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {}
          res()
        }, 8000)
        proc.once('exit', () => {
          clearTimeout(t)
          res()
        })
        // Windows has no SIGTERM delivery to node children; kill() terminates the process.
        proc.kill('SIGTERM')
      })
      log.end()
    },
    logFindings() {
      let text = ''
      try {
        text = readFileSync(logPath, 'utf8')
      } catch {
        return []
      }
      const out: { kind: string; line: string }[] = []
      const pats: [string, RegExp][] = [
        ['output_schema_mismatch', /OUTPUT SCHEMA MISMATCH/],
        ['illegal_transition', /Illegal transition/],
        ['tick_error', /\[tick\]/],
        ['background_task_failed', /background task failed/],
        ['unhandled_error', /unhandled error/],
        ['mediation_execution_failed', /\[mediation\].*failed/],
        ['reconciler_error', /\[reconciler\]/],
        ['mcp_tool_internal', /mcp tool failed/],
        ['house_bot_error', /house bots? (failed|restart failed)/],
      ]
      for (const line of text.split(/\r?\n/)) for (const [k, re] of pats) if (re.test(line)) out.push({ kind: k, line: redact(line).slice(0, 600) })
      return out
    },
  }
}

/** Never let a key, token or cookie reach the report. */
export function redact(s: string): string {
  return s.replace(/(rabs?_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|"api_key"\s*:\s*"[^"]+"|"value"\s*:\s*"[^"]+")/g, '[redacted]')
}

export function removeScratch(run: string) {
  rmSync(join(scratchRoot(), run), { recursive: true, force: true })
}
