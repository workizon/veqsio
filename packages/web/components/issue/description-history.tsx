'use client'

import { useEffect, useRef, useState } from 'react'
import { History, X } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useDescriptionVersion, useDescriptionVersions, useRestoreDescription, type DiffOp } from '@/hooks/use-issue-history'
import { Portal } from '@/components/portal'

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Created')

export function DiffView({ ops, label }: { ops: DiffOp[]; label: string }) {
  if (ops.every((o) => o.type === 'eq')) return <p className="text-caption text-[var(--text-tertiary)]">No differences.</p>
  return (
    <pre aria-label={label} className="max-h-72 overflow-auto rounded-md border border-[var(--surface-3)] bg-[var(--surface-1)] p-2 text-[12px] leading-5 whitespace-pre-wrap">
      {ops.map((o, i) => (
        <div
          key={i}
          className={o.type === 'add' ? 'bg-[color-mix(in_srgb,var(--success)_15%,transparent)]' : o.type === 'del' ? 'bg-[color-mix(in_srgb,var(--error)_15%,transparent)]' : 'text-[var(--text-tertiary)]'}
        >
          <span aria-hidden="true" className="select-none inline-block w-4">{o.type === 'add' ? '+' : o.type === 'del' ? '-' : ' '}</span>
          <span className="sr-only">{o.type === 'add' ? 'Added: ' : o.type === 'del' ? 'Removed: ' : ''}</span>
          {o.text || ' '}
        </div>
      ))}
    </pre>
  )
}

/** Button in the description header that opens the version drawer. */
export function DescriptionHistoryButton({ issueKey }: { issueKey: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Description history"
        title="Description history"
        className="p-1.5 rounded text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
      >
        <History className="w-4 h-4" aria-hidden="true" />
      </button>
      {open && <Portal><DescriptionHistoryDrawer issueKey={issueKey} onClose={() => setOpen(false)} /></Portal>}
    </>
  )
}

function DescriptionHistoryDrawer({ issueKey, onClose }: { issueKey: string; onClose: () => void }) {
  const list = useDescriptionVersions(issueKey, true)
  const [selected, setSelected] = useState<number | null>(null)
  const [mode, setMode] = useState<'previous' | 'current'>('previous')
  const detail = useDescriptionVersion(issueKey, selected)
  const restore = useRestoreDescription()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const versions = list.data?.versions ?? []
  const d = detail.data
  const ops = d ? (mode === 'previous' ? d.diffFromPrevious : d.diffToCurrent) : null

  const doRestore = async (version: number) => {
    try {
      await restore.mutateAsync({ key: issueKey, version })
      toast(`Description restored from version ${version}`, 'success')
      setSelected(null)
    } catch (err: any) {
      toast(err?.message || 'Failed to restore description', 'error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end veqsio-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside role="dialog" aria-modal="true" aria-label="Description history" className="h-full w-full max-w-md overflow-y-auto bg-[var(--surface-0)] shadow-xl border-l border-[var(--surface-3)] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-heading-3 text-[var(--text-primary)]">Description history</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {list.isLoading && <div className="flex justify-center py-6"><Spinner /></div>}
        {list.error && <p role="alert" className="text-body-sm text-[var(--error)]">{(list.error as Error).message}</p>}
        {!list.isLoading && !list.error && versions.length === 0 && (
          <p className="text-body-sm text-[var(--text-tertiary)]">The description has not been changed since the issue was created.</p>
        )}

        <ul className="space-y-1" aria-label="Versions">
          {versions.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                aria-pressed={selected === v.version}
                onClick={() => setSelected(v.version)}
                className={`w-full text-left rounded-md border px-3 py-2 text-body-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] ${selected === v.version ? 'border-[var(--brand-500)] bg-[var(--surface-2)]' : 'border-[var(--surface-3)] hover:bg-[var(--surface-1)]'}`}
              >
                <span className="font-medium text-[var(--text-primary)]">Version {v.version}</span>
                {v.current && <span className="ml-2 text-caption rounded bg-[var(--surface-3)] px-1.5 py-0.5">current</span>}
                <span className="block text-caption text-[var(--text-tertiary)]">
                  {fmt(v.createdAt)} by {v.author?.displayName ?? 'unknown'}
                  {v.added !== null && <> · +{v.added} -{v.removed} lines</>}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {selected !== null && (
          <section aria-label={`Version ${selected}`} className="space-y-3 border-t border-[var(--surface-3)] pt-3">
            {detail.isLoading && <Spinner size="sm" />}
            {detail.error && <p role="alert" className="text-body-sm text-[var(--error)]">{(detail.error as Error).message}</p>}
            {d && (
              <>
                <div role="group" aria-label="Compare with" className="flex gap-1 text-caption">
                  <button type="button" aria-pressed={mode === 'previous'} disabled={!d.diffFromPrevious} onClick={() => setMode('previous')} className={`rounded px-2 py-1 border ${mode === 'previous' ? 'border-[var(--brand-500)] text-[var(--brand-500)]' : 'border-[var(--surface-3)]'} disabled:opacity-40`}>Changes in this version</button>
                  <button type="button" aria-pressed={mode === 'current'} disabled={!d.diffToCurrent} onClick={() => setMode('current')} className={`rounded px-2 py-1 border ${mode === 'current' ? 'border-[var(--brand-500)] text-[var(--brand-500)]' : 'border-[var(--surface-3)]'} disabled:opacity-40`}>Compared with current</button>
                </div>
                {ops ? <DiffView ops={ops} label={mode === 'previous' ? 'Changes in this version' : 'Differences to the current description'} /> : (
                  <pre className="max-h-72 overflow-auto rounded-md border border-[var(--surface-3)] bg-[var(--surface-1)] p-2 text-[12px] whitespace-pre-wrap">{d.text || '(empty)'}</pre>
                )}
                {!d.current && (
                  <button type="button" onClick={() => void doRestore(d.version)} disabled={restore.isPending} className="veqsio-btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
                    {restore.isPending && <Spinner size="sm" />} Restore this version
                  </button>
                )}
                <p className="text-caption text-[var(--text-tertiary)]">Restoring saves the old text as a new version; nothing is lost.</p>
              </>
            )}
          </section>
        )}
      </aside>
    </div>
  )
}
