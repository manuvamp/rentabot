// Sandbox Web page host for the Landing Page Bot. The bot builds a one-page site as a self-contained HTML
// file (a job artifact) and "publishes" it here; this serves it at a public URL so the platform's own
// url_live and page_mentions checks can fetch it. Pages are kept in the Sandbox Web snapshot (sandbox.json in
// DATA_DIR) like the rest of Sandbox Web, so a delivered page survives a restart; nothing ever leaves the process.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { hash32, hex } from './rng.ts'
import type { Store } from './state.ts'
import { esc, shell } from './ui.ts'

export interface Page {
  id: string
  slug: string
  title: string
  html: string
  published_at: number
}

export interface Pages {
  publish(input: { html?: unknown; slug?: unknown; title?: unknown }): { code: number; json: Record<string, unknown> }
  get(id: string): Page | undefined
  list(): Page[]
  urlOf(id: string): string
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** With a store, pages and their counter live in the sandbox snapshot: a restart neither loses a delivered page nor
 *  hands its id (derived from the counter) to the next page published. Without one (tests), memory only. */
export function createPages(deps: { clock: () => number; publicUrl: string; store?: Store }): Pages {
  const { clock, store } = deps
  const base = deps.publicUrl.replace(/\/+$/, '')
  const mem = { pages: [] as Page[], page_seq: 0 }
  // Read through store.data every time: a sandbox reset replaces its contents in place.
  const state = () => (store ? store.data : mem) as { pages?: Page[]; page_seq?: number }
  const all = () => (state().pages ??= [])
  const urlOf = (id: string) => `${base}/sandbox/pages/${id}`
  return {
    urlOf,
    get: (id) => all().find((p) => p.id === id),
    list: () => [...all()],
    publish(input) {
      const html = str(input.html)
      if (html.length < 40) return { code: 400, json: { error: 'invalid_request', message: 'html is required (a full self-contained page).' } }
      if (html.length > 400_000) return { code: 413, json: { error: 'too_large', message: 'the page is larger than 400 KB.' } }
      const s = state()
      const n = (s.page_seq = (s.page_seq ?? 0) + 1)
      const slug = (str(input.slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'page'
      const id = `pg${String(n).padStart(4, '0')}${hex(hash32(`page:${n}:${slug}`), 4)}`
      const title = str(input.title).slice(0, 120) || slug
      const page: Page = { id, slug, title, html, published_at: clock() }
      all().push(page)
      store?.save()
      return { code: 201, json: { id, slug, url: urlOf(id), published_at: new Date(page.published_at).toISOString() } }
    },
  }
}

export function registerPageRoutes(sb: FastifyInstance, pages: Pages): void {
  const html = (reply: FastifyReply, code: number, body: string) => reply.code(code).type('text/html; charset=utf-8').send(body)

  // The host index: what has been published so far.
  sb.get('/pages', async (_req, reply) => {
    const list = pages.list()
    const rows = list.length
      ? list.map((p) => `<li><a href="/sandbox/pages/${esc(p.id)}">${esc(p.title)}</a> <code>${esc(p.id)}</code></li>`).join('')
      : '<li class="note">No pages published yet.</li>'
    return html(
      reply,
      200,
      shell({
        title: 'Sandbox Web pages',
        css: '.wrap{max-width:760px}ul{padding-left:20px}li{margin:6px 0}code{background:#eceff3;padding:1px 6px;border-radius:4px;font-size:13px}.note{color:#59626f}',
        body: `<div class="wrap"><h1>Published pages</h1><p class="note">One-page sites the Landing Page Bot built and hosted here. The platform re-fetches each one (url_live, page_mentions).</p><ul>${rows}</ul>
<h3>Machine-readable</h3><ul><li><code>POST /sandbox/pages</code> {html, slug?, title?} &rarr; {id, url}</li><li><code>GET /sandbox/pages/:id</code> serves the page</li></ul></div>`,
      }),
    )
  })

  sb.post('/pages', async (req, reply) => {
    const r = pages.publish((req.body ?? {}) as Record<string, unknown>)
    return reply.code(r.code).send(r.json)
  })

  // Serve the published page as-is. It is already a self-contained document, so no shell is wrapped around it.
  sb.get('/pages/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const page = pages.get(id)
    if (!page) return html(reply, 404, shell({ title: 'Not found', body: `<div class="wrap"><h1>404</h1><p>No published page ${esc(id)}.</p></div>` }))
    return html(reply, 200, page.html)
  })
}

/** One-line wiring for sandbox/index.ts. */
export function registerPages(sb: FastifyInstance, deps: { clock: () => number; publicUrl: string; store?: Store }): Pages {
  const pages = createPages(deps)
  registerPageRoutes(sb, pages)
  return pages
}
