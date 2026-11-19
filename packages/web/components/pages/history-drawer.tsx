'use client'

import { useEffect, useRef, useState } from 'react'
import { History, RotateCcw, X } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { usePageVersion, usePageVersions, useRestoreVersion } from '@/hooks/use-pages'
import { versionSummary } from '@/lib/pages'

/** Right-hand drawer with the version history of a page: pick a version, see what changed and restore it in one click. */
export function HistoryDrawer({ pageId, canRestore, onClose, onRestored }: { pageId: number; canRestore: boolean; onClose: () => void; onRestored: () => void }) {
  const versions = usePageVersions(pageId)
  const [selected, setSelected] = useState<number | null>(null)
  const [compare, setCompare] = useState<'previous' | 'current'>('previous')
  const detail = usePageVersion(pageId, selected, compare)
  const restore = useRestoreVersion(pageId)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { closeRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => { if (selected === null && versions.data?.versions[0]) setSelected(versions.data.versions[0].version) }, [versions.data, selected])

  const current = versions.data?.current
  const doRestore = (v: number) => restore.mutate(v, {
    onSuccess: (r) => { toast(r.changed ? `Restored version ${v} as version ${r.version}` : 'That version is already the current one', 'success'); onRestored() },
    onError: (e) => toast(e.message, 'error'),
  })

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside role="dialog" aria-modal="true" aria-label="Page history" className="w-full max-w-3xl h-full bg-[var(--surface-0)] border-l border-[var(--surface-3)] shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-[var(--surface-3)]">
          <h2 className="text-heading-3 flex items-center gap-2"><History className="w-5 h-5" aria-hidden /> Page history</h2>
          <button ref={closeRef} type="button" onClick={onClose} className="veqsio-btn-ghost p-2" aria-label="Close history"><X className="w-5 h-5" aria-hidden /></button>
        </header>
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[240px_1fr]">
          <nav aria-label="Versions" className="border-b md:border-b-0 md:border-r border-[var(--surface-3)] overflow-y-auto max-h-48 md:max-h-none">
            {versions.isLoading && <div className="p-4"><Spinner /></div>}
            {versions.isError && <p role="alert" className="p-4 text-sm text-red-600">Could not load the history.</p>}
            <ul>
              {versions.data?.versions.map((v) => (
                <li key={v.version}>
                  <button
                    type="button"
                    onClick={() => setSelected(v.version)}
                    aria-current={selected === v.version}
                    className={`w-full text-left px-4 py-2.5 border-b border-[var(--surface-2)] hover:bg-[var(--surface-1)] ${selected === v.version ? 'bg-[var(--surface-2)]' : ''}`}
                  >
                    <span className="flex items-center justify-between text-sm font-medium">
                      Version {v.version}
                      {v.version === current && <span className="text-xs rounded px-1.5 py-0.5 bg-[var(--surface-3)]">current</span>}
                    </span>
                    <span className="block text-xs text-[var(--text-secondary)]">{v.author?.displayName ?? 'Unknown'} · {new Date(v.createdAt).toLocaleString()}</span>
                    <span className="block text-xs text-[var(--text-tertiary)]">
                      {v.restoredFrom ? `Restored from version ${v.restoredFrom} · ` : ''}{versionSummary(v.added, v.removed)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <section className="overflow-y-auto p-5 min-w-0" aria-live="polite">
            {selected === null && <p className="text-sm text-[var(--text-secondary)]">Select a version.</p>}
            {detail.isLoading && selected !== null && <Spinner />}
            {detail.isError && <p role="alert" className="text-sm text-red-600">Could not load this version.</p>}
            {detail.data && (
              <>
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <h3 className="text-heading-3 mr-auto">{detail.data.title}</h3>
                  <label className="text-sm flex items-center gap-2">
                    Compare with
                    <select className="veqsio-input" value={compare} onChange={(e) => setCompare(e.target.value as 'previous' | 'current')}>
                      <option value="previous">previous version</option>
                      <option value="current">current page</option>
                    </select>
                  </label>
                  {canRestore && !detail.data.isCurrent && (
                    <button type="button" className="veqsio-btn-primary" disabled={restore.isPending} onClick={() => doRestore(detail.data!.version)}>
                      <RotateCcw className="w-4 h-4" aria-hidden /> Restore this version
                    </button>
                  )}
                </div>
                <p className="text-sm text-[var(--text-secondary)] mb-2">
                  Compared with {detail.data.compared === 'current' ? 'the current page (what restoring would change)' : detail.data.compared === 'empty' ? 'an empty page' : `version ${detail.data.compared.slice(1)}`}:{' '}
                  {versionSummary(detail.data.summary.added, detail.data.summary.removed)}
                  {detail.data.titleChanged && <> · title: &ldquo;{detail.data.titleChanged.from}&rdquo; to &ldquo;{detail.data.titleChanged.to}&rdquo;</>}
                </p>
                <pre className="text-xs leading-5 border border-[var(--surface-3)] rounded-lg overflow-x-auto" aria-label="Changes">
                  {detail.data.diff.length === 0 && <span className="block p-3 text-[var(--text-tertiary)]">The page is empty.</span>}
                  {detail.data.diff.map((h, i) => h.type === 'skip' ? (
                    <span key={i} className="block px-3 py-0.5 bg-[var(--surface-2)] text-[var(--text-tertiary)]">... {h.count} unchanged line{h.count === 1 ? '' : 's'} ...</span>
                  ) : (
                    <span key={i} className={`block px-3 whitespace-pre-wrap break-words ${h.type === 'add' ? 'bg-green-500/15' : h.type === 'del' ? 'bg-red-500/15 line-through decoration-red-500/40' : ''}`}>
                      <span className="select-none text-[var(--text-tertiary)] mr-2" aria-hidden>{h.type === 'add' ? '+' : h.type === 'del' ? '-' : ' '}</span>
                      <span className="sr-only">{h.type === 'add' ? 'Added: ' : h.type === 'del' ? 'Removed: ' : ''}</span>
                      {h.text || ' '}
                    </span>
                  ))}
                </pre>
              </>
            )}
          </section>
        </div>
      </aside>
    </div>
  )
}
