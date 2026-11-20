'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useDismiss } from '@/hooks/use-dismiss'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ArrowDown, ArrowLeft, ArrowUp, Columns, Copy, Download, Pencil, Share2, Star, Trash2 } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'
import { Modal } from '@/components/modal'
import { JqlInput } from '@/components/jql-input'
import { ShareDialog } from '@/components/share-dialog'
import { ViewLayout } from '@/components/views/view-layouts'
import { toast } from '@/components/toast'
import {
  downloadExport, saveViewShares, useCreateView, useDeleteView, useDuplicateView, useSetViewFavourite, useUpdateView,
  useView, useViewResult,
} from '@/hooks/use-views'
import {
  COLUMN_IDS, COLUMN_LABELS, GROUP_FIELDS, GROUP_LABELS, LAYOUTS, LAYOUT_LABELS, clearLastUsed, configEquals, loadLastUsed,
  moveColumn, nextSort, saveLastUsed, toggleColumn, withGrouping, type GroupField, type Layout, type ViewConfig,
} from '@/lib/views'
import { confirmDialog } from '@/components/dialogs'

const PAGE_SIZE = 100
const WIDE_PAGE_SIZE = 500

const store = () => { try { return window.localStorage } catch { return null } }

export default function ViewPage() {
  const { tr } = useI18n();

  const params = useParams<{ id: string }>()
  const id = decodeURIComponent(params.id)
  const router = useRouter()
  const view = useView(id)
  const base = view.data?.config ?? null

  const [config, setConfig] = useState<ViewConfig | null>(null)
  const [jqlText, setJqlText] = useState('')
  const [page, setPage] = useState(0)
  const [saveAs, setSaveAs] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const exportRef = useDismiss<HTMLDivElement>(exportOpen, () => setExportOpen(false))
  const columnsRef = useDismiss<HTMLDivElement>(columnsOpen, () => setColumnsOpen(false))
  const initialised = useRef<string | null>(null)

  // Start from the settings last used in this browser, else from the stored view.
  useEffect(() => {
    if (!base || initialised.current === id) return
    initialised.current = id
    const last = loadLastUsed(store(), id)
    const start = last ?? base
    setConfig(start)
    setJqlText(start.query.jql)
    setPage(0)
  }, [base, id])

  useEffect(() => { if (config) saveLastUsed(store(), id, config) }, [config, id])

  const wide = config ? config.layout === 'board' || config.layout === 'calendar' || config.layout === 'timeline' : false
  const pageSize = wide ? WIDE_PAGE_SIZE : PAGE_SIZE
  const result = useViewResult(config, page * pageSize, pageSize)
  const update = useUpdateView(id)
  const create = useCreateView()
  const del = useDeleteView()
  const dup = useDuplicateView()
  const fav = useSetViewFavourite()
  const onError = (e: unknown) => toast((e as Error).message, 'error')

  const dirty = useMemo(() => !!(config && base && !configEquals(config, base)), [config, base])
  const patch = (p: Partial<ViewConfig>) => { setConfig((c) => (c ? { ...c, ...p } : c)); setPage(0) }

  if (view.isLoading) return <AppLayout><Spinner /></AppLayout>
  if (view.error || !view.data || !config) {
    return (
      <AppLayout>
        <div className="space-y-3">
          <Link href="/views" className="inline-flex items-center gap-1 text-sm text-[var(--brand-500)] hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden /> {tr('All views')}</Link>
          {view.error ? <p role="alert" className="text-[var(--error)]">{(view.error as Error).message === 'View not found' ? tr('This view does not exist or is not shared with you.') : (view.error as Error).message}</p> : <Spinner />}
        </div>
      </AppLayout>
    )
  }
  const v = view.data
  const totalPages = result.data ? Math.max(1, Math.ceil(result.data.total / pageSize)) : 1

  const saveChanges = () => update.mutate({ config }, { onSuccess: () => { clearLastUsed(store(), id); toast(tr('View saved'), 'success') }, onError })
  const doSaveAs = () => create.mutate({ name: newName.trim(), config }, {
    onSuccess: (n) => { setSaveAs(false); toast(tr('Saved as a new view'), 'success'); router.push(`/views/${n.id}`) }, onError,
  })

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link href="/views" className="inline-flex items-center gap-1 text-sm text-[var(--brand-500)] hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden /> {tr('All views')}</Link>
            <h1 className="text-heading-1 text-[var(--text-primary)] mt-1">{v.name}</h1>
            {v.description && <p className="text-body text-[var(--text-secondary)]">{v.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button className="veqsio-btn-ghost p-2" aria-pressed={v.favourite} aria-label={v.favourite ? tr('Remove from favourites') : tr('Add to favourites')} onClick={() => fav.mutate({ id, favourite: !v.favourite }, { onSuccess: () => view.refetch(), onError })}>
              <Star className={`h-4 w-4 ${v.favourite ? 'fill-[var(--warning)] text-[var(--warning)]' : ''}`} />
            </button>
            <button className="veqsio-btn-secondary inline-flex items-center gap-1" onClick={() => dup.mutate({ id }, { onSuccess: (n) => { toast(tr('View duplicated'), 'success'); router.push(`/views/${n.id}`) }, onError })}><Copy className="h-4 w-4" aria-hidden /> {tr('Duplicate')}</button>
            {v.editable && <button className="veqsio-btn-secondary inline-flex items-center gap-1" onClick={() => { setNewName(v.name); setRenaming(true) }}><Pencil className="h-4 w-4" aria-hidden /> {tr('Rename')}</button>}
            {v.editable && <button className="veqsio-btn-secondary inline-flex items-center gap-1" onClick={() => setSharing(true)}><Share2 className="h-4 w-4" aria-hidden /> {tr('Share')}</button>}
            {v.editable && <button className="veqsio-btn-secondary inline-flex items-center gap-1" onClick={async () => (await confirmDialog(tr('Delete view "{name}"?', { name: v.name }))) && del.mutate(id, { onSuccess: () => router.push('/views'), onError })}><Trash2 className="h-4 w-4" aria-hidden /> {tr('Delete')}</button>}
            <div className="relative" ref={exportRef}>
              <button className="veqsio-btn-secondary inline-flex items-center gap-1" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((o) => !o)}><Download className="h-4 w-4" aria-hidden /> {tr('Export')}</button>
              {exportOpen && (
                <ul role="menu" className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-[var(--surface-3)] bg-[var(--surface-0)] py-1 shadow-lg">
                  {(['csv', 'xlsx', 'json'] as const).map((f) => (
                    <li key={f} role="none">
                      <button role="menuitem" className="w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-2)]" onClick={() => { setExportOpen(false); downloadExport(config, f, v.name).then(() => toast(tr('Exported as {format}', { format: f.toUpperCase() }), 'success')).catch(onError) }}>
                        {f === 'csv' ? 'CSV' : f === 'xlsx' ? tr('Excel (XLSX)') : 'JSON'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Query */}
        <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); patch({ query: { ...config.query, jql: jqlText } }) }}>
          <div className="text-sm font-medium">{tr('Query (JQL)')}</div>
          <div className="flex gap-2 items-start">
            <div className="flex-1"><JqlInput value={jqlText} onChange={setJqlText} /></div>
            <button className="veqsio-btn-secondary" disabled={jqlText.trim() === config.query.jql.trim()}>{tr('Apply')}</button>
          </div>
          {config.query.filters && <p className="text-xs text-[var(--text-tertiary)]">{tr('This view also applies saved simple filters.')}</p>}
        </form>

        {/* Controls */}
        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] p-3 text-sm">
          <div role="group" aria-label={tr('Layout')} className="flex gap-1">
            {LAYOUTS.map((l: Layout) => (
              <button key={l} aria-pressed={config.layout === l} className={config.layout === l ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'} onClick={() => patch({ layout: l })}>{tr(LAYOUT_LABELS[l])}</button>
            ))}
          </div>
          <label className="space-y-1">{tr('Group by')} <select className="veqsio-input block" value={config.groupBy} onChange={(e) => { setConfig(withGrouping(config, { groupBy: e.target.value as GroupField })); setPage(0) }}>
              {GROUP_FIELDS.map((g) => <option key={g} value={g}>{tr(GROUP_LABELS[g])}</option>)}
            </select>
          </label>
          <label className="space-y-1">{tr('Sub-group by')} <select className="veqsio-input block" value={config.subGroupBy} disabled={config.groupBy === 'none'} onChange={(e) => { setConfig(withGrouping(config, { subGroupBy: e.target.value as GroupField })); setPage(0) }}>
              {GROUP_FIELDS.filter((g) => g !== config.groupBy || g === 'none').map((g) => <option key={g} value={g}>{tr(GROUP_LABELS[g])}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" checked={config.showEmptyGroups} disabled={config.groupBy === 'none'} onChange={(e) => patch({ showEmptyGroups: e.target.checked })} />
            {tr('Show empty groups')} </label>
          {config.layout === 'calendar' && (
            <label className="space-y-1">{tr('Date')} <select className="veqsio-input block" value={config.dateField} onChange={(e) => patch({ dateField: e.target.value as ViewConfig['dateField'] })}>
                <option value="duedate">{tr('Due date')}</option><option value="startdate">{tr('Start date')}</option><option value="created">{tr('Created')}</option><option value="updated">{tr('Updated')}</option>
              </select>
            </label>
          )}
          <div className="relative" ref={columnsRef}>
            <button className="veqsio-btn-secondary inline-flex items-center gap-1" aria-haspopup="dialog" aria-expanded={columnsOpen} onClick={() => setColumnsOpen((o) => !o)}><Columns className="h-4 w-4" aria-hidden /> {tr('Display properties')}</button>
            {columnsOpen && (
              <div role="dialog" aria-label={tr('Display properties')} className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-auto rounded-md border border-[var(--surface-3)] bg-[var(--surface-0)] p-2 shadow-lg">
                <p className="px-1 pb-1 text-xs text-[var(--text-tertiary)]">{tr('Shown columns, in display order.')}</p>
                <ul className="space-y-0.5">
                  {config.columns.map((c, i) => (
                    <li key={c} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--surface-1)]">
                      <label className="flex flex-1 items-center gap-2"><input type="checkbox" checked onChange={() => patch({ columns: toggleColumn(config.columns, c) })} />{tr(COLUMN_LABELS[c])}</label>
                      <button className="veqsio-btn-ghost p-1" aria-label={tr('Move {name} up', { name: tr(COLUMN_LABELS[c]) })} disabled={i === 0} onClick={() => patch({ columns: moveColumn(config.columns, c, -1) })}><ArrowUp className="h-3 w-3" /></button>
                      <button className="veqsio-btn-ghost p-1" aria-label={tr('Move {name} down', { name: tr(COLUMN_LABELS[c]) })} disabled={i === config.columns.length - 1} onClick={() => patch({ columns: moveColumn(config.columns, c, 1) })}><ArrowDown className="h-3 w-3" /></button>
                    </li>
                  ))}
                </ul>
                <hr className="my-2 border-[var(--surface-3)]" />
                <ul className="space-y-0.5">
                  {COLUMN_IDS.filter((c) => !config.columns.includes(c)).map((c) => (
                    <li key={c} className="rounded px-1 py-0.5 hover:bg-[var(--surface-1)]"><label className="flex items-center gap-2"><input type="checkbox" checked={false} onChange={() => patch({ columns: toggleColumn(config.columns, c) })} />{tr(COLUMN_LABELS[c])}</label></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* Save bar */}
        {dirty && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--brand-300)] bg-[var(--brand-50)] px-3 py-2 text-sm">
            <span>{tr('You have unsaved changes to this view')}{v.builtin ? ' ' + tr('(built-in views cannot be changed)') : ''}.</span>
            <div className="flex gap-2">
              <button className="veqsio-btn-secondary" onClick={() => { clearLastUsed(store(), id); setConfig(base); setJqlText(base!.query.jql) }}>{tr('Reset')}</button>
              <button className="veqsio-btn-secondary" onClick={() => { setNewName(`${v.name} (copy)`); setSaveAs(true) }}>{tr('Save as new view')}</button>
              {v.editable && <button className="veqsio-btn-primary" disabled={update.isPending} onClick={saveChanges}>{tr('Save changes')}</button>}
            </div>
          </div>
        )}

        {/* Result */}
        {result.error && <p role="alert" className="text-[var(--error)]">{(result.error as Error).message}</p>}
        {result.isLoading && <Spinner />}
        {result.data && (
          <div className={result.isFetching ? 'opacity-70 transition-opacity' : ''}>
            <ViewLayout issues={result.data.issues} groups={result.data.groups} config={config} onSort={(field) => patch({ sort: nextSort(config.sort, field) })} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--text-secondary)]">
              <span aria-live="polite">{result.data.total} {result.data.total === 1 ? tr('issue') : tr('issues')}{config.groupBy !== 'none' && totalPages > 1 ? ' ' + tr('(groups show the issues of the current page)') : ''}</span>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button className="veqsio-btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>{tr('Previous')}</button>
                  <span>{tr('Page')} {page + 1} {tr('of')} {totalPages}</span>
                  <button className="veqsio-btn-secondary" disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}>{tr('Next')}</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {saveAs && (
        <Modal isOpen onClose={() => setSaveAs(false)} title={tr('Save as new view')}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) doSaveAs() }}>
            <label className="block text-sm space-y-1">{tr('Name')}<input autoFocus className="veqsio-input w-full" value={newName} maxLength={255} onChange={(e) => setNewName(e.target.value)} /></label>
            <div className="flex justify-end gap-2"><button type="button" className="veqsio-btn-secondary" onClick={() => setSaveAs(false)}>{tr('Cancel')}</button><button className="veqsio-btn-primary" disabled={!newName.trim() || create.isPending}>{tr('Save')}</button></div>
          </form>
        </Modal>
      )}
      {renaming && (
        <Modal isOpen onClose={() => setRenaming(false)} title={tr('Rename view')}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) update.mutate({ name: newName.trim() }, { onSuccess: () => { setRenaming(false); view.refetch() }, onError }) }}>
            <label className="block text-sm space-y-1">{tr('Name')}<input autoFocus className="veqsio-input w-full" value={newName} maxLength={255} onChange={(e) => setNewName(e.target.value)} /></label>
            <div className="flex justify-end gap-2"><button type="button" className="veqsio-btn-secondary" onClick={() => setRenaming(false)}>{tr('Cancel')}</button><button className="veqsio-btn-primary" disabled={!newName.trim() || update.isPending}>{tr('Rename')}</button></div>
          </form>
        </Modal>
      )}
      {sharing && <ShareDialog title={tr('Share "{name}"', { name: v.name })} initial={v.shares ?? []} save={(shares) => saveViewShares(id, shares)} onClose={() => { setSharing(false); view.refetch() }} />}
    </AppLayout>
  )
}
