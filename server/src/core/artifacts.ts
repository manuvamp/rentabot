// Artifacts (bytes on disk under DATA_DIR/artifacts, metadata in SQLite) and check evidence.
import type { Artifact } from '@rentabot/shared'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { json } from '../db/index.ts'
import type { Domain } from './domain.ts'
import { OpError } from './types.ts'
import { newId, sha256Tag } from './util.ts'

export class ArtifactStore {
  private d: Domain
  private dir: string
  constructor(d: Domain) {
    this.d = d
    this.dir = join(d.cfg.dataDir, 'artifacts')
  }

  create(p: { job_id: string | null; name: string; mime: string; bytes?: Uint8Array; url?: string; uploaded_by: string }): Artifact {
    const id = newId('art')
    let size = 0
    let hash: string
    let url: string
    let path: string | null = null
    if (p.bytes) {
      mkdirSync(this.dir, { recursive: true })
      path = join(this.dir, id)
      writeFileSync(path, p.bytes)
      size = p.bytes.byteLength
      hash = sha256Tag(p.bytes)
      url = `${this.d.cfg.publicUrl}/api/artifacts/${id}`
    } else if (p.url) {
      hash = sha256Tag(p.url) // external link: the hash pins the URL, not the remote bytes
      url = p.url
    } else throw new OpError('invalid_input', 'Give content_base64, text or url.', 'Upload bytes (base64), plain text, or an external URL.')
    const a: Artifact = { id, job_id: p.job_id, name: p.name, mime: p.mime, bytes: size, sha256: hash, url, uploaded_by: p.uploaded_by, created_at: this.d.nowIso() }
    this.d.db.run('INSERT INTO artifacts (id, job_id, data, path) VALUES (?, ?, ?, ?)', id, p.job_id, JSON.stringify(a), path)
    return a
  }

  meta(id: string): Artifact | null {
    const r = this.d.db.get<{ data: string }>('SELECT data FROM artifacts WHERE id = ?', id)
    return r ? json<Artifact>(r.data) : null
  }

  read(id: string): { meta: Artifact; bytes: Uint8Array } | null {
    const r = this.d.db.get<{ data: string; path: string | null }>('SELECT data, path FROM artifacts WHERE id = ?', id)
    if (!r) return null
    const meta = json<Artifact>(r.data)
    const bytes = r.path && existsSync(r.path) ? new Uint8Array(readFileSync(r.path)) : new Uint8Array()
    return { meta, bytes }
  }

  saveEvidence(job_id: string | null, kind: string, summary: string, payload: unknown): string {
    const id = newId('ev')
    let body = JSON.stringify(payload ?? null)
    if (body.length > 200_000) body = JSON.stringify({ truncated: true, head: body.slice(0, 200_000) })
    this.d.db.run('INSERT INTO evidence (id, job_id, kind, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, job_id, kind.slice(0, 60), summary.slice(0, 500), body, this.d.nowIso())
    return id
  }
}
