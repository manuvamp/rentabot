import { useCallback, useEffect, useRef, useState } from 'react'
import { callOp } from './client'
import type { OpInput, OpName, OpOutput } from './types'

export interface AsyncState<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
  setData: (d: T | undefined) => void
}

/** Tiny query hook: keeps stale data while reloading, optional polling, ignores out-of-order responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean; pollMs?: number } = {}): AsyncState<T> {
  const { enabled = true, pollMs } = opts
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)
  const [loading, setLoading] = useState(enabled)
  const [tick, setTick] = useState(0)
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const my = ++seq.current
    setLoading(true)
    fnRef
      .current()
      .then((d) => {
        if (seq.current !== my) return
        setData(d)
        setError(undefined)
      })
      .catch((e) => {
        if (seq.current !== my) return
        setError(e)
      })
      .finally(() => {
        if (seq.current === my) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, tick])

  useEffect(() => {
    if (!pollMs || !enabled) return
    const t = setInterval(() => setTick((n) => n + 1), pollMs)
    return () => clearInterval(t)
  }, [pollMs, enabled])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { data, error, loading, reload, setData }
}

export function useOp<N extends OpName>(name: N, input: OpInput<N>, opts: { enabled?: boolean; pollMs?: number } = {}): AsyncState<OpOutput<N>> {
  return useAsync(() => callOp(name, input), [name, JSON.stringify(input)], opts)
}

/** Run a mutating op from a button: tracks pending state and the last error. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true)
    setError(undefined)
    try {
      return await fnRef.current(...args)
    } catch (e) {
      setError(e)
      return undefined
    } finally {
      setPending(false)
    }
  }, [])
  return { run, pending, error, clearError: () => setError(undefined) }
}
