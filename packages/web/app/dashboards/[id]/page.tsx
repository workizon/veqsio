'use client'

import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import {
  ArrowLeft,
  Plus,
  Save,
  PieChart,
  Filter,
  UserCheck,
  Activity,
  BarChart3,
  HeartPulse,
  SlidersHorizontal,
  Star,
} from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { useDashboard, useUpdateDashboard, useDefaultDashboard, useSetDefaultDashboard } from '@/hooks/use-dashboards'
import { GadgetContainer } from '@/components/gadget-container'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import type { Gadget, GadgetType } from '@/hooks/use-dashboards'

const GADGET_TYPES: { type: GadgetType; label: string; icon: ReactNode; defaultTitle: string }[] = [
  { type: 'pie-chart', label: 'Pie Chart', icon: <PieChart className="w-5 h-5" />, defaultTitle: 'Issues by Status' },
  { type: 'filter-results', label: 'Filter Results', icon: <Filter className="w-5 h-5" />, defaultTitle: 'Filter Results' },
  { type: 'assigned-to-me', label: 'Assigned to Me', icon: <UserCheck className="w-5 h-5" />, defaultTitle: 'Assigned to Me' },
  { type: 'activity-stream', label: 'Activity Stream', icon: <Activity className="w-5 h-5" />, defaultTitle: 'Activity Stream' },
  { type: 'created-vs-resolved', label: 'Created vs Resolved', icon: <BarChart3 className="w-5 h-5" />, defaultTitle: 'Created vs Resolved' },
  { type: 'sprint-health', label: 'Sprint Health', icon: <HeartPulse className="w-5 h-5" />, defaultTitle: 'Sprint Health' },
  { type: 'average-age', label: 'Average Age', icon: <BarChart3 className="w-5 h-5" />, defaultTitle: 'Average Age' },
  { type: 'resolution-time', label: 'Resolution Time', icon: <BarChart3 className="w-5 h-5" />, defaultTitle: 'Resolution Time' },
  { type: 'stat', label: 'Number tile', icon: <BarChart3 className="w-5 h-5" />, defaultTitle: 'Open issues' },
  { type: 'issue-statistics', label: 'Issue statistics', icon: <BarChart3 className="w-5 h-5" />, defaultTitle: 'Issues by status' },
  { type: 'workload', label: 'Workload', icon: <UserCheck className="w-5 h-5" />, defaultTitle: 'Workload by assignee' },
  { type: 'two-dimensional', label: 'Two-dimensional table', icon: <Filter className="w-5 h-5" />, defaultTitle: 'Assignee by status' },
  { type: 'created-heatmap', label: 'Activity heat map', icon: <Activity className="w-5 h-5" />, defaultTitle: 'Activity heat map' },
  { type: 'due-date-calendar', label: 'Due dates', icon: <Activity className="w-5 h-5" />, defaultTitle: 'Due soon' },
  { type: 'recently-created', label: 'Recently created', icon: <Filter className="w-5 h-5" />, defaultTitle: 'Recently created' },
  { type: 'velocity', label: 'Velocity', icon: <BarChart3 className="w-5 h-5" />, defaultTitle: 'Velocity' },
  { type: 'sprint-burndown', label: 'Sprint burndown', icon: <BarChart3 className="w-5 h-5" />, defaultTitle: 'Sprint burndown' },
  { type: 'cumulative-flow', label: 'Cumulative flow', icon: <BarChart3 className="w-5 h-5" />, defaultTitle: 'Cumulative flow' },
  { type: 'notes', label: 'Note', icon: <Filter className="w-5 h-5" />, defaultTitle: 'Note' },
]

