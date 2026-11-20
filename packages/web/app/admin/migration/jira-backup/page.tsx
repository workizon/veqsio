'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Database,
  RefreshCw,
  BarChart3,
  ShieldAlert,
  Play,
  ChevronRight,
  CheckCircle2,
  HardDrive,
  Users,
  FolderKanban,
  ClipboardList,
  MessageSquare,
  Paperclip,
  Workflow,
  LayoutDashboard,
  Filter,
  Settings,
  Package,
  Flag,
} from 'lucide-react'
import { MigrationUploader } from '@/components/migration-uploader'
import { MigrationProgress } from '@/components/migration-progress'
import { MigrationConflicts } from '@/components/migration-conflicts'
import { toast } from '@/components/toast'
import { AppLayout } from '@/components/app-layout'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

interface BackupStats {
  users: number
  groups: number
  memberships: number
  projects: number
  issues: number
  comments: number
  attachments: number
  workflows: number
  workflowTransitions: number
  customFields: number
  customFieldValues: number
  issueLinks: number
  components: number
  versions: number
  filters: number
  dashboards: number
  permissionSchemes: number
  permissionEntries: number
  issueTypes: number
  statuses: number
  priorities: number
  resolutions: number
  labels: number
  issueLabels: number
  projectCategories: number
  projectRoles: number
  projectRoleActors: number
  boards: number
  sprints: number
  sprintIssues: number
  watchers: number
  votes: number
  issueComponents: number
  issueFixVersions: number
  issueAffectsVersions: number
}

interface ConflictItem {
  id: string
  type: string
  entityType: string
  sourceKey?: string
  message: string
  suggestedRename?: string
}

interface MigrationSession {
  id: number
  status: string
  backupPath: string
  totalEntities: number
  processedEntities: number
  errors: string[]
}

interface MigrationProgressData {
  sessionId: number
  status: 'pending' | 'analyzing' | 'running' | 'paused' | 'completed' | 'failed'
  phase: string
  totalEntities: number
  processedEntities: number
  currentEntityType: string
  errors: string[]
  conflictsResolved: number
  conflictsTotal: number
}

type Step = 'upload' | 'analyze' | 'conflicts' | 'run'

const statIcons: Record<string, React.ReactNode> = {
  users: <Users className="w-4 h-4" />,
  groups: <Users className="w-4 h-4" />,
  projects: <FolderKanban className="w-4 h-4" />,
  issues: <ClipboardList className="w-4 h-4" />,
  comments: <MessageSquare className="w-4 h-4" />,
  attachments: <Paperclip className="w-4 h-4" />,
  workflows: <Workflow className="w-4 h-4" />,
  dashboards: <LayoutDashboard className="w-4 h-4" />,
  filters: <Filter className="w-4 h-4" />,
  components: <Package className="w-4 h-4" />,
  versions: <Flag className="w-4 h-4" />,
  permissionSchemes: <Settings className="w-4 h-4" />,
}

function StatCard({ label, value }: { label: string; value: number }) {
  const icon = statIcons[label] || <HardDrive className="w-4 h-4" />
  return (
    <div className="veqsio-card flex items-center gap-3 p-4">
      <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center text-[var(--text-secondary)]">
        {icon}
      </div>
      <div>
        <p className="text-lg font-semibold text-[var(--text-primary)] leading-tight">{value.toLocaleString(getIntlLocale())}</p>
        <p className="text-xs text-[var(--text-tertiary)] capitalize">{label.replace(/([A-Z])/g, ' $1').trim()}</p>
      </div>
    </div>
  )
}

