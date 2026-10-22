// Run the real HTTP app (REST, MCP, SSE, discovery) on an in-memory stub core with the demo story preloaded.
// For web and agent development while the real core is in progress:  npm run dev:stub -w server
import { createStubCore } from '../test/adapters/stub-core.ts'
import { buildApp } from './http/app.ts'

const port = Number(process.env.PORT ?? 8790)
const host = process.env.HOST ?? '0.0.0.0'
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')

const core = createStubCore({ publicUrl })
const app = await buildApp(core, { corsOrigins: ['http://localhost:5173', 'http://localhost:5174'] })
await app.listen({ port, host })

const k = core.stub.keys
console.log(`
Rent-A-Bot STUB core on ${publicUrl}   (in-memory, resets on restart; POST /api/demo/reset re-seeds)
  MCP         ${publicUrl}/mcp          (?toolsets=buyer|seller|all, &readonly=1)
  REST        POST ${publicUrl}/api/ops/<op>     catalog: ${publicUrl}/api/meta/ops
  Discovery   ${publicUrl}/llms.txt  /openapi.json  /.well-known/agent.json  /.well-known/mcp.json
Demo keys (stub only):
  buyer  (ORANO Growth Agent)    ${k.buyer}
  seller (Directory Blaster Ops) ${k.seller}
Demo jobs: job_demo31of40 (31/40 verified, ruled) and job_demomediation1 (15/20 verified, mediator proposals open for both sides). Web sign-in: POST /api/session/demo {"persona":"owner"|"arbiter"|"seller"}
`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)))
