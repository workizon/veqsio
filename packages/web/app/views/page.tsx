'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Copy, Plus, Share2, Star, Trash2 } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { ShareDialog } from '@/components/share-dialog'
import { toast } from '@/components/toast'
import {
  saveViewShares, useCreateView, useDeleteView, useDuplicateView, useSetViewFavourite, useViewList,
  type ViewScope, type ViewSummary,
} from '@/hooks/use-views'
import { DEFAULT_CONFIG, LAYOUT_LABELS, type Layout } from '@/lib/views'
import { confirmDialog } from '@/components/dialogs'

const TABS: Array<{ id: ViewScope; label: string }> = [
  { id: 'all', label: 'All views' },
  { id: 'mine', label: 'My views' },
  { id: 'shared', label: 'Shared with me' },
  { id: 'favourites', label: 'Favourites' },
]

export default function ViewsPage() {
  const { tr } = useI18n();

  const router = useRouter()
  const [scope, setScope] = useState<ViewScope>('all')
  const [search, setSearch] = useState('')
  const [sharing, setSharing] = useState<ViewSummary | null>(null)
  const list = useViewList(scope, search.trim())
  const create = useCreateView()
  const del = useDeleteView()
  const dup = useDuplicateView()
  const fav = useSetViewFavourite()
  const onError = (e: unknown) => toast((e as Error).message, 'error')

  const rows: ViewSummary[] = [...(list.data?.builtin ?? []), ...(list.data?.values ?? [])]

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader
          title={tr('Views')}
          description={tr('Saved queries with a layout, grouping and columns. A view always shows what you are allowed to see.')}
          actions={
            <button
              className="veqsio-btn-primary inline-flex items-center gap-2" disabled={create.isPending}
              onClick={() => create.mutate({ name: 'New view', config: DEFAULT_CONFIG as any }, { onSuccess: (v) => router.push(`/views/${v.id}`), onError })}
            >
              <Plus className="h-4 w-4" aria-hidden /> {tr('New view')} </button>
          }
        />

        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label={tr('Views')} className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={scope === t.id} className={scope === t.id ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'} onClick={() => setScope(t.id)}>{tr(t.label)}</button>
            ))}
          </div>
          <label className="sr-only" htmlFor="views-search">{tr('Search views')}</label>
          <input id="views-search" type="search" className="veqsio-input max-w-xs" placeholder={tr('Search views')} value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {list.isLoading && <Spinner />}
        {list.error && <p role="alert" className="text-[var(--error)]">{(list.error as Error).message}</p>}
        {list.data && rows.length === 0 && (
          <EmptyState icon="folder" title={search ? tr('No views match your search') : scope === 'favourites' ? tr('No favourite views yet') : scope === 'shared' ? tr('Nothing has been shared with you') : tr('You have no views yet')} />
        )}
        <ul className="space-y-2">
          {rows.map((v) => (
            <li key={v.id} className="veqsio-card p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link href={`/views/${encodeURIComponent(v.id)}`} className="font-medium text-[var(--brand-500)] hover:underline">{v.name}</Link>
                  <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">{LAYOUT_LABELS[v.layout as Layout] ? tr(LAYOUT_LABELS[v.layout as Layout]) : v.layout}</span>
                  {v.builtin && <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">{tr('Built in')}</span>}
                  {v.shared && <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">{tr('Shared')}</span>}
                </div>
                <div className="font-mono text-xs text-[var(--text-secondary)] truncate max-w-xl" title={v.query}>{v.query}</div>
                {v.description && <div className="text-xs text-[var(--text-tertiary)]">{v.description}</div>}
                {!v.builtin && !v.editable && <div className="text-xs text-[var(--text-tertiary)]">{tr('by')} {v.owner?.displayName ?? tr('unknown')}</div>}
              </div>
              <div className="flex gap-1">
                <button className="veqsio-btn-ghost p-2" aria-pressed={v.favourite} aria-label={v.favourite ? tr('Remove from favourites: {name}', { name: v.name }) : tr('Add to favourites: {name}', { name: v.name })} onClick={() => fav.mutate({ id: v.id, favourite: !v.favourite }, { onError })}>
                  <Star className={`h-4 w-4 ${v.favourite ? 'fill-[var(--warning)] text-[var(--warning)]' : ''}`} />
                </button>
                <button className="veqsio-btn-ghost p-2" title={tr('Duplicate')} aria-label={tr('Duplicate {name}', { name: v.name })} onClick={() => dup.mutate({ id: v.id }, { onSuccess: (n) => { toast(tr('View duplicated'), 'success'); router.push(`/views/${n.id}`) }, onError })}><Copy className="h-4 w-4" /></button>
                {v.editable && <button className="veqsio-btn-ghost p-2" title={tr('Share')} aria-label={tr('Share {name}', { name: v.name })} onClick={() => setSharing(v)}><Share2 className="h-4 w-4" /></button>}
                {v.editable && <button className="veqsio-btn-ghost p-2" title={tr('Delete')} aria-label={tr('Delete {name}', { name: v.name })} onClick={async () => (await confirmDialog(tr('Delete view "{name}"?', { name: v.name }))) && del.mutate(v.id, { onError })}><Trash2 className="h-4 w-4" /></button>}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {sharing && (
        <ShareDialog title={tr('Share "{name}"', { name: sharing.name })} initial={sharing.shares ?? []} save={(shares) => saveViewShares(sharing.id, shares)} onClose={() => { setSharing(null); list.refetch() }} />
      )}
    </AppLayout>
  )
}
