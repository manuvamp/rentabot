import { apiGet } from './client'
import { useAsync } from './hooks'

export type JsonSchemaNode = {
  type?: string | string[]
  title?: string
  description?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  enum?: unknown[]
  const?: unknown
  default?: unknown
  format?: string
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  additionalProperties?: boolean | JsonSchemaNode
  [k: string]: unknown
}

export interface OpMeta {
  name: string
  title: string
  description: string
  toolset: string
  caller: string
  surfaces: string[]
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  input: JsonSchemaNode
  output?: JsonSchemaNode
}

/** GET /api/meta/ops. Accepts {ops|tools:[...]} or a bare array; schema keys input_schema | inputSchema | input. */
export function normalizeOps(raw: unknown): OpMeta[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { ops?: unknown[] })?.ops)
      ? (raw as { ops: unknown[] }).ops
      : Array.isArray((raw as { tools?: unknown[] })?.tools)
        ? (raw as { tools: unknown[] }).tools
        : []
  return arr.map((o) => {
    const r = o as Record<string, unknown>
    return {
      name: String(r.name),
      title: String(r.title ?? r.name),
      description: String(r.description ?? ''),
      toolset: String(r.toolset ?? 'other'),
      caller: String(r.caller ?? 'any'),
      surfaces: (r.surfaces as string[]) ?? ['mcp', 'rest'],
      annotations: (r.annotations as OpMeta['annotations']) ?? {},
      input: ((r.input_schema ?? r.inputSchema ?? r.input) as JsonSchemaNode) ?? { type: 'object', properties: {} },
      output: (r.output_schema ?? r.outputSchema ?? r.output) as JsonSchemaNode | undefined,
    }
  })
}

let cache: Promise<OpMeta[]> | null = null
export function loadOps(): Promise<OpMeta[]> {
  cache ??= apiGet<unknown>('/api/meta/ops')
    .then(normalizeOps)
    .catch((e) => {
      cache = null
      throw e
    })
  return cache
}

export function useMetaOps() {
  return useAsync(loadOps, [])
}

export const TOOLSET_ORDER = ['account', 'discover', 'negotiate', 'escrow', 'work', 'review', 'dispute', 'sell', 'jobs']
export const TOOLSET_LABEL: Record<string, string> = {
  account: 'Account',
  discover: 'Discover',
  negotiate: 'Negotiate',
  escrow: 'Escrow',
  work: 'Work',
  review: 'Review',
  dispute: 'Dispute',
  sell: 'Sell',
  jobs: 'Jobs and events',
}
