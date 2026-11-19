'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, Copy, ExternalLink, UserCheck } from 'lucide-react'
import { RichText } from './rich-text'
import { StatusBadge } from './status-badge'
import { PriorityBadge } from './priority-badge'
import { toast } from './toast'
import { useMyself, useUpdateIssue, type ApiIssue } from '@/hooks/use-issues'
import { useUndoableAction } from '@/hooks/use-undoable'
import { assigneeRestorePatch } from '@/lib/undo-helpers'

/** Plain-text-ish excerpt of a description (still Markdown / wiki markup; RichText renders it safely). */
export function excerpt(text: string | null | undefined, max = 480): string {
  const t = (text ?? '').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '))
  return (lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd() + ' …'
}

interface Props {
  issue: ApiIssue
  /** Focus the inline summary editor (F2 / e). */
  editing: boolean
  onStopEditing: () => void
  onClose: () => void
  id: string
}

/** Inline preview that expands under a row of the issue list. */
export function IssueListPreview({ issue, editing, onStopEditing, onClose, id }: Props) {
  const { data: myself } = useMyself()
  const update = useUpdateIssue()
  const undoableAction = useUndoableAction()
  const inputRef = useRef<HTMLInputElement>(null)
  const [summary, setSummary] = useState(issue.fields.summary)
  const [copied, setCopied] = useState(false)

  useEffect(() => { setSummary(issue.fields.summary) }, [issue.id, issue.fields.summary])
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])

  const save = () => {
    const next = summary.trim()
    if (!next || next === issue.fields.summary) { setSummary(issue.fields.summary); onStopEditing(); return }
    const previousSummary = issue.fields.summary
    update.mutate(
      { key: issue.key, fields: { summary: next } },
      { onSuccess: () => undoableAction({ message: `${issue.key} summary updated`, undo: () => update.mutateAsync({ key: issue.key, fields: { summary: previousSummary } }).then(() => undefined) }), onError: (e: any) => toast(e?.message || 'Failed to update', 'error') },
    )
    onStopEditing()
  }

  const assignToMe = () => {
    if (!myself) return
    const previous = issue.fields.assignee
    update.mutate(
      { key: issue.key, fields: { assignee: { id: myself.id } }, lookup: { users: [{ id: myself.id, displayName: myself.displayName || myself.name }] } },
      { onSuccess: () => undoableAction({
          message: `${issue.key} assigned to you`,
          undo: () => update.mutateAsync({ key: issue.key, fields: assigneeRestorePatch(previous), lookup: previous ? { users: [{ id: previous.id, displayName: previous.displayName }] } : undefined }).then(() => undefined),
        }), onError: (e: any) => toast(e?.message || 'Failed to assign', 'error') },
    )
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/issues/${issue.key}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast('Could not copy the link', 'error')
    }
  }

  const f = issue.fields
  const description = excerpt(f.description)

  return (
    <div id={id} role="region" aria-label={`Preview of ${issue.key}`} className="veqsio-fade-in px-4 py-3 border-b border-[var(--surface-3)] bg-[var(--surface-1)]" data-testid="issue-preview">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-caption text-[var(--text-tertiary)] mb-1">{issue.key} · {f.issuetype?.name}</div>
          {editing ? (
            <input
              ref={inputRef}
              aria-label={`Summary of ${issue.key}`}
              className="veqsio-input w-full"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); save() }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSummary(f.summary); onStopEditing() }
              }}
              onBlur={() => { setSummary(f.summary); onStopEditing() }}
            />
          ) : (
            <h3 className="text-heading-3 text-[var(--text-primary)]">{f.summary}</h3>
          )}
          <div className="mt-2 text-sm text-[var(--text-secondary)] max-h-40 overflow-y-auto">
            {description ? <RichText value={description} /> : <span className="text-[var(--text-tertiary)] italic">No description</span>}
          </div>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm flex-shrink-0 items-center">
          <dt className="text-caption text-[var(--text-tertiary)]">Status</dt>
          <dd>{f.status?.name ? <StatusBadge status={f.status.name} category={(f.status as any).category} /> : '—'}</dd>
          <dt className="text-caption text-[var(--text-tertiary)]">Priority</dt>
          <dd>{f.priority ? <PriorityBadge priority={f.priority.name} /> : '—'}</dd>
          <dt className="text-caption text-[var(--text-tertiary)]">Assignee</dt>
          <dd className="text-[var(--text-primary)]">{f.assignee?.displayName || 'Unassigned'}</dd>
          <dt className="text-caption text-[var(--text-tertiary)]">Reporter</dt>
          <dd className="text-[var(--text-secondary)]">{f.reporter?.displayName || '—'}</dd>
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <Link href={`/issues/${issue.key}`} className="veqsio-btn-primary text-xs flex items-center gap-1.5 px-3 py-1.5">
          <ExternalLink className="w-3.5 h-3.5" /> Open <kbd className="veqsio-kbd">↵</kbd>
        </Link>
        <button type="button" className="veqsio-btn-secondary text-xs flex items-center gap-1.5 px-3 py-1.5" onClick={assignToMe} disabled={!myself || f.assignee?.id === myself?.id}>
          <UserCheck className="w-3.5 h-3.5" /> Assign to me
        </button>
        <button type="button" className="veqsio-btn-secondary text-xs flex items-center gap-1.5 px-3 py-1.5" onClick={() => void copyLink()}>
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy link'}
        </button>
        <button type="button" className="veqsio-btn-ghost text-xs px-3 py-1.5" onClick={onClose}>
          Collapse <kbd className="veqsio-kbd">←</kbd>
        </button>
        <span className="text-caption text-[var(--text-tertiary)] ml-auto">Press <kbd className="veqsio-kbd">F2</kbd> to edit the summary</span>
      </div>
    </div>
  )
}
