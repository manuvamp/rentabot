// The job locker: credentials passed between buyer and seller. Values are encrypted in this browser for the other
// side's keys (end-to-end) or, when they have none, sent to be sealed by Rent-A-Bot. Revealed values live only in
// this component's state: never logged, never cached, never in URLs or storage, gone when the panel unmounts.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Download, Eye, EyeOff, KeyRound, Lock, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { newLockerItemId, openWithPrivateKey, sealForRecipients, type LockerItem, type LockerSecret, type OpOutput } from '@rentabot/shared'
import { ApiError, callOp, MOCK } from '../../../api/client'
import { useAction } from '../../../api/hooks'
import type { Job, Role } from '../../../api/types'
import { Button, Chip, CopyButton, ErrorBox, Receipt, ReceiptRule, Stamp, type StampKind } from '../../../components/ui'
import { dateTime } from '../../../lib/format'
import { createAndRegisterKey, downloadRecoveryKit, ensureKey, fingerprint, keyIsActive, restoreFromKit, saveLocalFile, type StoredLockerKey } from '../../../lib/locker-keys'

type Locker = OpOutput<'list_locker_items'>
type Keys = OpOutput<'list_encryption_keys'>
type Consent = Locker['consent'][number]
type Revealed = Record<string, LockerSecret>

/** Error text that can never carry a secret: server errors pass through, local failures get fixed wording. */
function safe(e: unknown, fallback: string): Error | undefined {
  if (!e) return undefined
  if (e instanceof ApiError) return e
  if (e instanceof Error && e.name === 'LockerUserError') return e
  return new Error(fallback)
}
function userError(message: string) {
  const e = new Error(message)
  e.name = 'LockerUserError'
  return e
}

const STATUS: Record<LockerItem['status'], [StampKind, string]> = {
  locked: ['held', 'LOCKED'],
  available: ['open', 'AVAILABLE'],
  released: ['paid', 'RELEASED'],
  shredded: ['voided', 'SHREDDED'],
}

// ---------------------------------------------------------------- key state

type KeyState = { s: 'loading' } | { s: 'ready'; key: StoredLockerKey; fp: string } | { s: 'revoked'; key: StoredLockerKey } | { s: 'error'; error: unknown }

function useBrowserKey(agentId: string | null) {
  const [state, setState] = useState<KeyState>({ s: 'loading' })
  const load = useCallback(async (make?: () => Promise<StoredLockerKey>) => {
    if (!agentId) return
    try {
      const key = await (make ? make() : ensureKey(agentId))
      if (!(await keyIsActive(key.kid))) return setState({ s: 'revoked', key })
      setState({ s: 'ready', key, fp: await fingerprint(key) })
    } catch (e) {
      setState({ s: 'error', error: e })
    }
  }, [agentId])
  useEffect(() => {
    setState({ s: 'loading' })
    void load()
  }, [load])
  return { state, load }
}

