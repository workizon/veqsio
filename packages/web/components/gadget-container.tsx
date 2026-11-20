'use client'


import { useI18n } from '@/hooks/use-i18n'
import { DeskGadget, VersionProgressGadget } from '@/components/gadgets/desk-gadgets'
import { useState, type ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  Settings,
  X,
  PieChart,
  Filter,
  UserCheck,
  Activity,
  BarChart3,
  HeartPulse,
} from 'lucide-react'
import type { Gadget, GadgetType } from '@/hooks/use-dashboards'
import { Modal } from '@/components/modal'
import { PieChartGadget } from './gadgets/pie-chart'
import { FilterResultsGadget } from './gadgets/filter-results'
import { AssignedToMeGadget } from './gadgets/assigned-to-me'
import { ActivityStreamGadget } from './gadgets/activity-stream'
import { RowGadget } from './gadgets/row-gadgets'
import { AgileGadget } from './gadgets/agile-gadgets'
import { useBoards } from '@/hooks/use-boards'
import { CreatedVsResolvedGadget } from './gadgets/created-vs-resolved'
import { SprintHealthGadget } from './gadgets/sprint-health'
import { AverageAgeGadget } from './gadgets/average-age'
import { ResolutionTimeGadget } from './gadgets/resolution-time'

const gadgetIcons: Record<GadgetType, ReactNode> = {
  'queue-counts': <Filter className="w-4 h-4" />,
  'sla-compliance': <Activity className="w-4 h-4" />,
  'sla-breaches': <Activity className="w-4 h-4" />,
  csat: <UserCheck className="w-4 h-4" />,
  'version-progress': <Activity className="w-4 h-4" />,
  'pie-chart': <PieChart className="w-4 h-4" />,
  'filter-results': <Filter className="w-4 h-4" />,
  'assigned-to-me': <UserCheck className="w-4 h-4" />,
  'activity-stream': <Activity className="w-4 h-4" />,
  'created-vs-resolved': <BarChart3 className="w-4 h-4" />,
  'sprint-health': <HeartPulse className="w-4 h-4" />,
  'average-age': <BarChart3 className="w-4 h-4" />,
  'resolution-time': <BarChart3 className="w-4 h-4" />,
  'issue-statistics': <BarChart3 className="w-4 h-4" />,
  'two-dimensional': <Filter className="w-4 h-4" />,
  workload: <UserCheck className="w-4 h-4" />,
  stat: <BarChart3 className="w-4 h-4" />,
  'recently-created': <Filter className="w-4 h-4" />,
  'created-heatmap': <Activity className="w-4 h-4" />,
  'due-date-calendar': <Activity className="w-4 h-4" />,
  notes: <Filter className="w-4 h-4" />,
  velocity: <BarChart3 className="w-4 h-4" />,
  'sprint-burndown': <BarChart3 className="w-4 h-4" />,
  'cumulative-flow': <BarChart3 className="w-4 h-4" />,
}

interface GadgetContainerProps {
  editable?: boolean
  gadget: Gadget
  onRemove: (id: string) => void
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void
}

