'use client'


import { useI18n } from '@/hooks/use-i18n'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Flag, Eye, EyeOff, GitBranch, Link2, MoreHorizontal, Paperclip, Share2, ThumbsUp, Trash2, Clapperboard, Move, Download, Sparkles } from 'lucide-react'
import { Breadcrumb } from '@/components/breadcrumb'
import { toast } from '@/components/toast'
import { useTerm } from '@/hooks/use-term'
import { useUpdateIssue, useIssueWatchers, useToggleWatch, useIssueVotes, useToggleVote } from '@/hooks/use-issues'
import type { ApiIssue, CommentsResponse } from '@/hooks/use-issues'
import { buildIssuePrompt, promptComments, promptIssueFromApi, suggestBranchName } from '@/lib/issue-prompt'
import { IssueTypeIcon, Popover } from './primitives'
import { StatusButton, type StatusButtonHandle } from './status-transition'

export interface IssueHeaderActions {
  attach: () => void
  addSubtask: () => void
  addLink: () => void
  clone: () => void
  move: () => void
  remove: () => void
}

export interface IssueHeaderHandle {
  openStatus: () => void
}

/** Click-to-edit title: Enter saves, Escape cancels, blur saves. */
export function InlineSummary({ issueKey, value }: { issueKey: string; value: string }) {
  const { tr } = useI18n();

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const cancelled = useRef(false)
  const update = useUpdateIssue()

  const save = async () => {
    if (cancelled.current) return
    const next = draft.trim()
    setEditing(false)
    if (!next || next === value) return
    try {
      await update.mutateAsync({ key: issueKey, fields: { summary: next } })
    } catch (err: any) {
      toast(err?.message || tr('Failed to update summary'), 'error')
    }
  }

  if (editing) {
    return (
      <div>
        <label htmlFor="issue-summary-input" className="sr-only">{tr('Summary')}</label>
        <input
          id="issue-summary-input"
          autoFocus
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void save() }
            if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setEditing(false) }
          }}
          onBlur={() => void save()}
          className="veqsio-input w-full text-heading-1 font-semibold"
        />
        <p className="text-caption text-[var(--text-tertiary)] mt-1">{tr('Enter to save, Esc to cancel')}</p>
      </div>
    )
  }
  return (
    <h1 className="text-heading-1 break-words">
      <button
        type="button"
        onClick={() => { cancelled.current = false; setDraft(value); setEditing(true) }}
        title={tr('Click to edit the summary')}
        className="w-full text-left rounded-md px-2 py-1 -mx-2 hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] transition-colors text-[var(--text-primary)]"
      >
        {value}
      </button>
    </h1>
  )
}

