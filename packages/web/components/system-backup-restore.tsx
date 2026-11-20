'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useQuery } from '@tanstack/react-query'
import { Database } from 'lucide-react'
import { Spinner } from './spinner'

interface Record_ { at: string; ok: boolean; file: string | null; bytes: number | null; durationSeconds: number | null; error: string | null }
interface Status {
  configured: boolean
  state: 'ok' | 'stale' | 'failed' | 'unknown'
  maxAgeHours: number
  backup: Record_ | null
  verify: Record_ | null
}

const LABEL = { ok: 'Verified', stale: 'Verification is overdue', failed: 'Last verification failed', unknown: 'Never verified' }
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(getIntlLocale()) : 'never')

/**
 * Backups are taken by scripts/backup.sh on the host (a pg_dump of the live database cannot safely be started or restored
 * from inside the web process), so this tab shows the real state those scripts report instead of faking actions.
 */
export function SystemBackupRestore() {
  const { tr } = useI18n();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'backup-status'],
    queryFn: async () => {
      const res = await fetch('/rest/api/2/admin/backup-status', { credentials: 'include' })
      if (!res.ok) throw new Error(res.statusText)
      return (await res.json()) as Status
    },
  })
  const tone = data?.state === 'ok' ? 'bg-green-100 text-green-800' : data?.state === 'unknown' ? 'bg-[var(--surface-2)] text-[var(--text-secondary)]' : 'bg-red-100 text-red-800'

  return (
    <div className="veqsio-card space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
          <Database className="w-5 h-5 text-[var(--brand-500)]" />
        </div>
        <div>
          <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Backup & Restore')}</h2>
          <p className="text-body-sm text-[var(--text-secondary)]">{tr('Backups run on the server with scripts; this page shows their last reported result.')}</p>
        </div>
      </div>

      {isLoading && <Spinner />}
      {error && <p role="alert" className="text-sm text-[var(--error)]">{tr('Could not load the backup status.')}</p>}
      {data && (
        <div className="space-y-2 text-sm">
          <p><span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>{LABEL[data.state]}</span></p>
          {data.backup ? (
            <p>{tr('Last backup:')} <strong>{when(data.backup.at)}</strong>{data.backup.ok ? '' : ' (failed)'}{data.backup.bytes != null ? `, ${(data.backup.bytes / 1048576).toFixed(1)} MiB` : ''}{data.backup.file ? `, ${data.backup.file}` : ''}</p>
          ) : (
            <p className="text-[var(--text-secondary)]">{tr('No backup has been reported yet.')}</p>
          )}
          {data.verify && <p>{tr('Last restore test:')} <strong>{when(data.verify.at)}</strong>{data.verify.ok ? '' : ' (failed)'}. Expected at least every {data.maxAgeHours} h.</p>}
          {data.verify?.error && <p className="text-[var(--error)]">{data.verify.error}</p>}
        </div>
      )}

      <div className="text-sm text-[var(--text-secondary)] space-y-1">
        <p>{tr('Create a backup:')} <code>scripts/backup.sh</code>. Prove it restores: <code>scripts/restore-verify.sh</code>. Schedule both with cron.</p>
        <p>{tr('Restoring over a live database is done from the server, not from this page. See docs/backup-and-recovery.md.')}</p>
      </div>
    </div>
  )
}
