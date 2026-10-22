// JSON Schema validation (draft 2020-12) for check params and json_schema_valid.
// Schemas can come from buyers, so they are size-capped and compiled schemas are cached by text.
import Ajv2020 from 'ajv/dist/2020.js'

const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: true })
const cache = new Map<string, ReturnType<typeof ajv.compile>>()
const MAX_SCHEMA_CHARS = 20_000

export interface SchemaCheck {
  ok: boolean
  errors: string[]
}

export function validateJson(schema: unknown, data: unknown): SchemaCheck {
  const key = JSON.stringify(schema ?? {})
  if (key.length > MAX_SCHEMA_CHARS) return { ok: false, errors: [`schema larger than ${MAX_SCHEMA_CHARS} characters`] }
  let fn = cache.get(key)
  if (!fn) {
    try {
      fn = ajv.compile(schema as object)
    } catch (e) {
      return { ok: false, errors: [`invalid schema: ${(e as Error).message.slice(0, 200)}`] }
    }
    if (cache.size > 500) cache.clear()
    cache.set(key, fn)
  }
  const ok = fn(data) as boolean
  const errors = ok ? [] : (fn.errors ?? []).slice(0, 8).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`)
  return { ok, errors }
}
