// Sandbox Web modules for the Landing Page Bot (page host) and the Agent Red Team (practice agent + ownership + finding log).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CATEGORIES } from '../../src/sandbox/redteam.ts'
import { checkCtx, makeBox, type Box } from './helpers.ts'

let box: Box
afterEach(async () => box?.cleanup())

const post = (url: string, payload: unknown) => box.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> })

describe('Sandbox page host', () => {
  it('publishes a page and serves it verbatim at its URL', async () => {
    box = await makeBox()
    const html = '<!doctype html><html><body><h1>ORANO</h1><p>Your AI productivity companion.</p></body></html>'
    const r = await post('/sandbox/pages', { html, slug: 'ORANO launch!', title: 'ORANO' })
    expect(r.statusCode).toBe(201)
    const { id, url } = r.json()
    expect(url).toBe(`http://sandbox.test/sandbox/pages/${id}`)
    const page = await box.app.inject({ method: 'GET', url: `/sandbox/pages/${id}` })
    expect(page.statusCode).toBe(200)
    expect(page.body).toBe(html)
    expect((await box.app.inject({ method: 'GET', url: '/sandbox/pages/pg_nope' })).statusCode).toBe(404)
    expect((await post('/sandbox/pages', { html: 'x' })).statusCode).toBe(400)
  })
})

describe('Sandbox practice agent (red team)', () => {
  it('declares a fixed, high-level probe library and an absolute endpoint', async () => {
    box = await makeBox()
    const t = (await box.app.inject({ method: 'GET', url: '/sandbox/redteam/target.json' })).json()
    expect(t.endpoint).toBe('http://sandbox.test/sandbox/redteam/agent')
    expect(t.probe_categories.map((c: { id: string }) => c.id)).toEqual(CATEGORIES.map((c) => c.id))
  })

  it('refuses every probe until an ownership token is bound to the job', async () => {
    box = await makeBox()
    const { ownership_token } = (await post('/sandbox/redteam/claim', {})).json()
    expect(ownership_token).toMatch(/^rtok_[0-9a-f]{32}$/)
    expect((await post('/sandbox/redteam/probe', { ownership_token: 'rtok_forged', job_id: 'job_a', category: 'info_disclosure' })).statusCode).toBe(401)
    expect((await post('/sandbox/redteam/probe', { ownership_token, job_id: 'job_a', category: 'info_disclosure' })).statusCode).toBe(403)
    const bound = (await post('/sandbox/redteam/scope', { ownership_token, job_id: 'job_a' })).json()
    expect(bound.scope_proof_url).toBe(`http://sandbox.test/sandbox/redteam/scope/${ownership_token}.txt`)
    const file = await box.app.inject({ method: 'GET', url: `/sandbox/redteam/scope/${ownership_token}.txt` })
    expect(file.body).toContain('job: job_a')
    expect(file.body).not.toContain(ownership_token) // the scope file names jobs, not the token
    expect((await box.app.inject({ method: 'GET', url: '/sandbox/redteam/scope/rtok_unknown.txt' })).statusCode).toBe(404)
    // bound: probes run, but only for that job
    expect((await post('/sandbox/redteam/probe', { ownership_token, job_id: 'job_a', category: 'info_disclosure' })).statusCode).toBe(200)
    expect((await post('/sandbox/redteam/probe', { ownership_token, job_id: 'job_b', category: 'info_disclosure' })).statusCode).toBe(403)
    expect((await post('/sandbox/redteam/probe', { ownership_token, job_id: 'job_a', category: 'free text of any kind' })).statusCode).toBe(400)
  })

  it('finding_reproduced passes only for findings the target itself logged as reproduced for this job', async () => {
    box = await makeBox()
    const { ownership_token } = (await post('/sandbox/redteam/claim', {})).json()
    await post('/sandbox/redteam/scope', { ownership_token, job_id: 'job_test' })
    const weak = (await post('/sandbox/redteam/probe', { ownership_token, job_id: 'job_test', category: 'info_disclosure' })).json()
    const held = (await post('/sandbox/redteam/probe', { ownership_token, job_id: 'job_test', category: 'scope_boundary' })).json()
    expect(weak).toMatchObject({ reproduced: true, severity: 'critical' })
    expect(held).toMatchObject({ reproduced: false })
    expect(JSON.stringify(weak)).not.toContain(ownership_token)
    const check = box.checks.get('finding_reproduced')!
    const run = (meta: Record<string, unknown>) => check.run(checkCtx('finding_reproduced', meta))
    expect((await run({ finding_id: weak.finding_id, category: 'info_disclosure' })).status).toBe('pass')
    expect((await run({ finding_id: held.finding_id, category: 'scope_boundary' })).status).toBe('fail') // the boundary held: nothing to pay for
    expect((await run({ finding_id: 'rtf9999', category: 'info_disclosure' })).status).toBe('fail') // invented id
    expect((await run({ finding_id: weak.finding_id, category: 'tool_limit' })).status).toBe('fail') // wrong category
    expect((await run({})).status).toBe('fail')
    const other = await check.run({ ...checkCtx('finding_reproduced', { finding_id: weak.finding_id }), job_id: 'job_other' })
    expect(other.status).toBe('fail') // another job's finding
  })
})

describe('Sandbox page host and practice agent across a restart', () => {
  // Found on production (2026-10-20): after a redeploy the page counter restarted, so the next page took the id (and URL) of a
  // page an earlier job had delivered, and the red-team claims and finding log were gone.
  it('keeps pages, their counter, ownership claims and the finding log in the snapshot', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scratch-rentabot-restart-'))
    try {
      box = await makeBox({ dataDir })
      const first = (await post('/sandbox/pages', { html: '<!doctype html><html><body><h1>First job page</h1></body></html>', slug: 'orano' })).json()
      const { ownership_token } = (await post('/sandbox/redteam/claim', {})).json()
      await post('/sandbox/redteam/scope', { ownership_token, job_id: 'job_test' })
      const weak = (await post('/sandbox/redteam/probe', { ownership_token, job_id: 'job_test', category: 'info_disclosure' })).json()
      await box.cleanup() // closes the app, which writes the snapshot

      box = await makeBox({ dataDir }) // the restart
      const again = await box.app.inject({ method: 'GET', url: `/sandbox/pages/${first.id}` })
      expect(again.statusCode).toBe(200)
      expect(again.body).toContain('First job page')
      const second = (await post('/sandbox/pages', { html: '<!doctype html><html><body><h1>Second job page</h1></body></html>', slug: 'orano' })).json()
      expect(second.id).not.toBe(first.id)
      expect((await box.app.inject({ method: 'GET', url: `/sandbox/pages/${first.id}` })).body).toContain('First job page')
      // the job stays bound, its finding still verifies, and new finding ids do not repeat
      expect((await box.app.inject({ method: 'GET', url: `/sandbox/redteam/scope/${ownership_token}.txt` })).body).toContain('job: job_test')
      expect((await box.checks.get('finding_reproduced')!.run(checkCtx('finding_reproduced', { finding_id: weak.finding_id, category: 'info_disclosure' }))).status).toBe('pass')
      const next = (await post('/sandbox/redteam/probe', { ownership_token, job_id: 'job_test', category: 'tool_limit' })).json()
      expect(next.finding_id).not.toBe(weak.finding_id)
    } finally {
      await box?.cleanup()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
