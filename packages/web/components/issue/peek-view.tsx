'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Eye, Maximize2, PanelRight, SquareArrowOutUpRight, X } from 'lucide-react'
import { toast } from '@/components/toast'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { useIssue, useIssueAttachments } from '@/hooks/use-issues'
import { PEEK_MODE_STORAGE_KEY, parsePeekMode, type PeekMode } from '@/lib/peek'
import { ActivitySection } from './activity-section'
import { DescriptionSection } from './description-section'
import { DetailsPanel } from './details-panel'
import { InlineSummary } from './issue-header'
import { IssueTypeIcon, IssueViewSkeleton } from './primitives'
import { StatusButton } from './status-transition'

function usePeekMode(): [PeekMode, (m: PeekMode) => void] {
  const [mode, setMode] = useState<PeekMode>('side')
  useEffect(() => {
    try { setMode(parsePeekMode(window.localStorage.getItem(PEEK_MODE_STORAGE_KEY))) } catch { /* private mode: keep the default */ }
  }, [])
  const update = (m: PeekMode) => {
    setMode(m)
    try { window.localStorage.setItem(PEEK_MODE_STORAGE_KEY, m) } catch { /* ignore */ }
  }
  return [mode, update]
}

/** The lightweight read / edit view of one issue: title, status, description, details and the activity feed. */
function PeekBody({ issueKey }: { issueKey: string }) {
  const { tr } = useI18n()
  const { data: issue, isLoading, error } = useIssue(issueKey)
  const { data: attachments } = useIssueAttachments(issueKey)
  const resolveAttachment = useMemo(() => {
    const byName = new Map((attachments || []).map((a) => [a.filename, `/rest/api/2/attachment/${a.id}`]))
    return (name: string) => byName.get(name) ?? null
  }, [attachments])

  if (isLoading) return <IssueViewSkeleton />
  if (error || !issue) {
    return <div role="alert" className="p-6 text-center text-body text-[var(--text-primary)]">{error?.message || tr('Issue not found')}</div>
  }
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <InlineSummary issueKey={issue.key} value={issue.fields.summary} />
        <StatusButton issueKey={issue.key} status={{ name: issue.fields.status.name, category: issue.fields.status.category }} />
      </div>
      <DescriptionSection issueKey={issue.key} description={issue.fields.description} resolveAttachment={resolveAttachment} />
      <DetailsPanel issue={issue} />
      <ActivitySection issueKey={issue.key} resolveAttachment={resolveAttachment} />
    </div>
  )
}

/**
 * Right-side panel (or centred dialog) that shows an issue without leaving the list, board or backlog.
 * Keyboard: Esc closes, Tab stays inside the panel and focus returns to where it was. The URL carries ?peek=KEY.
 */
export function IssuePeek({ peekKey, onClose }: { peekKey: string | null; onClose: () => void }) {
  const { tr } = useI18n();

  const [mode, setMode] = usePeekMode()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const open = !!peekKey
  useDialogFocus(open, dialogRef, closeRef)

  // window (not document): popovers and inline editors inside the panel handle Escape first and stop it there.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!peekKey) return null
  const side = mode === 'side'
  const titleId = 'issue-peek-title'

  return (
    <div className={side ? 'fixed inset-0 z-50' : 'fixed inset-0 z-50 flex items-center justify-center p-4 veqsio-modal-overlay'}>
      {side && <div className="absolute inset-0 bg-black/30" aria-hidden="true" onClick={onClose} data-testid="peek-backdrop" />}
      {!side && <div className="absolute inset-0" aria-hidden="true" onClick={onClose} />}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="issue-peek"
        className={side
          ? 'absolute inset-y-0 right-0 flex w-full sm:w-[min(42rem,100vw)] flex-col bg-[var(--surface-0)] border-l border-[var(--surface-3)] shadow-[var(--shadow-lg,0_10px_30px_rgba(0,0,0,.25))] outline-none'
          : 'veqsio-modal-panel relative flex w-full max-w-3xl max-h-[calc(100dvh-2rem)] flex-col outline-none'}
      >
        <div className="flex items-center gap-2 border-b border-[var(--surface-3)] px-4 py-2">
          <Eye className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
          <h2 id={titleId} className="text-body-sm font-medium text-[var(--text-primary)]">
            <span className="sr-only">{tr('Peek at')} </span>{peekKey}
          </h2>
          <div className="ml-auto flex items-center gap-1">
            <Link
              href={`/issues/${encodeURIComponent(peekKey)}`}
              className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption"
              title={tr('Open the full issue page')}
            >
              <SquareArrowOutUpRight className="w-4 h-4" aria-hidden="true" /> {tr('Open full page')} </Link>
            <button
              type="button"
              className="veqsio-btn-ghost p-1.5"
              aria-label={side ? tr('Show as centred dialog') : tr('Show as side panel')}
              title={side ? tr('Show as centred dialog') : tr('Show as side panel')}
              onClick={() => { setMode(side ? 'modal' : 'side'); toast(side ? tr('Peek opens centred') : tr('Peek opens as side panel'), 'success') }}
            >
              {side ? <Maximize2 className="w-4 h-4" aria-hidden="true" /> : <PanelRight className="w-4 h-4" aria-hidden="true" />}
            </button>
            <button ref={closeRef} type="button" className="veqsio-btn-ghost p-1.5" aria-label={tr('Close peek (Esc)')} title={tr('Close (Esc)')} onClick={onClose}>
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <PeekBody issueKey={peekKey} />
        </div>
      </div>
    </div>
  )
}

/** Small button for list rows and cards; sits next to (never inside) the link to the full page. */
export function PeekButton({ issueKey, onPeek, className = '', tabbable = true }: { issueKey: string; onPeek: (key: string) => void; className?: string; tabbable?: boolean }) {
  const { tr } = useI18n()
  return (
    <button
      type="button"
      tabIndex={tabbable ? 0 : -1}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPeek(issueKey) }}
      aria-label={tr('Peek at {key}', { key: issueKey })}
      title={tr('Peek at {key} (P in the list)', { key: issueKey })}
      className={`rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] ${className}`}
    >
      <Eye className="w-4 h-4" aria-hidden="true" />
    </button>
  )
}
