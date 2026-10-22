// createCore: wires storage, the payment rail, the state machine services, the op handlers,
// webhooks, the scheduler and demo seeding into the `Core` the adapters use.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, scaleMs, type AppConfig } from '../config.ts'
import { Db } from '../db/index.ts'
import type { Intelligence } from '../intelligence/types.ts'
import { createHandlers } from '../ops/index.ts'
import { createRail } from '../rails/index.ts'
import { SimulatedRail } from '../rails/simulated.ts'
import type { PaymentRail } from '../rails/types.ts'
import { parseWebhook } from '../rails/webhook.ts'
import { backfillHouseBriefs, isSeeded, seed } from '../seed/index.ts'
import { backfillNewBots } from '../seed/newbots-backfill.ts'
import { createAccounts } from './accounts.ts'
import { ArtifactStore } from './artifacts.ts'
import { Auth } from './auth.ts'
import { CheckRunner } from './checks.ts'
import { Domain } from './domain.ts'
import { EscrowService } from './escrow.ts'
import { Flows } from './flows.ts'
import type { JobRecord } from './model.ts'
import { OpenJobs } from './open-jobs.ts'
import { Locker } from './locker.ts'
import type { Services } from './services.ts'
import { Stats } from './stats.ts'
import type { Core, Principal, SessionInfo, SimApprovalInfo } from './types.ts'
import { json } from '../db/index.ts'
import { toAmount, toCents } from './util.ts'

export interface CreateCoreOptions {
  intelligence: Intelligence
  config?: Partial<AppConfig>
  now?: () => Date
  /** Inject a rail (tests). Default: from config. */
  rail?: PaymentRail
  /** fetch used for scope proofs (tests inject one). */
  fetch?: typeof fetch
  /** SQLite file; ':memory:' for tests. Default DATA_DIR/rentabot.db. */
  dbFile?: string
  /** Simulated rail knobs (tests): webhook delay, capture status. */
  simulated?: { webhookDelayMs?: number; captureStatus?: 'COMPLETED' | 'PENDING'; dropWebhooks?: boolean }
  /** Seed demo data when the database is empty (default true). */
  seed?: boolean
}

export interface CoreInternals {
  services: Services
  rail: PaymentRail
  /** Run every timer once (the scheduler calls this every few seconds). */
  tick(): Promise<void>
  /** Wait for background work: simulated webhooks, mediator steps. */
  drain(): Promise<void>
  /** Apply a webhook body without signature verification (simulated rail, tests). */
  ingestWebhook(rawBody: string): Promise<{ accepted: boolean; event_type: string | null; note: string }>
}

export type CoreImpl = Core & { internal: CoreInternals }

const DAY = 86_400_000
/** A failed seller payout is retried by the scheduler at most this often. */
const PAYOUT_RETRY_MS = 30_000

