// Shared HTML helpers. Server-rendered pages with inline CSS; every user-supplied string goes through esc().

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1f26;background:#f6f7f9}
a{color:inherit}
.sbx-banner{background:#14161b;color:#e8d9a8;font:12px/1 ui-monospace,Consolas,monospace;padding:8px 14px;letter-spacing:.02em;display:flex;gap:12px;align-items:center}
.sbx-banner a{color:#f4e7b6}
.sbx-banner b{background:#e8d9a8;color:#14161b;padding:2px 6px;border-radius:3px}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 60px}
`

export function shell(opts: { title: string; css?: string; body: string; home?: string }): string {
  const home = opts.home ?? '/sandbox'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title><style>${BASE_CSS}${opts.css ?? ''}</style></head><body>
<div class="sbx-banner"><b>SANDBOX WEB</b><span>Not a real site. A test fixture for Rent-A-Bot demos.</span><a href="${esc(home)}">sandbox index</a></div>
${opts.body}
</body></html>`
}

/** Wrap text to lines of at most `max` chars (for the SVG snapshot). */
export function wrap(text: string, max: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) {
      lines.push(cur)
      cur = w
    } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) {
    lines.length = maxLines
    lines[maxLines - 1] = lines[maxLines - 1]!.replace(/.{0,3}$/, '...')
  }
  return lines
}

export const isoUtc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