function KeyBar({ agentId, ks, reload }: { agentId: string; ks: KeyState; reload: (make?: () => Promise<StoredLockerKey>) => Promise<void> }) {
  const [mode, setMode] = useState<'none' | 'kit' | 'restore'>('none')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const act = useAction(async (fn: () => Promise<void>) => fn())
  const done = () => {
    setPass('')
    setPass2('')
    setMode('none')
  }
  useEffect(() => () => setPass(''), [])

  const kit = (e: FormEvent) => {
    e.preventDefault()
    if (ks.s !== 'ready') return
    void act.run(async () => {
      if (pass.length < 10) throw userError('Use a passphrase of at least 10 characters.')
      if (pass !== pass2) throw userError('The two passphrases differ.')
      await downloadRecoveryKit(ks.key, pass)
      done()
    })
  }
  const restore = (e: FormEvent) => {
    e.preventDefault()
    const f = file.current?.files?.[0]
    void act.run(async () => {
      if (!f) throw userError('Pick the recovery kit file.')
      try {
        await reload(() => restoreFromKit(agentId, f, pass))
      } catch (err) {
        throw err instanceof ApiError ? err : userError(err instanceof Error && /^(Wrong passphrase|That file|This kit|The kit|That key)/.test(err.message) ? err.message : 'Could not restore that kit.')
      }
      done()
    })
  }
  const fresh = () => void act.run(() => reload(() => createAndRegisterKey(agentId)))

  return (
    <div className="panel-2 p-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-4 text-hl" aria-hidden />
        {ks.s === 'loading' && <span className="text-soft">Preparing this browser's key…</span>}
        {ks.s === 'ready' && (
          <span className="min-w-0 text-soft">
            Browser key <span className="font-mono text-fog">{ks.key.kid}</span> <span className="font-mono text-mute" title="Fingerprint (compare out of band)">{ks.fp.slice(0, 12)}</span>
          </span>
        )}
        {ks.s === 'revoked' && <span className="text-coral">This browser's key {ks.key.kid} was revoked. Items sent to it cannot be opened here.</span>}
        {ks.s === 'error' && <span className="text-coral">No browser key: {safe(ks.error, 'the key store failed.')?.message}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ks.s === 'ready' && (
          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => setMode(mode === 'kit' ? 'none' : 'kit')}>
            Recovery kit
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} onClick={() => setMode(mode === 'restore' ? 'none' : 'restore')}>
          Restore
        </Button>
        {(ks.s === 'revoked' || ks.s === 'error') && (
          <Button size="sm" loading={act.pending} onClick={fresh}>
            New key
          </Button>
        )}
      </div>
      {mode === 'kit' && (
        <form onSubmit={kit} className="mt-2 space-y-1.5">
          <input className="field text-sm" type="password" autoComplete="new-password" placeholder="Passphrase (10+ characters)" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Passphrase" />
          <input className="field text-sm" type="password" autoComplete="new-password" placeholder="Same passphrase again" value={pass2} onChange={(e) => setPass2(e.target.value)} aria-label="Repeat passphrase" />
          <Button size="sm" type="submit" loading={act.pending}>
            Download recovery kit
          </Button>
        </form>
      )}
      {mode === 'restore' && (
        <form onSubmit={restore} className="mt-2 space-y-1.5">
          <input ref={file} type="file" accept="application/json,.json" className="block text-[12px] text-soft" aria-label="Recovery kit file" />
          <input className="field text-sm" type="password" autoComplete="off" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Passphrase" />
          <Button size="sm" type="submit" loading={act.pending}>
            Restore key
          </Button>
        </form>
      )}
      <ErrorBox className="mt-2" error={safe(act.error, 'That did not work.')} />
    </div>
  )
}

// ---------------------------------------------------------------- secret form

type FormKind = 'login' | 'api_key' | 'secret'
const EMPTY = { url: '', username: '', password: '', notes: '', key: '', value: '' }

function buildSecret(kind: FormKind, f: typeof EMPTY): LockerSecret {
  if (kind === 'login') {
    if (!f.username || !f.password) throw userError('Fill in the username and the password.')
    return { kind: 'login', url: f.url.trim(), username: f.username, password: f.password, notes: f.notes }
  }
  if (kind === 'api_key') {
    if (!f.key) throw userError('Paste the key.')
    return { kind: 'api_key', key: f.key, notes: f.notes }
  }
  if (!f.value) throw userError('Fill in the value.')
  return { kind: 'secret', value: f.value }
}

function hostOf(url: string): string {
  if (!url.trim()) return ''
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.slice(0, 200)
  } catch {
    return ''
  }
}

function SecretFields({ kind, f, set }: { kind: FormKind; f: typeof EMPTY; set: (p: Partial<typeof EMPTY>) => void }) {
  const input = (k: keyof typeof EMPTY, ph: string, secret = false) => (
    <input
      className="field field-paper text-sm"
      type={secret ? 'password' : 'text'}
      autoComplete={secret ? 'new-password' : 'off'}
      spellCheck={false}
      placeholder={ph}
      aria-label={ph}
      value={f[k]}
      onChange={(e) => set({ [k]: e.target.value })}
    />
  )
  return (
    <div className="space-y-1.5">
      {kind === 'login' && (
        <>
          {input('url', 'Site URL')}
          {input('username', 'Username or email')}
          {input('password', 'Password', true)}
          {input('notes', 'Notes (optional)')}
        </>
      )}
      {kind === 'api_key' && (
        <>
          {input('key', 'API key', true)}
          {input('notes', 'Notes (optional)')}
        </>
      )}
      {kind === 'secret' && input('value', 'Value', true)}
    </div>
  )
}

/** Encrypt for the recipients' keys if they have any, else send for sealing. Returns the put_locker_item body fields. */
async function sealBody(ref: { job_id: string; direction: 'access' | 'handover' }, secret: LockerSecret, recipients: Keys['buyer']) {
  if (!recipients.length) return { secret }
  const item_id = newLockerItemId()
  try {
    const { ciphertext, wraps } = await sealForRecipients({ ...ref, item_id }, secret, recipients.map((k) => ({ kid: k.kid, jwk: k.jwk })))
    return { item_id, ciphertext, wraps }
  } catch {
    throw userError('Could not encrypt in this browser.')
  }
}

function SealNote({ e2e, who }: { e2e: boolean; who: string }) {
  return e2e ? (
    <p className="flex items-center gap-1 text-[11px] text-lime-deep">
      <ShieldCheck className="size-3.5" aria-hidden /> end-to-end: encrypted here for the {who}'s key
    </p>
  ) : (
    <p className="text-[11px] text-amber-deep">Sealed by Rent-A-Bot: the platform can read this, the {who} has no encryption key.</p>
  )
}

function AccessForm({ jobId, c, sellerKeys, onSaved }: { jobId: string; c: Consent; sellerKeys: Keys['seller']; onSaved: () => void }) {
  const [kind, setKind] = useState<FormKind>(c.kind === 'account_login' ? 'login' : c.kind === 'api_key' ? 'api_key' : 'secret')
  const [f, setF] = useState(EMPTY)
  const [open, setOpen] = useState(!c.answered)
  useEffect(() => () => setF(EMPTY), [])
  const save = useAction(async () => {
    const secret = buildSecret(kind, f)
    const body = await sealBody({ job_id: jobId, direction: 'access' }, secret, sellerKeys)
    await callOp('put_locker_item', { job_id: jobId, access_id: c.access_id, label: `Access ${c.access_id}`, kind, site: kind === 'login' ? hostOf(f.url) : '', ...body })
    setF(EMPTY)
    setOpen(false)
    onSaved()
  })
  const u = c.usage
  return (
    <li className="space-y-2">
      <div className="note note-hover text-[1.05rem]" style={{ ['--r' as string]: '-1deg' }}>
        <p className="mb-1 font-mono text-[10px] uppercase tracking-widest opacity-70">
          {c.access_id} · {c.kind.replace(/_/g, ' ')}
          {c.required ? ' · required' : ''}
        </p>
        {c.text}
      </div>
      {u && (
        <p className="font-mono text-[11px] text-pmute">
          used {u.used_total}
          {u.max_total != null ? ` / ${u.max_total}` : ''} total · {u.used_today}
          {u.max_per_day != null ? ` / ${u.max_per_day}` : ''} today
        </p>
      )}
      {c.answered && !open ? (
        <div className="flex items-center gap-2">
          <Chip tone="lime" mono>
            answered
          </Chip>
          <Button size="sm" variant="quiet" onClick={() => setOpen(true)}>
            Send another
          </Button>
        </div>
      ) : (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void save.run()
          }}
        >
          <select className="field field-paper text-sm" value={kind} onChange={(e) => setKind(e.target.value as FormKind)} aria-label="Kind">
            <option value="login">Login</option>
            <option value="api_key">API key</option>
            <option value="secret">Secret</option>
          </select>
          <SecretFields kind={kind} f={f} set={(p) => setF((x) => ({ ...x, ...p }))} />
          <SealNote e2e={sellerKeys.length > 0} who="seller" />
          <Button size="sm" type="submit" loading={save.pending} icon={<Lock className="size-3.5" />}>
            Save
          </Button>
          <ErrorBox error={safe(save.error, 'Could not save. Nothing was sent in clear.')} />
        </form>
      )}
    </li>
  )
}