export async function createCore(opts: CreateCoreOptions): Promise<CoreImpl> {
  const cfg = loadConfig(opts.config)
  const clock = opts.now ?? (() => new Date())
  const db = new Db(opts.dbFile ?? join(cfg.dataDir, 'rentabot.db'))
  const rail = opts.rail ?? createRail(cfg, db, clock, scaleMs(cfg, 29 * DAY), opts.simulated)
  const d = new Domain(db, cfg, opts.intelligence, rail, clock)
  const artifacts = new ArtifactStore(d)
  const escrow = new EscrowService(d, opts.fetch ?? fetch)
  const checks = new CheckRunner(d, artifacts)
  const stats = new Stats(d)
  const flows = new Flows(d, escrow, checks, stats)
  const locker = new Locker(d, checks, escrow)
  await locker.init(cfg.sealKeysOld)
  const auth = new Auth(d)
  const openJobs = new OpenJobs(d, stats)
  const services: Services = { d, auth, escrow, checks, flows, locker, stats, artifacts, openJobs }
  escrow.onMoney = (rec, kind, cents) => stats.onMoney(rec, kind, cents)
  d.onTerminal = (rec: JobRecord) => {
    locker.onTerminal(rec)
    stats.onTerminal(rec)
  }
  const handlers = createHandlers(services)

  // ---------- webhooks ----------
  async function ingestWebhook(rawBody: string) {
    const evt = parseWebhook(rawBody)
    if (!evt) return { accepted: false, event_type: null, note: 'not a PayPal webhook event' }
    const fresh = db.run('INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at) VALUES (?, ?, ?)', evt.event_id, evt.event_type, d.nowIso())
    if (!Number(fresh.changes)) return { accepted: true, event_type: evt.event_type, note: 'duplicate delivery ignored' }
    const where = escrow.locate(evt)
    try {
      let note = 'no matching job or mandate'
      if (where.job_id) {
        note = await d.withLock(where.job_id, async () => {
          const rec = d.load(where.job_id!)
          const n = await escrow.applyWebhook(rec, evt)
          d.save(rec)
          return n
        })
      } else if (where.mandate_id) note = 'vault event recorded'
      db.run('UPDATE webhook_events SET result = ? WHERE event_id = ?', note, evt.event_id)
      return { accepted: true, event_type: evt.event_type, note }
    } catch (e) {
      // Forget the event so PayPal's retry applies it again.
      db.run('DELETE FROM webhook_events WHERE event_id = ?', evt.event_id)
      return { accepted: false, event_type: evt.event_type, note: `processing failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  rail.setWebhookSink?.(async (raw) => {
    await ingestWebhook(raw)
  })

  // ---------- scheduler ----------
  let ticking: Promise<void> | null = null
  async function tickOnce() {
    // Open jobs whose bid window closed: auto-award, or expire with no award. Awarding creates a job, so it runs before the job timers.
    await openJobs.tick()
    for (const id of d.openJobIds()) await flows.tickJob(id)
    // Locker: shred handovers 30 days after release, and anything left on finished jobs.
    locker.tick()
    // Retry payouts that failed after money was captured.
    for (const r of db.all<{ id: string }>("SELECT id FROM jobs WHERE state = 'SETTLED' AND data LIKE '%payout_failed%'")) {
      await d.withLock(r.id, async () => {
        const rec = d.load(r.id)
        const last = [...rec.escrow.events].reverse().find((e) => e.kind.startsWith('payout_'))
        // Back off: PayPal refusals (restricted sender country, unregistered receiver) do not fix themselves in 3 seconds.
        if (last?.kind === 'payout_failed' && d.nowMs() - Date.parse(last.ts) >= PAYOUT_RETRY_MS) await escrow.payout(rec)
      })
    }
    // Webhook fallback: captures still pending and payouts still unconfirmed after RECONCILE_AFTER_SECONDS are asked of PayPal.
    for (const r of db.all<{ id: string }>(`SELECT id FROM jobs WHERE data LIKE '%"pending_captures":[{%' OR data LIKE '%"status":"sent"%'`)) {
      await d.withLock(r.id, async () => {
        try {
          await escrow.reconcile(d.load(r.id))
        } catch (e) {
          console.error(`[reconciler] ${r.id}:`, e instanceof Error ? e.message : e)
        }
      })
    }
  }
  const tick = () => (ticking ??= tickOnce().finally(() => (ticking = null)))
  const timer = cfg.tickMs > 0 ? setInterval(() => void tick().catch((e) => console.error('[scheduler]', e)), cfg.tickMs) : null
  timer?.unref?.()

  async function drain() {
    const simPending = () => (rail instanceof SimulatedRail ? rail.pending : 0)
    for (let i = 0; i < 200; i++) {
      if (rail instanceof SimulatedRail) await rail.flush()
      await new Promise((r) => setTimeout(r, 0))
      if (!d.background.size && !simPending()) return
      await Promise.all([...d.background])
    }
  }

  // ---------- boot ----------
  if ((opts.seed ?? true) && !isSeeded(services)) seed(services)
  backfillNewBots(services)
  backfillHouseBriefs(services)
  // Mediator steps interrupted by a restart start again (an acceptance whose PayPal call failed is picked up by the next tick).
  for (const id of d.openJobIds()) {
    const rec = d.tryLoad(id)
    const status = rec?.state === 'DISPUTED' ? rec.mediation?.state.status : null
    if (status === 'investigating' || status === 'proposing') flows.scheduleStep(id)
  }

  /** May this principal read the artifact? The uploader, a party of a job that references it, or an arbiter (jobs they can see). */
  function canReadArtifact(meta: { id: string; job_id: string | null; uploaded_by: string }, principal: Principal): boolean {
    let actor
    try {
      actor = d.actor(principal)
    } catch {
      return false
    }
    if (actor.agents.has(meta.uploaded_by)) return true
    const jobIds = new Set<string>()
    if (meta.job_id) jobIds.add(meta.job_id)
    // Artifacts uploaded before a job existed are attached by reference: deliveries, messages, spec context.
    for (const r of db.all<{ job_id: string }>('SELECT DISTINCT job_id FROM messages WHERE data LIKE ?', `%${meta.id}%`)) jobIds.add(r.job_id)
    for (const r of db.all<{ id: string }>('SELECT id FROM jobs WHERE data LIKE ?', `%${meta.id}%`)) jobIds.add(r.id)
    for (const id of jobIds) {
      const rec = d.tryLoad(id)
      if (rec && d.roleIn(rec, actor)) return true
    }
    return false
  }

  async function session(principal: Principal): Promise<SessionInfo> {
    if (principal.kind === 'agent') {
      const a = d.agent(principal.agent_id)
      return { user: null, agents: a ? [a] : [] }
    }
    if (principal.kind !== 'user') return { user: null, agents: [] }
    const u = auth.user(principal.user_id)
    const role = (u?.persona === 'owner' || u?.persona === 'seller' || u?.persona === 'arbiter' ? u.persona : principal.roles.includes('arbiter') ? 'arbiter' : 'owner') as 'owner' | 'arbiter' | 'seller'
    const agents = d.agentsOfUser(principal.user_id, principal.act_as).map((id) => d.agent(id)).filter((a): a is NonNullable<typeof a> => !!a)
    return { user: { id: principal.user_id, name: principal.name, role, ...(u?.email ? { email: u.email } : {}) }, agents }
  }

  async function simulatedInfo(kind: 'order' | 'vault', id: string): Promise<SimApprovalInfo | null> {
    if (kind === 'vault') {
      const mid = escrow.mandateBySetupToken(id)
      const row = mid ? db.get<{ data: string }>('SELECT data FROM mandates WHERE id = ?', mid) : undefined
      if (!row) return null
      const m = json<{ monthly_cap: { value: string }; per_job_cap: { value: string }; categories: string[]; expires_at: string; agent_id: string }>(row.data)
      return {
        kind,
        id,
        title: 'Approve a spending mandate',
        amount: m.monthly_cap.value,
        currency: 'USD',
        lines: [
          { label: 'Per-job cap', value: `$${m.per_job_cap.value}` },
          { label: 'Categories', value: m.categories.join(', ') || 'none' },
          { label: 'Agent', value: d.agent(m.agent_id)?.name ?? m.agent_id },
          { label: 'Expires', value: m.expires_at.slice(0, 10) },
        ],
        return_to: '/account',
      }
    }
    const ref = db.get<{ job_id: string | null }>('SELECT job_id FROM paypal_refs WHERE paypal_id = ?', id)
    const rec = ref?.job_id ? d.tryLoad(ref.job_id) : null
    if (!rec) return null
    const contract = d.buildContract(rec)
    const total = contract ? toCents(contract.quote.total_max.value) : rec.escrow.authorized
    return {
      kind,
      id,
      title: `Authorize escrow for "${rec.title}"`,
      amount: toAmount(total),
      currency: 'USD',
      job_id: rec.id,
      lines: [
        { label: 'Job', value: rec.title },
        { label: 'Seller bot', value: d.bot(rec.seller_bot_id)?.name ?? rec.seller_bot_id },
        { label: 'Held, not taken', value: `$${toAmount(total)} (only what the checks prove is captured)` },
      ],
      return_to: `/jobs/${rec.id}`,
    }
  }

  const redirectErr = (path: string, e: unknown) => `${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(e instanceof Error ? e.message : String(e)).slice(0, 300)}`

  const core: CoreImpl = {
    handlers,
    config: { publicUrl: cfg.publicUrl, paymentRail: rail.kind, aiProvider: opts.intelligence.ai.provider, demoMode: cfg.demoMode },
    auth: {
      agentFromApiKey: async (key) => auth.agentFromApiKey(key),
      userFromSession: async (token) => auth.userFromSession(token),
      demoSignIn: async (persona) => auth.demoSignIn(persona),
      session,
    },
    accounts: createAccounts(services),
    events: {
      list: async (filter, limit) => d.bus.list(filter, limit),
      wait: (filter, timeoutMs, signal) => d.bus.wait(filter, timeoutMs, signal),
      subscribe: (filter, fn) => d.bus.subscribe(filter, fn),
      latestCursor: () => d.bus.latestCursor(),
    },
    payments: {
      async handleWebhook(headers, rawBody) {
        if (rail.kind === 'simulated') return { accepted: false, event_type: null, note: 'the simulated rail does not accept external webhooks' }
        let ok = false
        try {
          ok = await rail.verifyWebhook(headers, rawBody)
        } catch (e) {
          return { accepted: false, event_type: null, note: `signature verification unavailable: ${e instanceof Error ? e.message : String(e)}` }
        }
        if (!ok) return { accepted: false, event_type: null, note: 'signature verification failed' }
        return ingestWebhook(rawBody)
      },
      async onOrderReturn(query) {
        const job_id = query.job_id ?? ''
        const path = `/jobs/${encodeURIComponent(job_id)}`
        try {
          await d.withLock(job_id, async () => {
            const rec = d.load(job_id)
            if (query.token && rec.escrow.order_id && query.token !== rec.escrow.order_id) return
            if (query.cancel) escrow.approvalCancelled(rec)
            else await escrow.approvalReturned(rec)
          })
          return { redirect: `${path}?paypal=${query.cancel ? 'cancelled' : 'approved'}` }
        } catch (e) {
          return { redirect: redirectErr(path, e) }
        }
      },
      async onVaultReturn(query) {
        try {
          const m = await escrow.mandateApproved(query.mandate_id ?? '', !query.cancel)
          return { redirect: `/account?mandate=${m?.status ?? 'unknown'}` }
        } catch (e) {
          return { redirect: redirectErr('/account', e) }
        }
      },
      ...(rail.simulateApproval
        ? {
            simulatedInfo,
            async simulatedApprove(kind: 'order' | 'vault', id: string, approve: boolean) {
              try {
                await rail.simulateApproval!(kind, id, approve)
                if (kind === 'vault') {
                  const mid = escrow.mandateBySetupToken(id)
                  const m = mid ? await escrow.mandateApproved(mid, approve) : null
                  return { redirect: `/account?mandate=${m?.status ?? 'unknown'}` }
                }
                const ref = db.get<{ job_id: string | null }>('SELECT job_id FROM paypal_refs WHERE paypal_id = ?', id)
                if (!ref?.job_id) return { redirect: '/' }
                await d.withLock(ref.job_id, async () => {
                  const rec = d.load(ref.job_id!)
                  if (approve) await escrow.approvalReturned(rec)
                  else escrow.approvalCancelled(rec)
                })
                return { redirect: `/jobs/${ref.job_id}?paypal=${approve ? 'approved' : 'cancelled'}` }
              } catch (e) {
                return { redirect: redirectErr('/', e) }
              }
            },
          }
        : {}),
    },
    artifacts: {
      read: async (id, principal) => {
        const a = artifacts.read(id)
        return a && canReadArtifact(a.meta, principal) ? { mime: a.meta.mime, name: a.meta.name, bytes: a.bytes } : null
      },
    },
    public: {
      stats: async () => stats.stats(),
      feed: async (limit) => stats.feed(limit),
    },
    ...(cfg.demoMode
      ? {
          demo: {
            async reset() {
              await drain()
              db.wipe()
              rmSync(join(cfg.dataDir, 'artifacts'), { recursive: true, force: true })
              seed(services)
            },
          },
        }
      : {}),
    ...(opts.intelligence.aiClient?.chat ? { analyst: { enabled: opts.intelligence.aiClient.enabled, chat: (req) => opts.intelligence.aiClient.chat!(req) } } : {}),
    async close() {
      if (timer) clearInterval(timer)
      await drain()
      await rail.close?.()
      d.bus.close()
      db.close()
    },
    internal: { services, rail, tick, drain, ingestWebhook },
  }
  return core
}

