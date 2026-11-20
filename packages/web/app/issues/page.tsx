'use client'


import { getIntlLocale, relativeIntl } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { Fragment, useState, useEffect, useMemo, useRef } from 'react'
import { useMultiSort } from '@/lib/table-sort'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AppLayout } from '@/components/app-layout'
import { IssuePeek, PeekButton } from '@/components/issue/peek-view'
import { usePeek } from '@/hooks/use-peek'
import { EmptyState } from '@/components/empty-state'
import { StatusBadge } from '@/components/status-badge'
import { PriorityBadge } from '@/components/priority-badge'
import { IssueTypeGlyph } from '@/components/issue-type-glyph'
import { Avatar } from '@/components/avatar'
import { useIssues } from '@/hooks/use-issues'
import { useLiveInvalidation } from '@/hooks/use-realtime'
import { JqlInput } from '@/components/jql-input'
import { toast } from '@/components/toast'
import { useUndoableAction } from '@/hooks/use-undoable'
import { Skeleton } from '@/components/skeleton'
import { BulkChangeDialog } from '@/components/bulk-change-dialog'
import { runBulk } from '@/hooks/use-bulk'
import { mergeUndoResults, summarizeResult, undoGroups, type BulkResult } from '@/lib/bulk'
import { usePublishCommandTargets, useCommandLineStore } from '@/hooks/use-command-line'
import { IssueListPreview } from '@/components/issue-list-preview'
import { useShortcuts } from '@/hooks/use-shortcuts'
import { initialListNav, listNavReducer, reconcile, type ListNavAction, type ListNavState } from '@/lib/list-nav'
import { browserSessionStorage, saveIssueList } from '@/lib/issue-nav'
import {
  Plus,
  Download,
  Columns,
  ChevronLeft,
  ChevronRight,
  Filter,
  CheckSquare,
  Square,
  Save,
  Flag,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'

type FilterKey = 'all' | 'my' | 'reported' | 'watched'

const quickFilters: { key: FilterKey; label: string; jql: string }[] = [
  { key: 'all', label: 'All', jql: '' },
  { key: 'my', label: 'My Issues', jql: 'assignee = currentUser() AND status != Done' },
  { key: 'reported', label: 'Reported by Me', jql: 'reporter = currentUser()' },
  { key: 'watched', label: 'Watched', jql: 'watcher = currentUser()' },
]

interface SavedFilter {
  id: string
  name: string
  jql: string
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return relativeIntl(0, 'second') ?? 'just now'
  if (diffMins < 60) return relativeIntl(-diffMins, 'minute', 'short') ?? `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return relativeIntl(-diffHours, 'hour', 'short') ?? `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return relativeIntl(-diffDays, 'day', 'short') ?? `${diffDays}d ago`
  return d.toLocaleDateString(getIntlLocale())
}

function loadSavedFilters(): SavedFilter[] {
  try {
    return JSON.parse(localStorage.getItem('veqsio-saved-filters') || '[]')
  } catch {
    return []
  }
}

function saveSavedFilters(filters: SavedFilter[]) {
  localStorage.setItem('veqsio-saved-filters', JSON.stringify(filters))
}

import { useTerm } from '@/hooks/use-term'
import { Portal } from '@/components/portal'
import { promptDialog } from '@/components/dialogs'

const JQL_SORT_FIELDS: Record<string, string> = {
  key: 'key', summary: 'summary', type: 'issuetype', status: 'status', priority: 'priority',
  assignee: 'assignee', reporter: 'reporter', updated: 'updated', created: 'created',
}

export default function IssuesPage() {
  const { tr } = useI18n();

  const router = useRouter()
  const { t, Issues } = useTerm()
  const peek = usePeek()
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all')
  const [jql, setJql] = useState('')
  const [advancedMode, setAdvancedMode] = useState(false)

  // Deep links such as /issues?jql=... (used by the home page tiles) open straight in JQL mode.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('jql')
    if (fromUrl) {
      setAdvancedMode(true)
      setJqlText(fromUrl)
      setJql(fromUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [jqlText, setJqlText] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Row density of the list (S, M, L), remembered in this browser
  const [density, setDensityState] = useState<'s' | 'm' | 'l'>('m')
  useEffect(() => { try { const v = localStorage.getItem('issue-list-density'); if (v === 's' || v === 'm' || v === 'l') setDensityState(v) } catch { /* storage unavailable */ } }, [])
  const setDensity = (d: 's' | 'm' | 'l') => { setDensityState(d); try { localStorage.setItem('issue-list-density', d) } catch { /* ignore */ } }
  const rowSize = density === 's' ? 'py-0.5 min-h-[28px] text-[12px]' : density === 'l' ? 'py-3.5 min-h-[56px]' : 'py-2 min-h-[40px]'
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [nav, setNav] = useState<ListNavState>(initialListNav)
  const [editingId, setEditingId] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const filterBarRef = useRef<HTMLDivElement>(null)
  const idsRef = useRef<number[]>([])
  const urlReady = useRef(false)
  const dispatch = (a: ListNavAction) => setNav((s) => listNavReducer(s, a, idsRef.current))
  const selectedIssues = useMemo(() => new Set(nav.selected), [nav.selected])
  const setSelectedIssues = (set: Set<number>) => dispatch({ type: 'setSelection', ids: Array.from(set) })
  const [visibleColumns, setVisibleColumns] = useState<string[]>([
    'key',
    'summary',
    'status',
    'priority',
    'assignee',
    'updated',
  ])

  // Click a column header to sort (A-Z, Z-A, then back to the default order); Shift+click adds further sort columns.
  // Done in the query (ORDER BY a, b) so paging stays correct.
  const multiSort = useMultiSort()
  const orderJql = useMemo(() => {
    const parts = multiSort.keys.filter((k) => JQL_SORT_FIELDS[k.col]).map((k) => `${JQL_SORT_FIELDS[k.col]} ${k.dir.toUpperCase()}`)
    if (!parts.length) return jql
    return `${jql.replace(/\s*\border\s+by\b.*$/i, '').trim()} ORDER BY ${parts.join(', ')}`.trim()
  }, [jql, multiSort.keys])
  const { data, isLoading, error, refetch } = useIssues(orderJql)

  useEffect(() => {
    setSavedFilters(loadSavedFilters())
    // A query in the URL (?jql=...) comes from the command palette, a bookmark or the browser back button.
    try {
      const initial = new URLSearchParams(window.location.search).get('jql')
      if (initial) { setJql(initial); setJqlText(initial); setAdvancedMode(true) }
    } catch { /* no URL access: start with the default list */ }
    urlReady.current = true
  }, [])

  // Keep the active query in the URL so reload, back and shared links restore the list.
  useEffect(() => {
    if (!urlReady.current) return
    try {
      const url = new URL(window.location.href)
      if (jql) url.searchParams.set('jql', jql)
      else url.searchParams.delete('jql')
      window.history.replaceState(null, '', url.pathname + url.search)
    } catch { /* ignore */ }
  }, [jql])

  const issues = data?.issues || []
  // Live: the list follows what other people do in the projects it shows (new, changed and moved issues)
  const liveChannels = useMemo(() => [...new Set(issues.map((i) => i.fields.project?.id).filter(Boolean))].slice(0, 20).map((id) => `project:${id}`), [issues])
  useLiveInvalidation(liveChannels.length ? liveChannels : null, { queryKeys: [['issues', 'search']] })
  const total = data?.total || 0
  idsRef.current = issues.map((i) => i.id)

  useEffect(() => {
    setNav(initialListNav)
    setEditingId(null)
  }, [jql])

  // Drop selection, preview and focus of rows that disappeared after a refetch.
  const idKey = idsRef.current.join(',')
  useEffect(() => {
    setNav((s) => reconcile(s, idsRef.current))
  }, [idKey])

  // The issue view steps through this list with [ and ].
  useEffect(() => {
    if (issues.length > 0) saveIssueList(browserSessionStorage(), issues.map((i) => i.key), orderJql)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey, orderJql])

  const handleSearch = () => {
    const base = quickFilters.find((f) => f.key === activeFilter)?.jql || ''
    const parts = [base, search ? `text ~ "${search}"` : ''].filter(Boolean)
    setJql(parts.join(' AND '))
  }

  const handleFilterChange = (key: FilterKey) => {
    setActiveFilter(key)
    const base = quickFilters.find((f) => f.key === key)?.jql || ''
    const parts = [base, search ? `text ~ "${search}"` : ''].filter(Boolean)
    setJql(parts.join(' AND '))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  const toggleSelectAll = () => {
    if (selectedIssues.size === issues.length && issues.length > 0) {
      dispatch({ type: 'setSelection', ids: [] })
    } else {
      dispatch({ type: 'selectAll' })
    }
  }

  const toggleSelect = (id: number) => {
    const next = new Set(selectedIssues)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIssues(next)
  }

  /* ---- keyboard model (keys come from the issueList table in lib/shortcuts) ---- */
  const focusList = () => {
    if (document.activeElement !== listRef.current) listRef.current?.focus({ preventScroll: true })
  }
  const nudge = (a: ListNavAction) => { focusList(); dispatch(a) }
  const focusedIssue = nav.focus >= 0 ? issues[nav.focus] : undefined

  useShortcuts('issueList', {
    'issueList.focusSearch': () => {
      const el = filterBarRef.current?.querySelector<HTMLInputElement>('input, textarea')
      if (!el) return false
      el.focus()
      el.select?.()
    },
    'issueList.next': () => nudge({ type: 'move', delta: 1 }),
    'issueList.prev': () => nudge({ type: 'move', delta: -1 }),
    'issueList.first': () => nudge({ type: 'first' }),
    'issueList.last': () => nudge({ type: 'last' }),
    'issueList.extendDown': () => nudge({ type: 'move', delta: 1, extend: true }),
    'issueList.extendUp': () => nudge({ type: 'move', delta: -1, extend: true }),
    'issueList.toggleSelect': () => {
      if (!focusedIssue) return false
      dispatch({ type: 'toggleSelect' })
    },
    'issueList.open': () => {
      if (!focusedIssue) return false
      router.push(`/issues/${focusedIssue.key}`)
    },
    'issueList.peek': () => {
      if (!focusedIssue) return false
      peek.open(focusedIssue.key)
    },
    'issueList.expand': () => {
      if (issues.length === 0) return false
      focusList()
      setNav((s) => {
        const focused = s.focus < 0 ? listNavReducer(s, { type: 'focus', index: 0 }, idsRef.current) : s
        return listNavReducer(focused, { type: 'expand' }, idsRef.current)
      })
    },
    'issueList.collapse': () => {
      if (nav.expanded === null) return false
      dispatch({ type: 'collapse' })
      setEditingId(null)
    },
    'issueList.bulk': () => {
      if (selectedIssues.size === 0) return false
      setBulkOpen(true)
    },
    'issueList.edit': () => {
      if (issues.length === 0) return false
      focusList()
      const target = focusedIssue ?? issues[0]
      setNav((s) => {
        const focused = s.focus < 0 ? listNavReducer(s, { type: 'focus', index: 0 }, idsRef.current) : s
        return listNavReducer(focused, { type: 'expand' }, idsRef.current)
      })
      setEditingId(target.id)
    },
  })

  // keep the focused row visible while moving with the keyboard
  useEffect(() => {
    if (nav.focus < 0) return
    const id = idsRef.current[nav.focus]
    document.getElementById(`issue-row-${id}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [nav.focus])

  // Bulk change: one server-side request per run (see components/bulk-change-dialog.tsx and /rest/api/2/bulk/issues)
  const [bulkOpen, setBulkOpen] = useState(false)
  const bulkIssues = useMemo(
    () => issues.filter((i) => selectedIssues.has(i.id)).map((i) => ({ key: i.key, projectId: i.fields.project.id, projectKey: i.fields.project.key })),
    [issues, selectedIssues],
  )

  // The command line (Ctrl/Cmd+Alt+J) applies to the selected rows.
  usePublishCommandTargets(bulkIssues, () => setSelectedIssues(new Set()))

  const undoableAction = useUndoableAction()
  const undoBulk = async (r: BulkResult) => {
    try {
      const results: BulkResult[] = []
      for (const g of undoGroups(r)) results.push(await runBulk(g.issueKeys, g.operation, g.params))
      const { restored, failed } = mergeUndoResults(results)
      toast(failed ? tr('Restored {restored} issues; {failed} could not be restored', { restored, failed }) : restored === 1 ? tr('Restored {restored} issue', { restored }) : tr('Restored {restored} issues', { restored }), failed ? 'warning' : 'success')
    } catch (err: any) {
      toast(err?.message || tr('Undo failed'), 'error')
    }
    refetch()
  }

  const onBulkFinished = (r: BulkResult | null) => {
    if (!r) return
    refetch()
    // keep the issues that failed selected so they can be retried or changed another way
    const failedKeys = new Set(r.failed.map((f) => f.key))
    setSelectedIssues(new Set(issues.filter((i) => failedKeys.has(i.key)).map((i) => i.id)))
    const s = summarizeResult(r)
    if (s.canUndo) undoableAction({ message: s.headline, delayMs: 10_000, undo: () => undoBulk(r) })
    else if (s.succeeded > 0) toast(s.headline, s.failed ? 'warning' : 'success')
  }

  const exportCSV = () => {
    if (!issues.length) return
    const headers = visibleColumns
    const rows = issues.map((issue) =>
      headers.map((col) => {
        switch (col) {
          case 'key':
            return issue.key
          case 'summary':
            return issue.fields.summary
          case 'type':
            return issue.fields.issuetype?.name
          case 'status':
            return issue.fields.status?.name
          case 'priority':
            return issue.fields.priority?.name
          case 'assignee':
            return issue.fields.assignee?.displayName || 'Unassigned'
          case 'reporter':
            return issue.fields.reporter?.displayName || ''
          case 'updated':
            return issue.fields.updated
          case 'created':
            return issue.fields.created
          default:
            return ''
        }
      })
    )
    const csv = [
      headers.join(','),
      ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `issues-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast(tr('Exported to CSV'), 'success')
  }

  const saveFilter = async () => {
    const name = (await promptDialog(tr('Filter name:')))
    if (!name) return
    const next = [...savedFilters, { id: Math.random().toString(36).slice(2), name, jql }]
    setSavedFilters(next)
    saveSavedFilters(next)
    toast(tr('Filter saved'), 'success')
  }

  const allColumns = [
    { id: 'key', label: tr('Key') },
    { id: 'summary', label: tr('Summary') },
    { id: 'type', label: tr('Type') },
    { id: 'status', label: tr('Status') },
    { id: 'priority', label: tr('Priority') },
    { id: 'assignee', label: tr('Assignee') },
    { id: 'reporter', label: tr('Reporter') },
    { id: 'updated', label: tr('Updated') },
    { id: 'created', label: tr('Created') },
  ]

  // Column widths can be dragged in the header; they are remembered in the browser. Double-click resets one.
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  useEffect(() => {
    try { setColWidths(JSON.parse(window.localStorage.getItem('veqsio-issue-col-widths') || '{}')) } catch { /* ignore */ }
  }, [])
  const saveColWidths = (next: Record<string, number>) => {
    setColWidths(next)
    try { window.localStorage.setItem('veqsio-issue-col-widths', JSON.stringify(next)) } catch { /* private mode */ }
  }
  const startResize = (col: string, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const cell = e.currentTarget.parentElement as HTMLElement
    const startX = e.clientX
    const startW = cell.getBoundingClientRect().width
    let latest = startW
    const move = (ev: PointerEvent) => {
      latest = Math.max(60, Math.round(startW + ev.clientX - startX))
      setColWidths((cur) => ({ ...cur, [col]: latest }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      saveColWidths({ ...colWidthsRef.current, [col]: latest })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const colWidthsRef = useRef(colWidths)
  colWidthsRef.current = colWidths
  const resetColWidth = (col: string) => {
    const { [col]: _removed, ...rest } = colWidths
    saveColWidths(rest)
  }

  const columnWidth = (col: string) => {
    if (colWidths[col]) return `${colWidths[col]}px`
    switch (col) {
      case 'key':
        return '116px'
      case 'summary':
        return 'minmax(220px, 1fr)'
      case 'type':
        return '110px'
      case 'status':
        return '132px'
      case 'priority':
        return '104px'
      case 'assignee':
      case 'reporter':
        return '176px'
      case 'updated':
      case 'created':
        return '96px'
      default:
        return '120px'
    }
  }

  const gridTemplateColumns = `28px ${visibleColumns.map(columnWidth).join(' ')}`

  return (
    <AppLayout>
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-heading-1 text-[var(--text-primary)]">{Issues}</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCSV} className="veqsio-btn-secondary flex items-center gap-2">
              <Download className="w-4 h-4" />
              {tr('Export CSV')} </button>
            <Link href="/issues/create" className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('Create issue')} </Link>
          </div>
        </div>

        {/* Quick filters */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label={tr('Issue views')} className="inline-flex p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--surface-3)]">
            {quickFilters.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={activeFilter === f.key}
                onClick={() => handleFilterChange(f.key)}
                className={`px-3 py-1 rounded-md text-[13px] font-medium transition-colors ${
                  activeFilter === f.key
                    ? 'bg-[var(--surface-0)] text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {tr(f.label)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
          <div role="group" aria-label={tr('Row density')} className="hidden md:inline-flex p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--surface-3)]">
            {([['s', 'S', 'Compact rows'], ['m', 'M', 'Normal rows'], ['l', 'L', 'Roomy rows']] as const).map(([d, label, title]) => (
              <button key={d} type="button" aria-pressed={density === d} title={tr(title)} aria-label={tr(title)} onClick={() => setDensity(d)}
                className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${density === d ? 'bg-[var(--surface-0)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{label}</button>
            ))}
          </div>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-pressed={sidebarOpen}
            className="veqsio-btn-secondary text-[13px]"
          >
            <Filter className="w-3.5 h-3.5" />
            {tr('Filters and columns')} </button>
          </div>
        </div>

        <div className="flex gap-4">
          {/* Sidebar */}
          <div
            className={`${sidebarOpen ? 'w-64 flex-shrink-0' : 'w-0 overflow-hidden'} transition-all duration-300`}
          >
            <div className="space-y-4">
              <div className="veqsio-card">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-heading-3 text-[var(--text-primary)] flex items-center gap-2">
                    <Filter className="w-4 h-4" />
                    {tr('Saved Filters')} </h3>
                  <button onClick={() => setSidebarOpen(false)} aria-label={tr('Close filters')} className="veqsio-btn-ghost p-1 lg:hidden">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </div>
                {savedFilters.length === 0 ? (
                  <p className="text-caption text-[var(--text-secondary)]">{tr('No saved filters yet.')}</p>
                ) : (
                  <div className="space-y-1">
                    {savedFilters.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setJql(f.jql)}
                        className="w-full text-left px-2 py-1.5 rounded text-body-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={saveFilter}
                  className="mt-2 w-full flex items-center justify-center gap-1 text-caption text-[var(--brand-500)] hover:underline"
                >
                  <Save className="w-3 h-3" /> {tr('Save current filter')} </button>
              </div>

              <div className="veqsio-card">
                <h3 className="text-heading-3 text-[var(--text-primary)] flex items-center gap-2 mb-2">
                  <Columns className="w-4 h-4" />
                  {tr('Columns')} </h3>
                <div className="space-y-1">
                  {allColumns.map((col) => (
                    <label
                      key={col.id}
                      className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-[var(--surface-2)] transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={visibleColumns.includes(col.id)}
                        onChange={(e) => {
                          if (e.target.checked)
                            setVisibleColumns([...visibleColumns, col.id])
                          else setVisibleColumns(visibleColumns.filter((c) => c !== col.id))
                        }}
                        className="w-4 h-4 rounded border-[var(--surface-4)] text-[var(--brand-500)] focus:ring-[var(--brand-500)]"
                      />
                      <span className="text-body-sm text-[var(--text-secondary)]">{tr(col.label)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Main table */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* Filters bar */}
            <div ref={filterBarRef} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 p-2 bg-[var(--surface-1)] rounded-lg border border-[var(--surface-3)]">
              {advancedMode ? (
                <JqlInput
                  value={jqlText}
                  onChange={setJqlText}
                  onSubmit={() => setJql(jqlText.trim())}
                  placeholder={tr('Enter JQL, e.g. project = DEMO AND status = "In Progress"')}
                />
              ) : (
                <input
                  type="text"
                  placeholder={t('Search issues…  ( / )')}
                  aria-label={t('Search issues')}
                  className="veqsio-input flex-1"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
              )}
              <button
                onClick={() => (advancedMode ? setJql(jqlText.trim()) : handleSearch())}
                className="veqsio-btn-secondary"
              >
                {tr('Search')} </button>
              <button
                onClick={() => {
                  if (!advancedMode) setJqlText(jql)
                  setAdvancedMode(!advancedMode)
                }}
                className="veqsio-btn-ghost text-caption whitespace-nowrap"
              >
                {advancedMode ? tr('Basic') : tr('Advanced (JQL)')}
              </button>
            </div>

            {/* Bulk actions */}
            {selectedIssues.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 p-2 bg-[var(--brand-50)] rounded-lg border border-[var(--brand-100)]" role="region" aria-label={tr('Bulk actions')}>
                <span className="text-body-sm text-[var(--text-primary)] font-medium px-2" aria-live="polite">
                  {selectedIssues.size} {tr('selected')}
                </span>
                <button onClick={() => setBulkOpen(true)} className="veqsio-btn-primary text-xs" aria-keyshortcuts="b">
                  {tr('Bulk change...')} </button>
                <button onClick={() => useCommandLineStore.getState().openBar()} className="veqsio-btn-secondary text-xs" aria-keyshortcuts="Control+Alt+J Meta+Alt+J" title={tr('Command line (Ctrl/Cmd+Alt+J)')}>
                  {tr('Command line...')} </button>
                <button onClick={() => setSelectedIssues(new Set())} className="veqsio-btn-ghost text-xs">
                  {tr('Clear selection')} </button>
              </div>
            )}
            <Portal><BulkChangeDialog open={bulkOpen} issues={bulkIssues} onClose={() => setBulkOpen(false)} onFinished={onBulkFinished} /></Portal>

            {/* Phones: one card per issue instead of a wide table (the table below is for tablets and up) */}
            {!isLoading && !error && issues.length > 0 && (
              <ul aria-label={tr('Issues')} className="md:hidden space-y-2">
                {issues.map((issue) => (
                  <li
                    key={issue.id}
                    className={`rounded-xl border bg-[var(--surface-0)] ${selectedIssues.has(issue.id) ? 'border-[var(--brand-500)] bg-[var(--brand-50)]' : issue.fields.flagged ? 'border-[var(--warning)]' : 'border-[var(--surface-3)]'}`}
                  >
                    <div className="flex items-start gap-1 p-1.5">
                      <button
                        type="button"
                        aria-label={tr('Select {key}', { key: issue.key })}
                        aria-pressed={selectedIssues.has(issue.id)}
                        onClick={() => toggleSelect(issue.id)}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                      >
                        {selectedIssues.has(issue.id) ? <CheckSquare className="w-5 h-5 text-[var(--brand-500)]" /> : <Square className="w-5 h-5 text-[var(--text-tertiary)]" />}
                      </button>
                      <Link href={`/issues/${issue.key}`} className="min-w-0 flex-1 py-1.5 pr-2 focus-visible:outline-none">
                        <span className="flex items-center gap-2">
                          <IssueTypeGlyph name={issue.fields.issuetype?.name ?? ''} />
                          <span className="text-caption font-medium text-[var(--text-secondary)]">{issue.key}</span>
                          <span className="ml-auto"><StatusBadge status={issue.fields.status?.name} category={issue.fields.status?.category as any} /></span>
                        </span>
                        <span className="mt-1.5 block text-body-sm font-medium text-[var(--text-primary)] line-clamp-2">{issue.fields.summary}</span>
                        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--text-secondary)]">
                          {issue.fields.priority && <PriorityBadge priority={issue.fields.priority.name} />}
                          <span className="flex min-w-0 items-center gap-1.5">
                            {issue.fields.assignee?.displayName
                              ? <><Avatar name={issue.fields.assignee.displayName} size="sm" /><span className="truncate">{issue.fields.assignee.displayName}</span></>
                              : <span className="text-[var(--text-tertiary)]">{tr('Unassigned')}</span>}
                          </span>
                          <span className="ml-auto text-[var(--text-tertiary)]">{timeAgo(issue.fields.updated)}</span>
                        </span>
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* Table */}
            <div className={`border border-[var(--surface-3)] rounded-lg overflow-hidden ${!isLoading && !error && issues.length > 0 ? 'hidden md:block' : ''}`}>
              <div className="overflow-x-auto">
                <div className="min-w-[700px]">
                  <div
                    className="grid gap-4 items-center px-4 py-2 bg-[var(--surface-1)] border-b border-[var(--surface-3)] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]"
                    style={{ gridTemplateColumns: gridTemplateColumns }}
                  >
                    <div className="flex items-center justify-center">
                      <button
                        onClick={toggleSelectAll}
                        aria-label={tr('Select all issues')}
                        className="p-1 hover:bg-[var(--surface-2)] rounded transition-colors"
                      >
                        {selectedIssues.size === issues.length && issues.length > 0 ? (
                          <CheckSquare className="w-4 h-4 text-[var(--brand-500)]" />
                        ) : (
                          <Square className="w-4 h-4 text-[var(--text-tertiary)]" />
                        )}
                      </button>
                    </div>
                    {visibleColumns.map((col) => {
                      const dir = multiSort.dirOf(col)
                      const rank = multiSort.rankOf(col)
                      return (
                        <div key={col} className="relative min-w-0" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
                          {JQL_SORT_FIELDS[col] ? (
                            <button type="button" onClick={(e) => multiSort.toggle(col, e)} title={tr('Click to sort. Shift+click to sort by several columns.')} className="inline-flex max-w-full items-center gap-1 uppercase hover:text-[var(--text-primary)]">
                              {tr(allColumns.find((c) => c.id === col)?.label ?? '')}
                              {dir === 'asc' && <ArrowUp className="h-3 w-3" aria-hidden />}
                              {dir === 'desc' && <ArrowDown className="h-3 w-3" aria-hidden />}
                              {rank !== undefined && <span className="rounded bg-[var(--surface-2)] px-1 text-[10px] leading-4 normal-case" aria-label={tr('sort priority {rank}', { rank })}>{rank}</span>}
                            </button>
                          ) : tr(allColumns.find((c) => c.id === col)?.label ?? '')}
                          <div
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={tr('Resize {name} column', { name: tr(allColumns.find((c) => c.id === col)?.label ?? '') })}
                            title={tr('Drag to resize, double-click to reset')}
                            onPointerDown={(e) => startResize(col, e)}
                            onDoubleClick={() => resetColWidth(col)}
                            className="absolute -right-2 top-[-8px] bottom-[-8px] w-3 cursor-col-resize touch-none after:absolute after:left-1/2 after:top-1 after:bottom-1 after:w-px after:bg-[var(--surface-3)] hover:after:bg-[var(--brand-500)] hover:after:w-0.5"
                          />
                        </div>
                      )
                    })}
                  </div>

                  {isLoading && (
                    <div className="divide-y divide-[var(--surface-3)]" role="status" aria-busy="true" aria-label={tr('Loading issues')}>
                      {Array.from({ length: 6 }, (_, i) => (
                        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                          <Skeleton className="h-4 w-20" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-5 w-24 rounded-full" /><Skeleton className="h-4 w-16" />
                        </div>
                      ))}
                    </div>
                  )}

                  {error && (
                    <div className="flex items-center justify-center py-12 px-4 text-center">
                      <div className="text-[var(--error)] text-body">
                        {error.message || t('Failed to load issues')}
                      </div>
                    </div>
                  )}

                  {!isLoading && !error && issues.length === 0 && (
                    <div className="py-12">
                      <EmptyState
                        icon="inbox"
                        title={t('No issues found')}
                        description={
                          search
                            ? tr('Try a different search query.')
                            : t('Use Create issue above to add the first one.')
                        }
                      />
                    </div>
                  )}

                  {!isLoading && !error && issues.length > 0 && (
                  <div
                    ref={listRef}
                    role="listbox"
                    aria-label={tr('Issues')}
                    aria-multiselectable="true"
                    aria-activedescendant={nav.focus >= 0 && issues[nav.focus] ? `issue-row-${issues[nav.focus].id}` : undefined}
                    tabIndex={0}
                    className="veqsio-list outline-none"
                    onFocus={(e) => { if (e.target === e.currentTarget && nav.focus < 0) dispatch({ type: 'focus', index: 0 }) }}
                  >
                  {issues.map((issue, rowIndex) => (
                    <Fragment key={issue.id}>
                      <div
                        id={`issue-row-${issue.id}`}
                        role="option"
                        aria-selected={selectedIssues.has(issue.id)}
                        data-focused={nav.focus === rowIndex || undefined}
                        className={`group grid gap-4 items-center px-4 ${rowSize} border-b border-[var(--surface-3)] last:border-b-0 cursor-pointer transition-colors ${nav.focus === rowIndex ? 'veqsio-row-focus' : ''} ${
                          selectedIssues.has(issue.id) ? 'bg-[var(--brand-50)]' : issue.fields.flagged ? 'bg-[var(--warning)]/10 hover:bg-[var(--warning)]/15' : 'bg-[var(--surface-0)] hover:bg-[var(--surface-1)]'
                        }`}
                        style={{ gridTemplateColumns: gridTemplateColumns }}
                        onClick={() => router.push(`/issues/${issue.key}`)}
                        onMouseDown={(e) => { if (e.button === 0) dispatch({ type: 'focus', index: rowIndex }) }}
                      >
                        <div className="flex items-center justify-center">
                          <button
                            tabIndex={-1}
                            aria-label={tr('Select {key}', { key: issue.key })}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleSelect(issue.id)
                            }}
                            className="p-1 hover:bg-[var(--surface-2)] rounded transition-colors"
                          >
                            {selectedIssues.has(issue.id) ? (
                              <CheckSquare className="w-4 h-4 text-[var(--brand-500)]" />
                            ) : (
                              <Square className="w-4 h-4 text-[var(--text-tertiary)]" />
                            )}
                          </button>
                        </div>
                        {visibleColumns.map((col) => {
                          switch (col) {
                            case 'key':
                              return (
                                <div key={col} className="flex items-center gap-2 min-w-0">
                                  <IssueTypeGlyph name={issue.fields.issuetype?.name} />
                                  <span className="text-[12px] font-medium text-[var(--text-secondary)] tabular-nums truncate">
                                    {issue.key}
                                  </span>
                                  {issue.fields.flagged && <Flag className="w-3.5 h-3.5 shrink-0 text-[var(--warning)]" aria-label={tr('Flagged')} />}
                                  <PeekButton issueKey={issue.key} onPeek={peek.open} tabbable={false} className="ml-auto shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100 focus-visible:opacity-100" />
                                </div>
                              )
                            case 'summary':
                              return (
                                <div
                                  key={col}
                                  className="text-[13px] font-medium text-[var(--text-primary)] truncate"
                                  title={issue.fields.summary}
                                >
                                  {issue.fields.summary}
                                </div>
                              )
                            case 'type':
                              return (
                                <div
                                  key={col}
                                  className="text-caption text-[var(--text-secondary)]"
                                >
                                  {issue.fields.issuetype?.name}
                                </div>
                              )
                            case 'status':
                              return (
                                <div key={col}>
                                  <StatusBadge
                                    status={issue.fields.status?.name}
                                    category={
                                      issue.fields.status
                                        ?.category as any
                                    }
                                  />
                                </div>
                              )
                            case 'priority':
                              return (
                                <div key={col}>
                                  {issue.fields.priority ? (
                                    <PriorityBadge
                                      priority={issue.fields.priority.name}
                                    />
                                  ) : (
                                    <span className="text-[12px] text-[var(--text-tertiary)]">{tr('None')}</span>
                                  )}
                                </div>
                              )
                            case 'assignee':
                              return (
                                <div key={col} className="flex items-center gap-2 min-w-0 text-[12px] text-[var(--text-secondary)]">
                                  {issue.fields.assignee?.displayName ? (
                                    <>
                                      <Avatar name={issue.fields.assignee.displayName} size="sm" />
                                      <span className="truncate">{issue.fields.assignee.displayName}</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="w-5 h-5 rounded-full border border-dashed border-[var(--surface-4)] shrink-0" aria-hidden="true" />
                                      <span className="text-[var(--text-tertiary)]">{tr('Unassigned')}</span>
                                    </>
                                  )}
                                </div>
                              )
                            case 'reporter':
                              return (
                                <div
                                  key={col}
                                  className="text-caption text-[var(--text-secondary)]"
                                >
                                  {issue.fields.reporter?.displayName || ''}
                                </div>
                              )
                            case 'updated':
                              return (
                                <div
                                  key={col}
                                  className="text-caption text-[var(--text-tertiary)]"
                                >
                                  {timeAgo(issue.fields.updated)}
                                </div>
                              )
                            case 'created':
                              return (
                                <div
                                  key={col}
                                  className="text-caption text-[var(--text-tertiary)]"
                                >
                                  {timeAgo(issue.fields.created)}
                                </div>
                              )
                            default:
                              return null
                          }
                        })}
                      </div>
                      {nav.expanded === issue.id && (
                        <IssueListPreview
                          id={`issue-preview-${issue.id}`}
                          issue={issue}
                          editing={editingId === issue.id}
                          onStopEditing={() => { setEditingId(null); focusList() }}
                          onClose={() => { dispatch({ type: 'collapse' }); focusList() }}
                        />
                      )}
                    </Fragment>
                  ))}
                  </div>
                  )}
                </div>
              </div>
            </div>

            {!isLoading && !error && issues.length > 0 && (
              <p className="text-caption text-[var(--text-tertiary)] text-center">
                {tr('Showing')} {issues.length} {tr('of')} {total} {tr('issues')}
              </p>
            )}
          </div>
        </div>
      </div>
      <Portal><IssuePeek peekKey={peek.peekKey} onClose={peek.close} /></Portal>
    </AppLayout>
  )
}
