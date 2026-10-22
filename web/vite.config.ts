import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Every file under public/art, so the app only requests art that exists (no 404s for photos not generated yet). */
function artFiles(dir = fileURLToPath(new URL('./public/art', import.meta.url)), base = ''): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? artFiles(join(dir, f), `${base}${f}/`) : [`${base}${f}`]))
}

const backend = process.env.RENTABOT_API ?? 'http://localhost:8790'
const proxied = ['/api', '/mcp', '/llms.txt', '/llms-full.txt', '/openapi.json', '/.well-known']

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __ART__: JSON.stringify(artFiles()) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    // The simulated PayPal page (/sim/paypal/...) is a web route; only /api/sim is proxied.
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: backend, changeOrigin: true }])),
  },
  build: { chunkSizeWarningLimit: 900 },
})
