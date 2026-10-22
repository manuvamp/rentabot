import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPS } from '@rentabot/shared'
import { OpError } from '../../src/core/types.ts'
import { post, startLive, toolJson, type Live } from './helpers.ts'

let live: Live
beforeAll(async () => {
  live = await startLive()
})
afterAll(async () => {
  await live.close()
})
const buyer = () => live.core.stub.keys.buyer
const seller = () => live.core.stub.keys.seller
const get = (path: string, key?: string, headers: Record<string, string> = {}) => fetch(`${live.base}${path}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } })

describe('REST ops', () => {
  it('gives the same structured result as MCP for the same op', async () => {
    const c = await live.mcp({ key: buyer() })
    const viaMcp = ((await c.callTool({ name: 'get_job', arguments: { job_id: 'job_demo31of40' } })) as any).structuredContent
    const viaRest = await (await post(live.base, 'get_job', { job_id: 'job_demo31of40' }, buyer())).json()
    expect(viaRest).toEqual(viaMcp)
    const a = await (await post(live.base, 'search_bots', { query: 'outreach' })).json()
    const b = ((await (await live.mcp()).callTool({ name: 'search_bots', arguments: { query: 'outreach' } })) as any).structuredContent
    expect(a).toEqual(b)
    expect(a.bots).toHaveLength(1)
  })

  it('serves GET aliases for read-only ops with query coercion', async () => {
    const r = await get('/api/ops/get_job?job_id=job_demo31of40', buyer())
    expect(r.status).toBe(200)
    expect((await r.json()).job.state).toBe('RULED')
    const bots = await (await get('/api/ops/search_bots?limit=2&capability_class=reach')).json()
    expect(bots.bots).toHaveLength(1)
    const jobs = await (await get('/api/ops/list_jobs?needs_action=true&limit=5', buyer())).json()
    expect(jobs.jobs.map((j: any) => j.id)).toContain('job_demo31of40')
    const w = await (await get('/api/ops/wait_for_events?timeout_seconds=0&after_cursor=0&types=state,message', buyer())).json()
    expect(Array.isArray(w.events)).toBe(true)
    const mutating = await get('/api/ops/create_job', buyer())
    expect(mutating.status).toBe(400)
    expect((await mutating.json()).error.hint).toContain('POST')
  })

  it('maps errors to statuses and the OpError body', async () => {
    const noauth = await post(live.base, 'whoami', {})
    expect(noauth.status).toBe(401)
    expect(noauth.headers.get('www-authenticate')).toContain('Bearer')
    expect((await noauth.json()).error.hint).toContain('register_agent')

    const bad = await post(live.base, 'get_job', { job_id: 'x' }, buyer())
    expect(bad.status).toBe(400)
    const body = await bad.json()
    expect(body.error.code).toBe('invalid_input')
    expect(body.error.hint).toContain('job_id')

    expect((await post(live.base, 'no_such_op', {}, buyer())).status).toBe(404)
    expect((await post(live.base, 'get_job', { job_id: 'job_doesnotexist1' }, buyer())).status).toBe(404)
    const invalidJson = await fetch(`${live.base}/api/ops/whoami`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer()}` }, body: '{oops' })
    expect(invalidJson.status).toBe(400)
    expect((await post(live.base, 'whoami', {}, 'rab_wrong_key')).status).toBe(401)
    // an agent calling a person-only op
    expect((await post(live.base, 'claim_agent', { claim_code: 'ABCDEF12' }, buyer())).status).toBe(403)
    // MCP-only absence: arbiter_decide is REST but agents are forbidden
    expect((await post(live.base, 'arbiter_decide', { job_id: 'job_demo31of40', decision: 'confirm', note: 'fine by me' }, buyer())).status).toBe(403)
    // empty body works for no-arg ops
    expect((await fetch(`${live.base}/api/ops/list_checks`, { method: 'POST' })).status).toBe(200)
    // public ops ignore a stale key
    expect((await post(live.base, 'register_agent', { name: 'Stale Key Agent' }, 'rab_stale')).status).toBe(200)
  })

  it('does not leak internals on unexpected errors', async () => {
    const original = live.core.handlers.whoami
    live.core.handlers.whoami = async () => {
      throw new Error('database password is hunter2')
    }
    const r = await post(live.base, 'whoami', {}, buyer())
    live.core.handlers.whoami = original
    expect(r.status).toBe(500)
    const text = await r.text()
    expect(text).not.toContain('hunter2')
    expect(JSON.parse(text).error.code).toBe('internal')
    // OpError thrown by a handler keeps its status and body
    live.core.handlers.whoami = async () => {
      throw new OpError('mandate_exceeded', 'Over the monthly cap.', 'Ask for a bigger mandate.', [{ op: 'request_mandate', why: 'raise caps', args: {} }])
    }
    const r2 = await post(live.base, 'whoami', {}, buyer())
    live.core.handlers.whoami = original
    expect(r2.status).toBe(402)
    expect((await r2.json()).error.next_actions[0].op).toBe('request_mandate')
  })

  it('flags handler output that violates its schema (strict mode)', async () => {
    const original = live.core.handlers.list_checks
    ;(live.core.handlers as any).list_checks = async () => ({ checks: 'nope' })
    const r = await post(live.base, 'list_checks', {})
    live.core.handlers.list_checks = original
    expect(r.status).toBe(500)
  })

  it('runs a buyer flow end to end, with stale-contract protection and a simulated PayPal approval', async () => {
    const reg = await (await post(live.base, 'register_agent', { name: 'REST Buyer' })).json()
    const key = reg.api_key as string
    const draft = await (await post(live.base, 'draft_job_spec', { bot_id: 'bot_directoryblaster', skill_id: 'directory_submission', goal: 'List my product on 12 directories', quantity: 12 }, key)).json()
    const created = await (await post(live.base, 'create_job', { bot_id: 'bot_directoryblaster', spec: draft.spec, idempotency_key: 'rest-flow-1' }, key)).json()
    const again = await (await post(live.base, 'create_job', { bot_id: 'bot_directoryblaster', spec: draft.spec, idempotency_key: 'rest-flow-1' }, key)).json()
    expect(again.job.id).toBe(created.job.id)
    const jobId = created.job.id
    const job = await (await get(`/api/ops/get_job?job_id=${jobId}`, key)).json()
    const stale = await post(live.base, 'accept_contract', { job_id: jobId, contract_hash: 'sha256:' + '0'.repeat(64) }, key)
    expect(stale.status).toBe(409)
    expect((await stale.json()).error.code).toBe('stale_contract')
    const ok = await (await post(live.base, 'accept_contract', { job_id: jobId, contract_hash: job.job.contract_hash }, key)).json()
    expect(ok.job.state).toBe('AGREED')
    const early = await post(live.base, 'submit_delivery', { job_id: jobId, delivery: { deliverables: [] } }, key)
    expect(early.status).toBe(403) // buyer calling a seller op

    const funded = await (await post(live.base, 'fund_job', { job_id: jobId, idempotency_key: 'rest-fund-01' }, key)).json()
    expect(funded.job.state).toBe('AWAITING_APPROVAL')
    const orderId = funded.job.escrow.paypal.order_id
    const sim = await post(live.base, '../sim/paypal/approve', { kind: 'order', id: orderId, approve: true })
    expect(sim.status).toBe(200)
    expect((await get(`/api/ops/get_job?job_id=${jobId}`, key).then((r) => r.json())).job.state).toBe('IN_PROGRESS')

    // the seller delivers 12 units, 2 of them broken
    const units = Array.from({ length: 12 }, (_, n) => ({ ref: `u${n}`, url: `https://x.example/${n}`, artifact_ids: [], meta: n < 2 ? { fail: true } : {} }))
    const delivered = await (await post(live.base, 'submit_delivery', { job_id: jobId, delivery: { deliverables: [{ deliverable_id: 'D1', units }] } }, seller())).json()
    expect(delivered.job.state).toBe('DELIVERED')
    expect(delivered.job.fulfilment[0].passed_units).toBe(10)
    const accepted = await (await post(live.base, 'review_delivery', { job_id: jobId, decision: 'accept' }, key)).json()
    expect(accepted.job.state).toBe('SETTLED')
    const escrow = (await (await post(live.base, 'get_escrow', { job_id: jobId }, key)).json()).escrow
    expect(escrow.captured.value).toBe('15.00') // 10 x 1.50
  })

  it('applies a vault mandate so fund_job needs no human', async () => {
    const reg = await (await post(live.base, 'register_agent', { name: 'Mandated Buyer' })).json()
    const key = reg.api_key as string
    const m = await (await post(live.base, 'request_mandate', { monthly_cap: '100.00', per_job_cap: '50.00', categories: ['real_world_action'] }, key)).json()
    expect(m.mandate.status).toBe('pending_approval')
    expect((await post(live.base, '../sim/paypal/approve', { kind: 'vault', id: m.mandate.id, approve: true })).status).toBe(200)
    expect((await (await post(live.base, 'get_mandate', {}, key)).json()).mandate.status).toBe('active')
    const draft = await (await post(live.base, 'draft_job_spec', { bot_id: 'bot_directoryblaster', skill_id: 'directory_submission', goal: 'List my product on 10 directories', quantity: 10 }, key)).json()
    const job = await (await post(live.base, 'create_job', { bot_id: 'bot_directoryblaster', spec: draft.spec }, key)).json()
    const accepted = await (await post(live.base, 'accept_contract', { job_id: job.job.id, contract_hash: job.job.contract_hash ?? (await (await get(`/api/ops/get_job?job_id=${job.job.id}`, key)).json()).job.contract_hash }, key)).json()
    expect(accepted.job.state).toBe('AGREED')
    const funded = await (await post(live.base, 'fund_job', { job_id: job.job.id, idempotency_key: 'mandated-fund-1' }, key)).json()
    expect(funded.job.state).toBe('IN_PROGRESS')
    expect(funded.approval_url).toBeNull()
  })
})

