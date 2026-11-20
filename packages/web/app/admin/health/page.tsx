'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, DatabaseBackup, Info, OctagonAlert, RefreshCw, Timer } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'

type Severity = 'ok' | 'info' | 'warning' | 'critical'
interface Check { id: string; severity: Severity; title: string; detail: string; count: number; items: string[]; fix?: { label: string; href: string } }
interface Result { generatedAt: string; status: Severity; counts: Record<Severity, number>; checks: Check[] }

const ORDER: Severity[] = ['critical', 'warning', 'info', 'ok']
const STYLE: Record<Severity, { icon: typeof Info; box: string; label: string }> = {
  critical: { icon: OctagonAlert, box: 'border-red-300 bg-red-50', label: 'Critical' },
  warning: { icon: AlertTriangle, box: 'border-amber-300 bg-amber-50', label: 'Warning' },
  info: { icon: Info, box: 'border-[var(--surface-3)] bg-[var(--surface-1)]', label: 'Suggestion' },
  ok: { icon: CheckCircle2, box: 'border-green-200 bg-green-50', label: 'OK' },
}

type JobHealth = 'ok' | 'failing' | 'stale' | 'never'
interface JobRow { job: string; health: JobHealth; everyMs: number; node?: string; lastRunAt?: string; lastSuccessAt?: string | null; lastFailureAt?: string | null; lastDurationMs?: number; lastResult?: string; lastError?: string | null; runs?: number; failures?: number }
interface JobsResult { generatedAt: string; node: string; role: string; jobs: JobRow[] }
interface BackupRecord { at: string; ok: boolean; file: string | null; bytes: number | null; durationSeconds: number | null; error: string | null }
interface BackupResult {
  configured: boolean; state: 'ok' | 'stale' | 'failed' | 'unknown'; maxAgeHours: number
  backup: BackupRecord | null
  verify: (BackupRecord & { migrations: { applied: number; expected: number } | null; rowCounts: Record<string, number>; checks: { name: string; ok: boolean }[] }) | null
}

