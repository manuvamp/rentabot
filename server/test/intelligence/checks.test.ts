import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JobSpec, type Artifact } from '@rentabot/shared'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import type { CheckContext } from '../../src/intelligence/types.ts'
import { createCopilot } from '../../src/intelligence/copilot/copilot.ts'
import { createAiClient, readAiConfig } from '../../src/intelligence/ai/provider.ts'
import { demoContract } from './fixture.ts'

let server: http.Server
let host = ''
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = req.url ?? '/'
    if (u === '/ok') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><title>Dir</title><script>var ORANOFAKE=1</script><body><h1>ORANO &amp; friends</h1><p>Plan your week at oranoai.com</p></body></html>')
    if (u.startsWith('/r')) {
      const n = Number(u.slice(2))
      return void res.writeHead(302, { location: n > 0 ? `/r${n - 1}` : '/ok' }).end()
    }
    if (u === '/big') return void res.writeHead(200, { 'content-type': 'text/html' }).end(`<p>${'x'.repeat(3_000_000)} ORANO</p>`)
    if (u === '/to-meta') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
    if (u === '/.well-known/rentabot-scope.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('rentabot scope\njob_demo0001\n')
    res.writeHead(404).end('nope')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const bytes = (s: string) => new TextEncoder().encode(s)
const art = (id: string, mime: string, name: string, content: string) => ({
  meta: { id, job_id: null, name, mime, bytes: content.length, sha256: `sha256:${'0'.repeat(64)}`, url: '/x', uploaded_by: 'agt_x', created_at: '2026-10-19T00:00:00Z' } as Artifact,
  bytes: bytes(content),
})

function ctx(check: string, params: Record<string, unknown>, unit: Partial<NonNullable<CheckContext['unit']>> | null, store: Record<string, ReturnType<typeof art>> = {}): CheckContext {
  return {
    job_id: 'job_demo0001',
    contract: demoContract(),
    deliverable_id: 'D1',
    unit: unit ? { ref: 'u1', artifact_ids: [], meta: {}, ...unit } : null,
    test: { check, params },
    attempt: 1,
    artifact: async (id) => store[id] ?? null,
    saveEvidence: async () => 'ev_test0001',
  }
}

describe('check library', () => {
  const lib = () => createCheckLibrary({ allowHosts: [host] })
  const run = (c: CheckContext) => lib().get(c.test.check)!.run(c)

  it('lists every check with a valid definition', () => {
    const ids = lib().list().map((d) => d.id)
    expect(ids).toEqual(expect.arrayContaining(['url_live', 'page_mentions', 'artifact_attached', 'json_schema_valid', 'sha256_matches', 'report_sections_present', 'scope_proof_valid', 'email_delivered', 'finding_reproduces']))
  })

  it('url_live: pass, 404, redirects (<=3), and SSRF via redirect', async () => {
    expect((await run(ctx('url_live', {}, { url: `http://${host}/ok` }))).status).toBe('pass')
    expect((await run(ctx('url_live', {}, { url: `http://${host}/missing` }))).status).toBe('fail')
    expect((await run(ctx('url_live', {}, { url: `http://${host}/r2` }))).status).toBe('pass')
    const tooMany = await run(ctx('url_live', {}, { url: `http://${host}/r5` }))
    expect(tooMany.status).toBe('fail')
    expect(tooMany.detail).toMatch(/redirect/)
    const meta = await run(ctx('url_live', {}, { url: `http://${host}/to-meta` }))
    expect(meta.status).toBe('fail')
    expect(meta.detail).toMatch(/SSRF/)
  })

  it('url_live: private target without allow-list is refused', async () => {
    const r = await createCheckLibrary().get('url_live')!.run(ctx('url_live', {}, { url: `http://${host}/ok` }))
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/SSRF/)
  })

  it('page_mentions: visible text only, case-insensitive, size-capped', async () => {
    expect((await run(ctx('page_mentions', { must_include: ['orano', 'ORANOAI.COM'] }, { url: `http://${host}/ok` }))).status).toBe('pass')
    const r = await run(ctx('page_mentions', { must_include: ['ORANOFAKE'] }, { url: `http://${host}/ok` }))
    expect(r.status).toBe('fail') // only inside <script>
    expect((await run(ctx('page_mentions', { must_include: ['ORANO'] }, { url: `http://${host}/big` }))).detail).toMatch(/truncated/)
    expect((await run(ctx('page_mentions', {}, { url: `http://${host}/ok` }))).status).toBe('error') // params invalid
  })

  it('artifact_attached', async () => {
    const store = { art_img00001: art('art_img00001', 'image/png', 's.png', 'png'), art_txt00001: art('art_txt00001', 'text/plain', 'a.txt', 'x') }
    expect((await run(ctx('artifact_attached', { mime_prefix: 'image/' }, { artifact_ids: ['art_img00001'] }, store))).status).toBe('pass')
    expect((await run(ctx('artifact_attached', { mime_prefix: 'image/', min_count: 2 }, { artifact_ids: ['art_img00001', 'art_txt00001'] }, store))).status).toBe('fail')
  })

  it('json_schema_valid on meta and artifact', async () => {
    const schema = { type: 'object', required: ['listing_url'], properties: { listing_url: { type: 'string' } } }
    expect((await run(ctx('json_schema_valid', { schema }, { meta: { listing_url: 'https://x.example' } }))).status).toBe('pass')
    expect((await run(ctx('json_schema_valid', { schema }, { meta: {} }))).status).toBe('fail')
    const store = { art_json0001: art('art_json0001', 'application/json', 'u.json', '{"listing_url":"a"}') }
    expect((await run(ctx('json_schema_valid', { schema, source: 'artifact' }, { artifact_ids: ['art_json0001'] }, store))).status).toBe('pass')
  })

  it('sha256_matches computes from bytes', async () => {
    const store = { art_file0001: art('art_file0001', 'application/zip', 'f.zip', 'hello') }
    const h = createHash('sha256').update('hello').digest('hex')
    expect((await run(ctx('sha256_matches', { sha256: `sha256:${h}` }, { artifact_ids: ['art_file0001'] }, store))).status).toBe('pass')
    expect((await run(ctx('sha256_matches', { sha256: '0'.repeat(64) }, { artifact_ids: ['art_file0001'] }, store))).status).toBe('fail')
  })

  it('report_sections_present', async () => {
    const md = '# Executive Summary\ntext\n## Findings\n### Reproduction steps\n'
    const store = { art_rep00001: art('art_rep00001', 'text/markdown', 'r.md', md) }
    expect((await run(ctx('report_sections_present', { headings: ['summary', 'Findings', 'Reproduction'] }, { artifact_ids: ['art_rep00001'] }, store))).status).toBe('pass')
    const r = await run(ctx('report_sections_present', { headings: ['Scope'] }, { artifact_ids: ['art_rep00001'] }, store))
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/Scope/)
  })

  it('scope_proof_valid requires the job id at the well-known path', async () => {
    expect((await run(ctx('scope_proof_valid', { target: `http://${host}` }, null))).status).toBe('pass')
    const other = lib().get('scope_proof_valid')!.run({ ...ctx('scope_proof_valid', { target: `http://${host}` }, null), job_id: 'job_other0001' })
    expect((await other).status).toBe('fail')
  })

  it('stubs say who provides them, and register replaces them', async () => {
    const l = lib()
    const r = await l.get('email_delivered')!.run(ctx('email_delivered', {}, { ref: 'e1' }))
    expect(r.status).toBe('error')
    expect(r.detail).toMatch(/Sandbox Web/)
    l.register({ def: { ...l.get('email_delivered')!.def }, run: async () => ({ status: 'pass', detail: 'ok', evidence_id: null }) })
    expect((await l.get('email_delivered')!.run(ctx('email_delivered', {}, { ref: 'e1' }))).status).toBe('pass')
  })
})

