// Sandbox Web: self-hosted fake directories and an investor mail system for demo-mode bots, plus the
// acceptance checks that verify work done on them. Mounted under /sandbox.
import type { FastifyInstance } from 'fastify'
import type { CheckLibrary } from '../intelligence/types.ts'
import { createAccounts } from './accounts.ts'
import { registerApplicationChecks, registerApplicationRoutes } from './applications.ts'
import { registerMailChecks } from './checks.ts'
import { buildDirectories, registerDirectoryRoutes } from './directories.ts'
import { createMail, registerMailRoutes } from './mail.ts'
import { registerLinkSite } from './linksite.ts'
import { createMailboxes, registerMailboxRoutes } from './mailboxes.ts'
import { registerSaasRoutes, SERVICES } from './saas.ts'
import { registerPages } from './pages.ts'
import { MAIL_DOMAIN } from './personas.ts'
import { registerRedTeam } from './redteam.ts'
import { createStore } from './state.ts'
import { esc, shell } from './ui.ts'

export interface SandboxDeps {
  checks: CheckLibrary
  /** Origin that bots and the check runner use to reach this server, e.g. http://localhost:8790. */
  publicUrl: string
  dataDir: string
  /** Multiplier on every nominal delay (moderation, replies, removals). 1 = real minutes; 0.02 = a minute lasts 1.2 s. */
  timeScale: number
  now?: () => Date
  /** Changes which directory gets which behaviour and the look of each. Default is fixed. */
  seed?: string
}

export const SANDBOX_SEED = 'rent-a-bot-sandbox-v1'

