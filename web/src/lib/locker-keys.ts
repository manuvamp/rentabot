// Per-agent locker key store for the browser. The private key is a CryptoKey kept in IndexedDB (structured clone,
// never serialized to text); it is extractable only so the owner can export a passphrase-protected recovery kit.
// Nothing here logs, stores in localStorage, or sends anything but the PUBLIC JWK to the server.
import { exportPublicJwk, generateLockerKeyPair, jwkThumbprint, makeRecoveryKit, openRecoveryKit, RecoveryKit, type PublicJwk } from '@rentabot/shared'
import { apiGet, callOp } from '../api/client'

export interface StoredLockerKey {
  agent_id: string
  kid: string
  privateKey: CryptoKey
  publicJwk: PublicJwk
  created_at: string
}

const DB = 'rab-locker'
const STORE = 'keys'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser has no IndexedDB, so it cannot keep a locker key.'))
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'agent_id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error('Could not open the browser key store.'))
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const r = fn(t.objectStore(STORE))
      t.oncomplete = () => resolve(r.result)
      t.onerror = () => reject(new Error('The browser key store refused the change.'))
      t.onabort = () => reject(new Error('The browser key store refused the change.'))
    })
  } finally {
    db.close()
  }
}

export async function getStoredKey(agentId: string): Promise<StoredLockerKey | null> {
  const r = await tx<StoredLockerKey | undefined>('readonly', (s) => s.get(agentId) as IDBRequest<StoredLockerKey | undefined>)
  return r ?? null
}
const putStoredKey = (rec: StoredLockerKey) => tx('readwrite', (s) => s.put(rec)).then(() => rec)
export const deleteStoredKey = (agentId: string) => tx('readwrite', (s) => s.delete(agentId)).then(() => undefined)

/**
 * Everyone who tries the demo signs in as the same demo persona, and every new browser registers one more key for it. At the
 * server's per-agent cap the next browser would get no key at all, so on a demo identity the oldest browser keys are retired
 * to make room. Real accounts (PayPal sign-in) are never touched: they see the server's error and revoke keys themselves.
 */
async function registerWithRoom(publicJwk: PublicJwk) {
  const register = () => callOp('register_encryption_key', { jwk: publicJwk, label: 'browser' })
  try {
    return await register()
  } catch (e) {
    if (!/active keys/i.test(e instanceof Error ? e.message : JSON.stringify(e))) throw e
    const who = await apiGet<{ user?: { email?: string } | null }>('/api/session').catch(() => null)
    if (!who?.user?.email?.endsWith('.example')) throw e
    const { yours } = await callOp('list_encryption_keys', {})
    const old = yours.filter((k) => !k.revoked_at && k.label === 'browser').slice(0, 5)
    for (const k of old) await callOp('revoke_encryption_key', { kid: k.kid })
    return register()
  }
}

/** Make a new key pair, register its public half for the acting agent, keep the private half here. */
export async function createAndRegisterKey(agentId: string): Promise<StoredLockerKey> {
  const pair = await generateLockerKeyPair(true)
  const publicJwk = await exportPublicJwk(pair.publicKey)
  const { key } = await registerWithRoom(publicJwk)
  return putStoredKey({ agent_id: agentId, kid: key.kid, privateKey: pair.privateKey, publicJwk, created_at: key.created_at })
}

const pending = new Map<string, Promise<StoredLockerKey>>()
/** The stored key for this agent, or a new registered one. Concurrent callers share one creation. */
export function ensureKey(agentId: string): Promise<StoredLockerKey> {
  const p = pending.get(agentId)
  if (p) return p
  const run = getStoredKey(agentId)
    .then((k) => k ?? createAndRegisterKey(agentId))
    .finally(() => pending.delete(agentId))
  pending.set(agentId, run)
  return run
}

/** Is this kid still an active key of yours on the server? */
export async function keyIsActive(kid: string): Promise<boolean> {
  const { yours } = await callOp('list_encryption_keys', {})
  const k = yours.find((x) => x.kid === kid)
  return !!k && !k.revoked_at
}

export const fingerprint = (rec: StoredLockerKey) => jwkThumbprint(rec.publicJwk)

function download(name: string, data: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Build the recovery kit locally and save it as a file. The passphrase never leaves this function. */
export async function downloadRecoveryKit(rec: StoredLockerKey, passphrase: string): Promise<void> {
  const kit = await makeRecoveryKit({ kid: rec.kid, agent_id: rec.agent_id, privateKey: rec.privateKey, publicJwk: rec.publicJwk, passphrase })
  download(`rentabot-locker-recovery-${rec.kid}.json`, JSON.stringify(kit, null, 2), 'application/json')
}

/** Restore a private key from a recovery kit file. Checks agent, key pair match and that the key is still active. */
export async function restoreFromKit(agentId: string, file: File, passphrase: string): Promise<StoredLockerKey> {
  let kit: RecoveryKit
  try {
    kit = RecoveryKit.parse(JSON.parse(await file.text()))
  } catch {
    throw new Error('That file is not a Rent-A-Bot recovery kit.')
  }
  if (kit.agent_id !== agentId) throw new Error(`This kit belongs to ${kit.agent_id}, not the agent you are acting as.`)
  const privateKey = await openRecoveryKit(kit, passphrase, true)
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const match = jwk.x === kit.public_jwk.x && jwk.y === kit.public_jwk.y
  if (!match) throw new Error('The kit is damaged: its private and public keys do not match.')
  if (!(await keyIsActive(kit.kid))) throw new Error('That key was revoked. Make a new key instead.')
  return putStoredKey({ agent_id: agentId, kid: kit.kid, privateKey, publicJwk: kit.public_jwk, created_at: kit.created_at })
}

/** Save a file built in the browser (CSV export). */
export const saveLocalFile = download