export const IssueHeader = forwardRef<IssueHeaderHandle, { issue: ApiIssue; actions: IssueHeaderActions; parentHref?: boolean }>(
  function IssueHeader({ issue, actions }, ref) {
  const { tr } = useI18n();

    const { fields } = issue
    const statusRef = useRef<StatusButtonHandle>(null)
    const [copied, setCopied] = useState(false)
    const [moreOpen, setMoreOpen] = useState(false)
    const { data: watchers } = useIssueWatchers(issue.key)
    const { data: votes } = useIssueVotes(issue.key)
    const toggleWatch = useToggleWatch()
    const toggleVote = useToggleVote()
    const updateIssue = useUpdateIssue()
    const flagged = fields.flagged === true
    const toggleFlag = () => updateIssue.mutate(
      { key: issue.key, fields: { flagged: !flagged } },
      { onSuccess: () => toast(flagged ? tr('Flag removed') : tr('Flagged as an impediment'), 'success'), onError: (e: any) => toast(e?.message || tr('Could not change the flag'), 'error') },
    )
    const { t } = useTerm()
    const qc = useQueryClient()
    useImperativeHandle(ref, () => ({ openStatus: () => statusRef.current?.open() }), [])

    const projectKey = fields.project?.key || issue.key.split('-')[0]
    const crumbs = [
      { label: fields.project?.name || projectKey, href: `/projects/${encodeURIComponent(projectKey)}` },
      ...(fields.parent?.key ? [{ label: fields.parent.key, href: `/issues/${fields.parent.key}` }] : []),
      { label: issue.key },
    ]

    const copy = (text: string, msg: string) => {
      navigator.clipboard?.writeText(text).then(() => toast(msg, 'success'), () => toast(tr('Copy failed'), 'error'))
    }

    /** Markdown prompt for a coding assistant: issue, recent comments, branch name, untrusted-text note. */
    const copyAsPrompt = async () => {
      let comments: CommentsResponse['comments'] = []
      try {
        const res = await qc.fetchQuery({
          queryKey: ['issue', issue.key, 'comments'],
          staleTime: 10_000,
          queryFn: async () => {
            const r = await fetch(`/rest/api/2/issue/${encodeURIComponent(issue.key)}/comment`, { credentials: 'include' })
            if (!r.ok) throw new Error('comments unavailable')
            return (await r.json()) as CommentsResponse
          },
        })
        comments = res.comments
      } catch { /* the prompt is still useful without comments */ }
      copy(buildIssuePrompt(promptIssueFromApi(issue, window.location.origin), promptComments(comments)), tr('Prompt copied to clipboard'))
    }

    const watching = !!watchers?.isWatching
    const menuItem = 'w-full flex items-center gap-2 px-3 py-2 text-left text-body-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none'

    return (
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <IssueTypeIcon name={fields.issuetype?.name} />
          <Breadcrumb items={crumbs} />
          <button
            type="button"
            onClick={() => {
              copy(issue.key, t('Issue key copied'))
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            aria-label={tr('Copy issue key')}
            className="p-1 rounded text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>

        <InlineSummary issueKey={issue.key} value={fields.summary} />

        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap" role="toolbar" aria-label={tr('Issue actions')}>
          <button type="button" onClick={actions.attach} className="veqsio-btn-secondary flex items-center gap-1.5 text-sm">
            <Paperclip className="w-4 h-4" aria-hidden="true" /> {tr('Attach')} </button>
          {!fields.issuetype?.subtask && (
            <button type="button" onClick={actions.addSubtask} className="veqsio-btn-secondary flex items-center gap-1.5 text-sm">
              <GitBranch className="w-4 h-4" aria-hidden="true" /> {tr('Create sub-task')} </button>
          )}
          <button type="button" onClick={actions.addLink} className="veqsio-btn-secondary flex items-center gap-1.5 text-sm">
            <Link2 className="w-4 h-4" aria-hidden="true" /> {tr('Link issue')} </button>
          <button
            type="button" onClick={toggleFlag} aria-pressed={flagged} aria-keyshortcuts="f"
            title={flagged ? tr('Remove the impediment flag (F)') : tr('Flag as an impediment (F)')}
            className={`veqsio-btn-secondary flex items-center gap-1.5 text-sm ${flagged ? '!border-[var(--warning)] !text-[var(--warning)]' : ''}`}
          >
            <Flag className="w-4 h-4" aria-hidden="true" /> {flagged ? tr('Flagged') : tr('Flag')}
          </button>
          <StatusButton ref={statusRef} issueKey={issue.key} status={{ name: fields.status.name, category: fields.status.category }} />
          <Popover
            open={moreOpen}
            onOpenChange={setMoreOpen}
            label={tr('More actions')}
            haspopup="menu"
            panelClassName="min-w-[13rem] py-1"
            trigger={(p) => (
              <button type="button" {...p} aria-label={tr('More actions')} className="veqsio-btn-secondary px-2.5">
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          >
            <button role="menuitem" className={menuItem} onClick={() => { setMoreOpen(false); actions.clone() }}><Clapperboard className="w-4 h-4" aria-hidden="true" /> {tr('Clone')}</button>
            <button role="menuitem" className={menuItem} onClick={() => { setMoreOpen(false); actions.move() }}><Move className="w-4 h-4" aria-hidden="true" /> {tr('Move')}</button>
            <button
              role="menuitem"
              className={menuItem}
              onClick={() => { setMoreOpen(false); toggleWatch.mutate({ key: issue.key, watching: !watching }) }}
            >
              {watching ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
              {watching ? tr('Stop watching') : tr('Watch')}
            </button>
            <button
              role="menuitem"
              className={menuItem}
              onClick={() => {
                setMoreOpen(false)
                copy(suggestBranchName(issue.key, fields.summary || ''), tr('Branch name copied'))
              }}
            ><GitBranch className="w-4 h-4" aria-hidden="true" /> {tr('Copy branch name')}</button>
            <button role="menuitem" className={menuItem} onClick={() => { setMoreOpen(false); void copyAsPrompt() }}><Sparkles className="w-4 h-4" aria-hidden="true" /> {tr('Copy as prompt')}</button>
            <button role="menuitem" className={menuItem} onClick={() => { setMoreOpen(false); copy(window.location.href, tr('Link copied to clipboard')) }}><Share2 className="w-4 h-4" aria-hidden="true" /> {tr('Share (copy link)')}</button>
            <button
              role="menuitem"
              className={menuItem}
              onClick={() => {
                setMoreOpen(false)
                const blob = new Blob([JSON.stringify({ ...issue.fields, key: issue.key }, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `${issue.key}.json`
                a.click()
                URL.revokeObjectURL(url)
              }}
            >
              <Download className="w-4 h-4" aria-hidden="true" /> {tr('Export JSON')} </button>
            <div className="border-t border-[var(--surface-3)] my-1" />
            <button role="menuitem" className={`${menuItem} !text-[var(--error)]`} onClick={() => { setMoreOpen(false); actions.remove() }}><Trash2 className="w-4 h-4" aria-hidden="true" /> {tr('Delete')}</button>
          </Popover>

          <div className="flex items-center gap-1 sm:ml-auto">
            <button
              type="button"
              onClick={() => toggleVote.mutate({ key: issue.key, voting: !votes?.hasVoted })}
              disabled={toggleVote.isPending}
              aria-pressed={!!votes?.hasVoted}
              title={votes?.hasVoted ? tr('Remove vote') : tr('Vote for this issue')}
              className={`veqsio-btn-ghost flex items-center gap-1 text-sm ${votes?.hasVoted ? '!text-[var(--brand-500)]' : ''}`}
            >
              <ThumbsUp className="w-4 h-4" aria-hidden="true" />
              <span>{votes?.votes ?? 0}</span>
              <span className="sr-only">{tr('votes')}</span>
            </button>
            <button
              type="button"
              onClick={() => toggleWatch.mutate({ key: issue.key, watching: !watching })}
              disabled={toggleWatch.isPending}
              aria-pressed={watching}
              title={watching ? tr('Stop watching') : tr('Start watching')}
              className={`veqsio-btn-ghost flex items-center gap-1 text-sm ${watching ? '!text-[var(--brand-500)]' : ''}`}
            >
              <Eye className="w-4 h-4" aria-hidden="true" />
              <span>{watchers?.watchCount ?? 0}</span>
              <span className="sr-only">{tr('watchers')}</span>
            </button>
          </div>
        </div>

        {flagged && (
          <div role="status" className="flex items-center gap-2 rounded-lg border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-sm text-[var(--text-primary)]">
            <Flag className="w-4 h-4 text-[var(--warning)]" aria-hidden="true" /> {tr('This issue is flagged as an impediment.')} <button type="button" onClick={toggleFlag} className="ml-auto text-[var(--brand-600)] hover:underline">{tr('Remove flag')}</button>
          </div>
        )}

      </header>
    )
  },
)
