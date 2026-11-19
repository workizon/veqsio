'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { DraggableBoardCard, DroppableColumn } from '@/components/board-dnd'
import { useMoveToStatus } from '@/hooks/use-status-move'
import { TransitionDialog } from '@/components/issue/status-transition'
import type { ApiTransition } from '@/hooks/use-issues'
import { usePublishCommandTargets, useCommandLineStore } from '@/hooks/use-command-line'
import { Skeleton } from '@/components/skeleton'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { PriorityBadge } from '@/components/priority-badge'
import { normalizeCardLayout } from '@/lib/card-layout'
import { BoardCard } from '@/components/board-card'
import { IssuePeek, PeekButton } from '@/components/issue/peek-view'
import { usePeek } from '@/hooks/use-peek'
import { useIssues, useStatuses, usePriorities, useUpdateIssue } from '@/hooks/use-issues'
import { toast } from '@/components/toast'
import { buildLegend, colourFor, needsRuleLookup, normalizeCardColour } from '@/lib/card-colours'
import { useUsers } from '@/hooks/use-admin'
import { useBoards, useBoard, useFilter } from '@/hooks/use-boards'
import { useLiveInvalidation, usePresence } from '@/hooks/use-realtime'
import { PresenceAvatars } from '@/components/presence-avatars'
import Link from 'next/link'
import { useShortcuts } from '@/hooks/use-shortcuts'
import {
  Search,
  X,
  Filter,
  User,
  Tag,
  Flag,
  Plus,
  Layout,
  ListFilter,
  Settings,
  Terminal,
  ChevronDown,
  AlertTriangle,
} from 'lucide-react'
import { BoardSettingsModal } from '@/components/board-settings-modal'

import { useTerm } from '@/hooks/use-term'
import { Portal } from '@/components/portal'

/** Drag with a mouse or a pen only. On a touchscreen a sideways move is a swipe (see SwipeCard) and a vertical one scrolls. */
class MousePointerSensor extends PointerSensor {
  static activators = [{
    eventName: 'onPointerDown' as const,
    handler: ({ nativeEvent: e }: { nativeEvent: PointerEvent }) => e.pointerType !== 'touch' && e.isPrimary && e.button === 0,
  }] as any
}

