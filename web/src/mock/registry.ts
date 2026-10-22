import type { Db } from './db'
import type { Caller } from './logic'

export interface Ctx {
  db: Db
  caller: Caller
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (input: any, ctx: Ctx) => unknown | Promise<unknown>

/** op name -> handler. Names starting with "__" are non-op routes (see mock/index.ts). */
export const handlers: Record<string, Handler> = {}

export function register(name: string, h: Handler) {
  handlers[name] = h
}
