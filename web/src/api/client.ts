import type { NextAction, OpInput, OpName, OpOutput } from './types'

export const MOCK = import.meta.env.VITE_MOCK === '1' || import.meta.env.VITE_MOCK === 'true'

export class ApiError extends Error {
  code: string
  hint: string
  status: number
  next_actions: NextAction[]
  constructor(status: number, code: string, message: string, hint = '', next_actions: NextAction[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.hint = hint
    this.next_actions = next_actions
  }
}

const ACT_AS_KEY = 'rab_act_as'
export function getActAs(): string | null {
  try {
    return sessionStorage.getItem(ACT_AS_KEY)
  } catch {
    return null
  }
}
export function setActAs(id: string | null) {
  try {
    if (id) sessionStorage.setItem(ACT_AS_KEY, id)
    else sessionStorage.removeItem(ACT_AS_KEY)
  } catch {
    /* private mode */
  }
}

function headers(json = true): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (json) h['Content-Type'] = 'application/json'
  const act = getActAs()
  if (act) h['X-Act-As'] = act
  return h
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; hint?: string; next_actions?: NextAction[] } } | null)?.error
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? `Request failed (${res.status})`, e?.hint ?? '', e?.next_actions ?? [])
  }
  return data as T
}

export async function callOp<N extends OpName>(name: N, input: OpInput<N>): Promise<OpOutput<N>> {
  const res = await fetch(`/api/ops/${name}`, { method: 'POST', credentials: 'include', headers: headers(), body: JSON.stringify(input ?? {}) })
  return parse<OpOutput<N>>(res)
}

/** For forms generated from JSON Schema: the op name is dynamic, so it is not typed. */
export async function callOpRaw(name: string, input: unknown): Promise<unknown> {
  const res = await fetch(`/api/ops/${name}`, { method: 'POST', credentials: 'include', headers: headers(), body: JSON.stringify(input ?? {}) })
  return parse<unknown>(res)
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include', headers: headers(false) })
  return parse<T>(res)
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'include', headers: headers(), body: JSON.stringify(body ?? {}) })
  return parse<T>(res)
}

export function errorText(e: unknown): { message: string; hint: string } {
  if (e instanceof ApiError) return { message: e.message, hint: e.hint }
  if (e instanceof Error) return { message: e.message, hint: '' }
  return { message: 'Something went wrong.', hint: '' }
}
