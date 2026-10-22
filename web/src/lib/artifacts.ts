import { MOCK } from '../api/client'

/** Where to load an artifact from. In mock mode there is no file server, so we draw a placeholder screenshot. */
export function artifactSrc(id: string, label = ''): string {
  if (!MOCK) return `/api/artifacts/${id}`
  return placeholderShot(id, label)
}

function hue(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}

/** A tiny fake browser screenshot, deterministic from the id. */
export function placeholderShot(id: string, label = ''): string {
  const h = hue(id)
  const bars = Array.from({ length: 4 }, (_, i) => 30 + ((h >> (i * 3)) % 60))
  const title = (label || id).replace(/[<>&"]/g, '').slice(0, 26)
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200' viewBox='0 0 320 200'>
<rect width='320' height='200' fill='#f2ede3'/><rect width='320' height='22' fill='#d6cdb9'/>
<circle cx='12' cy='11' r='4' fill='#ff6b5b'/><circle cx='26' cy='11' r='4' fill='#ffd84d'/><circle cx='40' cy='11' r='4' fill='#8be3b4'/>
<rect x='62' y='6' width='200' height='11' rx='5' fill='#f2ede3'/>
<rect x='20' y='40' width='${bars[0] + 120}' height='14' fill='#1a1814'/>
<rect x='20' y='62' width='${bars[1] + 100}' height='7' fill='#6a6455'/>
<rect x='20' y='76' width='${bars[2] + 80}' height='7' fill='#6a6455'/>
<rect x='20' y='100' width='90' height='62' fill='#e6dfd0'/><rect x='120' y='100' width='90' height='62' fill='#e6dfd0'/>
<rect x='220' y='100' width='80' height='62' fill='#8be3b4'/>
<text x='24' y='185' font-family='monospace' font-size='11' fill='#1a1814'>${title}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
