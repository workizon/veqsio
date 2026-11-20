'use client'


import { useI18n } from '@/hooks/use-i18n'
import { SprintAutomationDialog } from '@/components/backlog/sprint-automation-dialog'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLiveInvalidation } from '@/hooks/use-realtime'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, rectIntersection,
  useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { AlertCircle, ChevronDown, Layout, Plus, RefreshCw, Search, X } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { IssuePeek } from '@/components/issue/peek-view'
import { usePeek } from '@/hooks/use-peek'
import { EmptyState } from '@/components/empty-state'
import { Skeleton } from '@/components/skeleton'
import { toast } from '@/components/toast'
import { useUndoableAction } from '@/hooks/use-undoable'
import { PlanningSection } from '@/components/backlog/planning-section'
import { MoveMenu, type MoveOption } from '@/components/backlog/move-menu'
import {
  CompleteSprintModal, CreateBoardModal, DeleteSprintModal, SprintFormModal, StartSprintModal,
} from '@/components/backlog/sprint-dialogs'
import { useBoards } from '@/hooks/use-boards'
import { useMyself, useProjectsList } from '@/hooks/use-issues'
import {
  useCompleteSprint, useCreatePlanIssue, useCreateSprint, useDeleteSprint, useLoadMoreBacklog,
  planningKey, useMoveIssues, usePlanning, useStartSprint, useUpdateSprint,
} from '@/hooks/use-planning'
import {
  emptyFilters, filterIssues, formatPoints, formatSprintDates, hasActiveFilters, keysToMove,
  locate, parseDropId, pluralize, suggestSprintName, sumPoints,
  type IssueKind, type MoveTarget, type PlanFilters, type PlanIssue, type PlanSprint, type PlanningData,
} from '@/lib/planning'

const BOARD_KEY = 'veqsio.backlog.board'

type Dialog =
  | { kind: 'create-sprint' }
  | { kind: 'edit-sprint'; sprint: PlanSprint }
  | { kind: 'start-sprint'; sprint: PlanSprint }
  | { kind: 'complete-sprint'; sprint: PlanSprint }
  | { kind: 'delete-sprint'; sprint: PlanSprint }
  | { kind: 'create-board' }
  | null

/** Rows win over their section so dropping between issues orders them; keyboard drags fall back to rect overlap. */
const collisions: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  if (hits.length) {
    const rows = hits.filter((h) => String(h.id).startsWith('row:'))
    return rows.length ? rows : hits
  }
  const rect = rectIntersection(args)
  const rows = rect.filter((h) => String(h.id).startsWith('row:'))
  return rows.length ? rows : rect
}