export async function registerSandbox(app: FastifyInstance, deps: SandboxDeps): Promise<void> {
  const seed = deps.seed ?? SANDBOX_SEED
  const nowFn = deps.now ?? (() => new Date())
  const clock = () => nowFn().getTime()
  const scale = Number.isFinite(deps.timeScale) && deps.timeScale >= 0 ? deps.timeScale : 1
  const store = createStore(deps.dataDir, seed)
  const mail = createMail({ store, clock, scale })
  const mailboxes = createMailboxes(store, clock)
  const accounts = createAccounts({ store, mail, clock, scale })
  const dirs = buildDirectories(seed)

  registerMailChecks(deps.checks, mail)

  await app.register(
    async (sb) => {
      registerDirectoryRoutes(sb, { dirs, store, mail, accounts, clock, scale, publicUrl: deps.publicUrl })
      registerMailRoutes(sb, { mail, store, clock, mailboxes })
      registerMailboxRoutes(sb, { mail, mailboxes, store, clock, publicUrl: deps.publicUrl })
      registerSaasRoutes(sb, { store, accounts, clock, scale, publicUrl: deps.publicUrl })
      const apps = registerApplicationRoutes(sb, { store, mail, clock, publicUrl: deps.publicUrl })
      registerApplicationChecks(deps.checks, apps, store)

      registerPages(sb, { clock, publicUrl: deps.publicUrl, store })
      registerLinkSite(sb)
      registerRedTeam(sb, { checks: deps.checks, clock, publicUrl: deps.publicUrl, store })

      sb.get('/', async (_req, reply) => {
        const live = store.data.submissions.length
        reply.type('text/html')
        return shell({
          title: 'Sandbox Web',
          css: `.wrap{max-width:820px}h1{margin:0 0 4px;font-size:30px}.lead{color:#59626f;margin-top:0}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}.tile{background:#fff;border:1px solid #e1e4e9;border-radius:10px;padding:14px}.tile b{font-size:24px;display:block}
ul{padding-left:20px}li{margin:6px 0}code{background:#eceff3;padding:1px 6px;border-radius:4px;font-size:13px}.warn{background:#fff7e0;border:1px solid #ecd88b;border-radius:8px;padding:12px 14px}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #c9ced6;background:#fff;cursor:pointer}`,
          body: `<div class="wrap"><h1>Sandbox Web</h1><p class="lead">Not real sites. These are test fixtures for Rent-A-Bot demos, hosted by the Rent-A-Bot server.</p>
<div class="warn">Everything here is fake and self-contained: bots can submit, email and fail without touching a real directory or a real investor. Some submissions genuinely fail, like on the real web.</div>
<div class="tiles"><div class="tile"><b>${dirs.length}</b>fake directories (${dirs.filter((d) => d.needs_account).length} want an account)</div><div class="tile"><b>25</b>investor personas on <code>${MAIL_DOMAIN}</code></div><div class="tile"><b>${live}</b>submissions so far</div></div>
<h3>Browse</h3><ul>
<li><a href="/sandbox/dirs">Directories</a> (${dirs.length}), each with a home page, an HTML submission form and listing pages</li>
<li><a href="/sandbox/mail">Mail viewer</a>: investor replies, verification and confirmation emails</li>
<li><a href="/sandbox/mail/mailboxes">Create a mailbox</a> with an app password (SMTP-style send, locked reads)</li>
<li><a href="/sandbox/saas">SaaS products</a> (${SERVICES.length}): signup, email verification, profile, public page</li>
<li><a href="/sandbox/apps">Application forms</a>: a fake accelerator, grants and launch directories</li>
<li><a href="/sandbox/pages">Published pages</a>: one-page sites the Landing Page Bot hosts</li>
<li><a href="/sandbox/site/">Acme Docs</a>: a small site with known broken links, for the Broken Link Hunter (<a href="/sandbox/site.json"><code>site.json</code></a> has the answer key)</li>
<li><a href="/sandbox/redteam">Practice agent</a>: a deliberately weak demo agent for authorized red-team testing, behind an ownership token</li></ul>
<h3>Machine-readable</h3><ul>
<li><a href="/sandbox/dirs.json"><code>GET /sandbox/dirs.json</code></a> directory catalog with declared requirements</li>
<li><code>POST /sandbox/dirs/:slug/api/submit</code> JSON submission: name, url, tagline, description, category, contact_email, logo_url, screenshot_url</li>
<li><a href="/sandbox/mail/investors.json"><code>GET /sandbox/mail/investors.json</code></a> investor personas (name, firm, thesis, check size, stage)</li>
<li><code>POST /sandbox/mail/mailboxes</code> {address} returns an app password once &middot; <code>POST /sandbox/mail/smtp/send</code> {username, password, to, subject, text, message_id?} sends as that mailbox (HTTP Basic works too); a registered mailbox is read with HTTP Basic</li>
<li><a href="/sandbox/saas.json"><code>GET /sandbox/saas.json</code></a> SaaS catalog &middot; <a href="/sandbox/apps.json"><code>GET /sandbox/apps.json</code></a> application programmes and their form fields</li>
<li><code>POST /sandbox/dirs/:slug/api/signup</code> and <code>/api/login</code> for directories that need an account</li>
<li><code>POST /sandbox/mail/send</code> {from, to, subject, text} (open test API; not for registered mailboxes) &middot; <a href="/sandbox/mail/messages"><code>GET /sandbox/mail/messages?address=</code></a> &middot; <code>GET /sandbox/mail/message/:id</code></li></ul>
<h3>Reset</h3><form method="post" action="/sandbox/reset" onsubmit="return confirm('Wipe all sandbox submissions and mail?')"><button>Reset sandbox state</button></form>
<p class="lead" style="font-size:13px">Time scale: ${esc(scale)} (moderation, reply and removal delays are multiplied by this).</p></div>`,
        })
      })

      sb.post('/reset', async (req, reply) => {
        store.reset()
        // a plain form post (from the index page) gets bounced back; API callers get JSON
        if (String(req.headers.accept ?? '').includes('text/html')) return reply.redirect('/sandbox')
        return { ok: true }
      })

      sb.addHook('onClose', async () => store.flush())
    },
    { prefix: '/sandbox' },
  )
}
