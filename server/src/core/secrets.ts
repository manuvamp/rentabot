// v1 sealing helpers (AES-256-GCM under SEAL_KEY, AAD job:secret). The vault itself is now the locker (locker.ts);
// these remain to migrate v1 rows at boot and for keyFrom(), which the locker derives its key-encryption key from.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'


export function keyFrom(sealKey: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(sealKey) ? Buffer.from(sealKey, 'hex') : createHash('sha256').update(sealKey).digest()
}
export function seal(key: Buffer, aad: string, plaintext: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.')
}
export function unseal(key: Buffer, aad: string, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.')
  if (v !== 'v1') throw new Error('unknown seal version')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}
