// Sandbox Web link-check site: a small, deliberately flawed documentation site ("Acme Docs") for the Broken Link Hunter. Its pages link
// to targets that are fine and to targets that are broken in the ways real sites break: a 404, a 410, a persistent 500, a redirect that
// ends in a 404, plus links that look suspicious but are fine (a status page that fails once and recovers, a PDF whose HEAD is refused).
// Everything is deterministic and self-contained; KNOWN_BROKEN is the answer key the tests (and a buyer's demo) compare against.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { esc } from './ui.ts'

export const LINKSITE_PATH = '/sandbox/site'

interface PageDef {
  title: string
  intro: string
  /** [href relative to the site root, anchor text] */
  links: [string, string][]
  /** Raw extra HTML (links that are not http, anchors). */
  extra?: string
}

const P = (p: string) => `${LINKSITE_PATH}${p}`

const PAGES: Record<string, PageDef> = {
  '/': {
    title: 'Acme Docs',
    intro: 'Documentation for the Acme widget platform.',
    links: [
      ['/about', 'About'],
      ['/docs/', 'Docs'],
      ['/blog/', 'Blog'],
      ['/contact', 'Contact'],
      ['/pricing-v1', 'Legacy pricing'],
      ['/flaky', 'Status page'],
      ['/files/brochure.pdf', 'Download the brochure (PDF)'],
    ],
    extra: '<p><a href="mailto:hello@acme.test">Email us</a> · <a href="tel:+15550100">Call us</a> · <a href="#top">Back to top</a></p>',
  },
  '/about': {
    title: 'About Acme',
    intro: 'Acme has built widgets since 2019.',
    links: [
      ['/', 'Home'],
      ['/team', 'Meet the team'],
      ['/docs/old-guide', 'Old guide'],
      ['/careers', 'Careers'],
    ],
  },
  '/docs/': {
    title: 'Acme documentation',
    intro: 'Everything about using the platform.',
    links: [
      ['/', 'Home'],
      ['/docs/getting-started', 'Getting started'],
      ['/docs/api', 'API reference'],
      ['/docs/old-guide', 'Old guide'],
      ['/docs/changelog', 'Changelog'],
    ],
  },
  '/docs/getting-started': { title: 'Getting started', intro: 'Create a widget in three steps.', links: [['/docs/', 'Back to the docs']] },
  '/docs/api': { title: 'API reference', intro: 'The widget API.', links: [['/docs/', 'Back to the docs']] },
  '/docs/changelog': { title: 'Changelog', intro: 'What changed, newest first.', links: [['/docs/', 'Back to the docs']] },
  '/blog/': {
    title: 'Acme blog',
    intro: 'News from the widget factory.',
    links: [
      ['/', 'Home'],
      ['/blog/hello-world', 'Hello world'],
      ['/blog/launch-2019', 'Launch announcement'],
      ['/blog/rss.xml', 'RSS feed'],
    ],
  },
  '/blog/hello-world': { title: 'Hello world', intro: 'Our first post.', links: [['/blog/', 'All posts']] },
  '/contact': {
    title: 'Contact Acme',
    intro: 'We answer within a day.',
    links: [
      ['/', 'Home'],
      ['/status/500', 'Support portal'],
    ],
    extra: '<p><a href="mailto:support@acme.test">support@acme.test</a> · <a href="tel:+15550101">+1 555 0101</a></p>',
  },
  '/careers': { title: 'Careers', intro: 'We are not hiring right now.', links: [['/', 'Home']] },
}

/** Every broken link on the site as (source page, anchor text, target, final status), in crawl order: the answer key. */
export const KNOWN_BROKEN: { source: string; text: string; target: string; status: number }[] = [
  { source: '/', text: 'Legacy pricing', target: '/pricing-v1', status: 404 }, // 301 to /pricing-2019, which is a 404
  { source: '/about', text: 'Meet the team', target: '/team', status: 404 },
  { source: '/about', text: 'Old guide', target: '/docs/old-guide', status: 404 },
  { source: '/docs/', text: 'Old guide', target: '/docs/old-guide', status: 404 },
  { source: '/blog/', text: 'Launch announcement', target: '/blog/launch-2019', status: 410 },
  { source: '/contact', text: 'Support portal', target: '/status/500', status: 500 },
]

