'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, ChevronDown, ChevronsLeft, ChevronsRight, ListChecks, Search } from 'lucide-react'
import { useIssues, type ApiIssue } from '@/hooks/use-issues'
import { browserSessionStorage, loadIssueList } from '@/lib/issue-nav'

const COLLAPSED_KEY = 'veqsio-issue-panel-collapsed'
const SORT_KEY = 'veqsio-issue-panel-sort'

/** Fields the search can order by (label shown in the menu, JQL field name). */
export const ORDER_FIELDS: { label: string; field: string }[] = [
  { label: 'Assignee', field: 'assignee' },
  { label: 'Created', field: 'created' },
  { label: 'Due date', field: 'duedate' },
  { label: 'Issue type', field: 'issuetype' },
  { label: 'Key', field: 'key' },
  { label: 'Priority', field: 'priority' },
  { label: 'Project', field: 'project' },
  { label: 'Reporter', field: 'reporter' },
  { label: 'Resolution', field: 'resolution' },
  { label: 'Resolved', field: 'resolved' },
  { label: 'Status', field: 'status' },
  { label: 'Summary', field: 'summary' },
  { label: 'Updated', field: 'updated' },
]

export interface PanelSort { field: string; dir: 'asc' | 'desc' }

function usePanelSort(): [PanelSort | null, (s: PanelSort | null) => void] {
  const [sort, setSort] = useState<PanelSort | null>(null)
  useEffect(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem(SORT_KEY) || 'null')
      if (v && ORDER_FIELDS.some((f) => f.field === v.field) && (v.dir === 'asc' || v.dir === 'desc')) setSort(v)
    } catch { /* ignore */ }
  }, [])
  const update = (s: PanelSort | null) => {
    setSort(s)
    try { window.localStorage.setItem(SORT_KEY, JSON.stringify(s)) } catch { /* private mode */ }
  }
  return [sort, update]
}

/** "Order by <field> v  ^" as in Jira: a searchable field menu and an ascending / descending toggle. */
function OrderBy({ sort, onChange }: { sort: PanelSort | null; onChange: (s: PanelSort | null) => void }) {
  const { tr } = useI18n();

  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  const current = ORDER_FIELDS.find((f) => f.field === sort?.field)
  const shown = ORDER_FIELDS.filter((f) => tr(f.label).toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div ref={ref} className="relative flex items-center gap-1 px-3 py-2 border-b border-[var(--surface-3)]">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQ('') }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex-1 min-w-0 inline-flex items-center justify-between gap-1 rounded-md px-2 py-1 text-sm text-left border ${sort ? 'border-[var(--brand-500)] text-[var(--brand-600)] bg-[var(--brand-50)]' : 'border-[var(--surface-3)] text-[var(--text-secondary)]'}`}
      >
        <span className="truncate">{current ? tr('Order by {field}', { field: tr(current.label) }) : tr('Order by')}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={!sort}
        onClick={() => sort && onChange({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
        aria-label={sort?.dir === 'desc' ? tr('Descending, click for ascending') : tr('Ascending, click for descending')}
        title={sort?.dir === 'desc' ? tr('Descending') : tr('Ascending')}
        className="p-1.5 rounded-md border border-[var(--surface-3)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
      >
        {sort?.dir === 'desc' ? <ArrowDown className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />}
      </button>
      {open && (
        <div className="absolute left-3 right-3 top-full z-20 mt-1 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-lg">
          <div className="relative p-2">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Search')}
              aria-label={tr('Search fields')}
              className="veqsio-input w-full pr-8 text-sm"
            />
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
          </div>
          <ul role="listbox" aria-label={tr('Order by')} className="max-h-64 overflow-y-auto pb-1">
            <li>
              <button type="button" role="option" aria-selected={!sort} onClick={() => { onChange(null); setOpen(false) }} className="w-full text-left px-3 py-1.5 text-sm text-[var(--text-tertiary)] hover:bg-[var(--surface-1)]">{tr('Default order')}</button>
            </li>
            {shown.map((f) => (
              <li key={f.field}>
                <button
                  type="button"
                  role="option"
                  aria-selected={sort?.field === f.field}
                  onClick={() => { onChange({ field: f.field, dir: sort?.field === f.field ? sort.dir : (f.field === 'created' || f.field === 'updated' ? 'desc' : 'asc') }); setOpen(false) }}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--surface-1)] ${sort?.field === f.field ? 'font-medium text-[var(--brand-600)]' : 'text-[var(--text-primary)]'}`}
                >
                  {tr(f.label)}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-[var(--text-tertiary)]">{tr('No matching field')}</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
const WINDOW = 25

/** The keys to show: a window around the current issue in the list the user came from. */
export function windowKeys(keys: string[], currentKey: string, size = WINDOW): string[] {
  const idx = keys.findIndex((k) => k.toLowerCase() === currentKey.toLowerCase())
  if (idx < 0) return []
  const start = Math.max(0, Math.min(idx - Math.floor(size / 2), keys.length - size))
  return keys.slice(start, start + size)
}