function HandoverForm({ job, buyerKeys, onSaved }: { job: Job; buyerKeys: Keys['buyer']; onSaved: () => void }) {
  const deliverables = job.contract?.spec.deliverables.map((d) => d.id) ?? []
  const [d, setD] = useState(deliverables[0] ?? 'D1')
  const [unit, setUnit] = useState('')
  const [f, setF] = useState(EMPTY)
  const [open, setOpen] = useState(false)
  useEffect(() => () => setF(EMPTY), [])
  const save = useAction(async () => {
    if (!unit.trim()) throw userError('Give the unit ref it belongs to.')
    const secret = buildSecret('login', f)
    const site = hostOf(f.url)
    const body = await sealBody({ job_id: job.id, direction: 'handover' }, secret, buyerKeys)
    await callOp('put_locker_item', { job_id: job.id, deliverable_id: d, unit_ref: unit.trim(), label: (site || 'Login').slice(0, 80), kind: 'login', site, ...body })
    setF(EMPTY)
    setUnit('')
    setOpen(false)
    onSaved()
  })
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Hand over a login
      </Button>
    )
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        void save.run()
      }}
    >
      <div className="grid grid-cols-[5rem_1fr] gap-1.5">
        <select className="field field-paper text-sm" value={d} onChange={(e) => setD(e.target.value)} aria-label="Deliverable">
          {(deliverables.length ? deliverables : ['D1']).map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <input className="field field-paper text-sm" placeholder="Unit ref" aria-label="Unit ref" value={unit} onChange={(e) => setUnit(e.target.value)} />
      </div>
      <SecretFields kind="login" f={f} set={(p) => setF((x) => ({ ...x, ...p }))} />
      <SealNote e2e={buyerKeys.length > 0} who="buyer" />
      <div className="flex gap-1.5">
        <Button size="sm" type="submit" loading={save.pending} icon={<Lock className="size-3.5" />}>
          Save
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <ErrorBox error={safe(save.error, 'Could not save. Nothing was sent in clear.')} />
    </form>
  )
}