export function GadgetContainer({ gadget, onRemove, onUpdateConfig, editable = true }: GadgetContainerProps) {
  const { tr } = useI18n();

  const [configOpen, setConfigOpen] = useState(false)
  const [localConfig, setLocalConfig] = useState(gadget.config)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: gadget.id, disabled: !editable })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 'auto',
  }

  const renderGadget = () => {
    switch (gadget.type) {
      case 'pie-chart':
        return <PieChartGadget config={gadget.config} />
      case 'filter-results':
        return <FilterResultsGadget config={gadget.config} />
      case 'assigned-to-me':
        return <AssignedToMeGadget config={gadget.config} />
      case 'activity-stream':
        return <ActivityStreamGadget config={gadget.config} />
      case 'created-vs-resolved':
        return <CreatedVsResolvedGadget config={gadget.config} />
      case 'sprint-health':
        return <SprintHealthGadget config={gadget.config} />
      case 'average-age':
        return <AverageAgeGadget config={gadget.config} />
      case 'resolution-time':
        return <ResolutionTimeGadget config={gadget.config} />
      case 'issue-statistics': case 'two-dimensional': case 'workload': case 'stat': case 'recently-created': case 'created-heatmap': case 'due-date-calendar': case 'notes':
        return <RowGadget type={gadget.type} config={gadget.config} />
      case 'velocity': case 'sprint-burndown': case 'cumulative-flow':
        return <AgileGadget type={gadget.type} config={gadget.config} />
      case 'queue-counts': case 'sla-compliance': case 'sla-breaches': case 'csat':
        return <DeskGadget type={gadget.type} config={gadget.config} />
      case 'version-progress':
        return <VersionProgressGadget config={gadget.config} />
      default:
        return <div className="p-4 text-body-sm text-[var(--text-secondary)]">{tr('Unknown gadget type')}</div>
    }
  }

  const handleSaveConfig = () => {
    onUpdateConfig(gadget.id, localConfig)
    setConfigOpen(false)
  }

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className="veqsio-card flex flex-col h-full min-w-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex items-center gap-2 min-w-0">
            {editable && <button
              {...attributes}
              {...listeners}
              className="veqsio-btn-ghost p-1 cursor-grab active:cursor-grabbing text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              title={tr('Drag to reorder')}
            >
              <GripVertical className="w-4 h-4" />
            </button>}
            <div className="text-[var(--brand-500)]">{gadgetIcons[gadget.type]}</div>
            <h3 className="text-heading-3 text-[var(--text-primary)] truncate">
              {gadget.title}
            </h3>
          </div>
          {editable && <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => {
                setLocalConfig(gadget.config)
                setConfigOpen(true)
              }}
              className="veqsio-btn-ghost p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              title={tr('Configure')}
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              onClick={() => onRemove(gadget.id)}
              className="veqsio-btn-ghost p-1.5 text-[var(--text-tertiary)] hover:text-[var(--error)]"
              title={tr('Remove')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0">{renderGadget()}</div>
      </div>

      {/* Config modal */}
      <Modal
        isOpen={configOpen}
        onClose={() => setConfigOpen(false)}
        title={`Configure ${gadget.title}`}
        size="sm"
      >
        <div className="space-y-4">
          <ConfigFields
            type={gadget.type}
            config={localConfig}
            onChange={setLocalConfig}
          />
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setConfigOpen(false)}
              className="veqsio-btn-secondary"
            >
              {tr('Cancel')} </button>
            <button
              onClick={handleSaveConfig}
              className="veqsio-btn-primary"
            >
              {tr('Save')} </button>
          </div>
        </div>
      </Modal>
    </>
  )
}