const DEFAULT_CONFIGS: Record<GadgetType, Record<string, unknown>> = {
  'queue-counts': {}, 'sla-compliance': { days: 30 }, 'sla-breaches': { limit: 8 }, csat: { days: 30 }, 'version-progress': {},
  'pie-chart': { field: 'status' },
  'filter-results': { jql: 'assignee = currentUser() ORDER BY updated DESC' },
  'assigned-to-me': {},
  'activity-stream': { limit: 10 },
  'created-vs-resolved': { days: 30 },
  'sprint-health': {},
  'average-age': { period: 'daily', count: 30 },
  'resolution-time': { period: 'daily', count: 30 },
  stat: { jql: 'resolution = Unresolved', label: 'open' },
  'issue-statistics': { jql: 'resolution = Unresolved', field: 'status' },
  workload: { jql: 'resolution = Unresolved' },
  'two-dimensional': { jql: 'resolution = Unresolved', field: 'assignee', field2: 'status' },
  'created-heatmap': { days: 120 },
  'due-date-calendar': { jql: 'resolution = Unresolved' },
  'recently-created': { limit: 10 },
  notes: { text: '' },
  velocity: { count: 6 },
  'sprint-burndown': {},
  'cumulative-flow': { days: 30 },
}

export default function DashboardPage() {
  const params = useParams()
  const id = params.id as string

  const { data: dashboard, isLoading, isError, refetch } = useDashboard(id)
  const defaultDash = useDefaultDashboard()
  const setDefaultDash = useSetDefaultDashboard()
  const isDefault = defaultDash.data?.id === id
  const updateDashboard = useUpdateDashboard()

  const [gadgets, setGadgets] = useState<Gadget[]>([])
  const [hasChanges, setHasChanges] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!hasChanges) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasChanges])

  // Sync gadgets from query when loaded or when dashboard changes
  useEffect(() => {
    if (dashboard?.gadgets && !hasChanges) {
      setGadgets(
        dashboard.gadgets.map((g) => ({
          ...g,
          title: g.title || GADGET_TYPES.find((t) => t.type === g.type)?.defaultTitle || g.type,
          position: g.position ?? { column: 0, row: 0 },
        }))
      )
    }
  }, [dashboard, hasChanges])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setGadgets((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id)
        const newIndex = items.findIndex((i) => i.id === over.id)
        const moved = arrayMove(items, oldIndex, newIndex)
        setHasChanges(true)
        return moved.map((g, idx) => ({
          ...g,
          position: { ...g.position, row: Math.floor(idx / 2), column: idx % 2 },
        }))
      })
    }
  }, [])

  const handleAddGadget = (type: GadgetType) => {
    setEditing(true)
    const meta = GADGET_TYPES.find((g) => g.type === type)
    const gadget: Gadget = {
      id: `gadget-${crypto.randomUUID()}`,
      type,
      title: meta?.defaultTitle || type,
      config: { ...DEFAULT_CONFIGS[type] },
      position: { column: gadgets.length % 2, row: Math.floor(gadgets.length / 2) },
    }
    setGadgets((prev) => [...prev, gadget])
    setHasChanges(true)
    setAddOpen(false)
  }

  const handleRemoveGadget = (gadgetId: string) => {
    setGadgets((prev) => prev.filter((g) => g.id !== gadgetId))
    setHasChanges(true)
  }

  const handleUpdateConfig = (gadgetId: string, config: Record<string, unknown>) => {
    setGadgets((prev) =>
      prev.map((g) => (g.id === gadgetId ? { ...g, config } : g))
    )
    setHasChanges(true)
  }

  const handleSave = async () => {
    try {
      await updateDashboard.mutateAsync({ id, gadgets })
      setHasChanges(false)
      setEditing(false)
      toast('Dashboard saved', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to save dashboard', 'error')
    }
  }

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-24">
          <Spinner />
        </div>
      </AppLayout>
    )
  }

  if (isError || !dashboard) {
    return (
      <AppLayout>
        <EmptyState
          icon="frown"
          title="Unable to open dashboard"
          description="It may be unavailable, or you may not have access. Try again or return to your dashboards."
          action={
            <div className="flex gap-2"><button className="veqsio-btn-secondary" onClick={() => void refetch()}>Retry</button><Link href="/dashboards" className="veqsio-btn-primary">
              Back to Dashboards
            </Link></div>
          }
        />
      </AppLayout>
    )
  }

  const displayGadgets = hasChanges ? gadgets : (dashboard?.gadgets || [])

  return (
    <AppLayout>
      <div className="space-y-6 py-2 sm:py-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboards"
              aria-label="Back to my dashboards"
              className="veqsio-btn-ghost p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <p className="text-caption text-[var(--text-tertiary)] mb-1">MY DASHBOARD</p>
              <h1 className="text-heading-1 text-[var(--text-primary)] break-words">
                {dashboard.name}
              </h1>
              {dashboard.description && (
                <p className="text-body-sm text-[var(--text-secondary)] mt-0.5">
                  {dashboard.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!editing && (
              <button
                type="button"
                onClick={() => setDefaultDash.mutate(isDefault ? null : id, { onSuccess: () => toast(isDefault ? 'Default dashboard removed' : 'This dashboard opens first from now on', 'success'), onError: (e: Error) => toast(e.message, 'error') })}
                aria-pressed={isDefault}
                className={`veqsio-btn-secondary flex items-center gap-2 ${isDefault ? '!border-[var(--brand-500)] !text-[var(--brand-600)]' : ''}`}
                title={isDefault ? 'This is your default dashboard (click to remove)' : 'Open this dashboard first after sign-in'}
              ><Star className={`w-4 h-4 ${isDefault ? 'fill-current' : ''}`} aria-hidden="true" />{isDefault ? 'Default' : 'Make default'}</button>
            )}
            {!editing && <button onClick={() => setEditing(true)} className="veqsio-btn-secondary"><SlidersHorizontal className="w-4 h-4" />Customize</button>}
            {editing && <button disabled={updateDashboard.isPending} onClick={() => { setGadgets(dashboard.gadgets); setHasChanges(false); setEditing(false) }} className="veqsio-btn-ghost">Cancel</button>}
            <button
              onClick={() => setAddOpen(true)}
              disabled={updateDashboard.isPending}
              className="veqsio-btn-secondary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add widget
            </button>
            {editing && <button
              onClick={handleSave}
              disabled={!hasChanges || updateDashboard.isPending}
              className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="w-4 h-4" />
              {updateDashboard.isPending ? 'Saving...' : 'Save changes'}
            </button>}
          </div>
        </div>

        {editing && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--brand-200)] bg-[var(--brand-50)] px-4 py-3 text-sm text-[var(--brand-800)]"><span>Drag widgets to arrange your dashboard. Use the settings icon to configure each widget.</span><span className="font-medium">{hasChanges ? 'Unsaved changes' : 'Customizing'}</span></div>}

        {/* Gadget Grid */}
        {displayGadgets.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="A dashboard that works for you"
            description="Start with your assigned issues, a saved filter or a chart. Add widgets and arrange them your way."
            action={
              <button
                onClick={() => setAddOpen(true)}
                className="veqsio-btn-primary flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Add widget
              </button>
            }
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={displayGadgets.map((g) => g.id)}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {displayGadgets.map((gadget) => (
                  <GadgetContainer
                    key={gadget.id}
                    gadget={gadget}
                    editable={editing && !updateDashboard.isPending}
                    onRemove={handleRemoveGadget}
                    onUpdateConfig={handleUpdateConfig}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Add Gadget Modal */}
      <Modal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add widget"
        size="md"
      >
        <div className="grid grid-cols-2 gap-3">
          {GADGET_TYPES.map((g) => (
            <button
              key={g.type}
              onClick={() => handleAddGadget(g.type)}
              className="veqsio-card flex flex-col items-center gap-3 p-6 text-center hover:border-[var(--brand-500)] transition-colors"
            >
              <div className="w-12 h-12 rounded-xl bg-[var(--brand-50)] dark:bg-[var(--brand-100)] flex items-center justify-center text-[var(--brand-500)]">
                {g.icon}
              </div>
              <div>
                <p className="text-body-sm font-medium text-[var(--text-primary)]">{g.label}</p>
                <p className="text-caption text-[var(--text-tertiary)] mt-0.5">{g.defaultTitle}</p>
              </div>
            </button>
          ))}
        </div>
      </Modal>
    </AppLayout>
  )
}