const JOB_STYLE: Record<JobHealth, { label: string; cls: string }> = {
  ok: { label: 'Healthy', cls: 'bg-green-100 text-green-800' },
  failing: { label: 'Failing', cls: 'bg-red-100 text-red-800' },
  stale: { label: 'No recent run', cls: 'bg-amber-100 text-amber-800' },
  never: { label: 'No heartbeat yet', cls: 'bg-[var(--surface-2)] text-[var(--text-secondary)]' },
}
const every = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`)
const when = (iso: string | null | undefined, never: string) => (iso ? new Date(iso).toLocaleString() : never)

function JobsCard() {
  const { tr } = useI18n();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'jobs'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await fetch('/rest/api/2/admin/jobs', { credentials: 'include' })
      if (!res.ok) throw new Error(res.statusText)
      return (await res.json()) as JobsResult
    },
  })
  return (
    <section className="veqsio-card p-4 space-y-3" aria-labelledby="jobs-h">
      <h2 id="jobs-h" className="text-heading-3 flex items-center gap-2"><Timer className="w-4 h-4" aria-hidden /> {tr('Background jobs')}</h2>
      {isLoading && <Spinner />}
      {error && <p role="alert" className="text-sm text-[var(--error)]">{tr('Could not load job heartbeats.')}</p>}
      {data && data.jobs.length === 0 && (
        <p className="text-sm text-[var(--text-secondary)]">{tr('No job has reported yet. Jobs report after their first run (node role:')} {data.role}).</p>
      )}
      {data && data.jobs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{tr('Heartbeat of each background job')}</caption>
            <thead><tr className="text-left text-[var(--text-secondary)]">
              <th scope="col" className="py-1 pr-3">{tr('Job')}</th><th scope="col" className="pr-3">{tr('State')}</th><th scope="col" className="pr-3">{tr('Every')}</th>
              <th scope="col" className="pr-3">{tr('Last run')}</th><th scope="col" className="pr-3">{tr('Last success')}</th><th scope="col" className="pr-3">{tr('Failures')}</th><th scope="col">{tr('Last error')}</th>
            </tr></thead>
            <tbody>
              {data.jobs.map((j) => (
                <tr key={j.job} className="border-t border-[var(--surface-3)] align-top">
                  <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">{j.job}</th>
                  <td className="pr-3"><span className={`rounded px-1.5 py-0.5 text-xs ${JOB_STYLE[j.health].cls}`}>{tr(JOB_STYLE[j.health].label)}</span></td>
                  <td className="pr-3">{j.everyMs ? every(j.everyMs) : '-'}</td>
                  <td className="pr-3">{when(j.lastRunAt, tr('never'))}</td>
                  <td className="pr-3">{when(j.lastSuccessAt, tr('never'))}</td>
                  <td className="pr-3">{j.failures ?? 0}</td>
                  <td className="break-words max-w-xs">{j.lastError ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-[var(--text-tertiary)]">{tr('Heartbeats are shared through Redis, so jobs running on another node show up here too. Prometheus metrics: see docs/observability.md.')}</p>
    </section>
  )
}

function BackupCard() {
  const { tr } = useI18n();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'backup-status'],
    queryFn: async () => {
      const res = await fetch('/rest/api/2/admin/backup-status', { credentials: 'include' })
      if (!res.ok) throw new Error(res.statusText)
      return (await res.json()) as BackupResult
    },
  })
  const tone = data?.state === 'ok' ? 'bg-green-100 text-green-800' : data?.state === 'unknown' ? 'bg-[var(--surface-2)] text-[var(--text-secondary)]' : 'bg-red-100 text-red-800'
  const label = { ok: 'Verified', stale: 'Verification is overdue', failed: 'Last verification failed', unknown: 'Never verified' }
  return (
    <section className="veqsio-card p-4 space-y-3" aria-labelledby="backup-h">
      <h2 id="backup-h" className="text-heading-3 flex items-center gap-2"><DatabaseBackup className="w-4 h-4" aria-hidden /> {tr('Last verified backup')}</h2>
      {isLoading && <Spinner />}
      {error && <p role="alert" className="text-sm text-[var(--error)]">{tr('Could not load the backup status.')}</p>}
      {data && (
        <>
          <p><span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>{tr(label[data.state])}</span></p>
          {!data.configured && (
            <p className="text-sm text-[var(--text-secondary)]">{tr('No status file found. Run')} <code>scripts/backup.sh</code> {tr('and')} <code>scripts/restore-verify.sh</code> {tr('on a schedule and make their')} <code>last-backup.json</code> / <code>last-verify.json</code> {tr('readable by the API (BACKUP_STATUS_DIR). See docs/backup-and-recovery.md.')}</p>
          )}
          {data.backup && (
            <p className="text-sm">{tr('Last backup:')} <strong>{when(data.backup.at, tr('never'))}</strong>{data.backup.ok ? '' : ' ' + tr('(failed)')}{data.backup.bytes != null ? `, ${(data.backup.bytes / 1048576).toFixed(1)} MiB` : ''}{data.backup.file ? `, ${data.backup.file}` : ''}</p>
          )}
          {data.verify && (
            <div className="text-sm space-y-1">
              <p>{tr('Last restore verification:')} <strong>{when(data.verify.at, tr('never'))}</strong>{data.verify.durationSeconds != null ? ` (${Math.round(data.verify.durationSeconds)} s)` : ''}{tr('. Expected at least every')} {data.maxAgeHours} h.</p>
              {data.verify.error && <p className="text-[var(--error)]">{data.verify.error}</p>}
              {data.verify.migrations && <p>{tr('Schema:')} {tr('{applied} of {expected}', { applied: data.verify.migrations.applied, expected: data.verify.migrations.expected })} {tr('migrations in the restored copy.')}</p>}
              {Object.keys(data.verify.rowCounts).length > 0 && (
                <p className="font-mono text-xs break-words">{Object.entries(data.verify.rowCounts).map(([k, n]) => `${k}=${n}`).join('  ')}</p>
              )}
              {data.verify.checks.length > 0 && (
                <ul className="flex flex-wrap gap-2">{data.verify.checks.map((c) => (
                  <li key={c.name} className={`rounded px-1.5 py-0.5 text-xs ${c.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}><span className="sr-only">{c.ok ? tr('Passed:') : tr('Failed:')} </span>{c.name}</li>
                ))}</ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default function HealthCheckPage() {
  const { tr } = useI18n();

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'health-check'],
    queryFn: async () => {
      const res = await fetch('/rest/api/2/admin/health-check', { credentials: 'include' })
      if (!res.ok) throw new Error(res.status === 403 ? tr('System administrator rights are required') : res.statusText)
      return (await res.json()) as Result
    },
  })

  const sorted = data ? [...data.checks].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity)) : []

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title={tr('Configuration health')} description={tr('Finds misconfiguration before your users run into it.')}
          actions={<><button className="veqsio-btn-secondary flex items-center gap-2" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> {tr('Re-check')} </button></>} />

        {isLoading && <Spinner />}
        {error && <p role="alert" className="text-[var(--error)]">{(error as Error).message}</p>}

        {data && (
          <>
            <div className="veqsio-card p-4 flex flex-wrap gap-4 text-sm" aria-live="polite">
              {(['critical', 'warning', 'info', 'ok'] as Severity[]).map((s) => (
                <span key={s}><strong>{data.counts[s]}</strong> {tr(STYLE[s].label).toLowerCase()}</span>
              ))}
            </div>
            <ul className="space-y-3">
              {sorted.map((c) => {
                const S = STYLE[c.severity]
                const Icon = S.icon
                return (
                  <li key={c.id} className={`rounded border p-4 ${S.box}`}>
                    <div className="flex items-start gap-3">
                      <Icon className="w-5 h-5 mt-0.5 shrink-0" aria-hidden />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium"><span className="sr-only">{tr(S.label)}: </span>{c.title}{c.count > 0 && <span className="ml-2 text-sm font-normal">({c.count})</span>}</div>
                        <p className="text-sm text-[var(--text-secondary)]">{c.detail}</p>
                        {c.items.length > 0 && <p className="text-sm mt-1 font-mono break-words">{c.items.join(', ')}{c.count > c.items.length ? ', …' : ''}</p>}
                        {c.fix && c.severity !== 'ok' && <Link href={c.fix.href} className="text-sm text-[var(--brand-500)] hover:underline">{tr(c.fix.label)} →</Link>}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="text-xs text-[var(--text-tertiary)]">{tr('Checked')} {new Date(data.generatedAt).toLocaleString()}</p>
          </>
        )}

        <h2 className="text-heading-2 pt-2">{tr('Operations')}</h2>
        <JobsCard />
        <BackupCard />
      </div>
    </AppLayout>
  )
}