function AgileConfig({ type, config, update }: { type: string; config: Record<string, unknown>; update: (k: string, v: unknown) => void }) {
  const { tr } = useI18n();

  const boards = useBoards().data?.values ?? []
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Board')}</label>
        <select value={(config.boardId as string) || ''} onChange={(e) => update('boardId', e.target.value)} className="veqsio-input w-full">
          <option value="">{tr('Choose a board…')}</option>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      {type !== 'cumulative-flow' && (
        <div>
          <label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Unit')}</label>
          <select value={(config.unit as string) || 'issues'} onChange={(e) => update('unit', e.target.value)} className="veqsio-input w-full">
            <option value="issues">{tr('Issues')}</option><option value="points">{tr('Story points')}</option><option value="hours">{tr('Hours')}</option>
          </select>
        </div>
      )}
      {type === 'velocity' && <div><label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Sprints to show')}</label><input type="number" min={1} max={30} value={(config.count as number) || 6} onChange={(e) => update('count', parseInt(e.target.value, 10) || 6)} className="veqsio-input w-full" /></div>}
      {type === 'cumulative-flow' && <div><label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Days')}</label><input type="number" min={7} max={365} value={(config.days as number) || 30} onChange={(e) => update('days', parseInt(e.target.value, 10) || 30)} className="veqsio-input w-full" /></div>}
    </div>
  )
}

function ConfigFields({
  type,
  config,
  onChange,
}: {
  type: GadgetType
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}) {
  const { tr } = useI18n();

  const update = (key: string, value: unknown) => {
    onChange({ ...config, [key]: value })
  }

  const FIELDS = [['status', 'Status'], ['statusCategory', 'Status category'], ['priority', 'Priority'], ['type', 'Issue type'], ['assignee', 'Assignee'], ['reporter', 'Reporter'], ['project', 'Project'], ['component', 'Component'], ['labels', 'Labels'], ['fixversion', 'Fix version'], ['createdMonth', 'Created month'], ['resolvedMonth', 'Resolved month'], ['dueMonth', 'Due month']] as const
  const select = (key: string, label: string, options: readonly (readonly [string, string])[], fallback: string) => (
    <div>
      <label className="block text-caption text-[var(--text-secondary)] mb-1.5">{label}</label>
      <select value={(config[key] as string) || fallback} onChange={(e) => update(key, e.target.value)} className="veqsio-input w-full">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  )
  if (['issue-statistics', 'two-dimensional', 'workload', 'stat', 'recently-created', 'created-heatmap', 'due-date-calendar'].includes(type)) {
    return (
      <div className="space-y-3">
        <div>
          <label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('JQL (leave empty for everything you can see)')}</label>
          <input value={(config.jql as string) || ''} onChange={(e) => update('jql', e.target.value)} className="veqsio-input w-full" placeholder={tr('project = DEMO AND resolution = Unresolved')} />
        </div>
        {(type === 'issue-statistics') && select('field', 'Group by', FIELDS, 'status')}
        {(type === 'two-dimensional') && <>{select('field', 'Rows', FIELDS, 'assignee')}{select('field2', 'Columns', FIELDS, 'status')}</>}
        {(type === 'issue-statistics' || type === 'workload' || type === 'two-dimensional') && select('metric', 'Count', [['count', 'Issues'], ['estimate', 'Estimated hours'], ['spent', 'Hours spent']], 'count')}
        {type === 'created-heatmap' && <>{select('dateField', 'Day by', [['created', 'Created'], ['resolved', 'Resolved'], ['updated', 'Updated'], ['due', 'Due']], 'created')}
          <div><label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Days to show')}</label><input type="number" min={7} max={365} value={(config.days as number) || 120} onChange={(e) => update('days', parseInt(e.target.value, 10) || 120)} className="veqsio-input w-full" /></div></>}
        {type === 'stat' && <>
          <div><label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Label')}</label><input value={(config.label as string) || ''} onChange={(e) => update('label', e.target.value)} className="veqsio-input w-full" maxLength={100} /></div>
          <label className="flex items-center gap-2 text-body-sm"><input type="checkbox" checked={!!config.compare} onChange={(e) => update('compare', e.target.checked)} /> {tr('Compare new issues with the previous period')}</label>
          {!!config.compare && <div><label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Period (days)')}</label><input type="number" min={1} max={365} value={(config.days as number) || 7} onChange={(e) => update('days', parseInt(e.target.value, 10) || 7)} className="veqsio-input w-full" /></div>}
        </>}
        {(type === 'issue-statistics' || type === 'workload' || type === 'recently-created') && <div><label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Rows to show')}</label><input type="number" min={1} max={100} value={(config.limit as number) || 10} onChange={(e) => update('limit', parseInt(e.target.value, 10) || 10)} className="veqsio-input w-full" /></div>}
      </div>
    )
  }
  if (type === 'velocity' || type === 'sprint-burndown' || type === 'cumulative-flow') {
    return <AgileConfig type={type} config={config} update={update} />
  }
  if (type === 'notes') {
    return (<div><label className="block text-caption text-[var(--text-secondary)] mb-1.5">{tr('Text')}</label><textarea rows={6} value={(config.text as string) || ''} onChange={(e) => update('text', e.target.value)} className="veqsio-input w-full" maxLength={20000} /></div>)
  }

  switch (type) {
    case 'pie-chart':
      return (
        <div>
          <label className="block text-caption text-[var(--text-secondary)] mb-1.5">
            {tr('Group by')} </label>
          <select
            value={(config.field as string) || 'status'}
            onChange={(e) => update('field', e.target.value)}
            className="veqsio-input w-full"
          >
            <option value="status">{tr('Status')}</option>
            <option value="priority">{tr('Priority')}</option>
            <option value="type">{tr('Issue type')}</option>
            <option value="assignee">{tr('Assignee')}</option>
          </select>
        </div>
      )
    case 'filter-results':
      return (
        <div className="space-y-3">
          <div>
            <label className="block text-caption text-[var(--text-secondary)] mb-1.5">
              {tr('Filter ID')} </label>
            <input
              type="text"
              value={(config.filterId as string) || ''}
              onChange={(e) => update('filterId', e.target.value)}
              className="veqsio-input w-full"
              placeholder="e.g. 1"
            />
          </div>
          <div className="text-caption text-[var(--text-tertiary)] text-center">{tr('— or —')}</div>
          <div>
            <label className="block text-caption text-[var(--text-secondary)] mb-1.5">
              {tr('JQL')} </label>
            <input
              type="text"
              value={(config.jql as string) || ''}
              onChange={(e) => update('jql', e.target.value)}
              className="veqsio-input w-full"
              placeholder={tr('project = DEMO ORDER BY created DESC')}
            />
          </div>
        </div>
      )
    case 'activity-stream':
      return (
        <div>
          <label className="block text-caption text-[var(--text-secondary)] mb-1.5">
            {tr('Number of items')} </label>
          <input
            type="number"
            min={1}
            max={50}
            value={(config.limit as number) || 10}
            onChange={(e) => update('limit', parseInt(e.target.value, 10))}
            className="veqsio-input w-full"
          />
        </div>
      )
    case 'created-vs-resolved':
      return (
        <div>
          <label className="block text-caption text-[var(--text-secondary)] mb-1.5">
            {tr('Days to show')} </label>
          <input
            type="number"
            min={7}
            max={90}
            value={(config.days as number) || 30}
            onChange={(e) => update('days', parseInt(e.target.value, 10))}
            className="veqsio-input w-full"
          />
        </div>
      )
    case 'sprint-health':
      return (
        <div>
          <label className="block text-caption text-[var(--text-secondary)] mb-1.5">
            {tr('Sprint ID')} </label>
          <input
            type="text"
            value={(config.sprintId as string) || '1'}
            onChange={(e) => update('sprintId', e.target.value)}
            className="veqsio-input w-full"
          />
        </div>
      )
    case 'average-age':
    case 'resolution-time':
      return (
        <div className="space-y-3">
          <div>
            <label className="block text-caption text-[var(--text-secondary)] mb-1.5">
              {tr('Period')} </label>
            <select
              value={(config.period as string) || 'daily'}
              onChange={(e) => update('period', e.target.value)}
              className="veqsio-input w-full"
            >
              <option value="daily">{tr('Daily')}</option>
              <option value="weekly">{tr('Weekly')}</option>
              <option value="monthly">{tr('Monthly')}</option>
            </select>
          </div>
          <div>
            <label className="block text-caption text-[var(--text-secondary)] mb-1.5">
              {tr('Number of periods')} </label>
            <input
              type="number"
              min={1}
              max={90}
              value={(config.count as number) || 30}
              onChange={(e) => update('count', parseInt(e.target.value, 10))}
              className="veqsio-input w-full"
            />
          </div>
        </div>
      )
    default:
      return (
        <p className="text-body-sm text-[var(--text-secondary)]">
          {tr('This gadget has no configurable options.')} </p>
      )
  }
}