describe('sessions, SSE, webhooks, artifacts, public data', () => {
  it('signs a person in with a cookie and lets them act through an agent', async () => {
    const r = await fetch(`${live.base}/api/session/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: 'owner' }) })
    expect(r.status).toBe(200)
    const cookie = r.headers.get('set-cookie')!
    expect(cookie).toMatch(/rab_session=sess_owner/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    const c = cookie.split(';')[0]!
    const session = await (await fetch(`${live.base}/api/session`, { headers: { cookie: c } })).json()
    expect(session.principal).toMatchObject({ kind: 'user', name: 'Manu' })
    // the shape the web app reads: the person with their demo role, and the agents they own
    expect(session.user).toMatchObject({ id: 'usr_manu0001', name: 'Manu', role: 'owner' })
    expect(session.agents.map((a: any) => a.id)).toContain('agt_oranogrowth001')
    const viaKey = await (await fetch(`${live.base}/api/session`, { headers: { authorization: `Bearer ${buyer()}` } })).json()
    expect(viaKey.user).toBeNull()
    expect(viaKey.agents.map((a: any) => a.id)).toEqual(['agt_oranogrowth001'])
    const asDefault = await (await fetch(`${live.base}/api/ops/whoami`, { headers: { cookie: c } })).json()
    expect(asDefault.agent.id).toBe('agt_oranogrowth001')
    const actAs = await (await fetch(`${live.base}/api/ops/whoami`, { headers: { cookie: c, 'x-act-as': 'agt_dirblaster0001' } })).json()
    expect(actAs.agent.id).toBe('agt_dirblaster0001')
    const anon = await (await fetch(`${live.base}/api/session`)).json()
    expect(anon.principal.kind).toBe('public')
    const out = await fetch(`${live.base}/api/session/logout`, { method: 'POST' })
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await fetch(`${live.base}/api/session/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: 'wizard' }) })).status).toBe(400)
  })

  it('streams the backlog then live events over SSE, honouring Last-Event-ID', async () => {
    const readUntil = async (res: Response, stop: (frames: { id?: string; event?: string; data?: string }[]) => boolean) => {
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const frames: { id?: string; event?: string; data?: string }[] = []
      const deadline = Date.now() + 4000
      while (Date.now() < deadline && !stop(frames)) {
        const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 1500))])
        if (done) break
        buf += dec.decode(value)
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const f: any = {}
          for (const line of raw.split('\n')) {
            const m = /^(id|event|data): ?(.*)$/.exec(line)
            if (m) f[m[1]!] = m[2]
          }
          if (f.id) frames.push(f)
        }
      }
      await reader.cancel().catch(() => {})
      return frames
    }
    const before = live.core.events.latestCursor()
    const ctl = new AbortController()
    const res = await fetch(`${live.base}/api/events/stream?after_cursor=0&job_id=job_demo31of40`, { headers: { authorization: `Bearer ${buyer()}` }, signal: ctl.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    setTimeout(() => live.core.stub.emit('message', 'job_demo31of40', 'live one', ['agt_oranogrowth001']), 300)
    const frames = await readUntil(res, (f) => f.some((x) => JSON.parse(x.data!).summary === 'live one'))
    ctl.abort()
    expect(frames.length).toBeGreaterThan(1) // backlog + live
    const ids = frames.map((f) => Number(f.id))
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
    expect(JSON.parse(frames.at(-1)!.data!).summary).toBe('live one')
    expect(frames.at(-1)!.event).toBe('message')
    expect(ids.at(-1)!).toBeGreaterThan(before)

    // resume after the last seen id: no backlog repeats
    const ctl2 = new AbortController()
    const res2 = await fetch(`${live.base}/api/events/stream?job_id=job_demo31of40&types=message`, { headers: { authorization: `Bearer ${buyer()}`, 'last-event-id': String(ids.at(-1)) }, signal: ctl2.signal })
    setTimeout(() => live.core.stub.emit('message', 'job_demo31of40', 'after resume', ['agt_oranogrowth001']), 200)
    const frames2 = await readUntil(res2, (f) => f.length >= 1)
    ctl2.abort()
    expect(frames2).toHaveLength(1)
    expect(JSON.parse(frames2[0]!.data!).summary).toBe('after resume')
    expect((await fetch(`${live.base}/api/events/stream?types=bogus`, { headers: { authorization: `Bearer ${buyer()}` } })).status).toBe(400)
  })

  it('preserves the raw webhook body and redirects PayPal returns', async () => {
    const body = '{ "event_type":  "PAYMENT.CAPTURE.COMPLETED",\n "x": 1 }'
    const r = await fetch(`${live.base}/api/paypal/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.event_type).toBe('PAYMENT.CAPTURE.COMPLETED')
    expect(j.note).toBe(`received ${body.length} bytes`)
    const ret = await fetch(`${live.base}/api/paypal/return?token=ORDER123`, { redirect: 'manual' })
    expect(ret.status).toBe(302)
    expect(ret.headers.get('location')).toBe('/jobs?returned=ORDER123')
    const vret = await fetch(`${live.base}/api/paypal/vault/return?setup_token_id=ST1`, { redirect: 'manual' })
    expect(vret.headers.get('location')).toBe('/mandates?returned=ST1')
  })

  it('serves artifacts only to signed-in callers, safely', async () => {
    const up = await (await post(live.base, 'upload_artifact', { name: 'proof <1>.html', mime: 'text/html', text: '<script>alert(1)</script>' }, buyer())).json()
    const id = up.artifact.id
    expect((await get(`/api/artifacts/${id}`)).status).toBe(401)
    const r = await get(`/api/artifacts/${id}`, buyer())
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('<script>')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(r.headers.get('content-security-policy')).toContain('sandbox')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    const png = await (await post(live.base, 'upload_artifact', { name: 'a.png', mime: 'image/png', content_base64: Buffer.from('x').toString('base64') }, buyer())).json()
    expect((await get(`/api/artifacts/${png.artifact.id}`, buyer())).headers.get('content-disposition')).toMatch(/^inline/)
    expect((await get('/api/artifacts/art_missing000', buyer())).status).toBe(404)
  })

  it('serves public data, health, the catalog, CORS and request ids', async () => {
    const stats = await (await get('/api/public/stats')).json()
    expect(stats.bots_listed).toBe(3)
    expect(stats.payment_rail).toBe('simulated')
    expect(Array.isArray(await (await get('/api/public/feed?limit=5')).json())).toBe(true)
    expect((await (await get('/api/health')).json()).ok).toBe(true)
    const meta = await (await get('/api/meta/ops')).json()
    expect(meta.count).toBe(OPS.length) // counted from the catalog, never hard-coded
    expect(meta.ops.find((o: any) => o.name === 'fund_job')).toMatchObject({ toolset: 'escrow', caller: 'buyer' })
    expect(meta.ops[0].input_schema.type).toBe('object')
    const pre = await fetch(`${live.base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://agent.example', 'access-control-request-method': 'POST' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull()
    expect(pre.headers.get('access-control-allow-headers')).toContain('Mcp-Session-Id')
    const local = await fetch(`${live.base}/api/health`, { headers: { origin: 'http://localhost:5173' } })
    expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(local.headers.get('access-control-allow-credentials')).toBe('true')
    const rid = await fetch(`${live.base}/api/health`, { headers: { 'x-request-id': 'my-trace-12345' } })
    expect(rid.headers.get('x-request-id')).toBe('my-trace-12345')
    const nf = await get('/api/nothing/here')
    expect(nf.status).toBe(404)
    expect((await nf.json()).error.code).toBe('not_found')
  })

  it('resets demo data only in demo mode', async () => {
    const r = await fetch(`${live.base}/api/demo/reset`, { method: 'POST' })
    expect(r.status).toBe(200)
    expect((await post(live.base, 'get_job', { job_id: 'job_demo31of40' }, buyer())).status).toBe(200)
    const other = await startLive({ demoMode: false, simulated: false })
    try {
      expect((await fetch(`${other.base}/api/demo/reset`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${other.base}/api/session/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: 'owner' }) })).status).toBe(404)
      expect((await post(other.base, '../sim/paypal/approve', { kind: 'order', id: 'x', approve: true })).status).toBe(404)
    } finally {
      await other.close()
    }
  })

  it('rate-limits per key with a retry hint', async () => {
    const limited = await startLive({}, { rateLimit: { burst: 3, perSecond: 0.01, publicBurst: 2, publicPerSecond: 0.01 } })
    try {
      const key = limited.core.stub.keys.buyer
      const codes: number[] = []
      for (let i = 0; i < 5; i++) codes.push((await post(limited.base, 'whoami', {}, key)).status)
      expect(codes).toEqual([200, 200, 200, 429, 429])
      const r = await post(limited.base, 'whoami', {}, key)
      expect(r.headers.get('retry-after')).toBeTruthy()
      expect((await r.json()).error.code).toBe('rate_limited')
      // other callers have their own bucket
      expect((await post(limited.base, 'whoami', {}, limited.core.stub.keys.seller)).status).toBe(200)
      // MCP tool calls count too
      const c = await limited.mcp({ key: limited.core.stub.keys.seller })
      const res: any[] = []
      for (let i = 0; i < 4; i++) res.push(await c.callTool({ name: 'whoami', arguments: {} }))
      expect(res.some((x) => x.isError && toolJson(x).error.code === 'rate_limited')).toBe(true)
    } finally {
      await limited.close()
    }
  })
})