describe('spec copilot fallback (AI off)', () => {
  it('produces a valid spec with registered checks, deadline and budget', async () => {
    const ai = createAiClient(readAiConfig({ AI_PROVIDER: 'none' }))
    const checks = createCheckLibrary().list()
    const now = Date.parse('2026-10-19T10:00:00Z')
    const copilot = createCopilot({ ai, now: () => now })
    const skill = {
      id: 'directory_submission',
      title: 'Submit a product to directories',
      description: 'Submits and proves listings.',
      needs: {},
      delivers: { type: 'object', properties: { url: { type: 'string' } } },
      checks: ['url_live', 'page_mentions', 'artifact_attached', 'listing_magic'],
      pricing: { model: 'per_unit' as const, currency: 'USD' as const, price: '1.50', unit: 'verified_listing', min_units: 20 },
      turnaround: 'P7D',
      verify_window: 'P14D',
      examples: [],
    }
    const d = await copilot.draft({ bot: {} as never, skill, goal: 'Get ORANO listed on 40 AI directories, with a high-quality description', quantity: 40, checks })
    expect(() => JobSpec.parse(d.spec)).not.toThrow()
    expect(d.estimate.value).toBe('60.00')
    expect(d.spec.budget_cap.value).toBe('60.00')
    expect(d.spec.deliverables[0]!.quantity).toBe(40)
    expect(d.spec.deliverables[0]!.acceptance.map((a) => a.check)).toEqual(['url_live', 'page_mentions', 'artifact_attached'])
    expect(d.spec.deliverables[0]!.acceptance[1]!.params).toEqual({ must_include: ['ORANO'] })
    expect(Date.parse(d.spec.deadline)).toBeGreaterThan(now + 7 * 86_400_000)
    expect(d.warnings.join(' ')).toMatch(/listing_magic/)
    expect(d.spec.deliverables[0]!.rubric).toMatch(/high-quality/)
  })

  it('says so when the asked quantity is outside the bot\'s range, and tells the model the real quantity (found on production 2026-10-20)', async () => {
    const checks = createCheckLibrary().list()
    const skill = {
      id: 'directory_submission',
      title: 'Submit a product to directories',
      description: 'Submits and proves listings.',
      needs: {},
      delivers: { type: 'object', properties: { url: { type: 'string' } } },
      checks: ['url_live'],
      pricing: { model: 'per_unit' as const, currency: 'USD' as const, price: '1.50', unit: 'verified_listing', min_units: 20, max_units: 120 },
      turnaround: 'P7D',
      verify_window: 'PT0H',
      examples: [],
    }
    // AI off: the template path.
    const off = createCopilot({ ai: createAiClient(readAiConfig({ AI_PROVIDER: 'none' })) })
    const a = await off.draft({ bot: {} as never, skill, goal: 'List ORANO on 10 free AI directories', quantity: 10, checks })
    expect(a.spec.deliverables[0]!.quantity).toBe(20)
    expect(a.warnings.join(' ')).toMatch(/asked for 10 .*at least 20/)
    // AI on: the model wrote its text for the 10 the buyer asked for; it must be told the spec is for 20.
    let prompt = ''
    const ai = {
      enabled: true,
      config: { models: { main: 'fake' } },
      askJson: async (o: { prompt: string }) => {
        prompt = o.prompt
        return { deliverables: [{ id: 'D1', description: '10 listings', quantity: 10, acceptance: [{ check: 'url_live', params: {} }], rubric: '' }], out_of_scope: [], warnings: [] }
      },
    }
    const on = createCopilot({ ai: ai as never })
    const b = await on.draft({ bot: {} as never, skill, goal: 'List ORANO on 10 free AI directories', quantity: 10, checks })
    expect(b.spec.deliverables[0]!.quantity).toBe(20)
    expect(prompt).toMatch(/buyer asked for 10/)
    expect(b.warnings.join(' ')).toMatch(/asked for 10 .*at least 20/)
    // Inside the range: no such warning.
    const c = await off.draft({ bot: {} as never, skill, goal: 'List ORANO on 30 free AI directories', quantity: 30, checks })
    expect(c.warnings.join(' ')).not.toMatch(/asked for/)
  })
})