export default function BoardPage() {
  const { t } = useTerm()
  const peek = usePeek()
  const { data: boardsData, isLoading: boardsLoading } = useBoards()
  const boards = boardsData?.values || []

  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [filterAssignee, setFilterAssignee] = useState<string | null>(null)
  const [filterPriority, setFilterPriority] = useState<string | null>(null)
  const [filterLabel, setFilterLabel] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [showBoardSettings, setShowBoardSettings] = useState(false)
  const [activeQuickFilters, setActiveQuickFilters] = useState<Set<string>>(new Set())
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const updateIssue = useUpdateIssue()
  const toggleFlag = (key: string, flagged: boolean) => {
    updateIssue.mutate({ key, fields: { flagged } }, {
      onSuccess: () => toast(flagged ? `${key} flagged` : `Flag removed from ${key}`, 'success'),
      onError: (e: any) => toast(e?.message || 'Could not change the flag', 'error'),
    })
  }

  // Auto-select first board when list loads
  useEffect(() => {
    if (boards.length > 0 && !selectedBoardId) {
      // ?board=ID comes from the command palette
      const wanted = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('board') : null
      setSelectedBoardId(boards.find((b) => String(b.id) === wanted)?.id ?? boards[0].id)
    }
  }, [boards, selectedBoardId])

  const searchRef = useRef<HTMLInputElement>(null)
  useShortcuts('board', { 'board.focusSearch': () => { searchRef.current?.focus() } })

  const { data: board, isLoading: boardLoading } = useBoard(selectedBoardId ?? '')
  const boardChannel = selectedBoardId ? `board:${selectedBoardId}` : null
  useLiveInvalidation(boardChannel, { queryKeys: [['board', selectedBoardId], ['issues', 'search']], toastOthers: true })
  const boardViewers = usePresence(boardChannel)
  const { data: filterData, isLoading: filterLoading } = useFilter(board?.filterId ?? null)

  // Scrum boards show the issues of their active sprint(s); Kanban boards show everything the filter matches
  const isScrum = board?.type === 'scrum'
  const activeSprintsQ = useQuery<number[], Error>({
    queryKey: ['board-active-sprints', selectedBoardId],
    enabled: !!selectedBoardId && isScrum,
    staleTime: 0,
    queryFn: async () => {
      const res = await fetch(`/rest/agile/1.0/board/${selectedBoardId}/sprint?state=active`, { credentials: 'include' })
      if (!res.ok) throw new Error('Could not load the active sprint')
      const body = await res.json()
      return (body.values ?? []).map((s: { id: number }) => s.id)
    },
  })
  const activeSprintIds = activeSprintsQ.data
  const noActiveSprint = isScrum && activeSprintsQ.isSuccess && (activeSprintIds?.length ?? 0) === 0

  // Build JQL from board project/filter + active quick filters
  const jql = useMemo(() => {
    if (!board) return ''
    const parts: string[] = []
    if (isScrum) {
      if (!activeSprintIds || activeSprintIds.length === 0) return 'key = __loading__'
      parts.push(`sprint in (${activeSprintIds.join(',')})`)
    }
    if (board.filterId) {
      if (filterData?.jql) {
        parts.push(`(${filterData.jql})`)
      } else {
        // Filter JQL not loaded yet; return no-op query so we don't fetch everything
        return 'key = __loading__'
      }
    } else {
      parts.push(`project = ${board.projectId}`)
    }
    board.quickFilters?.forEach((qf) => {
      if (activeQuickFilters.has(qf.id)) {
        parts.push(qf.jql)
      }
    })
    return parts.join(' AND ')
  }, [board, filterData, activeQuickFilters, isScrum, activeSprintIds])

  const {
    data: issuesData,
    isLoading: issuesLoading,
    error: issuesError,
  } = useIssues(jql, !!board)

  const { data: statusesData, isLoading: statusesLoading } = useStatuses()
  const { data: usersData } = useUsers()
  const { data: prioritiesData } = usePriorities()

  const isLoading = boardsLoading || boardLoading || filterLoading || issuesLoading || statusesLoading || (isScrum && activeSprintsQ.isLoading)
  const statuses = statusesData || []
  const issues = issuesData?.issues || []
  const users = usersData?.values || []
  const priorities = prioritiesData || []

  // Selection for the command line (checkbox on a card, or Shift/Ctrl-click) and drag-and-drop between columns.
  const qc = useQueryClient()
  const moveToStatus = useMoveToStatus()
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [dragKey, setDragKey] = useState<string | null>(null)
  // A move whose only route needs input (a resolution, a comment, a screen) opens the same dialog as the status button of the issue.
  const [pendingMove, setPendingMove] = useState<{ key: string; fromStatus: { name: string; category?: string | null }; transition: ApiTransition } | null>(null)
  const sensors = useSensors(useSensor(MousePointerSensor, { activationConstraint: { distance: 8 } }))
  const toggleSelect = (key: string) => setSelectedKeys((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const commandTargets = useMemo(
    () => issues.filter((i) => selectedKeys.has(i.key)).map((i) => ({ key: i.key, projectId: i.fields.project.id, projectKey: i.fields.project.key })),
    [issues, selectedKeys],
  )
  usePublishCommandTargets(commandTargets, () => setSelectedKeys(new Set()))

  const onDragEnd = (e: DragEndEvent) => {
    setDragKey(null)
    const over = e.over ? String(e.over.id) : ''
    if (!over.startsWith('column:')) return
    const issue = issues.find((i) => i.key === String(e.active.id))
    const column = boardColumns.find((c) => `column:${c.id}` === over)
    if (issue && column) moveIssueToColumn(issue, column)
  }
  /** Moves a card to a column through the issue's workflow: by dragging, by swiping on a phone, or from the card menu. */
  const moveIssueToColumn = (issue: (typeof issues)[number], column: (typeof boardColumns)[number]) => {
    if (issue.fields.status.id === column.statusId) return
    const key = issue.key
    const target = statuses.find((s) => s.id === String(column.statusId))
    const qk = ['issues', 'search', jql]
    void moveToStatus({
      key,
      fromName: issue.fields.status.name,
      toStatusId: Number(column.statusId),
      toName: target?.name ?? column.name,
      onNeedsInput: (transition) => setPendingMove({ key, fromStatus: { name: issue.fields.status.name, category: (issue.fields.status as { category?: string | null }).category }, transition }),
      optimistic: () => {
        void qc.cancelQueries({ queryKey: qk })
        const prev = qc.getQueryData<any>(qk)
        if (prev) {
          qc.setQueryData(qk, {
            ...prev,
            issues: prev.issues.map((i: any) => i.key === key ? { ...i, fields: { ...i.fields, status: { ...i.fields.status, id: column.statusId, name: target?.name ?? column.name, ...(target ? { category: (target as any).category ?? i.fields.status.category } : {}) } } } : i),
          })
        }
        return () => { if (prev) qc.setQueryData(qk, prev) }
      },
    })
  }
  const draggedIssue = dragKey ? issues.find((i) => i.key === dragKey) : null

  // Collect all unique labels from issues
  const allLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const issue of issues) {
      for (const label of issue.fields.labels || []) {
        labels.add(label)
      }
    }
    return Array.from(labels).sort()
  }, [issues])

  // Client-side search + filters
  const filteredIssues = useMemo(() => {
    return issues.filter((issue) => {
      const matchesSearch =
        !searchText ||
        issue.key.toLowerCase().includes(searchText.toLowerCase()) ||
        issue.fields.summary.toLowerCase().includes(searchText.toLowerCase())
      const matchesAssignee =
        !filterAssignee ||
        (filterAssignee === 'unassigned' && !issue.fields.assignee) ||
        issue.fields.assignee?.displayName === filterAssignee
      const matchesPriority =
        !filterPriority || issue.fields.priority?.name === filterPriority
      const matchesLabel =
        !filterLabel || issue.fields.labels?.includes(filterLabel)
      const matchesFlag = !onlyFlagged || issue.fields.flagged === true
      return matchesSearch && matchesAssignee && matchesPriority && matchesLabel && matchesFlag
    })
  }, [issues, searchText, filterAssignee, filterPriority, filterLabel, onlyFlagged])

  // Card colours (board setting). Rule colouring is evaluated by the server with the JQL engine.
  const cardColour = useMemo(() => normalizeCardColour(board?.config), [board])
  const colourKeys = useMemo(() => issues.map((i) => i.key).sort(), [issues])
  const ruleLookup = useQuery<Record<string, number>, Error>({
    queryKey: ['card-colours', selectedBoardId, colourKeys.join(','), JSON.stringify(cardColour.rules)],
    enabled: !!selectedBoardId && needsRuleLookup(cardColour) && colourKeys.length > 0,
    queryFn: async () => {
      const res = await fetch(`/rest/agile/1.0/board/${selectedBoardId}/card-colours`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: colourKeys }),
      })
      if (!res.ok) throw new Error('Could not evaluate the card colour rules')
      return (await res.json()).colours
    },
  })
  const ruleMatches = ruleLookup.data ?? {}
  const legend = useMemo(() => buildLegend(cardColour, filteredIssues, ruleMatches), [cardColour, filteredIssues, ruleMatches])
  const cardLayout = useMemo(() => normalizeCardLayout(board?.config), [board])
  const cardProps = (issue: (typeof issues)[number]) => {
    const c = colourFor(cardColour, issue, ruleMatches)
    return { colour: c?.token ?? null, colourReason: c ? `${c.reason}` : undefined, onToggleFlag: toggleFlag, layout: cardLayout }
  }

  const issuesByStatus: Record<string, typeof issues> = useMemo(() => {
    const map: Record<string, typeof issues> = {}
    for (const issue of filteredIssues) {
      const statusName = issue.fields.status.name
      if (!map[statusName]) map[statusName] = []
      map[statusName].push(issue)
    }
    return map
  }, [filteredIssues])

  // Fallback columns when no board is selected or board has no columns
  const fallbackColumns = useMemo(() => {
    if (statuses.length > 0) {
      return statuses.map((s) => s.name)
    }
    return Array.from(new Set(filteredIssues.map((i) => i.fields.status.name)))
  }, [statuses, filteredIssues])

  // Board columns sorted by sortOrder
  const boardColumns = useMemo(() => {
    if (!board?.columns) return []
    return [...board.columns].sort((a, b) => a.sortOrder - b.sortOrder)
  }, [board])

  const activeFilterCount = [
    filterAssignee,
    filterPriority,
    filterLabel,
  ].filter(Boolean).length

  const clearFilters = () => {
    setSearchText('')
    setFilterAssignee(null)
    setFilterPriority(null)
    setFilterLabel(null)
  }

  const toggleQuickFilter = (id: string) => {
    setActiveQuickFilters((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const clearQuickFilters = () => {
    setActiveQuickFilters(new Set())
  }

  const selectedBoard = boards.find((b) => b.id === selectedBoardId)

  return (
    <AppLayout>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <Breadcrumb items={[{ label: 'Boards' }]} />
            <div className="flex items-center gap-3 mt-2">
              <h1 className="text-heading-1 text-[var(--text-primary)]">Board</h1>
              <PresenceAvatars users={boardViewers} />
              {boards.length > 0 && (
                <div className="relative">
                  <select
                    aria-label="Board"
                    value={selectedBoardId || ''}
                    onChange={(e) => setSelectedBoardId(e.target.value || null)}
                    className="veqsio-input text-sm pr-8 appearance-none"
                  >
                    {boards.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)] pointer-events-none" />
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`veqsio-btn-secondary flex items-center gap-2 ${activeFilterCount > 0 ? 'border-[var(--brand-500)] text-[var(--brand-500)]' : ''}`}
            >
              <ListFilter className="w-4 h-4" />
              Filters
              {activeFilterCount > 0 && (
                <span className="bg-[var(--brand-500)] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setShowBoardSettings(true)}
              className="veqsio-btn-secondary flex items-center gap-2"
              title="Board settings"
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>
            <button
              type="button"
              onClick={() => useCommandLineStore.getState().openBar()}
              className="veqsio-btn-secondary flex items-center gap-2"
              title="Command line for the selected cards (Ctrl/Cmd+Alt+J)"
              aria-keyshortcuts="Control+Alt+J Meta+Alt+J"
            >
              <Terminal className="w-4 h-4" aria-hidden="true" />
              Command{selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ''}
            </button>
            <Link href="/issues/create" className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Create issue
            </Link>
          </div>
        </div>

        {/* No boards prompt */}
        {!boardsLoading && boards.length === 0 && (
          <div className="veqsio-card p-6 flex items-center gap-4">
            <Layout className="w-8 h-8 text-[var(--brand-500)]" />
            <div className="flex-1">
              <h3 className="text-heading-3 text-[var(--text-primary)]">No boards yet</h3>
              <p className="text-body-sm text-[var(--text-secondary)]">
                Create a board in a project to organize issues into columns.
              </p>
            </div>
            <Link href="/projects" className="veqsio-btn-primary">
              Go to Projects
            </Link>
          </div>
        )}

        {/* Search + Filters */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
            <input
              ref={searchRef}
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search issues on this board..."
              className="veqsio-input w-full pl-10 pr-10"
            />
            {searchText && (
              <button
                onClick={() => setSearchText('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
            {board && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOnlyFlagged((v) => !v)}
                  aria-pressed={onlyFlagged}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors inline-flex items-center gap-1.5 ${
                    onlyFlagged
                      ? 'bg-[var(--warning)] text-white'
                      : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
                  }`}
                >
                  <Flag className="w-3.5 h-3.5" aria-hidden="true" /> Only flagged
                </button>
                {(board.quickFilters ?? [])
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((qf) => {
                    const isActive = activeQuickFilters.has(qf.id)
                    return (
                      <button
                        key={qf.id}
                        onClick={() => toggleQuickFilter(qf.id)}
                        className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                          isActive
                            ? 'bg-[var(--brand-500)] text-white'
                            : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
                        }`}
                      >
                        {qf.name}
                      </button>
                    )
                  })}
                {activeQuickFilters.size > 0 && (
                  <button
                    onClick={clearQuickFilters}
                    className="text-caption text-[var(--brand-500)] hover:underline ml-2"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {showFilters && (
            <div className="veqsio-card space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-body-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
                  <Filter className="w-4 h-4" /> Quick Filters
                </span>
                {activeFilterCount > 0 && (
                  <button
                    onClick={clearFilters}
                    className="text-caption text-[var(--brand-500)] hover:underline"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Assignee filter */}
                <div>
                  <label className="text-caption text-[var(--text-tertiary)] flex items-center gap-1 mb-1">
                    <User className="w-3 h-3" /> Assignee
                  </label>
                  <select
                    value={filterAssignee || ''}
                    onChange={(e) => setFilterAssignee(e.target.value || null)}
                    className="veqsio-input w-full text-sm"
                  >
                    <option value="">All assignees</option>
                    <option value="unassigned">Unassigned</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.displayName || u.name}>
                        {u.displayName || u.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Priority filter */}
                <div>
                  <label className="text-caption text-[var(--text-tertiary)] flex items-center gap-1 mb-1">
                    <Flag className="w-3 h-3" /> Priority
                  </label>
                  <select
                    value={filterPriority || ''}
                    onChange={(e) => setFilterPriority(e.target.value || null)}
                    className="veqsio-input w-full text-sm"
                  >
                    <option value="">All priorities</option>
                    {priorities.map((p) => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {/* Label filter */}
                <div>
                  <label className="text-caption text-[var(--text-tertiary)] flex items-center gap-1 mb-1">
                    <Tag className="w-3 h-3" /> Label
                  </label>
                  <select
                    value={filterLabel || ''}
                    onChange={(e) => setFilterLabel(e.target.value || null)}
                    className="veqsio-input w-full text-sm"
                  >
                    <option value="">All labels</option>
                    {allLabels.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>

        {legend.length > 0 && (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--text-secondary)]" aria-label={`Card colours by ${cardColour.by}`} data-testid="card-colour-legend">
            <li className="text-[var(--text-tertiary)]">Colour by {cardColour.by === 'issuetype' ? 'issue type' : cardColour.by === 'rules' ? 'rules' : cardColour.by}:</li>
            {legend.map((l) => (
              <li key={`${l.token}-${l.label}`} className="inline-flex items-center gap-1.5">
                <span className="h-3 w-1 rounded-sm" style={{ background: `var(--label-${l.token}-dot)` }} aria-hidden="true" />
                {l.label} <span className="tabular-nums text-[var(--text-tertiary)]">{l.count}</span>
              </li>
            ))}
          </ul>
        )}

        {isLoading && (
          <div className="flex gap-4 overflow-x-auto pb-4" role="status" aria-busy="true" aria-label="Loading board">
            {[3, 2, 1].map((n, c) => (
              <div key={c} className="flex-shrink-0 w-80 bg-[var(--surface-1)] rounded-lg border border-[var(--surface-3)] p-3 space-y-2">
                <Skeleton className="h-5 w-28" />
                {Array.from({ length: n }, (_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
              </div>
            ))}
          </div>
        )}

        {noActiveSprint && !isLoading && (
          <EmptyState
            icon="folder"
            title="No active sprint"
            description={t('A Scrum board shows the issues of its active sprint. Start a sprint from the backlog to see work here.')}
            action={<Link href="/backlog" className="veqsio-btn-primary inline-block">Plan a sprint</Link>}
          />
        )}

        {issuesError && (
          <div className="flex items-center justify-center py-16 px-4 text-center">
            <div className="text-[var(--error)] text-body">
              {issuesError.message || 'Failed to load board data'}
            </div>
          </div>
        )}

        {!isLoading && !issuesError && !noActiveSprint && (
          <>
            {/* Board view with configured columns */}
            {selectedBoardId && boardColumns.length > 0 ? (
              <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setDragKey(String(e.active.id))} onDragCancel={() => setDragKey(null)} onDragEnd={onDragEnd}>
              {/* Phones: a strip of column names to jump to; the columns snap into place when swiping */}
              <nav aria-label="Board columns" className="sm:hidden flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                {boardColumns.map((column) => (
                  <button
                    key={column.id}
                    type="button"
                    className="shrink-0 rounded-full border border-[var(--surface-3)] bg-[var(--surface-1)] px-3 py-1 text-caption text-[var(--text-secondary)]"
                    onClick={() => document.getElementById(`board-col-${column.id}`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })}
                  >
                    {column.name} <span className="text-[var(--text-tertiary)]">{filteredIssues.filter((i) => i.fields.status.id === column.statusId).length}</span>
                  </button>
                ))}
              </nav>
              <div className="flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory sm:snap-none scroll-px-4" data-testid="board-columns">
                {boardColumns.map((column) => {
                  const colIssues = filteredIssues.filter(
                    (issue) => issue.fields.status.id === column.statusId
                  )
                  const statusObj = statuses.find((s) => s.id === String(column.statusId))
                  const isOverWip = column.max !== null && colIssues.length > column.max
                  const isUnderWip = column.min !== null && colIssues.length < column.min

                  return (
                    <div
                      key={column.id}
                      id={`board-col-${column.id}`}
                      className="flex-1 basis-[85vw] sm:basis-72 min-w-[85vw] sm:min-w-[18rem] snap-center bg-[var(--surface-1)] rounded-lg border border-[var(--surface-3)]"
                    >
                      {/* Column header */}
                      <div className="p-3 border-b border-[var(--surface-3)] flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {statusObj?.statusCategory?.colorName && (
                            <span
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: statusObj.statusCategory.colorName }}
                            />
                          )}
                          <h3 className="text-heading-3 text-[var(--text-primary)]">{column.name}</h3>
                        </div>
                        <div className="flex items-center gap-2">
                          {(isOverWip || isUnderWip) && (
                            <span
                              title={
                                isOverWip
                                  ? `WIP limit exceeded (${colIssues.length}/${column.max})`
                                  : `Below minimum WIP (${colIssues.length}/${column.min})`
                              }
                              className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                isOverWip
                                  ? 'bg-[var(--error)]/10 text-[var(--error)]'
                                  : 'bg-[var(--warning)]/10 text-[var(--warning)]'
                              }`}
                            >
                              <AlertTriangle className="w-3 h-3" />
                              {colIssues.length}/{column.max ?? column.min}
                            </span>
                          )}
                          <span className="text-caption text-[var(--text-tertiary)] bg-[var(--surface-2)] px-2 py-0.5 rounded-full">
                            {colIssues.length}
                          </span>
                        </div>
                      </div>

                      {/* Cards */}
                      <DroppableColumn columnId={column.id} className="p-2 space-y-2 max-h-[calc(100vh-280px)] min-h-24 overflow-y-auto rounded-b-lg">
                        {colIssues.length === 0 && (
                          <div className="text-center py-6 text-caption text-[var(--text-tertiary)]">
                            No issues
                          </div>
                        )}
                        {colIssues.map((issue) => {
                          const colIdx = boardColumns.indexOf(column)
                          const prevCol = colIdx > 0 ? boardColumns[colIdx - 1] : undefined
                          const nextCol = colIdx >= 0 ? boardColumns[colIdx + 1] : undefined
                          const moves = [
                            ...(nextCol ? [{ label: `Move to ${nextCol.name}`, onSelect: () => moveIssueToColumn(issue, nextCol) }] : []),
                            ...(prevCol ? [{ label: `Move to ${prevCol.name}`, onSelect: () => moveIssueToColumn(issue, prevCol) }] : []),
                          ]
                          return (
                          <div key={issue.id} className="group/peek relative">
                            <DraggableBoardCard issue={issue} selected={selectedKeys.has(issue.key)} onToggleSelect={toggleSelect} cardProps={{ ...cardProps(issue), moves }}
                              swipe={{
                                left: nextCol ? { label: `${nextCol.name} →`, onTrigger: () => moveIssueToColumn(issue, nextCol) } : undefined,
                                right: prevCol ? { label: `← ${prevCol.name}`, onTrigger: () => moveIssueToColumn(issue, prevCol) } : undefined,
                              }} />
                            <PeekButton issueKey={issue.key} onPeek={peek.open} className="absolute right-8 top-1.5 bg-[var(--surface-0)]/90 opacity-0 group-hover/peek:opacity-100 focus-visible:opacity-100" />
                          </div>
                          )
                        })}
                        <Link href={`/issues/create?status=${encodeURIComponent(statusObj?.name || column.name)}`} className="block no-underline">
                          <button className="w-full py-2 text-caption text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded-lg transition-colors flex items-center justify-center gap-1">
                            <Plus className="w-3 h-3" /> Add issue
                          </button>
                        </Link>
                      </DroppableColumn>
                    </div>
                  )
                })}
              </div>
              <DragOverlay>
                {draggedIssue ? <div className="rotate-2 shadow-xl opacity-95"><BoardCard issue={draggedIssue} /></div> : null}
              </DragOverlay>
              </DndContext>
            ) : (
              /* Fallback view: all statuses */
              <>
                {filteredIssues.length === 0 ? (
                  <EmptyState
                    icon="inbox"
                    title={t(issues.length === 0 ? 'No issues' : 'No matching issues')}
                    description={
                      issues.length === 0
                        ? t('There are no issues to display on the board.')
                        : 'Try adjusting your search or filters.'
                    }
                  />
                ) : (
                  <div className="flex gap-4 overflow-x-auto pb-4">
                    {fallbackColumns.map((col) => {
                      const colIssues = issuesByStatus[col] || []
                      const statusObj = statuses.find((s) => s.name === col)
                      return (
                        <div
                          key={col}
                          className="flex-1 basis-72 min-w-[18rem] bg-[var(--surface-1)] rounded-lg border border-[var(--surface-3)]"
                        >
                          {/* Column header */}
                          <div className="p-3 border-b border-[var(--surface-3)] flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {statusObj?.statusCategory?.colorName && (
                                <span
                                  className="w-2.5 h-2.5 rounded-full"
                                  style={{ backgroundColor: statusObj.statusCategory.colorName }}
                                />
                              )}
                              <h3 className="text-heading-3 text-[var(--text-primary)]">{col}</h3>
                            </div>
                            <span className="text-caption text-[var(--text-tertiary)] bg-[var(--surface-2)] px-2 py-0.5 rounded-full">
                              {colIssues.length}
                            </span>
                          </div>

                          {/* Cards */}
                          <div className="p-2 space-y-2 max-h-[calc(100vh-280px)] overflow-y-auto">
                            {colIssues.map((issue) => (
                              <div key={issue.id} className="group/peek relative">
                                <Link href={`/issues/${issue.key}`} className="block no-underline">
                                  <BoardCard issue={issue} {...cardProps(issue)} />
                                </Link>
                                <PeekButton issueKey={issue.key} onPeek={peek.open} className="absolute right-1.5 top-1.5 bg-[var(--surface-0)]/90 opacity-0 group-hover/peek:opacity-100 focus-visible:opacity-100" />
                              </div>
                            ))}
                            <Link href={`/issues/create?status=${encodeURIComponent(col)}`} className="block no-underline">
                              <button className="w-full py-2 text-caption text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded-lg transition-colors flex items-center justify-center gap-1">
                                <Plus className="w-3 h-3" /> Add issue
                              </button>
                            </Link>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {pendingMove && (
        <TransitionDialog
          key={`${pendingMove.key}:${pendingMove.transition.id}`}
          issueKey={pendingMove.key}
          fromStatus={pendingMove.fromStatus}
          transition={pendingMove.transition}
          onClose={() => { setPendingMove(null); void qc.invalidateQueries({ queryKey: ['issues', 'search'] }) }}
        />
      )}
      <BoardSettingsModal
        open={showBoardSettings}
        initialBoardId={selectedBoardId}
        onClose={() => setShowBoardSettings(false)}
      />
      <Portal><IssuePeek peekKey={peek.peekKey} onClose={peek.close} /></Portal>
    </AppLayout>
  )
}
