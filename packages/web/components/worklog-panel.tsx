'use client'

import { useState } from 'react'
import {
  useIssueWorklogs,
  useCreateWorklog,
  useUpdateWorklog,
  useDeleteWorklog,
  parseDuration,
  formatDuration,
} from '@/hooks/use-worklogs'
import { useIssue } from '@/hooks/use-issues'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import { Modal } from './modal'
import { toast } from './toast'
import {
  Clock,
  Timer,
  Plus,
  Edit2,
  Trash2,
  X,
  Check,
  Calendar,
} from 'lucide-react'
import { confirmDialog } from '@/components/dialogs'

export function WorklogForm({
  issueKey,
  issueId,
  existing,
  onClose,
}: {
  issueKey: string
  issueId: number
  existing?: {
    id: number
    timeSpentSeconds: number
    comment?: string
    started?: string
  }
  onClose: () => void
}) {
  const [timeInput, setTimeInput] = useState(
    existing ? formatDuration(existing.timeSpentSeconds) : ''
  )
  const [comment, setComment] = useState(existing?.comment || '')
  const [started, setStarted] = useState(
    existing?.started
      ? new Date(existing.started).toISOString().slice(0, 16)
      : new Date().toISOString().slice(0, 16)
  )

  const create = useCreateWorklog()
  const update = useUpdateWorklog()
  const isPending = create.isPending || update.isPending

  const handleSubmit = () => {
    const seconds = parseDuration(timeInput)
    if (!seconds) {
      toast('Invalid time format. Use e.g. 2h 30m or 1d', 'error')
      return
    }

    if (existing) {
      update.mutate(
        {
          id: existing.id,
          issueKey,
          data: {
            timeSpentSeconds: seconds,
            description: comment || undefined,
            started: new Date(started).toISOString(),
          },
        },
        {
          onSuccess: () => {
            toast('Worklog updated', 'success')
            onClose()
          },
          onError: (err) => toast(err.message, 'error'),
        }
      )
    } else {
      create.mutate(
        {
          issueKey,
          data: {
            issueId,
            issueKey,
            timeSpentSeconds: seconds,
            description: comment || undefined,
            started: new Date(started).toISOString(),
          },
        },
        {
          onSuccess: () => {
            toast('Worklog logged', 'success')
            onClose()
          },
          onError: (err) => toast(err.message, 'error'),
        }
      )
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-body-sm font-medium text-[var(--text-primary)]">
          Time Spent
        </label>
        <input
          type="text"
          value={timeInput}
          onChange={(e) => setTimeInput(e.target.value)}
          placeholder="e.g. 2h 30m, 1d, 3w"
          className="veqsio-input w-full mt-1"
        />
        <p className="text-caption text-[var(--text-tertiary)] mt-1">
          Use w (weeks), d (days), h (hours), m (minutes). Example: 2h 30m
        </p>
      </div>

      <div>
        <label className="text-body-sm font-medium text-[var(--text-primary)]">
          Date Started
        </label>
        <input
          type="datetime-local"
          value={started}
          onChange={(e) => setStarted(e.target.value)}
          className="veqsio-input w-full mt-1"
        />
      </div>

      <div>
        <label className="text-body-sm font-medium text-[var(--text-primary)]">
          Description (optional)
        </label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What did you work on?"
          className="veqsio-input w-full mt-1 min-h-[80px] resize-y"
        />
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="veqsio-btn-secondary">
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={isPending}
          className="veqsio-btn-primary disabled:opacity-50 flex items-center gap-2"
        >
          {isPending ? <Spinner size="sm" /> : <Check className="w-4 h-4" />}
          {existing ? 'Update' : 'Log Work'}
        </button>
      </div>
    </div>
  )
}

export function WorklogPanel({ issueKey }: { issueKey: string }) {
  const { data, isLoading } = useIssueWorklogs(issueKey)
  const { data: issue } = useIssue(issueKey)
  const deleteWorklog = useDeleteWorklog()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<{
    id: number
    timeSpentSeconds: number
    comment?: string
    started?: string
  } | null>(null)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  const worklogs = data?.worklogs || []
  const totalTime = data?.totalTimeSpentSeconds || 0

  const handleDelete = async (id: number) => {
    if (!(await confirmDialog('Delete this worklog?'))) return
    deleteWorklog.mutate(
      { id, issueKey },
      {
        onSuccess: () => toast('Worklog deleted', 'success'),
        onError: (err) => toast(err.message, 'error'),
      }
    )
  }

  return (
    <div className="space-y-4">
      {/* Summary card */}
      <div className="veqsio-card flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
            <Timer className="w-5 h-5 text-[var(--brand-500)]" />
          </div>
          <div>
            <p className="text-caption text-[var(--text-tertiary)]">Total time spent</p>
            <p className="text-display text-[var(--text-primary)]">
              {formatDuration(totalTime)}
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            setEditing(null)
            setModalOpen(true)
          }}
          className="veqsio-btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Log work
        </button>
      </div>

      {/* Worklog list */}
      {worklogs.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No work logged"
          description="Log time spent on this issue to track progress and effort."
        />
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
          {worklogs.map((wl) => (
            <div
              key={wl.id}
              className="px-4 py-3 hover:bg-[var(--surface-1)] transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-body-sm font-medium text-[var(--text-primary)]">
                      {wl.author.displayName || 'Unknown'}
                    </span>
                    <span className="text-caption text-[var(--text-tertiary)]">
                      logged {wl.timeSpent}
                    </span>
                  </div>
                  {wl.comment && (
                    <p className="text-body-sm text-[var(--text-secondary)] mt-1">
                      {wl.comment}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-1 text-caption text-[var(--text-tertiary)]">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {wl.started
                        ? new Date(wl.started).toLocaleDateString()
                        : '-'}
                    </span>
                    <span>{formatDuration(wl.timeSpentSeconds)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => {
                      setEditing({
                        id: wl.id,
                        timeSpentSeconds: wl.timeSpentSeconds,
                        comment: wl.comment,
                        started: wl.started,
                      })
                      setModalOpen(true)
                    }}
                    className="p-1.5 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)]"
                    title="Edit"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(wl.id)}
                    className="p-1.5 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--error)]"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit Worklog' : 'Log Work'}
        size="md"
      >
        <WorklogForm
          issueKey={issueKey}
          issueId={issue?.id || 0}
          existing={editing || undefined}
          onClose={() => setModalOpen(false)}
        />
      </Modal>
    </div>
  )
}
