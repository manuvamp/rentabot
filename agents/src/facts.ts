// Loads the ORANO facts block: `key: value` front matter (the listing fields) plus the markdown body.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface OranoFacts {
  name: string
  url: string
  tagline_60: string
  description_300: string
  category: string
  contact_email: string
  /** The whole block (fields + body) as plain text: the context a seller may rely on. */
  text: string
}

export const FACTS_PATH = join(import.meta.dirname, 'orano-facts.md')
const REQUIRED = ['name', 'url', 'tagline_60', 'description_300', 'category', 'contact_email'] as const

export function parseFacts(src: string): OranoFacts {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src)
  if (!m) throw new Error('orano-facts.md must start with a --- front matter block.')
  const fields: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  for (const k of REQUIRED) if (!fields[k]) throw new Error(`orano-facts.md is missing "${k}".`)
  if (fields.tagline_60!.length > 60) throw new Error('tagline_60 is longer than 60 characters.')
  if (fields.description_300!.length > 300) throw new Error('description_300 is longer than 300 characters.')
  const header = REQUIRED.map((k) => `${k}: ${fields[k]}`).join('\n')
  return {
    name: fields.name!,
    url: fields.url!,
    tagline_60: fields.tagline_60!,
    description_300: fields.description_300!,
    category: fields.category!,
    contact_email: fields.contact_email!,
    text: `${header}\n\n${m[2]!.trim()}\n`,
  }
}

export function loadOranoFacts(path = FACTS_PATH): OranoFacts {
  return parseFacts(readFileSync(path, 'utf8'))
}