// ---------------------------------------------------------------- items

function secretRows(s: LockerSecret): [string, string, boolean][] {
  switch (s.kind) {
    case 'login':
      return [
        ['User', s.username, false],
        ['Password', s.password, true],
        ...(s.notes ? ([['Notes', s.notes, false]] as [string, string, boolean][]) : []),
      ]
    case 'api_key':
      return [['Key', s.key, true], ...(s.notes ? ([['Notes', s.notes, false]] as [string, string, boolean][]) : [])]
    case 'recovery_codes':
      return [['Codes', s.codes.join('\n'), true]]
    case 'note':
      return [['Note', s.text, false]]
    case 'secret':
      return [['Value', s.value, true]]
  }
}

function SecretView({ s }: { s: LockerSecret }) {
  const [show, setShow] = useState(false)
  return (
    <div className="mt-1.5 space-y-1 rounded-md border border-pink/20 bg-white/40 p-2 font-mono text-[11.5px]">
      {secretRows(s).map(([label, value, hidden]) => (
        <div key={label} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-pmute">{label}</span>
          <span className="min-w-0 flex-1 break-all text-pink">{hidden && !show ? '••••••••••' : value}</span>
          {hidden && (
            <button type="button" className="text-pmute hover:text-pink" onClick={() => setShow((x) => !x)} aria-label={show ? 'Hide' : 'Show'}>
              {show ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
            </button>
          )}
          <CopyButton text={value} label="Copy" onPaper />
        </div>
      ))}
    </div>
  )
}

function ItemRow({ it, jobId, role, revealed, onReveal, onHide, onChanged }: { it: LockerItem; jobId: string; role: Role; revealed?: LockerSecret; onReveal: () => Promise<void>; onHide: () => void; onChanged: () => void }) {
  const reveal = useAction(onReveal)
  const shred = useAction(async (acknowledged: boolean) => {
    await callOp('shred_locker_item', { job_id: jobId, item_id: it.id, acknowledged })
    onHide()
    onChanged()
  })
  const [kind, label] = STATUS[it.status]
  const canOpen = it.status !== 'shredded' && ((role === 'buyer' && it.direction === 'handover') || (role === 'seller' && it.direction === 'access'))
  const mine = (role === 'buyer' && it.from_role === 'buyer') || (role === 'seller' && it.from_role === 'seller')
  const who = revealed?.kind === 'login' ? revealed.username : ''
  return (
    <li className="border-b border-dashed border-pink/20 py-2.5 last:border-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.8rem] font-bold">
            {it.site || it.label}
            {who && <span className="ml-1.5 font-normal text-pmute">{who}</span>}
          </p>
          <p className="text-[0.66rem] text-pmute">
            {it.direction === 'access' ? it.access_id : `${it.deliverable_id} · ${it.unit_ref}`} · {it.kind.replace('_', ' ')} · <span className={it.protection === 'e2e' ? 'text-lime-deep' : 'text-amber-deep'}>{it.protection_label}</span>
            {it.server_run_sender ? ' · made on Rent-A-Bot' : ''}
          </p>
          {it.status_reason && <p className="text-[0.66rem] text-pmute">{it.status_reason}</p>}
        </div>
        <Stamp kind={kind} size="xs" rotate={-4} animate={false}>
          {label}
        </Stamp>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {canOpen &&
          (revealed ? (
            <Button size="sm" variant="quiet" onClick={onHide} icon={<EyeOff className="size-3.5" />}>
              Hide
            </Button>
          ) : (
            <Button size="sm" variant="ink" loading={reveal.pending} onClick={() => void reveal.run()} icon={<Eye className="size-3.5" />} disabled={it.status === 'locked'}>
              Reveal
            </Button>
          ))}
        {it.status !== 'shredded' && role === 'buyer' && it.direction === 'handover' && (it.status === 'released' || it.status === 'available') && (
          <Button size="sm" variant="quiet" loading={shred.pending} onClick={() => void shred.run(true)}>
            I changed the password
          </Button>
        )}
        {it.status !== 'shredded' && mine && (
          <Button size="sm" variant="quiet" loading={shred.pending} onClick={() => confirm('Shred this item? It cannot be undone.') && void shred.run(false)} icon={<Trash2 className="size-3.5" />}>
            Shred
          </Button>
        )}
      </div>
      {revealed && <SecretView s={revealed} />}
      <ErrorBox className="mt-1.5" error={safe(reveal.error, 'Could not open this item in this browser.') ?? safe(shred.error, 'Could not shred.')} />
    </li>
  )
}

function csvCell(v: string) {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return `"${s.replace(/"/g, '""')}"`
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <ReceiptRule double />
      <p className="mb-1.5 text-[0.66rem] font-bold uppercase tracking-[0.2em] text-pmute">{title}</p>
      {children}
    </>
  )
}

