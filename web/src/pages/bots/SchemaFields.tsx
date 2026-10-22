import type { JsonSchemaNode } from '../../api/meta'

function typeOf(n: JsonSchemaNode): string {
  if (n.enum) return 'choice'
  if (n.type === 'array') return `list of ${n.items ? typeOf(n.items) : 'values'}`
  if (n.format === 'uri') return 'URL'
  if (n.format === 'email') return 'email'
  if (n.format === 'date-time') return 'date and time'
  return Array.isArray(n.type) ? n.type.join(' or ') : (n.type ?? 'value')
}

function constraints(n: JsonSchemaNode): string[] {
  const c: string[] = []
  if (n.enum) c.push(`one of: ${n.enum.join(', ')}`)
  if (n.maxLength) c.push(`max ${n.maxLength} chars`)
  if (n.minLength) c.push(`min ${n.minLength} chars`)
  if (n.minItems) c.push(`at least ${n.minItems}`)
  if (n.maxItems) c.push(`at most ${n.maxItems}`)
  if (typeof n.minimum === 'number') c.push(`min ${n.minimum}`)
  if (typeof n.maximum === 'number') c.push(`max ${n.maximum}`)
  if (n.default !== undefined) c.push(`default ${JSON.stringify(n.default)}`)
  return c
}

/** Readable field list for a JSON Schema object: name, type, required, description, constraints. */
export function SchemaFields({ schema, tone = 'ink' }: { schema: JsonSchemaNode; tone?: 'ink' | 'paper' }) {
  const props = Object.entries(schema.properties ?? {})
  const required = new Set(schema.required ?? [])
  const paper = tone === 'paper'
  if (props.length === 0) return <p className={`text-sm ${paper ? 'text-pmute' : 'text-mute'}`}>No fields declared.</p>
  return (
    <dl className={`divide-y ${paper ? 'divide-pink/15' : 'divide-line'}`}>
      {props.map(([key, n]) => {
        const c = constraints(n)
        const isReq = required.has(key)
        return (
          <div key={key} className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
            <dt className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-mono text-[13px] font-semibold">{key}</span>
              <span className={`ml-2 text-[11px] uppercase tracking-wider ${isReq ? (paper ? 'text-coral-deep' : 'text-amber') : paper ? 'text-pmute' : 'text-mute'}`}>{isReq ? 'required' : 'optional'}</span>
            </dt>
            <dd className="min-w-0 text-[13.5px]">
              <span className={`font-mono text-[12px] ${paper ? 'text-lime-deep' : 'text-lime'}`}>{typeOf(n)}</span>
              {n.description && <span className={`ml-2 ${paper ? 'text-pink/80' : 'text-soft'}`}>{n.description}</span>}
              {c.length > 0 && <div className={`mt-0.5 font-mono text-[11.5px] ${paper ? 'text-pmute' : 'text-mute'}`}>{c.join(' · ')}</div>}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
