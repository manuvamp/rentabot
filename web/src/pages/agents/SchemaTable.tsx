import type { JsonSchemaNode } from '../../api/meta'

function typeOf(n: JsonSchemaNode): string {
  const alt = n.anyOf ?? n.oneOf
  if (alt?.length) {
    const nonNull = alt.filter((a) => a.type !== 'null')
    const t = [...new Set(nonNull.map(typeOf))].join(' | ')
    return alt.length > nonNull.length ? `${t} | null` : t
  }
  if (n.enum) return 'enum'
  if (n.const !== undefined) return 'const'
  const base = Array.isArray(n.type) ? n.type.join(' | ') : (n.type ?? 'any')
  if (base === 'array') return `${n.items ? typeOf(n.items) : 'any'}[]`
  if (base === 'object' && n.additionalProperties && typeof n.additionalProperties === 'object') return `map<string, ${typeOf(n.additionalProperties)}>`
  return base
}

function constraints(n: JsonSchemaNode): string[] {
  const out: string[] = []
  const alt = (n.anyOf ?? n.oneOf)?.find((a) => a.type !== 'null')
  const s = alt ? { ...alt, ...n } : n
  if (s.enum) out.push(`one of: ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  if (s.const !== undefined) out.push(`= ${JSON.stringify(s.const)}`)
  if (s.format) out.push(`format: ${s.format}`)
  if (s.minimum !== undefined) out.push(`min ${s.minimum}`)
  if (s.maximum !== undefined) out.push(`max ${s.maximum}`)
  if (s.minLength !== undefined) out.push(`min length ${s.minLength}`)
  if (s.maxLength !== undefined) out.push(`max length ${s.maxLength}`)
  if (s.minItems !== undefined) out.push(`min items ${s.minItems}`)
  if (s.maxItems !== undefined) out.push(`max items ${s.maxItems}`)
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`)
  if (s.items?.enum) out.push(`items: ${s.items.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  return out
}

/** Readable inputs table for an op, generated from its JSON Schema. */
export function SchemaTable({ schema }: { schema: JsonSchemaNode }) {
  const props = Object.entries(schema.properties ?? {})
  if (!props.length) return <p className="text-sm text-mute">No inputs.</p>
  const required = new Set(schema.required ?? [])
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[520px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-ink-2 text-[11px] uppercase tracking-widest text-mute">
            <th scope="col" className="px-3 py-2 font-medium">Name</th>
            <th scope="col" className="px-3 py-2 font-medium">Type</th>
            <th scope="col" className="px-3 py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {props.map(([name, n]) => {
            const c = constraints(n)
            return (
              <tr key={name} className="border-b border-line/60 align-top last:border-0">
                <td className="px-3 py-2 font-mono text-fog">
                  {name}
                  {required.has(name) ? <span className="ml-1 text-coral" title="required">*</span> : <span className="ml-1.5 text-[10px] text-mute">optional</span>}
                </td>
                <td className="px-3 py-2 font-mono text-soft">{typeOf(n)}</td>
                <td className="px-3 py-2 text-soft">
                  {n.description && <p>{n.description}</p>}
                  {c.length > 0 && <p className="mt-0.5 font-mono text-[11.5px] text-mute">{c.join(' · ')}</p>}
                  {n.type === 'object' && n.properties && <p className="mt-0.5 font-mono text-[11.5px] text-mute">fields: {Object.keys(n.properties).join(', ')}</p>}
                  {n.type === 'array' && n.items?.type === 'object' && n.items.properties && <p className="mt-0.5 font-mono text-[11.5px] text-mute">item fields: {Object.keys(n.items.properties).join(', ')}</p>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** A minimal example input from the schema (required fields only). */
export function exampleInput(schema: JsonSchemaNode): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const req = new Set(schema.required ?? [])
  for (const [k, n] of Object.entries(schema.properties ?? {})) {
    if (!req.has(k)) continue
    out[k] = sample(n)
  }
  return out
}

function sample(n: JsonSchemaNode): unknown {
  const alt = (n.anyOf ?? n.oneOf)?.find((a) => a.type !== 'null')
  if (alt) return sample({ ...alt, ...n, anyOf: undefined, oneOf: undefined })
  if (n.enum) return n.enum[0]
  if (n.default !== undefined) return n.default
  const t = Array.isArray(n.type) ? n.type[0] : n.type
  if (t === 'string') {
    if (n.format === 'email') return 'agent@example.com'
    if (n.format === 'uri') return 'https://example.com'
    if (n.format === 'date-time') return '2026-11-01T12:00:00Z'
    return n.pattern?.startsWith('^job_') ? 'job_…' : '…'
  }
  if (t === 'integer' || t === 'number') return n.minimum ?? 1
  if (t === 'boolean') return true
  if (t === 'array') return n.items ? [sample(n.items)] : []
  if (t === 'object') return n.properties ? exampleInput(n) : {}
  return null
}