export default function MigrationPage() {
  const { tr } = useI18n();

  const queryClient = useQueryClient()

  const [step, setStep] = useState<Step>('upload')
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [stats, setStats] = useState<BackupStats | null>(null)
  const [conflicts, setConflicts] = useState<ConflictItem[]>([])
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [uploadPct, setUploadPct] = useState(0)

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      // chunked and resumable: one request cannot carry a big backup through the proxies in front of a cloud workspace (100 MB through Cloudflare on the Free and Pro plans)
      const fail = async (res: Response, fallback: string) => { const d = await res.json().catch(() => ({})); throw new Error(d.errorMessages?.[0] || fallback) }
      const init = await fetch(`${API_BASE}/rest/api/2/migration/upload/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ filename: file.name, size: file.size }) })
      if (!init.ok) await fail(init, 'Upload failed')
      const { uploadId, chunkSize } = await init.json() as { uploadId: string; chunkSize: number }
      let offset = 0
      while (offset < file.size) {
        const end = Math.min(offset + chunkSize, file.size)
        let attempt = 0, sent = false
        while (!sent) { // a chunk is retried with growing pauses; the server refuses a wrong offset and tells us where it is, so a retry can never duplicate data
          try {
            const res = await fetch(`${API_BASE}/rest/api/2/migration/upload/${uploadId}?offset=${offset}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(offset, end) })
            if (res.ok) { sent = true; break }
            if (res.status === 409) { const d = await res.json().catch(() => ({})); if (Number.isInteger(d.received)) { offset = d.received; break } }
            if (res.status < 500 && res.status !== 408 && res.status !== 429) await fail(res, 'Upload failed')
            throw new Error(`HTTP ${res.status}`)
          } catch (e) {
            if (++attempt > 5) throw new Error(tr('Upload interrupted at {mb} MB: {message}', { mb: Math.round(offset / 1048576), message: (e as Error).message }))
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
          }
        }
        if (sent) offset = end
        setUploadPct(Math.round((offset / file.size) * 100))
      }
      const done = await fetch(`${API_BASE}/rest/api/2/migration/upload/${uploadId}/complete`, { method: 'POST', credentials: 'include' })
      if (!done.ok) await fail(done, 'Upload failed')
      return done.json()
    },
    onSuccess: (data) => {
      setBackupPath(data.path)
      toast(tr('Backup uploaded successfully'), 'success')
      analyzeMutation.mutate(data.path)
    },
    onError: (err: Error) => {
      toast(err.message, 'error')
    },
  })

  const analyzeMutation = useMutation({
    mutationFn: async (path: string) => {
      const res = await fetch(`${API_BASE}/rest/api/2/migration/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
        credentials: 'include',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.errorMessages?.[0] || 'Analysis failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setStats(data.stats)
      setStep('analyze')
      dryRunMutation.mutate(backupPath!)
    },
    onError: (err: Error) => {
      toast(err.message, 'error')
    },
  })

  const dryRunMutation = useMutation({
    mutationFn: async (path: string) => {
      const res = await fetch(`${API_BASE}/rest/api/2/migration/dry-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
        credentials: 'include',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.errorMessages?.[0] || 'Dry-run failed')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setConflicts(data.conflicts || [])
      if (data.conflicts?.length > 0) {
        setStep('conflicts')
        const initial: Record<string, string> = {}
        data.conflicts.forEach((c: ConflictItem) => {
          initial[c.id] = 'skip'
        })
        setResolutions(initial)
      } else {
        setStep('run')
      }
    },
    onError: (err: Error) => {
      toast(err.message, 'error')
    },
  })

  const runMutation = useMutation({
    mutationFn: async ({ path, opts }: { path: string; opts: Record<string, unknown> }) => {
      const res = await fetch(`${API_BASE}/rest/api/2/migration/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, options: opts }),
        credentials: 'include',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.errorMessages?.[0] || 'Migration failed to start')
      }
      return res.json()
    },
    onSuccess: (data) => {
      setSessionId(data.sessionId)
      setStep('run')
      toast(tr('Migration started'), 'success')
      queryClient.invalidateQueries({ queryKey: ['migration', data.sessionId] })
    },
    onError: (err: Error) => {
      toast(err.message, 'error')
    },
  })

  const pauseMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API_BASE}/rest/api/2/migration/${id}/pause`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Pause failed')
      return res.json()
    },
    onSuccess: () => {
      toast(tr('Migration paused'), 'info')
      queryClient.invalidateQueries({ queryKey: ['migration', sessionId] })
    },
  })

  const resumeMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API_BASE}/rest/api/2/migration/${id}/resume`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Resume failed')
      return res.json()
    },
    onSuccess: () => {
      toast(tr('Migration resumed'), 'success')
      queryClient.invalidateQueries({ queryKey: ['migration', sessionId] })
    },
  })

  const { data: progressData } = useQuery<MigrationProgressData | null>({
    queryKey: ['migration', sessionId],
    queryFn: async () => {
      if (!sessionId) return null
      const res = await fetch(`${API_BASE}/rest/api/2/migration/${sessionId}/status`, {
        credentials: 'include',
      })
      if (!res.ok) return null
      const data = await res.json()
      return data.progress as MigrationProgressData
    },
    enabled: !!sessionId,
    refetchInterval: ((query: any) => {
      const data = query?.state?.data as MigrationProgressData | null | undefined
      if (!data) return 5000
      return data.status === 'running' || data.status === 'analyzing' ? 2000 : 5000
    }) as any,
  })

  const handleUpload = useCallback((file: File) => {
    uploadMutation.mutate(file)
  }, [uploadMutation])

  const handleContinue = useCallback(() => {
    if (!backupPath) return
    const conflictResolution: Record<string, string> = {}
    Object.entries(resolutions).forEach(([k, v]) => {
      if (v !== 'skip') conflictResolution[k] = v
    })
    runMutation.mutate({ path: backupPath, opts: { conflictResolution } })
  }, [backupPath, resolutions, runMutation])

  const handleDownloadReport = useCallback(async (id: number) => {
    try {
      const res = await fetch(`${API_BASE}/rest/api/2/migration/${id}/logs`, {
        credentials: 'include',
      })
      const data = await res.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `migration-report-${id}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast(tr('Failed to download report'), 'error')
    }
  }, [])

  const totalCount = stats
    ? Object.values(stats).reduce((a, b) => a + b, 0)
    : 0

  const statEntries = stats
    ? Object.entries(stats).filter(([, v]) => v > 0)
    : []

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <a href="/admin/migration" className="text-sm text-[var(--brand-500)] hover:underline">{tr('← Import from other tools')}</a>
            <h1 className="text-heading-1 text-[var(--text-primary)]">{tr('Import a Jira backup file')}</h1>
            <p className="text-body-sm text-[var(--text-secondary)] mt-1">
              {tr('Import a Jira Data Center XML backup into Veqsio, or')}{' '}
              <a href="/admin/migration/jira" className="text-[var(--brand-500)] hover:underline">
                {tr('import directly from a live Jira (Cloud or Server/DC) over REST')} </a>
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
            <Database className="w-4 h-4" />
            <span>{tr('Max 2GB')}</span>
          </div>
        </div>

        {/* Stepper */}
        <div className="flex flex-wrap items-center gap-2">
          {(['upload', 'analyze', 'conflicts', 'run'] as Step[]).map((s, idx) => {
            const steps: Step[] = ['upload', 'analyze', 'conflicts', 'run']
            const currentIdx = steps.indexOf(step)
            const isActive = s === step
            const isDone = currentIdx > idx
            return (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-[var(--brand-500)] text-white'
                      : isDone
                      ? 'bg-[var(--success)]/10 text-[var(--success)]'
                      : 'bg-[var(--surface-2)] text-[var(--text-tertiary)]'
                  }`}
                  >
                  {isDone ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <span className="w-3.5 h-3.5 flex items-center justify-center text-[10px]">{idx + 1}</span>
                  )}
                  <span className="capitalize">{s}</span>
                </div>
                {idx < steps.length - 1 && <ChevronRight className="w-4 h-4 text-[var(--surface-3)]" />}
              </div>
            )
          })}
        </div>

        {/* Upload Step */}
        {step === 'upload' && (
          <div className="space-y-6">
            <MigrationUploader
              onUpload={handleUpload}
              isUploading={uploadMutation.isPending}
            />

            {uploadMutation.isPending && (
              <div className="flex items-center justify-center gap-2 text-sm text-[var(--text-secondary)]">
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>{tr('Uploading backup...')} {uploadPct}%</span>
              </div>
            )}

            {analyzeMutation.isPending && (
              <div className="flex items-center justify-center gap-2 text-sm text-[var(--text-secondary)]">
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>{tr('Analyzing backup contents...')}</span>
              </div>
            )}
          </div>
        )}

        {/* Analyze Step */}
        {(step === 'analyze' || step === 'conflicts' || step === 'run') && stats && (
          <>
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                <h2 className="text-heading-2 text-[var(--text-primary)] flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-[var(--brand-500)]" />
                  {tr('Analysis Results')} </h2>
                <span className="text-sm text-[var(--text-tertiary)]">{totalCount.toLocaleString(getIntlLocale())} {tr('total entities')}</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {statEntries.map(([key, value]) => (
                  <StatCard key={key} label={key} value={value} />
                ))}
              </div>
            </div>

            {step === 'conflicts' && conflicts.length > 0 && (
              <MigrationConflicts
                conflicts={conflicts}
                onResolve={setResolutions}
                onContinue={handleContinue}
              />
            )}

            {step === 'run' && !sessionId && (
              <div className="veqsio-card p-6 flex flex-col items-center gap-4">
                <ShieldAlert className="w-10 h-10 text-[var(--warning)]" />
                <div className="text-center">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{tr('Ready to migrate')}</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-1">
                    {conflicts.length > 0
                      ? tr(conflicts.length === 1 ? '{n} conflict will be skipped.' : '{n} conflicts will be skipped.', { n: conflicts.length })
                      : tr('No conflicts detected.')}
                  </p>
                </div>
                <button
                  onClick={handleContinue}
                  disabled={runMutation.isPending}
                  className="veqsio-btn-primary flex items-center gap-2"
                >
                  <Play className="w-4 h-4" />
                  <span>{runMutation.isPending ? 'Starting...' : 'Start Migration'}</span>
                </button>
              </div>
            )}
          </>
        )}

        {/* Run Step */}
        {sessionId && (
          <MigrationProgress
            progress={progressData ?? null}
            onPause={(id) => pauseMutation.mutate(id)}
            onResume={(id) => resumeMutation.mutate(id)}
            onDownloadReport={handleDownloadReport}
          />
        )}

        {step === 'run' && progressData?.status === 'completed' && (
          <div className="veqsio-card p-6 text-center space-y-3">
            <CheckCircle2 className="w-10 h-10 text-[var(--success)] mx-auto" />
            <p className="text-sm font-medium text-[var(--text-primary)]">{tr('Migration completed successfully!')}</p>
            <div className="flex justify-center gap-2">
              <button
                onClick={() => {
                  setStep('upload')
                  setBackupPath(null)
                  setStats(null)
                  setConflicts([])
                  setSessionId(null)
                  setResolutions({})
                }}
                className="veqsio-btn-secondary"
              >
                {tr('Migrate Another Backup')} </button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
