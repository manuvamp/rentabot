import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import type { CheckContext, CheckLibrary } from '../../src/intelligence/types.ts'
import { registerSandbox } from '../../src/sandbox/index.ts'

export const T0 = Date.parse('2026-11-01T10:00:00Z')
export const MIN = 60_000

export interface Box {
  app: FastifyInstance
  checks: CheckLibrary
  dataDir: string
  /** Move the fake clock forward by this many REAL milliseconds. */
  advanceMs(ms: number): void
  /** Move the fake clock forward by nominal minutes (multiplied by the box's timeScale). */
  advanceMinutes(min: number): void
  clock(): number
  cleanup(): Promise<void>
}

export async function makeBox(opts: { timeScale?: number; dataDir?: string; seed?: string } = {}): Promise<Box> {
  const scale = opts.timeScale ?? 0.01
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scratch-rentabot-sandbox-'))
  let t = T0
  const app = Fastify()
  const checks = createCheckLibrary()
  await registerSandbox(app, { checks, publicUrl: 'http://sandbox.test', dataDir, timeScale: scale, now: () => new Date(t), seed: opts.seed })
  await app.ready()
  return {
    app,
    checks,
    dataDir,
    advanceMs: (ms) => void (t += ms),
    advanceMinutes: (min) => void (t += min * MIN * scale),
    clock: () => t,
    async cleanup() {
      await app.close()
      if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export const product = (over: Record<string, unknown> = {}) => ({
  name: 'ORANO',
  url: 'https://oranoai.com',
  tagline: 'Your AI money coach',
  description: 'ORANO helps people get out of debt with a friendly AI coach that plans, tracks and nudges.',
  category: 'AI Tools',
  contact_email: 'hello@oranoai.com',
  logo_url: 'https://oranoai.com/logo.png',
  screenshot_url: 'https://oranoai.com/shot.png',
  ...over,
})

export function checkCtx(check: string, meta: Record<string, unknown> | null, params: Record<string, unknown> = {}): CheckContext {
  return {
    job_id: 'job_test',
    contract: {} as never,
    deliverable_id: 'D1',
    unit: meta === null ? null : { ref: 'email-1', artifact_ids: [], meta },
    test: { check, params },
    attempt: 1,
    artifact: async () => null,
    saveEvidence: async () => 'evd_test',
  }
}

export const FIXTURE_PASSWORD = 'Tr0ub4dor&3-fixture!'

/**
 * Sign up on directories that need an account, let the verification mails arrive (the fake clock moves), open each link and
 * log in. Returns the session token per slug.
 */
export async function sessionsFor(b: Box, slugs: string[], email = 'hello@oranoai.com', password = FIXTURE_PASSWORD): Promise<Record<string, string>> {
  for (const slug of slugs) {
    const r = await b.app.inject({ method: 'POST', url: `/sandbox/dirs/${slug}/api/signup`, payload: { email, password, display_name: 'ORANO' } })
    if (r.statusCode !== 201) throw new Error(`signup ${slug}: ${r.statusCode} ${r.body}`)
  }
  b.advanceMinutes(5)
  const inbox = (await b.app.inject({ url: `/sandbox/mail/messages?address=${encodeURIComponent(email)}` })).json().messages as { from: string; subject: string; text: string }[]
  const out: Record<string, string> = {}
  for (const slug of slugs) {
    const mail = inbox.find((m) => m.from === `noreply@${slug}.dirs.sandbox` && /Verify your email/.test(m.subject))
    const link = mail?.text.match(/https?:\/\/\S+\/account\/verify\/[0-9a-f]+/)?.[0]
    if (!link) throw new Error(`no verification mail for ${slug}`)
    await b.app.inject({ url: new URL(link).pathname })
    const login = await b.app.inject({ method: 'POST', url: `/sandbox/dirs/${slug}/api/login`, payload: { email, password } })
    if (login.statusCode !== 200) throw new Error(`login ${slug}: ${login.statusCode} ${login.body}`)
    out[slug] = login.json().session_token
  }
  return out
}