function dotClass(category: string | undefined): string {
  const c = (category ?? '').toLowerCase()
  if (c.includes('done') || c.includes('resolved') || c.includes('closed')) return 'bg-green-500'
  if (c.includes('progress') || c.includes('indeterminate')) return 'bg-blue-500'
  return 'bg-slate-400'
}

interface Props {
  issueKey: string
  projectKey: string
  collapsed: boolean
  onToggle: () => void
}

export function useIssuePanelCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === '1') } catch { /* private mode */ }
  }, [])
  const toggle = () => setCollapsed((c) => {
    try { window.localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1') } catch { /* private mode */ }
    return !c
  })
  return [collapsed, toggle]
}

/**
 * Left-hand list of the other issues, as in Jira: the list the user opened this issue from (the issue list
 * stores its result keys), or the latest issues of the same project when there is none.
 */
export function IssueListPanel({ issueKey, projectKey, collapsed, onToggle }: Props) {
  const { tr } = useI18n();

  const [stored, setStored] = useState<ReturnType<typeof loadIssueList>>(null)
  useEffect(() => { setStored(loadIssueList(browserSessionStorage())) }, [issueKey])

  const [sort, setSort] = usePanelSort()
  const keys = useMemo(() => (stored ? windowKeys(stored.keys, issueKey) : []), [stored, issueKey])
  const fromList = keys.length > 0 && !sort
  // With an explicit order the list is re-queried: the query the user came from (or the project), ordered as asked.
  const baseJql = (stored?.label || '').replace(/\s*\border\s+by\b.*$/i, '').trim() || `project = "${projectKey}"`
  const jql = sort
    ? `${baseJql} ORDER BY ${sort.field} ${sort.dir.toUpperCase()}`
    : fromList
      ? `key in (${keys.join(',')})`
      : `project = "${projectKey}" ORDER BY updated DESC`

  const { data, isLoading } = useIssues(jql, !collapsed && (fromList || !!projectKey || !!sort))

  const issues: ApiIssue[] = useMemo(() => {
    const found = data?.issues ?? []
    if (!fromList) return found.slice(0, 50)
    const byKey = new Map(found.map((i) => [i.key.toLowerCase(), i]))
    return keys.map((k) => byKey.get(k.toLowerCase())).filter((i): i is ApiIssue => !!i)
  }, [data, fromList, keys])

  if (collapsed) {
    return (
      <div className="hidden lg:flex flex-col items-center gap-2 w-9 py-2 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] self-start sticky top-20">
        <button type="button" onClick={onToggle} aria-label={tr('Show the issue list')} title={tr('Show the issue list')} className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
          <ChevronsRight className="w-4 h-4" />
        </button>
        <button type="button" onClick={onToggle} aria-label={tr('Issues')} title={tr('Issues')} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-2)]">
          <ListChecks className="w-4 h-4" />
        </button>
      </div>
    )
  }

  return (
    <aside
      aria-label={tr('Issues')}
      className="hidden lg:block sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--surface-3)] sticky top-0 bg-[var(--surface-0)]">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)]">{tr('Issues')}</p>
          <p className="text-caption text-[var(--text-tertiary)] truncate" title={fromList ? stored?.label : undefined}>
            {sort || fromList ? (stored?.label || tr('Your list')) : tr('Latest in {project}', { project: projectKey })}
          </p>
        </div>
        <button type="button" onClick={onToggle} className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label={tr('Hide the issue list')} title={tr('Hide the issue list')}>
          <ChevronsLeft className="w-4 h-4" />
        </button>
      </div>
      <OrderBy sort={sort} onChange={setSort} />
      {isLoading && <p className="px-3 py-3 text-caption text-[var(--text-tertiary)]">{tr('Loading…')}</p>}
      <ul>
        {issues.map((i) => {
          const current = i.key.toLowerCase() === issueKey.toLowerCase()
          return (
            <li key={i.id}>
              <Link
                href={`/issues/${i.key}`}
                aria-current={current ? 'page' : undefined}
                className={`block px-3 py-2 border-b border-[var(--surface-3)] last:border-b-0 hover:bg-[var(--surface-1)] ${current ? 'bg-[var(--surface-1)] border-l-2 border-l-[var(--brand-500)]' : ''}`}
              >
                <span className="flex items-center gap-2 text-caption text-[var(--text-tertiary)]">
                  <span className={`inline-block w-2 h-2 rounded-full ${dotClass(i.fields.status?.category)}`} aria-hidden="true" />
                  <span>{i.key}</span>
                  <span className="truncate">{i.fields.status?.name}</span>
                </span>
                <span className="block text-sm text-[var(--text-primary)] truncate" title={i.fields.summary}>{i.fields.summary}</span>
              </Link>
            </li>
          )
        })}
        {!isLoading && issues.length === 0 && <li className="px-3 py-3 text-caption text-[var(--text-tertiary)]">{tr('No issues')}</li>}
      </ul>
    </aside>
  )
}
