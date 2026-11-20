'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { Pause, Play, Loader2, CheckCircle2, AlertCircle, Download } from 'lucide-react'
import { toast } from './toast'

export interface MigrationProgressData {
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

interface MigrationProgressProps {
  progress: MigrationProgressData | null | undefined
  onPause: (sessionId: number) => void
  onResume: (sessionId: number) => void
  onDownloadReport: (sessionId: number) => void
}

const statusConfig = {
  pending: { label: 'Pending', icon: Loader2, color: 'text-[var(--text-tertiary)]', bg: 'bg-[var(--surface-2)]' },
  analyzing: { label: 'Analyzing', icon: Loader2, color: 'text-[var(--info)]', bg: 'bg-[var(--brand-50)]' },
  running: { label: 'Running', icon: Loader2, color: 'text-[var(--brand-500)]', bg: 'bg-[var(--brand-50)]' },
  paused: { label: 'Paused', icon: Pause, color: 'text-[var(--warning)]', bg: 'bg-[var(--warning)]/10' },
  completed: { label: 'Completed', icon: CheckCircle2, color: 'text-[var(--success)]', bg: 'bg-[var(--success)]/10' },
  failed: { label: 'Failed', icon: AlertCircle, color: 'text-[var(--error)]', bg: 'bg-[var(--error)]/10' },
}

export function MigrationProgress({ progress, onPause, onResume, onDownloadReport }: MigrationProgressProps) {
  const { tr } = useI18n();

  const [logsOpen, setLogsOpen] = useState(false)

  if (!progress) {
    return (
      <div className="veqsio-card p-6 text-center">
        <p className="text-sm text-[var(--text-tertiary)]">{tr('No active migration session')}</p>
      </div>
    )
  }

  const config = statusConfig[progress.status]
  const Icon = config.icon
  const pct = progress.totalEntities > 0
    ? Math.round((progress.processedEntities / progress.totalEntities) * 100)
    : 0

  return (
    <div className="veqsio-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full ${config.bg} flex items-center justify-center`}>
            <Icon className={`w-5 h-5 ${config.color} ${progress.status === 'running' || progress.status === 'analyzing' ? 'animate-spin' : ''}`} />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">{config.label}</p>
            <p className="text-xs text-[var(--text-tertiary)] capitalize">{progress.phase}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {progress.status === 'running' && (
            <button
              onClick={() => onPause(progress.sessionId)}
              className="veqsio-btn-ghost flex items-center gap-1.5"
            >
              <Pause className="w-4 h-4" />
              <span>{tr('Pause')}</span>
            </button>
          )}
          {progress.status === 'paused' && (
            <button
              onClick={() => onResume(progress.sessionId)}
              className="veqsio-btn-primary flex items-center gap-1.5"
            >
              <Play className="w-4 h-4" />
              <span>{tr('Resume')}</span>
            </button>
          )}
          {(progress.status === 'completed' || progress.status === 'failed') && (
            <button
              onClick={() => onDownloadReport(progress.sessionId)}
              className="veqsio-btn-secondary flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" />
              <span>{tr('Report')}</span>
            </button>
          )}
        </div>
      </div>

      <div>
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-[var(--text-secondary)]">{progress.processedEntities.toLocaleString()} of {progress.totalEntities.toLocaleString()}</span>
          <span className="font-medium text-[var(--text-primary)]">{pct}%</span>
        </div>
        <div className="h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--brand-500)] transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {progress.errors.length > 0 && (
        <div>
          <button
            onClick={() => setLogsOpen(!logsOpen)}
            className="text-xs font-medium text-[var(--error)] hover:underline"
          >
            {logsOpen ? 'Hide' : 'Show'} {progress.errors.length} error{progress.errors.length !== 1 ? 's' : ''}
          </button>
          {logsOpen && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-[var(--error)]/5 border border-[var(--error)]/10 p-3 space-y-1">
              {progress.errors.map((err, i) => (
                <p key={i} className="text-xs text-[var(--error)] font-mono">{err}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
