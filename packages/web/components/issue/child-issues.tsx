'use client'


import { useI18n } from '@/hooks/use-i18n'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Avatar } from '@/components/avatar'
import { Skeleton } from '@/components/skeleton'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useCreateIssue, useIssueTypesMeta, useSubtasks } from '@/hooks/use-issues'
import type { ApiIssue } from '@/hooks/use-issues'
import { subtaskProgress } from '@/lib/issue-view'
import { IssueTypeIcon, StatusLozenge } from './primitives'

export interface ChildIssuesHandle {
  focusAdd: () => void
}

export const ChildIssues = forwardRef<ChildIssuesHandle, { issue: ApiIssue }>(function ChildIssues({ issue }, ref) {
  const { tr } = useI18n();

  const { data, isLoading } = useSubtasks(issue.key)
  const { data: issueTypes } = useIssueTypesMeta()
  const create = useCreateIssue()
  const [adding, setAdding] = useState(false)
  const [summary, setSummary] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const sectionRef = useRef<HTMLElement>(null)

  const children = data?.issues || []
  const progress = useMemo(() => subtaskProgress(children.map((c) => ({ category: c.fields.status?.category }))), [children])
  const subtaskType = issueTypes?.find((t) => t.subtask)

  useImperativeHandle(ref, () => ({
    focusAdd: () => {
      setAdding(true)
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => inputRef.current?.focus(), 0)
    },
  }))

  // Sub-tasks cannot have children of their own.
  if (issue.fields.issuetype?.subtask) return null

  const submit = async () => {
    const text = summary.trim()
    if (!text) return
    if (!subtaskType) {
      toast(tr('No sub-task issue type is configured'), 'error')
      return
    }
    try {
      await create.mutateAsync({
        fields: {
          project: { id: issue.fields.project.id },
          summary: text,
          issuetype: { id: Number(subtaskType.id) },
          parent: { id: issue.id },
        },
      })
      setSummary('')
      inputRef.current?.focus() // stay open for the next one
    } catch (err: any) {
      toast(err?.message || tr('Failed to create sub-task'), 'error')
    }
  }

  return (
    <section ref={sectionRef} aria-labelledby="issue-children-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="issue-children-heading" className="text-heading-3 text-[var(--text-primary)]">
          {tr('Sub-tasks')} {progress.total > 0 && <span className="text-[var(--text-tertiary)] font-normal">({progress.done}/{progress.total})</span>}
        </h2>
        <button
          type="button"
          onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 0) }}
          aria-label={tr('Add a sub-task')}
          title={tr('Add a sub-task')}
          className="p-1.5 rounded text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {progress.total > 0 && (
        <div className="flex items-center gap-3">
          <div
            className="flex h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.donePercent}
            aria-label={tr('Sub-task progress')}
          >
            <div className="bg-[var(--status-done)]" style={{ width: `${progress.donePercent}%` }} />
            <div className="bg-[var(--status-inprogress)]" style={{ width: `${progress.inProgressPercent}%` }} />
          </div>
          <span className="text-caption text-[var(--text-tertiary)] tabular-nums">{progress.donePercent}{tr('% Done')}</span>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : children.length === 0 && !adding ? (
        <p className="text-body-sm text-[var(--text-tertiary)]">
          {tr('No sub-tasks yet.')}{' '}
          <button type="button" onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 0) }} className="text-[var(--brand-500)] hover:underline">
            {tr('Add one')} </button>
        </p>
      ) : (
        <ul className="divide-y divide-[var(--surface-3)] border border-[var(--surface-3)] rounded-lg">
          {children.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] transition-colors">
              <IssueTypeIcon name={c.fields.issuetype?.name} />
              <Link href={`/issues/${c.key}`} className="font-mono text-body-sm text-[var(--brand-500)] hover:underline shrink-0">{c.key}</Link>
              <Link href={`/issues/${c.key}`} className="flex-1 min-w-0 truncate text-body-sm text-[var(--text-primary)] hover:underline">{c.fields.summary}</Link>
              {c.fields.assignee ? <Avatar name={c.fields.assignee.displayName} size="sm" /> : <span className="sr-only">{tr('Unassigned')}</span>}
              <StatusLozenge name={c.fields.status.name} category={c.fields.status.category} />
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <form
          onSubmit={(e) => { e.preventDefault(); void submit() }}
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor="child-summary" className="sr-only">{tr('Sub-task summary')}</label>
          <input
            id="child-summary"
            ref={inputRef}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); setSummary('') } }}
            placeholder={tr('What needs to be done?')}
            maxLength={500}
            className="veqsio-input flex-1 min-w-[12rem] text-sm"
          />
          <button type="submit" disabled={create.isPending || !summary.trim()} className="veqsio-btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
            {create.isPending && <Spinner size="sm" />} {tr('Create')} </button>
          <button type="button" onClick={() => { setAdding(false); setSummary('') }} className="veqsio-btn-secondary text-sm">{tr('Cancel')}</button>
        </form>
      )}
    </section>
  )
})
