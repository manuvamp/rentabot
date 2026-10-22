// End to end over real HTTP: the shipped url_live / page_mentions / artifact_attached checks against Sandbox Web.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import { buildDirectories } from '../../src/sandbox/directories.ts'
import { SANDBOX_SEED, registerSandbox } from '../../src/sandbox/index.ts'
import { checkCtx, product } from './helpers.ts'

const app = Fastify()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scratch-rentabot-sandbox-'))
let origin = ''
let checks: ReturnType<typeof createCheckLibrary>

beforeAll(async () => {
  const probe = net.createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise((r) => probe.close(r))
  origin = `http://127.0.0.1:${port}`
  checks = createCheckLibrary({ allowHosts: [`127.0.0.1:${port}`] })
  await registerSandbox(app, { checks, publicUrl: origin, dataDir, timeScale: 1 })
  await app.listen({ port, host: '127.0.0.1' })
})
afterAll(async () => {
  await app.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const post = async (slug: string) => (await fetch(`${origin}/sandbox/dirs/${slug}/api/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(product()) })).json() as Promise<{ listing_url: string }>
const run = (check: string, url: string, params: Record<string, unknown>) => {
  const ctx = checkCtx(check, {}, params)
  ctx.unit = { ref: 'u', url, artifact_ids: [], meta: {} }
  return checks.get(check)!.run(ctx)
}

describe('real checks over HTTP', () => {
  it('url_live + page_mentions pass on an instant listing and page_mentions fails on a rewritten one', async () => {
    const dirs = buildDirectories(SANDBOX_SEED)
    const good = await post(dirs.find((d) => d.behavior === 'instant' && !d.needs_account)!.slug)
    expect((await run('url_live', good.listing_url, {})).status).toBe('pass')
    expect((await run('page_mentions', good.listing_url, { must_include: ['ORANO'] })).status).toBe('pass')

    const rewritten = await post(dirs.find((d) => d.behavior === 'rewrite_name' && !d.needs_account)!.slug)
    expect((await run('url_live', rewritten.listing_url, {})).status).toBe('pass')
    expect((await run('page_mentions', rewritten.listing_url, { must_include: ['ORANO'] })).status).toBe('fail')

    const pending = await post(dirs.find((d) => d.behavior === 'moderation_delay' && !d.needs_account)!.slug)
    expect((await run('url_live', pending.listing_url, {})).status).toBe('fail') // 404 now; delayed check retries
  })

  it('the snapshot is served as an image', async () => {
    const dirs = buildDirectories(SANDBOX_SEED)
    const l = await post(dirs.filter((d) => d.behavior === 'instant' && !d.needs_account)[1]!.slug)
    const r = await fetch(`${l.listing_url}/snapshot`)
    expect(r.headers.get('content-type')).toContain('image/svg+xml')
    expect(await r.text()).toContain('rendered snapshot')
  })
})
