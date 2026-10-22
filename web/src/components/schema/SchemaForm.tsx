import { useId, useMemo, useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import type { JsonSchemaNode } from '../../api/meta'
import { Button, ErrorBox } from '../ui'

/**
 * Form generated from an operation's input JSON Schema, so people use exactly the operations agents use.
 * Raw state mirrors the schema: strings for text-like fields, booleans, nested objects, [key, value] pairs for records.
 */

type Kind = 'object' | 'record' | 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'lines' | 'json'
type Pair = [string, string]
type Raw = string | boolean | Pair[] | { [k: string]: Raw }

const isNull = (n: JsonSchemaNode) => n.type === 'null' || (Array.isArray(n.type) && n.type.length === 1 && n.type[0] === 'null')

function unwrap(node: JsonSchemaNode): { node: JsonSchemaNode; nullable: boolean; multi: boolean } {
  const alts = node.anyOf ?? node.oneOf
  if (alts) {
    const real = alts.filter((a) => !isNull(a))
    const nullable = real.length !== alts.length
    if (real.length === 1) return { ...unwrap({ ...real[0], description: real[0].description ?? node.description, title: real[0].title ?? node.title, default: real[0].default ?? node.default }), nullable }
    return { node, nullable, multi: true }
  }
  if (Array.isArray(node.type)) {
    const t = node.type.filter((x) => x !== 'null')
    return { node: { ...node, type: t.length === 1 ? t[0] : undefined }, nullable: t.length !== node.type.length, multi: t.length > 1 }
  }
  return { node, nullable: false, multi: false }
}

function kindOf(raw: JsonSchemaNode): { kind: Kind; node: JsonSchemaNode } {
  const { node, multi } = unwrap(raw)
  if (multi) return { kind: 'json', node }
  if (node.enum && node.enum.every((e) => ['string', 'number'].includes(typeof e))) return { kind: 'enum', node }
  if (node.const !== undefined) return { kind: 'enum', node: { ...node, enum: [node.const] } }
  switch (node.type) {
    case 'object': {
      if (node.properties && Object.keys(node.properties).length) return { kind: 'object', node }
      const ap = node.additionalProperties
      if (ap === undefined || ap === true || ap === false) return { kind: 'json', node }
      const apKind = typeof ap === 'object' ? (ap.type as string | undefined) : undefined
      if (!apKind || apKind === 'string' || apKind === 'number' || apKind === 'integer' || apKind === 'boolean' || Object.keys(ap).length === 0) return { kind: 'record', node }
      return { kind: 'json', node }
    }
    case 'boolean':
      return { kind: 'boolean', node }
    case 'integer':
      return { kind: 'integer', node }
    case 'number':
      return { kind: 'number', node }
    case 'string':
      return { kind: 'string', node }
    case 'array': {
      const it = node.items ? unwrap(node.items).node : undefined
      if (it && (it.type === 'string' || it.type === 'integer' || it.type === 'number') && !it.enum) return { kind: 'lines', node }
      return { kind: 'json', node }
    }
    default:
      return { kind: 'json', node }
  }
}

const ACRONYMS = new Set(['url', 'id', 'api', 'ip', 'dns', 'seo', 'sha256', 'json', 'jsonl', 'csv', 'html', 'mx'])
/** tagline_60 -> Tagline, site_url -> Site URL: a trailing number is a length limit, which the help text already states. */
const humanize = (k: string) =>
  k
    .replace(/_\d+$/, '')
    .split('_')
    .map((w, i) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
const display = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function init(schema: JsonSchemaNode, value: unknown, hide: string[] = [], root = false): Raw {
  const { kind, node } = kindOf(schema)
  const v = value === undefined ? node.default : value
  switch (kind) {
    case 'object': {
      const o: { [k: string]: Raw } = {}
      for (const [k, child] of Object.entries(node.properties ?? {})) {
        if (root && hide.includes(k)) continue
        o[k] = init(child, (v as Record<string, unknown> | undefined)?.[k], [], false)
      }
      return o
    }
    case 'record':
      return Object.entries((v as Record<string, unknown>) ?? {}).map(([k, x]) => [k, display(x)] as Pair)
    case 'boolean':
      return Boolean(v ?? false)
    case 'lines':
      return Array.isArray(v) ? v.join('\n') : ''
    case 'json':
      return v === undefined || v === null ? '' : JSON.stringify(v, null, 2)
    case 'string':
      return node.format === 'date-time' && typeof v === 'string' ? toLocalInput(v) : display(v)
    default:
      return v === undefined || v === null ? '' : String(v)
  }
}

type Errors = Record<string, string>

function serialize(schema: JsonSchemaNode, raw: Raw | undefined, path: string, required: boolean, errors: Errors): unknown {
  const { kind, node } = kindOf(schema)
  const err = (m: string) => {
    errors[path] = m
    return undefined
  }
  switch (kind) {
    case 'object': {
      const out: Record<string, unknown> = {}
      const req = new Set(node.required ?? [])
      for (const [k, child] of Object.entries(node.properties ?? {})) {
        const r = (raw as { [k: string]: Raw } | undefined)?.[k]
        const v = serialize(child, r, path ? `${path}.${k}` : k, req.has(k), errors)
        if (v !== undefined) out[k] = v
      }
      return Object.keys(out).length || required ? out : undefined
    }
    case 'record': {
      const pairs = ((raw as Pair[]) ?? []).filter(([k]) => k.trim() !== '')
      const ap = typeof node.additionalProperties === 'object' ? node.additionalProperties : {}
      const t = ap.type
      const out: Record<string, unknown> = {}
      for (const [k, v] of pairs) {
        if (t === 'string') out[k] = v
        else if (t === 'number' || t === 'integer') {
          const n = Number(v)
          if (Number.isNaN(n)) return err(`"${k}" must be a number.`)
          out[k] = n
        } else if (t === 'boolean') out[k] = v === 'true'
        else {
          try {
            out[k] = JSON.parse(v)
          } catch {
            out[k] = v
          }
        }
      }
      return pairs.length || required ? out : undefined
    }
    case 'boolean':
      return Boolean(raw)
    case 'enum': {
      const s = String(raw ?? '')
      if (s === '') return required ? err('Choose one.') : undefined
      const orig = (node.enum ?? []).find((e) => String(e) === s)
      return orig ?? s
    }
    case 'integer':
    case 'number': {
      const s = String(raw ?? '').trim()
      if (s === '') return required ? err('Required.') : undefined
      const n = Number(s)
      if (Number.isNaN(n)) return err('Enter a number.')
      if (kind === 'integer' && !Number.isInteger(n)) return err('Enter a whole number.')
      if (node.minimum !== undefined && n < node.minimum) return err(`At least ${node.minimum}.`)
      if (node.maximum !== undefined && n > node.maximum) return err(`At most ${node.maximum}.`)
      return n
    }
    case 'string': {
      const s = String(raw ?? '')
      if (s.trim() === '') return required ? err('Required.') : undefined
      if (node.minLength !== undefined && s.length < node.minLength) return err(`At least ${node.minLength} characters.`)
      if (node.maxLength !== undefined && s.length > node.maxLength) return err(`At most ${node.maxLength} characters (now ${s.length}).`)
      if (node.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return err('Enter a valid email address.')
      if (node.format === 'uri' || node.format === 'url') {
        try {
          new URL(s)
        } catch {
          return err('Enter a full URL, like https://example.com.')
        }
      }
      if (node.format === 'date-time') {
        const d = new Date(s)
        if (Number.isNaN(d.getTime())) return err('Enter a valid date and time.')
        return d.toISOString()
      }
      if (node.pattern) {
        try {
          if (!new RegExp(node.pattern).test(s)) return err(`Does not match the expected format (${node.pattern}).`)
        } catch {
          /* pattern not supported by JS: let the server decide */
        }
      }
      return s
    }
    case 'lines': {
      const items = String(raw ?? '')
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
      const num = unwrap(node.items ?? {}).node.type !== 'string'
      if (!items.length) return required ? err('Add at least one line.') : undefined
      if (node.minItems !== undefined && items.length < node.minItems) return err(`At least ${node.minItems} lines.`)
      if (node.maxItems !== undefined && items.length > node.maxItems) return err(`At most ${node.maxItems} lines.`)
      if (num) {
        const ns = items.map(Number)
        if (ns.some(Number.isNaN)) return err('Every line must be a number.')
        return ns
      }
      return items
    }
    case 'json': {
      const s = String(raw ?? '').trim()
      if (s === '') return required ? err('Required (JSON).') : undefined
      try {
        return JSON.parse(s)
      } catch (e) {
        return err(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`)
      }
    }
  }
}

/* ------------------------------------------------------------------ UI */

interface NodeProps {
  schema: JsonSchemaNode
  value: Raw | undefined
  onChange: (v: Raw) => void
  path: string
  label: string
  required: boolean
  errors: Errors
  idBase: string
}

function Shell({ id, label, required, help, error, children, inline }: { id: string; label: string; required: boolean; help?: string; error?: string; children: ReactNode; inline?: boolean }) {
  return (
    <div className={inline ? 'flex items-start gap-3' : ''}>
      {!inline && (
        <label htmlFor={id} className="mb-1 flex items-baseline gap-1.5 text-[13px] font-semibold text-fog">
          {label}
          {required ? (
            <span className="text-coral" aria-hidden>
              *
            </span>
          ) : (
            <span className="text-[11px] font-normal text-mute">optional</span>
          )}
        </label>
      )}
      <div className={inline ? 'min-w-0 flex-1' : ''}>
        {children}
        {help && (
          <p id={`${id}-help`} className="mt-1 text-xs leading-snug text-mute">
            {help}
          </p>
        )}
        {error && (
          <p id={`${id}-err`} role="alert" className="mt-1 text-xs font-medium text-coral">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

function FieldNode({ schema, value, onChange, path, label, required, errors, idBase }: NodeProps) {
  const { kind, node } = kindOf(schema)
  const id = `${idBase}-${path.replace(/[^a-zA-Z0-9]/g, '_')}`
  const error = errors[path]
  const help = [node.description, node.maxLength && kind === 'string' ? `Up to ${node.maxLength} characters.` : '', node.minimum !== undefined || node.maximum !== undefined ? `${node.minimum ?? ''}–${node.maximum ?? ''}` : ''].filter(Boolean).join(' ')
  const aria = { 'aria-required': required || undefined, 'aria-invalid': error ? true : undefined, 'aria-describedby': [help ? `${id}-help` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined }

  switch (kind) {
    case 'object': {
      const req = new Set(node.required ?? [])
      const v = (value as { [k: string]: Raw }) ?? {}
      return (
        <fieldset className="rounded-xl border border-line p-3">
          <legend className="px-1.5 text-[13px] font-semibold text-fog">{label}</legend>
          {node.description && <p className="mb-2 text-xs text-mute">{node.description}</p>}
          <div className="space-y-3">
            {Object.entries(node.properties ?? {}).map(([k, child]) => (
              <FieldNode key={k} schema={child} value={v[k]} onChange={(nv) => onChange({ ...v, [k]: nv })} path={`${path}.${k}`} label={child.title ?? humanize(k)} required={req.has(k)} errors={errors} idBase={idBase} />
            ))}
          </div>
        </fieldset>
      )
    }
    case 'record': {
      const pairs = (value as Pair[]) ?? []
      const set = (i: number, j: 0 | 1, s: string) => onChange(pairs.map((p, n) => (n === i ? ((j === 0 ? [s, p[1]] : [p[0], s]) as Pair) : p)))
      return (
        <fieldset>
          <legend className="mb-1 text-[13px] font-semibold text-fog">
            {label} {!required && <span className="text-[11px] font-normal text-mute">optional</span>}
          </legend>
          {node.description && <p className="mb-2 text-xs text-mute">{node.description}</p>}
          <div className="space-y-2">
            {pairs.map(([k, v], i) => (
              <div key={i} className="flex items-start gap-2">
                <input className="field !w-[26%] min-w-[64px] shrink-0 font-mono text-[13px]" aria-label={`${label} key ${i + 1}`} placeholder="key" value={k} onChange={(e) => set(i, 0, e.target.value)} />
                <textarea className="field min-h-[40px] min-w-0 flex-1 !w-auto" rows={v.length > 60 ? 3 : 1} aria-label={`${label} value for ${k || 'key ' + (i + 1)}`} placeholder="value" value={v} onChange={(e) => set(i, 1, e.target.value)} />
                <button type="button" onClick={() => onChange(pairs.filter((_, n) => n !== i))} className="mt-2 text-mute hover:text-coral" aria-label={`Remove ${k || 'row'}`}>
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => onChange([...pairs, ['', '']])} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-soft hover:text-hl">
            <Plus className="size-3.5" /> Add {pairs.length ? 'another' : 'an entry'}
          </button>
          {error && (
            <p role="alert" className="mt-1 text-xs font-medium text-coral">
              {error}
            </p>
          )}
        </fieldset>
      )
    }
    case 'boolean':
      return (
        <Shell id={id} label={label} required={false} help={node.description} error={error} inline>
          <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm text-fog">
            <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--color-hl)]" />
            {label}
          </label>
        </Shell>
      )
    case 'enum':
      return (
        <Shell id={id} label={label} required={required} help={node.description} error={error}>
          <select id={id} className="field" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} {...aria}>
            {!required || node.default === undefined ? <option value="">{required ? 'Choose…' : 'Not set'}</option> : null}
            {(node.enum ?? []).map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
        </Shell>
      )
    case 'integer':
    case 'number':
      return (
        <Shell id={id} label={label} required={required} help={help} error={error}>
          <input id={id} className="field font-mono" inputMode="decimal" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} {...aria} />
        </Shell>
      )
    case 'lines':
      return (
        <Shell id={id} label={label} required={required} help={[node.description, 'One per line.'].filter(Boolean).join(' ')} error={error}>
          <textarea id={id} className="field min-h-[84px] font-mono text-[13px]" rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} {...aria} />
        </Shell>
      )
    case 'json':
      return (
        <Shell id={id} label={label} required={required} help={[node.description, 'JSON.'].filter(Boolean).join(' ')} error={error}>
          <textarea id={id} className="field min-h-[96px] font-mono text-[12.5px]" spellCheck={false} rows={5} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={node.type === 'array' ? '[ ]' : '{ }'} {...aria} />
        </Shell>
      )
    case 'string': {
      const long = (node.maxLength ?? 0) > 200 || /body|text|reason|note|description|context|grounds|statement|answer|goal|jsonl|csv|lines/i.test(path.split('.').pop() ?? '') || /(jsonl|csv|one per line|per line)/i.test(node.description ?? '') || (node.maxLength === undefined && !node.format && /text|reason|note|goal|answer|grounds|description/i.test(label))
      const type = node.format === 'email' ? 'email' : node.format === 'uri' || node.format === 'url' ? 'url' : node.format === 'date-time' ? 'datetime-local' : 'text'
      return (
        <Shell id={id} label={label} required={required} help={help} error={error}>
          {long && type === 'text' ? (
            <textarea id={id} className="field min-h-[84px]" rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} {...aria} />
          ) : (
            <input id={id} className={`field ${node.pattern || node.format === 'uri' ? 'font-mono text-[13px]' : ''}`} type={type} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} {...aria} />
          )}
        </Shell>
      )
    }
  }
}

export interface SchemaFormProps {
  schema: JsonSchemaNode
  /** Prefill (a next_action's args). Keys listed in `hide` are submitted as given. */
  initial?: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>
  submitLabel?: string
  pending?: boolean
  error?: unknown
  hide?: string[]
  onCancel?: () => void
  /** Shown above the submit button when there is nothing to fill in. */
  emptyNote?: string
  submitVariant?: 'primary' | 'danger' | 'ghost'
}

export function SchemaForm({ schema, initial, onSubmit, submitLabel = 'Send', pending, error, hide = [], onCancel, emptyNote, submitVariant = 'primary' }: SchemaFormProps) {
  const uid = useId()
  const root = useMemo(() => ({ ...schema, type: schema.type ?? 'object' }) as JsonSchemaNode, [schema])
  const props = root.properties ?? {}
  const [raw, setRaw] = useState<{ [k: string]: Raw }>(() => init(root, initial, hide, true) as { [k: string]: Raw })
  const [errors, setErrors] = useState<Errors>({})
  const required = new Set(root.required ?? [])
  const visible = Object.entries(props).filter(([k]) => !hide.includes(k))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const errs: Errors = {}
    const out: Record<string, unknown> = {}
    for (const [k, child] of visible) {
      const v = serialize(child, raw[k], k, required.has(k), errs)
      if (v !== undefined) out[k] = v
    }
    for (const k of hide) if (initial && initial[k] !== undefined) out[k] = initial[k]
    setErrors(errs)
    if (Object.keys(errs).length) {
      const first = Object.keys(errs)[0].replace(/[^a-zA-Z0-9]/g, '_')
      requestAnimationFrame(() => document.getElementById(`${uid}-${first}`)?.focus())
      return
    }
    void onSubmit(out)
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3.5">
      {visible.map(([k, child]) => (
        <FieldNode key={k} schema={child} value={raw[k]} onChange={(v) => setRaw((r) => ({ ...r, [k]: v }))} path={k} label={child.title ?? humanize(k)} required={required.has(k)} errors={errors} idBase={uid} />
      ))}
      {!visible.length && <p className="text-sm text-soft">{emptyNote ?? 'Nothing to fill in. Confirm to go ahead.'}</p>}
      {Object.keys(errors).length > 0 && (
        <p role="alert" className="text-xs font-medium text-coral">
          Fix {Object.keys(errors).length} field{Object.keys(errors).length > 1 ? 's' : ''} above.
        </p>
      )}
      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" variant={submitVariant} loading={pending}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
