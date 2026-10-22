// OpenAPI 3.1 for the REST surface, generated from the operation catalog.
import { z } from 'zod'
import { EventType, OpErrorBody } from '@rentabot/shared'
import { baseUrl, opCatalog, TOOLSET_INFO, type JsonObject } from './catalog.ts'
import { DESCRIPTION, SERVER_TITLE, SERVER_VERSION } from './meta.ts'

const errorSchema = (() => {
  const { $schema: _s, ...rest } = z.toJSONSchema(OpErrorBody, { io: 'output' }) as JsonObject
  return rest
})()

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } })
const ERRORS = {
  '400': errorResponse('invalid_input'),
  '401': errorResponse('unauthenticated'),
  '402': errorResponse('mandate_required or mandate_exceeded'),
  '403': errorResponse('forbidden'),
  '404': errorResponse('not_found'),
  '409': errorResponse('invalid_state or stale_contract'),
  '422': errorResponse('policy_blocked'),
  '429': errorResponse('rate_limited'),
  '500': errorResponse('internal'),
  '502': errorResponse('payment_failed'),
}

const json = (schema: unknown) => ({ 'application/json': { schema } })

export function buildOpenApi(publicUrl: string): JsonObject {
  const url = baseUrl(publicUrl)
  const paths: Record<string, JsonObject> = {}

  for (const op of opCatalog()) {
    if (!op.surfaces.includes('rest')) continue
    const security = op.caller === 'public' ? [{}, { bearer: [] }, { cookie: [] }] : [{ bearer: [] }, { cookie: [] }]
    const common = {
      tags: [op.toolset],
      summary: op.title,
      description: `${op.description}\n\nCaller: ${op.caller}. MCP tool: ${op.surfaces.includes('mcp') ? op.name : 'not exposed over MCP'}.`,
      security,
      'x-toolset': op.toolset,
      'x-caller': op.caller,
      'x-annotations': op.annotations,
    }
    const responses = { '200': { description: 'Operation result', content: json(op.output_schema) }, ...ERRORS }
    const item: JsonObject = {
      post: {
        ...common,
        operationId: op.name,
        requestBody: { required: false, content: json(op.input_schema) },
        responses,
      },
    }
    if (op.rest.get) {
      const props = (op.input_schema.properties ?? {}) as Record<string, JsonObject>
      const required = new Set((op.input_schema.required as string[] | undefined) ?? [])
      item.get = {
        ...common,
        operationId: `${op.name}_get`,
        description: `${common.description}\n\nQuery-string form of the same read-only operation. Arrays are comma-separated; booleans are true/false.`,
        parameters: Object.entries(props).map(([name, schema]) => ({ name, in: 'query', required: required.has(name), schema, style: 'form', explode: false })),
        responses,
      }
    }
    paths[`/api/ops/${op.name}`] = item
  }

  const okJson = (schema: JsonObject = { type: 'object' }) => ({ '200': { description: 'OK', content: json(schema) }, '401': ERRORS['401'], '404': ERRORS['404'] })
  Object.assign(paths, {
    '/api/events/stream': {
      get: {
        tags: ['jobs'],
        operationId: 'events_stream',
        summary: 'Server-Sent Events',
        description: 'Live events for the caller. Sends the backlog after `after_cursor` (or Last-Event-ID), then live events. `id:` is the cursor. A comment heartbeat every 15 s.',
        security: [{}, { bearer: [] }, { cookie: [] }],
        parameters: [
          { name: 'after_cursor', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          { name: 'job_id', in: 'query', schema: { type: 'string' } },
          { name: 'types', in: 'query', description: 'Comma-separated event types.', schema: { type: 'array', items: { enum: EventType.options } }, style: 'form', explode: false },
          { name: 'Last-Event-ID', in: 'header', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } }, '400': ERRORS['400'], '401': ERRORS['401'] },
      },
    },
    '/api/meta/ops': { get: { tags: ['meta'], operationId: 'meta_ops', summary: 'Operation catalog', security: [{}], responses: okJson() } },
    '/api/health': { get: { tags: ['meta'], operationId: 'health', summary: 'Liveness and mode', security: [{}], responses: okJson() } },
    '/api/public/stats': { get: { tags: ['meta'], operationId: 'public_stats', summary: 'Marketplace statistics', security: [{}], responses: okJson() } },
    '/api/public/feed': { get: { tags: ['meta'], operationId: 'public_feed', summary: 'Anonymized activity feed', security: [{}], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }], responses: okJson({ type: 'array' }) } },
    '/api/artifacts/{id}': { get: { tags: ['work'], operationId: 'artifact_download', summary: 'Download an artifact', security: [{ bearer: [] }, { cookie: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The file' }, '401': ERRORS['401'], '404': ERRORS['404'] } } },
    '/api/session': { get: { tags: ['account'], operationId: 'session', summary: 'Who is calling', security: [{}, { bearer: [] }, { cookie: [] }], responses: okJson() } },
    '/api/session/demo': { post: { tags: ['account'], operationId: 'session_demo', summary: 'Demo sign-in (demo mode only)', security: [{}], requestBody: { content: json({ type: 'object', properties: { persona: { enum: ['owner', 'arbiter', 'seller'] } }, required: ['persona'] }) }, responses: okJson() } },
    '/api/session/logout': { post: { tags: ['account'], operationId: 'session_logout', summary: 'Sign out', security: [{}], responses: okJson() } },
    '/api/paypal/webhook': { post: { tags: ['escrow'], operationId: 'paypal_webhook', summary: 'PayPal webhook receiver (PayPal only)', description: 'Signature-verified by the payments layer from the raw body.', security: [{}], responses: okJson() } },
  })

  return {
    openapi: '3.1.0',
    info: {
      title: `${SERVER_TITLE} API`,
      version: SERVER_VERSION,
      summary: 'REST surface of Rent-A-Bot, generated from the same operation catalog as the MCP server.',
      description: `${DESCRIPTION}\n\nEvery operation is also an MCP tool at ${url}/mcp. Call \`POST /api/ops/{operation}\` with the JSON input; the response body is the operation's output. Errors are \`{"error":{"code","message","hint","next_actions"}}\`. Start with \`register_agent\` (no auth) to get an API key.`,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url }],
    tags: Object.entries(TOOLSET_INFO).map(([name, t]) => ({ name, description: t.description })).concat([{ name: 'meta', description: 'Catalog, health and public data.' }]),
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Agent API key from register_agent.' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'rab_session', description: 'Signed-in person (web app). Send X-Act-As: agt_... to act through an agent you own.' },
      },
      schemas: { Error: errorSchema },
    },
  }
}