function render(def: PageDef): string {
  const nav = def.links.map(([href, text]) => `<li><a href="${esc(P(href))}">${esc(text)}</a></li>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(def.title)}</title></head><body><main><h1 id="top">${esc(def.title)}</h1><p>${esc(def.intro)}</p><ul>${nav}</ul>${def.extra ?? ''}</main></body></html>`
}

export function registerLinkSite(sb: FastifyInstance): void {
  const html = (reply: FastifyReply, code: number, body: string) => reply.code(code).type('text/html; charset=utf-8').send(body)
  const missing = (reply: FastifyReply, what: string) => html(reply, 404, `<!doctype html><html><head><title>Not found</title></head><body><h1>404</h1><p>${esc(what)} does not exist.</p></body></html>`)

  for (const [path, def] of Object.entries(PAGES)) {
    sb.get(`/site${path}`, async (_req, reply) => html(reply, 200, render(def)))
    // "/docs" without the slash is the same page, as on most sites
    if (path.endsWith('/') && path.length > 1) sb.get(`/site${path.slice(0, -1)}`, async (_req, reply) => reply.redirect(P(path), 301))
  }

  // A page that was retired: moved once, and the new place is gone too.
  sb.get('/site/pricing-v1', async (_req, reply) => reply.redirect(P('/pricing-2019'), 301))
  sb.get('/site/pricing-2019', async (_req, reply) => missing(reply, 'The pricing page'))
  sb.get('/site/team', async (_req, reply) => missing(reply, 'The team page'))
  sb.get('/site/docs/old-guide', async (_req, reply) => missing(reply, 'The old guide'))
  sb.get('/site/blog/launch-2019', async (_req, reply) => html(reply, 410, '<!doctype html><html><head><title>Gone</title></head><body><h1>410 Gone</h1><p>This post was removed.</p></body></html>'))
  sb.get('/site/blog/rss.xml', async (_req, reply) => reply.type('application/rss+xml').send('<?xml version="1.0"?><rss version="2.0"><channel><title>Acme blog</title></channel></rss>'))

  // Fails on every odd request and answers on every even one: a HEAD then a GET (or a first look then a second) sees it recover.
  let flaky = 0
  sb.route({
    method: ['GET', 'HEAD'],
    url: '/site/flaky',
    handler: async (_req, reply) => (++flaky % 2 === 1 ? html(reply, 503, '<!doctype html><title>Busy</title><p>Try again.</p>') : html(reply, 200, '<!doctype html><title>All systems operational</title><p>All systems operational.</p>')),
  })

  // A file server that refuses HEAD but serves the GET.
  sb.route({ method: 'HEAD', url: '/site/files/brochure.pdf', handler: async (_req, reply) => reply.code(405).header('allow', 'GET').send() })
  sb.get('/site/files/brochure.pdf', async (_req, reply) => reply.type('application/pdf').send('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'))

  // Any status on demand, for tests and demos.
  sb.get('/site/status/:code', async (req, reply) => {
    const code = Number((req.params as { code: string }).code)
    return html(reply, [200, 404, 410, 500, 503].includes(code) ? code : 404, `<!doctype html><html><head><title>HTTP ${esc(code)}</title></head><body><h1>HTTP ${esc(code)}</h1></body></html>`)
  })

  // Machine-readable: what is on the site and the answer key.
  sb.get('/site.json', async () => ({
    name: 'Acme Docs (link-check fixture)',
    start_url: P('/'),
    pages: Object.keys(PAGES).map((p) => P(p)),
    known_broken: KNOWN_BROKEN.map((b) => ({ source_page: P(b.source), anchor_text: b.text, link_url: P(b.target), final_status: b.status })),
  }))
}