// ---------------------------------------------------------------- panel

export function LockerPanel({ job, role, refreshKey }: { job: Job; role: Role; refreshKey: string }) {
  const agentId = role === 'buyer' ? job.buyer_agent_id : role === 'seller' ? job.seller_agent_id : null
  const [data, setData] = useState<{ locker: Locker; keys: Keys } | null>(null)
  const [error, setError] = useState<unknown>()
  const [revealed, setRevealed] = useState<Revealed>({})
  const { state: ks, load: reloadKey } = useBrowserKey(MOCK ? null : agentId)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const my = ++seq.current
    try {
      const [locker, keys] = await Promise.all([callOp('list_locker_items', { job_id: job.id }), callOp('list_encryption_keys', { job_id: job.id })])
      if (my !== seq.current) return
      setData({ locker, keys })
      setError(undefined)
      setRevealed((r) => Object.fromEntries(Object.entries(r).filter(([id]) => locker.items.some((i) => i.id === id && i.status !== 'shredded'))))
    } catch (e) {
      if (my === seq.current) setError(e)
    }
  }, [job.id])

  useEffect(() => {
    if (agentId) void refresh()
  }, [refresh, refreshKey, agentId, ks.s])
  // drop every revealed value when the panel goes away or the job changes
  useEffect(() => () => setRevealed({}), [job.id])

  const reveal = useCallback(
    async (it: LockerItem) => {
      const r = await callOp('open_locker_item', { job_id: job.id, item_id: it.id })
      let secret: LockerSecret
      if (r.secret) secret = r.secret
      else if (r.ciphertext && r.wraps) {
        if (ks.s !== 'ready') throw userError('This browser has no active key. Restore your recovery kit.')
        try {
          secret = await openWithPrivateKey({ job_id: job.id, item_id: it.id, direction: it.direction }, r.ciphertext, r.wraps, [{ kid: ks.key.kid, privateKey: ks.key.privateKey }])
        } catch {
          throw userError('This browser\'s key cannot open it (it was sent to another key). Restore your recovery kit.')
        }
      } else throw userError('The server returned nothing to open.')
      setRevealed((x) => ({ ...x, [it.id]: secret }))
      void refresh()
    },
    [job.id, ks, refresh],
  )

  const items = data?.locker.items ?? []
  const access = useMemo(() => items.filter((i) => i.direction === 'access'), [items])
  const handovers = useMemo(() => items.filter((i) => i.direction === 'handover'), [items])

  if (MOCK || !agentId) return null

  const exportCsv = () => {
    const rows = [['site', 'url', 'username', 'password', 'notes']]
    for (const it of items) {
      const s = revealed[it.id]
      if (!s) continue
      if (s.kind === 'login') rows.push([it.site, s.url, s.username, s.password, s.notes])
      else if (s.kind === 'api_key') rows.push([it.site, '', '', s.key, s.notes])
      else if (s.kind === 'secret') rows.push([it.site, '', '', s.value, ''])
      else if (s.kind === 'recovery_codes') rows.push([it.site, '', '', s.codes.join(' '), s.notes])
      else rows.push([it.site, '', '', '', s.text])
    }
    saveLocalFile(`locker-${job.id}.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv')
  }

  const row = (it: LockerItem) => (
    <ItemRow key={it.id} it={it} jobId={job.id} role={role} revealed={revealed[it.id]} onReveal={() => reveal(it)} onHide={() => setRevealed(({ [it.id]: _, ...rest }) => rest)} onChanged={() => void refresh()} />
  )
  const l = data?.locker
  const sellerServerRun = data?.keys.seller.some((k) => k.custody === 'server_run')

  return (
    <section id="locker" aria-labelledby="locker-h" className="scroll-mt-24 space-y-3 px-1 pt-1">
      <h2 id="locker-h" className="visually-hidden">
        Locker
      </h2>
      <KeyBar agentId={agentId} ks={ks} reload={reloadKey} />
      <ErrorBox error={error} title="Locker did not load" onRetry={() => void refresh()} />
      {l && (
        <Receipt title="Locker" padded>
          {role === 'buyer' && l.consent.length > 0 && (
            <>
              <p className="mb-2 text-[0.72rem] text-pmute">Read what you allow, then hand over access.{sellerServerRun ? ' The seller bot runs on Rent-A-Bot.' : ''}</p>
              <ul className="space-y-4">
                {l.consent.map((c) => (
                  <AccessForm key={c.access_id} jobId={job.id} c={c} sellerKeys={data.keys.seller} onSaved={() => void refresh()} />
                ))}
              </ul>
            </>
          )}

          {access.length > 0 && (
            <Section title={role === 'seller' ? 'Access granted to you' : 'Access you gave'}>
              <ul>{access.map(row)}</ul>
            </Section>
          )}

          {(handovers.length > 0 || role === 'seller') && (
            <Section title={role === 'seller' ? 'Handed over to the buyer' : 'Handed over to you'}>
              <ul>{handovers.map(row)}</ul>
              {role === 'seller' && (
                <div className="mt-2">
                  <HandoverForm job={job} buyerKeys={data.keys.buyer} onSaved={() => void refresh()} />
                </div>
              )}
            </Section>
          )}

          {Object.keys(revealed).length > 0 && (
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="ink" icon={<Download className="size-3.5" />} onClick={exportCsv}>
                Download CSV
              </Button>
            </div>
          )}

          {!items.length && !(role === 'buyer' && l.consent.length) && <p className="py-1 text-[0.74rem] text-pmute">Empty. Nothing was asked or handed over.</p>}

          {l.actions.length > 0 && (
            <Section title="Logged actions">
              <ol className="space-y-1.5">
                {l.actions.map((a) => (
                  <li key={a.id} className="text-[0.72rem] leading-snug">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`font-bold ${a.accepted ? '' : 'text-coral-deep'}`}>
                        {a.action.replace(/_/g, ' ')} {a.access_id ? `· ${a.access_id}` : ''}
                      </span>
                      <span className="text-[0.64rem] text-pmute">{dateTime(a.ts)}</span>
                    </div>
                    <p className="break-all text-[0.66rem] text-pmute">
                      {a.target}
                      {a.accepted ? '' : ` · rejected: ${a.reason}`}
                    </p>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {l.audit.length > 0 && (
            <Section title="Audit">
              <ol className="space-y-1">
                {l.audit.map((a, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-2 text-[0.68rem] leading-snug">
                    <span className="min-w-0">
                      <span className={`font-bold ${a.event === 'denied' || a.event === 'action_rejected' ? 'text-coral-deep' : ''}`}>{a.event.replace(/_/g, ' ')}</span> <span className="text-pmute">{a.who} · {a.surface}</span>
                      {a.detail && <span className="block break-words text-pmute">{a.detail}</span>}
                    </span>
                    <span className="shrink-0 text-[0.62rem] text-pmute">{dateTime(a.ts)}</span>
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </Receipt>
      )}
    </section>
  )
}