describe('mediation ops, simulated PayPal pages, artifact access, arbiter views', () => {
  const j = (r: Response) => r.json() as Promise<any>
  const asArbiter = async () => {
    const r = await fetch(`${live.base}/api/session/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: 'arbiter' }) })
    return r.headers.get('set-cookie')!.split(';')[0]!
  }

  it('get_mediation (POST and GET) and respond_to_proposal: accept by both sides settles the job', async () => {
    const via = await j(await get('/api/ops/get_mediation?job_id=job_demomediation1', buyer()))
    expect(via.mediation).toMatchObject({ status: 'negotiating', round: 1 })
    expect(via.mediation.proposals.map((p: any) => p.kind)).toEqual(['split', 'redo'])
    expect(via.your_role).toBe('buyer')
    const ids = via.next_actions.filter((a: any) => a.op === 'respond_to_proposal').map((a: any) => a.args.proposal_id)
    expect(ids).toEqual(via.mediation.proposals.map((p: any) => p.id))
    const split = via.mediation.proposals[0]
    expect(await j(await post(live.base, 'get_mediation', { job_id: 'job_demomediation1' }, seller()))).toMatchObject({ your_role: 'seller' })
    expect((await post(live.base, 'get_mediation', { job_id: 'job_demomediation1' }, buyer() + 'x')).status).toBe(401)

    // validation: rejection needs a reason, unknown proposal, bad answer, bad id shape, strangers
    const noReason = await post(live.base, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: split.id, answer: 'reject' }, buyer())
    expect(noReason.status).toBe(400)
    expect((await post(live.base, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: 'prp_aaaaaaaaaaaa', answer: 'accept' }, buyer())).status).toBe(404)
    expect((await post(live.base, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: split.id, answer: 'maybe' }, buyer())).status).toBe(400)
    expect((await post(live.base, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: 'bogus', answer: 'accept' }, buyer())).status).toBe(400)
    const reg = await j(await post(live.base, 'register_agent', { name: 'Nosy Mediation Agent' }))
    expect((await post(live.base, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: split.id, answer: 'accept' }, reg.api_key)).status).toBe(403)

    const first = await j(await post(live.base, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: split.id, answer: 'accept' }, buyer()))
    expect(first.job.state).toBe('DISPUTED')
    expect(first.explanation).toMatch(/accepted proposal|answered accept/)
    expect((await post(live.base, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: split.id, answer: 'accept' }, buyer())).status).toBe(409) // answered once
    const done = await j(await post(live.base, 'respond_to_proposal', { job_id: 'job_demomediation1', proposal_id: split.id, answer: 'accept' }, seller()))
    expect(done.job.state).toBe('SETTLED')
    expect(done.job.mediation).toMatchObject({ status: 'agreed', agreed_proposal_id: split.id })
    expect(done.explanation).toMatch(/executed/)
  })

  it('serves the op input JSON Schemas for the new operations in the catalog', async () => {
    const meta = await j(await get('/api/meta/ops'))
    const respond = meta.ops.find((o: any) => o.name === 'respond_to_proposal')
    expect(respond.input_schema.required).toEqual(expect.arrayContaining(['job_id', 'proposal_id', 'answer']))
    expect(respond.input_schema.properties.answer.enum).toEqual(['accept', 'reject', 'counter'])
    expect(respond.input_schema.properties.terms.properties).toHaveProperty('release_now')
    expect(meta.ops.find((o: any) => o.name === 'get_mediation').annotations.readOnlyHint).toBe(true)
    for (const o of meta.ops) expect(o.input_schema.type, o.name).toBe('object')
    expect(meta.ops.find((o: any) => o.name === 'get_platform_ledger').surfaces).toEqual(['rest'])
  })

  it('the arbiter sees every appealed job and the platform ledger; others do not', async () => {
    const cookie = await asArbiter()
    const queue = await j(await fetch(`${live.base}/api/ops/list_jobs?state=APPEALED`, { headers: { cookie } }))
    expect(Array.isArray(queue.jobs)).toBe(true)
    expect((await post(live.base, 'get_platform_ledger', { limit: 5 }, buyer())).status).toBe(403)
    const ledger = await j(await fetch(`${live.base}/api/ops/get_platform_ledger`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }))
    expect(ledger).toMatchObject({ currency: 'USD', totals: expect.any(Object), jobs: expect.any(Array) })
    // an appeal makes the job show up in the queue, whoever the arbiter is
    expect((await j(await post(live.base, 'get_job', { job_id: 'job_demo31of40' }, buyer()))).job.state).toBe('RULED')
    await post(live.base, 'appeal_ruling', { job_id: 'job_demo31of40', grounds: 'The nine failed listings were still in moderation when checked.' }, seller())
    const after = await j(await fetch(`${live.base}/api/ops/list_jobs?state=APPEALED`, { headers: { cookie } }))
    expect(after.jobs.map((x: any) => x.id)).toContain('job_demo31of40')
    expect(after.jobs.find((x: any) => x.id === 'job_demo31of40').your_role).toBe('arbiter')
  })

  it('the simulated PayPal info page exists only on the simulated rail', async () => {
    const reg = await j(await post(live.base, 'register_agent', { name: 'Sim Page Buyer' }))
    const draft = await j(await post(live.base, 'draft_job_spec', { bot_id: 'bot_directoryblaster', skill_id: 'directory_submission', goal: 'List my product on 10 directories', quantity: 10 }, reg.api_key))
    const created = await j(await post(live.base, 'create_job', { bot_id: 'bot_directoryblaster', spec: draft.spec }, reg.api_key))
    const hash = (await j(await get(`/api/ops/get_job?job_id=${created.job.id}`, reg.api_key))).job.contract_hash
    await post(live.base, 'accept_contract', { job_id: created.job.id, contract_hash: hash }, reg.api_key)
    const funded = await j(await post(live.base, 'fund_job', { job_id: created.job.id, idempotency_key: 'sim-page-fund-1' }, reg.api_key))
    const orderId = funded.job.escrow.paypal.order_id
    const info = await j(await get(`/api/sim/paypal/order/${orderId}`))
    expect(info).toMatchObject({ kind: 'order', amount: '15.00', currency: 'USD', job_id: created.job.id })
    expect(info.lines.length).toBeGreaterThan(0)
    expect((await get('/api/sim/paypal/order/NOSUCHORDER')).status).toBe(404)
    const approved = await j(await post(live.base, '../sim/paypal/approve', { kind: 'order', id: orderId, approve: true }))
    expect(approved).toEqual({ redirect: `/jobs/${created.job.id}` })
    // a real PayPal rail has no stand-in pages
    const real = await startLive({ simulated: false })
    try {
      expect((await fetch(`${real.base}/api/sim/paypal/order/ANY`)).status).toBe(404)
      expect((await fetch(`${real.base}/api/sim/paypal/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'order', id: 'X', approve: true }) })).status).toBe(404)
    } finally {
      await real.close()
    }
  })

  it('artifacts are readable by the uploader and the parties of the job, not by strangers', async () => {
    const up = await j(await post(live.base, 'upload_artifact', { name: 'proof.txt', text: 'proof of work', job_id: 'job_demo31of40' }, seller()))
    const id = up.artifact.id as string
    expect((await get(`/api/artifacts/${id}`)).status).toBe(401)
    expect(await (await get(`/api/artifacts/${id}`, seller())).text()).toBe('proof of work') // uploader
    expect((await get(`/api/artifacts/${id}`, buyer())).status).toBe(200) // buyer of that job
    const stranger = await j(await post(live.base, 'register_agent', { name: 'Artifact Snoop' }))
    expect((await get(`/api/artifacts/${id}`, stranger.api_key)).status).toBe(404) // same answer as for an unknown id
    expect((await get('/api/artifacts/art_doesnotexist', stranger.api_key)).status).toBe(404)
  })

  it('register_agent and whoami never send an agent to the REST-only claim_agent', async () => {
    const reg = await j(await post(live.base, 'register_agent', { name: 'Unclaimed Agent' }))
    const me = await j(await post(live.base, 'whoami', {}, reg.api_key))
    for (const na of [...reg.next_actions, ...me.next_actions]) expect(na.op).not.toBe('claim_agent')
  })
})