function ErrorPanel({ title, message, onRetry, retrying }: { title: string; message: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div role="alert" className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/5 p-6 text-center">
      <AlertCircle className="w-8 h-8 mx-auto text-[var(--error)] mb-2" aria-hidden="true" />
      <h2 className="text-heading-3 text-[var(--text-primary)]">{title}</h2>
      <p className="text-body-sm text-[var(--text-secondary)] mt-1 mb-4">{message}</p>
      <button type="button" onClick={onRetry} disabled={retrying} className="veqsio-btn-primary inline-flex items-center gap-2">
        <RefreshCw className={`w-4 h-4 ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" /> {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}

function PlanningSkeleton() {
  const { tr } = useI18n();

  return (
    <div className="space-y-4" aria-busy="true" aria-label={tr('Loading backlog')}>
      {[3, 2, 4].map((rows, i) => (
        <div key={i} className="rounded-lg border border-[var(--surface-3)] overflow-hidden">
          <div className="p-3 bg-[var(--surface-1)] flex items-center gap-3">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-24 ml-auto" />
          </div>
          {Array.from({ length: rows }).map((_, r) => (
            <div key={r} className="flex items-center gap-3 px-3 py-2.5 border-t border-[var(--surface-3)]">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-5 w-16 rounded-full hidden sm:block" />
              <Skeleton className="h-5 w-6 rounded-full" />
              <Skeleton className="h-5 w-5 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

import { useTerm } from '@/hooks/use-term'
import { Portal } from '@/components/portal'

export default function BacklogPage() {
  const { tr } = useI18n();

  const { t } = useTerm()
  const peek = usePeek()
  const qc = useQueryClient()
  const boardsQ = useBoards()
  const scrumBoards = useMemo(() => (boardsQ.data?.values ?? []).filter((b) => b.type === 'scrum'), [boardsQ.data])

  const [pickedBoard, setPickedBoard] = useState<string | null>(null)
  useEffect(() => {
    try { setPickedBoard(window.localStorage.getItem(BOARD_KEY)) } catch { /* storage unavailable */ }
  }, [])
  const boardId = scrumBoards.find((b) => b.id === pickedBoard)?.id ?? scrumBoards[0]?.id ?? null
  const pickBoard = (id: string) => {
    setPickedBoard(id)
    setSelected(new Set())
    try { window.localStorage.setItem(BOARD_KEY, id) } catch { /* ignore */ }
  }

  const planningQ = usePlanning(boardId)
  // Live updates: other people moving issues or starting/completing sprints refresh this board's planning view
  useLiveInvalidation(boardId ? `board:${boardId}` : null, { queryKeys: [planningKey(boardId)], toastOthers: true })
  const data = planningQ.data
  const { data: me } = useMyself()
  const projectsQ = useProjectsList(scrumBoards.length === 0)

  const [filters, setFilters] = useState<PlanFilters>(emptyFilters)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['completed']))
  const [dialog, setDialog] = useState<Dialog>(null)
  const [automationOpen, setAutomationOpen] = useState(false)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const undoableAction = useUndoableAction()
  const move = useMoveIssues(boardId, (message) => toast(`Could not move issues: ${message}`, 'error'))
  const createSprint = useCreateSprint(boardId)
  const updateSprint = useUpdateSprint(boardId)
  const deleteSprint = useDeleteSprint(boardId)
  const startSprint = useStartSprint(boardId)
  const completeSprint = useCompleteSprint(boardId)
  const createIssue = useCreatePlanIssue(boardId, data?.board.projectId)
  const loadMore = useLoadMoreBacklog(boardId)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  const openSprints = useMemo(() => (data?.sprints ?? []).filter((s) => s.state !== 'closed'), [data])
  const closedSprints = useMemo(() => (data?.sprints ?? []).filter((s) => s.state === 'closed'), [data])

  const allIssues = useMemo<PlanIssue[]>(() => [...openSprints.flatMap((s) => s.issues), ...(data?.backlog.issues ?? [])], [openSprints, data])
  const issueByKey = useMemo(() => new Map(allIssues.map((i) => [i.key, i])), [allIssues])
  const liveSelection = useMemo(() => new Set([...selected].filter((k) => issueByKey.has(k))), [selected, issueByKey])
  const assignees = useMemo(() => [...new Set(allIssues.map((i) => i.assignee?.name).filter(Boolean) as string[])].sort(), [allIssues])
  const filtered = hasActiveFilters(filters)

  const toggleCollapsed = (id: string) => setCollapsed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleSelect = useCallback((key: string) => setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n }), [])
  const selectAll = useCallback((keys: string[], on: boolean) => setSelected((prev) => { const n = new Set(prev); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); return n }), [])

  const targetName = (t: MoveTarget, d: PlanningData) => (t.kind === 'backlog' ? 'the backlog' : d.sprints.find((s) => s.id === t.id)?.name ?? 'the sprint')

  const doMove = useCallback((keys: string[], target: MoveTarget, beforeKey?: string | null) => {
    if (!data || keys.length === 0) return
    const anchor = beforeKey && !keys.includes(beforeKey) ? beforeKey : null
    const already = keys.every((k) => {
      const at = locate(data, k)
      return at && at.kind === target.kind && (at.kind === 'backlog' || (target.kind === 'sprint' && at.id === target.id))
    })
    if (already && !anchor) return
    const name = targetName(target, data)
    // Where each issue is now, so "Undo" can put it back (not into a closed sprint, which refuses issues).
    const origins = new Map<string, { target: MoveTarget; sig: string }>()
    for (const k of keys) {
      const at = locate(data, k)
      if (!at) continue
      if (at.kind === 'sprint' && data.sprints.find((s) => s.id === at.id)?.state === 'closed') continue
      origins.set(k, at.kind === 'backlog' ? { target: { kind: 'backlog' }, sig: 'b' } : { target: { kind: 'sprint', id: at.id }, sig: `s${at.id}` })
    }
    move.mutate({ keys, target, beforeKey: target.kind === 'sprint' ? anchor : null }, {
      onSuccess: () => {
        setAnnouncement(`Moved ${keys.join(', ')} to ${name}`)
        if (origins.size === 0) { toast(`Moved ${pluralize(keys.length, 'issue')} to ${name}`, 'success'); return }
        undoableAction({
          message: `Moved ${pluralize(keys.length, 'issue')} to ${name}`,
          undo: async () => {
            const groups = new Map<string, { target: MoveTarget; keys: string[] }>()
            for (const [k, o] of origins) groups.set(o.sig, { target: o.target, keys: [...(groups.get(o.sig)?.keys ?? []), k] })
            for (const g of groups.values()) await move.mutateAsync({ keys: g.keys, target: g.target, beforeKey: null })
            toast(tr('Move undone'), 'success')
          },
        })
      },
    })
    setSelected((prev) => { const n = new Set(prev); keys.forEach((k) => n.delete(k)); return n })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, move])

  const moveOptionsFor = useCallback((key: string): MoveOption[] => {
    if (!data) return []
    const at = locate(data, key)
    const opts: MoveOption[] = []
    if (at?.kind !== 'backlog') opts.push({ id: 'backlog', label: 'Backlog', target: { kind: 'backlog' } })
    for (const s of data.sprints) {
      if (s.state === 'closed' || (at?.kind === 'sprint' && at.id === s.id)) continue
      opts.push({ id: `s${s.id}`, label: s.name, hint: s.state === 'active' ? 'active' : 'planned', target: { kind: 'sprint', id: s.id } })
    }
    return opts
  }, [data])

  const bulkOptions = useMemo<MoveOption[]>(() => {
    if (!data) return []
    return [
      { id: 'backlog', label: 'Backlog', target: { kind: 'backlog' } as MoveTarget },
      ...openSprints.map((s) => ({ id: `s${s.id}`, label: s.name, hint: s.state === 'active' ? 'active' : 'planned', target: { kind: 'sprint', id: s.id } as MoveTarget })),
    ]
  }, [data, openSprints])

  const onDragStart = (e: DragStartEvent) => setDragKey(String(e.active.id).replace(/^issue:/, ''))
  const onDragEnd = (e: DragEndEvent) => {
    const key = String(e.active.id).replace(/^issue:/, '')
    setDragKey(null)
    if (!e.over) return
    const overId = String(e.over.id)
    let target: MoveTarget | null = null
    let beforeKey: string | null = null
    if (overId.startsWith('row:')) {
      const d = e.over.data.current as { key: string; containerId: string } | undefined
      const parsed = parseDropId(d?.containerId)
      if (parsed) { target = parsed.target; beforeKey = d?.key ?? null }
    } else {
      target = parseDropId(overId)?.target ?? null
    }
    if (target) doMove(keysToMove(liveSelection, key), target, beforeKey)
  }

  /* ---- sprint actions ---- */

  /** Runs a dialog action; failures propagate so the dialog shows the server message and stays open. */
  const run = async (fn: () => Promise<unknown>, success: string) => {
    await fn()
    toast(success, 'success')
    setDialog(null)
  }

  const handleCreateIssue = (target: MoveTarget) => async (input: { summary: string; issueTypeId: number; typeName: string }) => {
    try {
      const issue = await createIssue.mutateAsync({ ...input, target })
      toast(`Created ${issue.key}`, 'success')
      setAnnouncement(`Created ${issue.key}`)
    } catch (err) {
      toast((err as Error).message, 'error')
      throw err
    }
  }

  const createBoard = async (v: { name: string; projectId: number }) => {
    const res = await fetch('/rest/api/2/board', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: v.name, type: 'scrum', projectId: v.projectId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.errorMessages?.[0] || (res.status === 403 ? 'You need the Administer Projects permission to create boards' : `HTTP ${res.status}`))
    }
    await qc.invalidateQueries({ queryKey: ['boards'] })
    toast(tr('Board created'), 'success')
    setDialog(null)
  }

  /* ---- render ---- */

  const header = (
    <PageHeader
      title={tr('Backlog')}
      description={tr('Plan sprints and manage your product backlog.')}
      actions={data && (
        <>
          {scrumBoards.length > 1 ? (
            <select aria-label={tr('Board')} value={boardId ?? ''} onChange={(e) => pickBoard(e.target.value)} className="veqsio-input !w-auto">
              {scrumBoards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : (
            <span className="text-body-sm text-[var(--text-secondary)] inline-flex items-center gap-1.5"><Layout className="w-4 h-4" aria-hidden="true" />{data.board.name}</span>
          )}
          <button type="button" onClick={() => setAutomationOpen(true)} className="veqsio-btn-secondary inline-flex items-center gap-2" title={tr('Create the next sprint automatically')}>{tr('Automation')}</button>
          <button type="button" onClick={() => setDialog({ kind: 'create-sprint' })} className="veqsio-btn-primary inline-flex items-center gap-2">
            <Plus className="w-4 h-4" aria-hidden="true" /> {tr('Create sprint')} </button>
        </>
      )}
    />
  )
  const automationDialog = automationOpen && data ? <SprintAutomationDialog boardId={data.board.id} initial={data.board.sprintAutomation ?? { autoCreateNext: false, durationDays: 14, autoMoveIncomplete: 'backlog' }} onClose={() => setAutomationOpen(false)} /> : null

  let body: React.ReactNode
  if (boardsQ.isLoading || (boardId && planningQ.isLoading)) {
    body = <PlanningSkeleton />
  } else if (boardsQ.error) {
    body = <ErrorPanel title={tr('Could not load boards')} message={boardsQ.error.message} onRetry={() => boardsQ.refetch()} retrying={boardsQ.isFetching} />
  } else if (!boardId) {
    const hasOtherBoards = (boardsQ.data?.values.length ?? 0) > 0
    body = (
      <div className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
        <EmptyState
          icon="folder"
          title={hasOtherBoards ? 'No Scrum board yet' : 'No boards yet'}
          description={tr('Sprints live on Scrum boards. Create a board for one of your projects to start planning.')}
          action={
            <button type="button" onClick={() => setDialog({ kind: 'create-board' })} className="veqsio-btn-primary inline-flex items-center gap-2">
              <Plus className="w-4 h-4" aria-hidden="true" /> {tr('Create Scrum board')} </button>
          }
        />
      </div>
    )
  } else if (planningQ.error || !data) {
    body = <ErrorPanel title={tr('Could not load the backlog')} message={planningQ.error?.message ?? 'Unknown error'} onRetry={() => planningQ.refetch()} retrying={planningQ.isFetching} />
  } else {
    const backlogShown = filterIssues(data.backlog.issues, filters)
    body = (
      <DndContext sensors={sensors} collisionDetection={collisions} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragKey(null)}>
        {/* Filters */}
        <div role="search" className="flex flex-wrap items-center gap-2 p-3 bg-[var(--surface-0)] rounded-lg border border-[var(--surface-3)]">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
            <input
              type="search"
              placeholder={tr('Search by key or summary')}
              aria-label={t('Search issues in all sprints and the backlog')}
              value={filters.text}
              onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
              className="bg-transparent flex-1 text-body-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
            />
          </div>
          <select aria-label={tr('Filter by assignee')} value={filters.assignee ?? ''} onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value || null }))} className="veqsio-input !w-auto !min-h-0 py-1 text-body-sm">
            <option value="">{tr('All assignees')}</option>
            <option value="unassigned">{tr('Unassigned')}</option>
            {assignees.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select aria-label={t('Filter by issue type')} value={filters.type ?? ''} onChange={(e) => setFilters((f) => ({ ...f, type: (e.target.value || null) as IssueKind | null }))} className="veqsio-input !w-auto !min-h-0 py-1 text-body-sm">
            <option value="">{tr('All types')}</option>
            {(['story', 'task', 'bug', 'epic', 'sub-task'] as const).map((t) => <option key={t} value={t}>{t === 'sub-task' ? 'Sub-task' : t[0].toUpperCase() + t.slice(1)}</option>)}
          </select>
          {me?.displayName && (
            <button
              type="button"
              aria-pressed={!!filters.onlyMine}
              onClick={() => setFilters((f) => ({ ...f, onlyMine: f.onlyMine ? null : me.displayName }))}
              className={`text-xs px-2.5 py-1 rounded-full border ${filters.onlyMine ? 'bg-[var(--brand-600)] text-white border-[var(--brand-600)]' : 'border-[var(--surface-4)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'}`}
            >
              {tr('Only my issues')} </button>
          )}
          {filtered && (
            <button type="button" onClick={() => setFilters(emptyFilters)} className="veqsio-btn-ghost text-xs inline-flex items-center gap-1">
              <X className="w-3 h-3" aria-hidden="true" /> {tr('Clear filters')} </button>
          )}
        </div>

        {openSprints.length === 0 && (
          <div className="rounded-lg border border-dashed border-[var(--surface-4)] bg-[var(--surface-0)] p-6 text-center">
            <h2 className="text-heading-3 text-[var(--text-primary)]">{tr('Plan your first sprint')}</h2>
            <p className="text-body-sm text-[var(--text-secondary)] mt-1 mb-4">{tr('Create a sprint, then move issues from the backlog into it.')}</p>
            <button type="button" onClick={() => setDialog({ kind: 'create-sprint' })} className="veqsio-btn-primary inline-flex items-center gap-2">
              <Plus className="w-4 h-4" aria-hidden="true" /> {tr('Create sprint')} </button>
          </div>
        )}

        {openSprints.map((sprint) => (
            <PlanningSection
              onPeek={peek.open}
              key={sprint.id}
              sprint={sprint}
              title={sprint.name}
              issues={filterIssues(sprint.issues, filters)}
              totalCount={sprint.issueCount}
              totalPoints={sprint.storyPoints}
              filtered={filtered}
              expanded={!collapsed.has(String(sprint.id))}
              onToggle={() => toggleCollapsed(String(sprint.id))}
              selected={liveSelection}
              onToggleSelect={toggleSelect}
              onSelectAll={selectAll}
              moveOptionsFor={moveOptionsFor}
              onMove={doMove}
              ghostKeys={dragKey && liveSelection.has(dragKey) ? liveSelection : new Set()}
              onStart={sprint.state === 'future' ? () => setDialog({ kind: 'start-sprint', sprint }) : undefined}
              onComplete={sprint.state === 'active' ? () => setDialog({ kind: 'complete-sprint', sprint }) : undefined}
              onEdit={() => setDialog({ kind: 'edit-sprint', sprint })}
              onDelete={sprint.state === 'future' ? () => setDialog({ kind: 'delete-sprint', sprint }) : undefined}
              createPending={createIssue.isPending}
              onCreateIssue={handleCreateIssue({ kind: 'sprint', id: sprint.id })}
            />
        ))}

        <PlanningSection
          onPeek={peek.open}
          title={tr('Backlog')}
          issues={backlogShown}
          totalCount={data.backlog.total}
          totalPoints={data.backlog.storyPoints}
          filtered={filtered}
          expanded={!collapsed.has('backlog')}
          onToggle={() => toggleCollapsed('backlog')}
          selected={liveSelection}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          moveOptionsFor={moveOptionsFor}
          onMove={doMove}
          ghostKeys={dragKey && liveSelection.has(dragKey) ? liveSelection : new Set()}
          createPending={createIssue.isPending}
          onCreateIssue={handleCreateIssue({ kind: 'backlog' })}
          backlogMore={{ shown: data.backlog.issues.length, total: data.backlog.total, loading: loadMore.isPending, onLoadMore: () => loadMore.mutate(undefined, { onError: (e) => toast(`Could not load more issues: ${e.message}`, 'error') }) }}
        />

        {closedSprints.length > 0 && (
          <section aria-labelledby="completed-title" className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
            <button
              type="button"
              onClick={() => toggleCollapsed('completed')}
              aria-expanded={!collapsed.has('completed')}
              aria-controls="completed-list"
              className="w-full flex items-center gap-2 p-3 bg-[var(--surface-1)] rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
            >
              <ChevronDown className={`w-4 h-4 text-[var(--text-tertiary)] transition-transform ${collapsed.has('completed') ? '-rotate-90' : ''}`} aria-hidden="true" />
              <h3 id="completed-title" className="text-heading-3 text-[var(--text-primary)]">{tr('Completed sprints')}</h3>
              <span className="text-caption text-[var(--text-tertiary)]">{closedSprints.length}</span>
            </button>
            {!collapsed.has('completed') && (
              <ul id="completed-list" className="divide-y divide-[var(--surface-3)] border-t border-[var(--surface-3)]">
                {closedSprints.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-body-sm">
                    <span className="font-medium text-[var(--text-primary)]">{s.name}</span>
                    <span className="text-caption text-[var(--text-tertiary)]">{formatSprintDates(s.startDate, s.endDate)}</span>
                    <span className="text-caption text-[var(--text-tertiary)]">{t(pluralize(s.issueCount, 'issue'))} · {formatPoints(s.storyPoints)} points</span>
                    <Link href="/reports" className="ml-auto text-caption text-[var(--brand-600)] hover:underline">{tr('View reports')}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {liveSelection.size > 0 && (
          <div role="region" aria-label={tr('Bulk actions')} className="sticky bottom-4 z-30 mx-auto w-fit max-w-full flex flex-wrap items-center gap-3 rounded-xl border border-[var(--surface-4)] bg-[var(--surface-0)] shadow-[var(--shadow-lg)] px-4 py-2">
            <span className="text-body-sm text-[var(--text-primary)]">
              {t(pluralize(liveSelection.size, 'issue'))} {tr('selected ·')} {formatPoints(sumPoints([...liveSelection].map((k) => issueByKey.get(k)!).filter(Boolean)))} points
            </span>
            <MoveMenu label={`Move ${liveSelection.size} selected issues to…`} text="Move to…" options={bulkOptions} onSelect={(t) => doMove([...liveSelection], t)} className="border border-[var(--surface-4)]" />
            <button type="button" onClick={() => setSelected(new Set())} className="veqsio-btn-ghost text-xs">{tr('Clear selection')}</button>
          </div>
        )}

        <DragOverlay>
          {dragKey && issueByKey.get(dragKey) ? (
            <div className="rounded-lg border border-[var(--brand-500)] bg-[var(--surface-0)] shadow-[var(--shadow-lg)] px-3 py-2 flex items-center gap-2 max-w-md">
              <span className="text-caption font-medium text-[var(--text-secondary)]">{dragKey}</span>
              <span className="truncate text-body-sm text-[var(--text-primary)]">{issueByKey.get(dragKey)!.summary}</span>
              {liveSelection.has(dragKey) && liveSelection.size > 1 && (
                <span className="shrink-0 rounded-full bg-[var(--brand-600)] text-white text-[11px] px-1.5 py-0.5">+{liveSelection.size - 1}</span>
              )}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    )
  }

  return (
    <AppLayout>
      <div className="space-y-4">
        {header}
        {automationDialog}
        {body}
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      </div>

      {dialog?.kind === 'create-sprint' && data && (
        <SprintFormModal
          mode="create"
          suggestedName={suggestSprintName(data.sprints)}
          onClose={() => setDialog(null)}
          onSubmit={(v) => run(() => createSprint.mutateAsync(v), `Sprint “${v.name}” created`)}
        />
      )}
      {dialog?.kind === 'edit-sprint' && (
        <SprintFormModal
          mode="edit"
          sprint={dialog.sprint}
          suggestedName={dialog.sprint.name}
          onClose={() => setDialog(null)}
          onSubmit={(v) => run(() => updateSprint.mutateAsync({ id: dialog.sprint.id, ...v }), 'Sprint updated')}
        />
      )}
      {dialog?.kind === 'start-sprint' && data && (
        <StartSprintModal
          sprint={dialog.sprint}
          otherActive={openSprints.filter((s) => s.state === 'active' && s.id !== dialog.sprint.id)}
          allowParallel={data.board.allowParallelSprints}
          onClose={() => setDialog(null)}
          onSubmit={(v) => run(async () => {
            const res = await startSprint.mutateAsync({ id: dialog.sprint.id, ...v })
            res.warnings.forEach((w) => toast(w, 'warning'))
          }, `${dialog.sprint.name} started`)}
        />
      )}
      {dialog?.kind === 'complete-sprint' && (
        <CompleteSprintModal
          sprint={dialog.sprint}
          targets={openSprints.filter((s) => s.id !== dialog.sprint.id)}
          onClose={() => setDialog(null)}
          onSubmit={async (to) => {
            try {
              const res = await completeSprint.mutateAsync({ id: dialog.sprint.id, moveIncompleteTo: to })
              const s = res.summary
              toast(`${dialog.sprint.name} completed: ${s.completed} done${s.moved ? `, ${s.moved} moved to ${s.movedTo.type === 'sprint' ? s.movedTo.name : 'the backlog'}` : ''}`, 'success')
              setDialog(null)
            } catch (err) {
              toast(`Could not complete sprint: ${(err as Error).message}`, 'error')
              throw err
            }
          }}
        />
      )}
      {dialog?.kind === 'delete-sprint' && (
        <DeleteSprintModal
          sprint={dialog.sprint}
          onClose={() => setDialog(null)}
          onSubmit={() => run(() => deleteSprint.mutateAsync(dialog.sprint.id), `${dialog.sprint.name} deleted`)}
        />
      )}
      {dialog?.kind === 'create-board' && (
        <CreateBoardModal projects={projectsQ.data ?? []} onClose={() => setDialog(null)} onSubmit={createBoard} />
      )}
      <Portal><IssuePeek peekKey={peek.peekKey} onClose={peek.close} /></Portal>
    </AppLayout>
  )
}
