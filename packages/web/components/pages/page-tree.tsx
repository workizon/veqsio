'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, FileText, Lock, Plus } from 'lucide-react'
import { ancestorIds, buildPageTree, visibleRows, type PageSummary } from '@/lib/pages'

/** Collapsible page tree of one scope (workspace or project). The open page is highlighted and its ancestors are expanded. */
export function PageTree({ pages, currentId, onCreate, canCreate }: {
  pages: PageSummary[]
  currentId: number | null
  onCreate: (parentId: number | null) => void
  canCreate: boolean
}) {
  const { tr } = useI18n();

  const roots = useMemo(() => buildPageTree(pages), [pages])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Open the path down to the current page whenever it changes.
  useEffect(() => {
    if (currentId === null) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const id of ancestorIds(pages, currentId)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [currentId, pages])

  const rows = useMemo(() => visibleRows(roots, expanded), [roots, expanded])
  const toggle = (id: number) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  if (!pages.length) {
    return (
      <div className="px-3 py-6 text-sm text-[var(--text-secondary)] text-center">
        <p>{tr('No pages yet.')}</p>
        {canCreate && <button type="button" className="veqsio-btn-secondary mt-3" onClick={() => onCreate(null)}><Plus className="w-4 h-4" aria-hidden /> {tr('Create the first page')}</button>}
      </div>
    )
  }

  return (
    <ul role="tree" aria-label={tr('Pages')} className="text-sm space-y-0.5">
      {rows.map(({ node, depth }) => {
        const hasKids = node.children.length > 0
        const open = expanded.has(node.id)
        const current = node.id === currentId
        return (
          <li key={node.id} role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={current} className="group">
            <div
              className={`flex items-center gap-1 rounded-md pr-1 ${current ? 'bg-[var(--brand-50,var(--surface-2))] text-[var(--brand-600,var(--brand-500))] font-medium' : 'hover:bg-[var(--surface-2)] text-[var(--text-primary)]'}`}
              style={{ paddingLeft: depth * 14 + 4 }}
            >
              {hasKids ? (
                <button type="button" onClick={() => toggle(node.id)} aria-label={open ? tr('Collapse {title}', { title: node.title }) : tr('Expand {title}', { title: node.title })} className="p-1 rounded hover:bg-[var(--surface-3)]">
                  {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
                </button>
              ) : <span className="w-[22px]" aria-hidden />}
              <Link href={`/pages/${node.id}`} className="flex-1 min-w-0 flex items-center gap-1.5 py-1.5" aria-current={current ? 'page' : undefined}>
                <FileText className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden />
                <span className="truncate">{node.title}</span>
                {node.locked && <Lock className="w-3 h-3 shrink-0 text-[var(--text-tertiary)]" aria-label={tr('Locked')} />}
              </Link>
              {canCreate && (
                <button type="button" onClick={() => onCreate(node.id)} aria-label={tr('Add a child page under {title}', { title: node.title })} className="p-1 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--surface-3)]">
                  <Plus className="w-3.5 h-3.5" aria-hidden />
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
