// /ops/studio: the Platform P&L dashboard, built on AG Studio 3.0. Lazy-loaded (see App.tsx) so none of it ships with the
// landing page. Reads one REST-only op (get_platform_analytics), themes Studio from the site's tokens, adds two custom widgets
// and one custom agent, and sends every model turn through our own server (POST /api/analyst/turn).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgStudio, AgStudioProvider } from 'ag-studio-react'
import { AgStudioAiModule, enableStudioDevValidations } from 'ag-studio'
import type { AgStudioApi } from 'ag-studio'
import { Bot, MessageSquareText, Moon, RefreshCw, Sun } from 'lucide-react'
import { callOp } from '../../api/client'
import { useAsync } from '../../api/hooks'
import { useSession } from '../../api/session'
import { Button, Chip, Container, ErrorBox, Skeleton, Spinner } from '../../components/ui'
import { SignInPanel } from '../../layout/RequireSession'
import { createAnalystHarness, aiToolDisplay } from './studio/ai'
import { buildStudioData } from './studio/data'
import { PAGES, initialReport } from './studio/report'
import { rabStudioTheme } from './studio/theme'
import { buildWidgets, notifyStudioState } from './studio/widgets'
import './studio/studio.css'

if (import.meta.env.DEV) enableStudioDevValidations()

const MODULES = [AgStudioAiModule]
const LICENSE = (import.meta.env.VITE_AG_STUDIO_LICENSE as string | undefined) || undefined
const PANELS = { view: { left: ['filters' as const] }, edit: { left: ['filters' as const], right: ['ai' as const] } }

type LookMode = 'ink' | 'paper'
const readLook = (): LookMode => (typeof localStorage !== 'undefined' && localStorage.getItem('rab-studio-look') === 'paper' ? 'paper' : 'ink')

function Dashboard() {
  const [includeSimulated, setIncludeSimulated] = useState(true)
  const [look, setLook] = useState<LookMode>(readLook)
  const [editing, setEditing] = useState(false)
  const [page, setPage] = useState<string>(PAGES[0].id)
  const apiRef = useRef<AgStudioApi | null>(null)

  const analytics = useAsync(() => callOp('get_platform_analytics', { include_simulated: includeSimulated }), [includeSimulated])
  // The model is chosen at mount, so ask the server first; a failed lookup is treated as "AI off" rather than a broken panel.
  const health = useAsync(async () => {
    try {
      const r = await fetch('/api/health', { credentials: 'include' })
      const j = (await r.json()) as { ai_provider?: string }
      return { aiOn: !!j.ai_provider && j.ai_provider !== 'none' }
    } catch {
      return { aiOn: false }
    }
  }, [])

  const jobsRef = useRef<Record<string, string | number | boolean | null>[]>([])
  jobsRef.current = analytics.data?.tables.jobs ?? []

  const data = useMemo(() => (analytics.data ? buildStudioData(analytics.data.tables) : undefined), [analytics.data])
  const widgets = useMemo(() => buildWidgets(), [])
  const aiOn = health.data?.aiOn

  const selectPage = useCallback((id: string) => {
    setPage(id)
    const api = apiRef.current
    if (api) api.setState({ ...api.getState(), selectedPageId: id } as never)
  }, [])
  const setLookPersist = (l: LookMode) => {
    setLook(l)
    try {
      localStorage.setItem('rab-studio-look', l)
    } catch {
      /* private mode */
    }
  }

  const a = analytics.data
  return (
    <Container className="py-8 sm:py-10" wide>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Ops console · arbiter</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">Platform P&amp;L studio</h1>
          <p className="mt-1 max-w-2xl text-sm text-mute">
            Where every escrow dollar goes and what the platform keeps. Click a step in the waterfall to filter the page. Ask the analyst why net moved.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {a && a.simulated_jobs > 0 && <Chip tone="amber" mono>simulated history: {a.simulated_jobs} jobs</Chip>}
          {a && <Chip mono>{a.live_jobs} live</Chip>}
          <div role="group" aria-label="Pages" className="flex gap-1">
            {PAGES.map((p) => (
              <Button key={p.id} size="sm" variant={page === p.id ? 'primary' : 'ghost'} aria-pressed={page === p.id} onClick={() => selectPage(p.id)}>
                {p.title}
              </Button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setIncludeSimulated((v) => !v)} aria-pressed={includeSimulated} icon={<Bot className="size-4" aria-hidden />}>
            {includeSimulated ? 'Simulated: on' : 'Simulated: off'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLookPersist(look === 'ink' ? 'paper' : 'ink')} icon={look === 'ink' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}>
            {look === 'ink' ? 'Paper' : 'Ink'}
          </Button>
          <Button variant="ghost" size="sm" onClick={analytics.reload} icon={<RefreshCw className="size-4" aria-hidden />}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => setEditing((v) => !v)} icon={<MessageSquareText className="size-4" aria-hidden />} aria-pressed={editing}>
            {editing ? 'Back to view' : 'Ask the analyst'}
          </Button>
        </div>
      </div>

      <ErrorBox error={analytics.error} title="Could not load the analytics" onRetry={analytics.reload} className="mb-4" />
      {!data || aiOn === undefined ? (
        analytics.error ? null : <Skeleton className="h-[70vh]" />
      ) : (
        <div className={`ag-theme-mode rab-studio overflow-hidden rounded-xl border border-line`} data-ag-theme-mode={look} style={{ height: 'max(680px, calc(100vh - 210px))' }}>
          <AgStudioProvider licenseKey={LICENSE} modules={MODULES}>
            <AgStudio
              key={aiOn ? 'ai' : 'no-ai'}
              style={{ height: '100%' }}
              theme={rabStudioTheme}
              data={data}
              widgets={widgets as never}
              initialState={initialReport}
              mode={editing ? 'edit' : 'view'}
              panels={PANELS}
              ai={({ api }: { api: AgStudioApi }) => createAnalystHarness(api, { aiOn, getJobs: () => jobsRef.current })}
              aiToolDisplay={aiToolDisplay as never}
              onStateUpdated={notifyStudioState}
              onApiReady={(e: { api: AgStudioApi }) => {
                apiRef.current = e.api
              }}
            />
          </AgStudioProvider>
        </div>
      )}
      {!LICENSE && <p className="mt-2 font-mono text-[11px] text-mute">AG Studio is running without a licence key (VITE_AG_STUDIO_LICENSE), so it shows its evaluation watermark.</p>}
    </Container>
  )
}

export default function Studio() {
  const { session, loading } = useSession()
  useEffect(() => {
    document.title = 'Platform P&L studio · Rent-A-Bot'
  }, [])
  if (loading)
    return (
      <Container className="py-24">
        <Spinner label="Checking your session" />
      </Container>
    )
  const role = session?.user?.role
  if (role !== 'arbiter' && role !== 'owner') return <SignInPanel reason="The P&L studio is for the arbiter, or the owner persona on a demo server. Pick one to continue." />
  return <Dashboard />
}
