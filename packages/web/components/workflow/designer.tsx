'use client'


import { useI18n } from '@/hooks/use-i18n'
import { WorkflowHistoryList } from './history'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, LayoutGrid, Table2, Plus, Save, Wand2, AlertTriangle, Trash2, Network } from 'lucide-react'
import { toast } from '../toast'
import { Modal } from '../modal'
import { Spinner } from '../spinner'
import { DesignerCanvas, type Selection } from './designer-canvas'
import { TransitionPanel } from './transition-panel'
import { TransitionsTable } from './transitions-table'
import {
  useWorkflowDetail, useWorkflowTypes, useAdminStatuses, useWorkflowMutations,
  type WorkflowDetail, type AdminStatus,
} from '@/hooks/use-workflow-designer'
import {
  autoLayout, mergeLayout, defaultTransitionName, normalizeCategory, CATEGORY_LABEL, CATEGORY_VAR, CATEGORY_ORDER, CATEGORY_HINT,
  type DStatus, type Pos,
} from '@/lib/workflow-graph'

type Layout = Record<number, Pos>
const errMsg = (e: unknown, tr: (k: string) => string) => (e instanceof Error ? e.message : tr('Something went wrong'))

function sameLayout(a: Layout, b: Layout): boolean {
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => b[Number(k)] && b[Number(k)].x === a[Number(k)].x && b[Number(k)].y === a[Number(k)].y)
}

interface ConfirmState { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }

export function WorkflowDesigner({ workflowId }: { workflowId: number }) {
  const { tr } = useI18n();

  const { data: detail, isLoading, error } = useWorkflowDetail(workflowId)
  const { data: types } = useWorkflowTypes()
  const { data: adminStatuses } = useAdminStatuses()
  const m = useWorkflowMutations(workflowId)

  const [layout, setLayout] = useState<Layout | null>(null)
  const [view, setView] = useState<'canvas' | 'table'>('canvas')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [panelDirty, setPanelDirty] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const statusById = useMemo(() => {
    const map = new Map<number, DStatus & { issueCount?: number }>()
    for (const s of detail?.statuses ?? []) map.set(s.id, s)
    for (const s of adminStatuses?.statuses ?? []) map.set(s.id, s)
    return map
  }, [detail, adminStatuses])

  // Server-side baseline for the unsaved indicator: what the canvas would show if nothing was moved.
  const serverLayout = useMemo<Layout>(
    () => (detail ? mergeLayout(detail.statuses, detail.transitions, detail.positions) : {}),
    [detail],
  )

  useEffect(() => {
    if (!detail) return
    setLayout((prev) => {
      if (prev === null) return serverLayout
      // keep local edits, add statuses that appeared on the server
      const missing = detail.statuses.filter((s) => !prev[s.id])
      if (missing.length === 0) return prev
      return mergeLayout([...Object.keys(prev).map((k) => statusById.get(Number(k))).filter(Boolean) as DStatus[], ...missing], detail.transitions, prev)
    })
  }, [detail]) // eslint-disable-line react-hooks/exhaustive-deps

  const placed = useMemo<DStatus[]>(
    () => (layout ? (Object.keys(layout).map((k) => statusById.get(Number(k))).filter(Boolean) as DStatus[]) : []),
    [layout, statusById],
  )
  const layoutDirty = !!layout && !!detail && !sameLayout(layout, serverLayout)
  const unsaved = layoutDirty || panelDirty

  useEffect(() => {
    if (!unsaved) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [unsaved])

  // Deselect things that no longer exist.
  useEffect(() => {
    if (!detail || !selected) return
    if (selected.kind === 'transition' && !detail.transitions.some((t) => t.id === selected.id)) setSelected(null)
    if (selected.kind === 'status' && layout && !layout[selected.id]) setSelected(null)
  }, [detail, layout, selected])

  const requestSelect = useCallback((sel: Selection | null) => {
    const same = sel && selected && sel.kind === selected.kind && sel.id === selected.id
    if (same) return
    if (panelDirty) {
      setConfirm({
        title: tr('Discard unsaved changes?'), message: tr('The transition you are editing has unsaved changes.'), confirmLabel: tr('Discard changes'), danger: true,
        onConfirm: () => { setPanelDirty(false); setSelected(sel) },
      })
    } else setSelected(sel)
  }, [panelDirty, selected, tr])

  if (isLoading || !layout) return <div className="flex justify-center py-16"><Spinner /></div>
  if (error || !detail) return <p role="alert" className="text-[var(--error)]">{error ? errMsg(error, tr) : tr('Workflow not found')}</p>

  const transitions = detail.transitions
  const flagged = new Set(detail.warnings.map((w) => w.statusId).filter((x): x is number => typeof x === 'number'))
  const selTransition = selected?.kind === 'transition' ? transitions.find((t) => t.id === selected.id) : undefined
  const selStatus = selected?.kind === 'status' ? statusById.get(selected.id) : undefined

  async function connect(from: number | null, to: number) {
    if (panelDirty) { toast(tr('Save or revert the open transition first'), 'warning'); return }
    const target = statusById.get(to)
    if (!target) return
    try {
      const res = await m.addTransition.mutateAsync({ name: defaultTransitionName(target.name, transitions, from, to), fromStatusId: from, toStatusId: to })
      setSelected({ kind: 'transition', id: res.id })
      toast(tr('Transition added. Rename it and set conditions in the panel.'), 'success')
    } catch (e) { toast(errMsg(e, tr), 'error') }
  }

  async function saveLayout() {
    const nodes: Record<string, Pos> = {}
    for (const [k, v] of Object.entries(layout!)) nodes[k] = v
    try { await m.saveLayout.mutateAsync({ id: workflowId, nodes }); toast(tr('Layout saved'), 'success') } catch (e) { toast(errMsg(e, tr), 'error') }
  }

  function placeStatus(s: DStatus) {
    setLayout((l) => mergeLayout([...Object.keys(l!).map((k) => statusById.get(Number(k))).filter(Boolean) as DStatus[], s], transitions, l))
    setSelected({ kind: 'status', id: s.id })
  }

  function removeFromWorkflow(id: number) {
    setLayout((l) => { const { [id]: _drop, ...rest } = l!; return rest })
    setSelected(null)
  }

  function askDeleteTransition(id: number, name: string) {
    setConfirm({
      title: tr('Delete transition?'), message: tr('“{name}” will be removed from this workflow. Issues keep their status.', { name }), confirmLabel: tr('Delete transition'), danger: true,
      onConfirm: async () => {
        try { await m.deleteTransition.mutateAsync(id); setPanelDirty(false); setSelected(null); toast(tr('Transition deleted'), 'success') } catch (e) { toast(errMsg(e, tr), 'error') }
      },
    })
  }

  function askDeleteStatus(s: DStatus) {
    setConfirm({
      title: tr('Delete status everywhere?'), message: tr('“{name}” is shared by all workflows. It can only be deleted when no issue, transition or board column uses it.', { name: s.name }), confirmLabel: tr('Delete status'), danger: true,
      onConfirm: async () => {
        try { await m.deleteStatus.mutateAsync(s.id); removeFromWorkflow(s.id); toast(tr('Status deleted'), 'success') } catch (e) { toast(errMsg(e, tr), 'error') }
      },
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/admin/workflows" className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><ArrowLeft className="w-4 h-4" /> {tr('All workflows')}</Link>
          <h1 className="text-heading-1 text-[var(--text-primary)] mt-1 flex items-center gap-2 flex-wrap">
            <Network className="w-5 h-5 text-[var(--brand-500)]" aria-hidden />
            <span className="truncate">{detail.name}</span>
            {detail.isDefault && <span className="veqsio-badge">{tr('Default')}</span>}
          </h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-xs font-medium px-2 py-1 rounded-full ${unsaved ? 'bg-[var(--warning)]/15 text-[var(--warning)]' : 'bg-[var(--surface-2)] text-[var(--text-tertiary)]'}`}
            role="status" aria-live="polite" data-testid="unsaved-indicator"
          >
            {unsaved ? (layoutDirty && panelDirty ? tr('Unsaved layout and transition') : layoutDirty ? tr('Unsaved layout changes') : tr('Unsaved transition changes')) : tr('All changes saved')}
          </span>
          <div className="inline-flex rounded-lg border border-[var(--surface-3)] overflow-hidden" role="group" aria-label={tr('View')}>
            <button type="button" className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${view === 'canvas' ? 'bg-[var(--brand-50)] text-[var(--brand-700)]' : 'text-[var(--text-secondary)]'}`} aria-pressed={view === 'canvas'} onClick={() => setView('canvas')}><LayoutGrid className="w-4 h-4" /> {tr('Canvas')}</button>
            <button type="button" className={`px-3 py-1.5 text-sm flex items-center gap-1.5 border-l border-[var(--surface-3)] ${view === 'table' ? 'bg-[var(--brand-50)] text-[var(--brand-700)]' : 'text-[var(--text-secondary)]'}`} aria-pressed={view === 'table'} onClick={() => setView('table')}><Table2 className="w-4 h-4" /> {tr('Table')}</button>
          </div>
          <button type="button" className="veqsio-btn-secondary flex items-center gap-1.5" onClick={() => setAddOpen(true)}><Plus className="w-4 h-4" /> {tr('Add status')}</button>
          {view === 'canvas' && (
            <button type="button" className="veqsio-btn-secondary flex items-center gap-1.5" onClick={() => setLayout(autoLayout(placed, transitions))} title={tr('Arrange statuses automatically')}><Wand2 className="w-4 h-4" /> {tr('Auto-layout')}</button>
          )}
          <button type="button" className="veqsio-btn-primary flex items-center gap-1.5" onClick={saveLayout} disabled={!layoutDirty || m.saveLayout.isPending}><Save className="w-4 h-4" /> {tr('Save layout')}</button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px] items-start">
        <div className="min-w-0 space-y-3">
          {view === 'canvas' ? (
            <DesignerCanvas
              statuses={placed}
              transitions={transitions}
              positions={layout}
              selected={selected}
              flaggedStatusIds={flagged}
              onSelect={requestSelect}
              onMove={(id, pos) => setLayout((l) => ({ ...l!, [id]: pos }))}
              onConnect={connect}
            />
          ) : (
            <TransitionsTable
              workflow={detail}
              placed={placed}
              types={types}
              selected={selected}
              onSelect={requestSelect}
              onDeleteTransition={(t) => askDeleteTransition(t.id, t.name)}
              onAddTransition={async (name, from, to) => {
                if (panelDirty) { toast(tr('Save or revert the open transition first'), 'warning'); return false }
                try { const r = await m.addTransition.mutateAsync({ name, fromStatusId: from, toStatusId: to }); setSelected({ kind: 'transition', id: r.id }); toast(tr('Transition added'), 'success'); return true } catch (e) { toast(errMsg(e, tr), 'error'); return false }
              }}
            />
          )}
          {detail.warnings.length > 0 && <Warnings detail={detail} onPick={(id) => requestSelect({ kind: 'status', id })} />}
        </div>

        <aside className="veqsio-card p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] overflow-auto" aria-label={tr('Details')}>
          {selTransition && types ? (
            <TransitionPanel
              key={selTransition.id}
              transition={selTransition}
              allTransitions={transitions}
              statuses={placed}
              types={types}
              saving={m.updateTransition.isPending}
              onSave={async (patch) => { try { await m.updateTransition.mutateAsync({ id: selTransition.id, ...patch }); toast(tr('Transition saved'), 'success') } catch (e) { toast(errMsg(e, tr), 'error') } }}
              onDelete={() => askDeleteTransition(selTransition.id, selTransition.name)}
              onDirtyChange={setPanelDirty}
            />
          ) : selStatus ? (
            <StatusPanel
              key={selStatus.id}
              status={selStatus as AdminStatus}
              hasTransitions={transitions.some((t) => t.fromStatusId === selStatus.id || t.toStatusId === selStatus.id)}
              onSave={async (patch) => { try { await m.updateStatus.mutateAsync({ id: selStatus.id, ...patch }); toast(tr('Status saved'), 'success') } catch (e) { toast(errMsg(e, tr), 'error') } }}
              onRemove={() => removeFromWorkflow(selStatus.id)}
              onDelete={() => askDeleteStatus(selStatus)}
            />
          ) : (
            <WorkflowPanel detail={detail} onSave={async (d) => { try { await m.updateWorkflow.mutateAsync({ id: workflowId, ...d }); toast(tr('Workflow saved'), 'success') } catch (e) { toast(errMsg(e, tr), 'error') } }} saving={m.updateWorkflow.isPending} />
          )}
        </aside>
      </div>

      <WorkflowHistoryList workflowId={workflowId} />

      <AddStatusModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        available={(adminStatuses?.statuses ?? []).filter((s) => !layout[s.id])}
        onPlace={(s) => { placeStatus(s); setAddOpen(false) }}
        onCreate={async (d) => { try { const s = await m.createStatus.mutateAsync(d); placeStatus(s); setAddOpen(false); toast(tr('Status created and added'), 'success') } catch (e) { toast(errMsg(e, tr), 'error') } }}
        creating={m.createStatus.isPending}
      />

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Warnings({ detail, onPick }: { detail: WorkflowDetail; onPick: (id: number) => void }) {
  const { tr } = useI18n();

  return (
    <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm" role="region" aria-label={tr('Workflow warnings')}>
      <p className="font-medium flex items-center gap-1.5 text-[var(--text-primary)]"><AlertTriangle className="w-4 h-4 text-[var(--warning)]" aria-hidden /> {detail.warnings.length === 1 ? tr('{n} warning', { n: 1 }) : tr('{n} warnings', { n: detail.warnings.length })}</p>
      <ul className="mt-1 space-y-0.5 text-[var(--text-secondary)]">
        {detail.warnings.map((w, i) => (
          <li key={i}>
            {w.statusId !== undefined ? <button type="button" className="text-left hover:underline" onClick={() => onPick(w.statusId!)}>{w.message}</button> : w.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

function WorkflowPanel({ detail, onSave, saving }: { detail: WorkflowDetail; onSave: (d: { name: string; description: string | null }) => Promise<void>; saving: boolean }) {
  const { tr } = useI18n();

  const [name, setName] = useState(detail.name)
  const [description, setDescription] = useState(detail.description ?? '')
  const nameId = useId(), descId = useId()
  useEffect(() => { setName(detail.name); setDescription(detail.description ?? '') }, [detail.name, detail.description])
  const dirty = name !== detail.name || description !== (detail.description ?? '')
  return (
    <div className="space-y-4">
      <h3 className="text-heading-2 text-[var(--text-primary)]">{tr('Workflow')}</h3>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (dirty && name.trim()) onSave({ name: name.trim(), description: description.trim() || null }) }}>
        <div>
          <label htmlFor={nameId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
          <input id={nameId} className="veqsio-input w-full" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label htmlFor={descId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Description')}</label>
          <textarea id={descId} className="veqsio-input w-full min-h-[72px]" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <button type="submit" className="veqsio-btn-primary flex items-center gap-1.5" disabled={!dirty || saving}><Save className="w-4 h-4" /> {tr('Save details')}</button>
      </form>

      <div className="text-sm space-y-1">
        <p className="font-medium text-[var(--text-primary)]">{tr('Used by')}</p>
        {detail.schemes.length === 0 ? (
          <p className="text-[var(--text-tertiary)]">{detail.isDefault ? tr('The default workflow: projects without a workflow scheme use it.') : tr('No workflow scheme uses this workflow yet.')}</p>
        ) : (
          <ul className="text-[var(--text-secondary)] list-disc pl-4">
            {detail.schemes.map((s) => <li key={s.id}>{tr('Scheme “')}{s.name}”</li>)}
            {detail.projects.map((p) => <li key={p.id}>{tr('Project')} <Link className="text-[var(--brand-600)] hover:underline" href={`/projects/${p.key}`}>{p.key}</Link></li>)}
          </ul>
        )}
        <Link href="/admin" className="inline-block text-[var(--brand-600)] hover:underline">{tr('Edit workflow schemes')}</Link>
      </div>

      <div className="text-sm space-y-1.5">
        <p className="font-medium text-[var(--text-primary)]">{tr('Status colours')}</p>
        <ul className="space-y-1">
          {CATEGORY_ORDER.map((c) => (
            <li key={c} className="flex items-center gap-2 text-[var(--text-secondary)]" title={CATEGORY_HINT[c]}><span className="inline-block w-3 h-3 rounded-full" style={{ background: CATEGORY_VAR[c] }} aria-hidden /> {CATEGORY_LABEL[c]}</li>
          ))}
        </ul>
        <p className="text-xs text-[var(--text-tertiary)]">{tr('Select a status or a transition to edit it. Transition changes are saved with “Save transition”; positions and added statuses with “Save layout”.')}</p>
      </div>
    </div>
  )
}

function StatusPanel({ status, hasTransitions, onSave, onRemove, onDelete }: {
  status: AdminStatus; hasTransitions: boolean
  onSave: (p: { name?: string; category?: string; color?: string; allowNewIssues?: boolean }) => Promise<void>
  onRemove: () => void; onDelete: () => void
}) {
  const { tr } = useI18n();

  const [name, setName] = useState(status.name)
  const [category, setCategory] = useState<string>(normalizeCategory(status.category))
  const [color, setColor] = useState(status.color || '#667085')
  const [allowNew, setAllowNew] = useState(status.allowNewIssues !== false)
  const nameId = useId(), catId = useId(), colId = useId(), allowId = useId()
  useEffect(() => { setName(status.name); setCategory(normalizeCategory(status.category)); setColor(status.color || '#667085'); setAllowNew(status.allowNewIssues !== false) }, [status.name, status.category, status.color, status.allowNewIssues])
  const dirty = name !== status.name || category !== normalizeCategory(status.category) || color !== status.color || allowNew !== (status.allowNewIssues !== false)
  return (
    <div className="space-y-4">
      <h3 className="text-heading-2 text-[var(--text-primary)]">{tr('Status')}</h3>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (dirty && name.trim()) onSave({ name: name.trim(), category, color, allowNewIssues: allowNew }) }}>
        <div>
          <label htmlFor={nameId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
          <input id={nameId} className="veqsio-input w-full" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={catId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Category')}</label>
            <select id={catId} className="veqsio-input w-full" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={colId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Board colour')}</label>
            <input id={colId} type="color" className="veqsio-input w-full h-[38px] p-1" value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#667085'} onChange={(e) => setColor(e.target.value)} />
          </div>
        </div>
        <div className="flex items-start gap-2">
          <input id={allowId} type="checkbox" className="mt-0.5" checked={allowNew} onChange={(e) => setAllowNew(e.target.checked)} />
          <label htmlFor={allowId} className="text-sm text-[var(--text-primary)]">{tr('Allow new issues in this status')} <span className="block text-xs text-[var(--text-tertiary)]">{tr('Turn off to refuse creating issues directly into this status (for example Done or In review).')}</span>
          </label>
        </div>
        <p className="text-xs text-[var(--text-tertiary)]">{tr('Name, category and colour are shared by every workflow that uses this status.')}{typeof status.issueCount === 'number' && ` ${status.issueCount} issue${status.issueCount === 1 ? '' : 's'} currently in this status.`}</p>
        <button type="submit" className="veqsio-btn-primary flex items-center gap-1.5" disabled={!dirty}><Save className="w-4 h-4" /> {tr('Save status')}</button>
      </form>
      <div className="flex flex-col gap-2 pt-1 border-t border-[var(--surface-3)]">
        <button type="button" className="veqsio-btn-secondary" onClick={onRemove} disabled={hasTransitions} title={hasTransitions ? tr('Delete its transitions first') : undefined}>{tr('Remove from this workflow')}</button>
        {hasTransitions && <p className="text-xs text-[var(--text-tertiary)]">{tr('This status still has transitions. Delete them to remove it from the workflow.')}</p>}
        <button type="button" className="veqsio-btn-ghost flex items-center gap-1.5 text-[var(--error)] justify-center" onClick={onDelete}><Trash2 className="w-4 h-4" /> {tr('Delete status everywhere')}</button>
      </div>
    </div>
  )
}

function AddStatusModal({ open, onClose, available, onPlace, onCreate, creating }: {
  open: boolean; onClose: () => void; available: AdminStatus[]
  onPlace: (s: AdminStatus) => void
  onCreate: (d: { name: string; category: string }) => Promise<void>
  creating: boolean
}) {
  const { tr } = useI18n();

  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [pick, setPick] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('to_do')
  const pickId = useId(), nameId = useId(), catId = useId()
  useEffect(() => { if (open) { setPick(''); setName(''); setCategory('to_do'); setMode(available.length ? 'existing' : 'new') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal isOpen={open} onClose={onClose} title={tr('Add status')} size="sm">
      <div className="space-y-4">
        <div className="inline-flex rounded-lg border border-[var(--surface-3)] overflow-hidden" role="group" aria-label={tr('Status source')}>
          <button type="button" aria-pressed={mode === 'existing'} className={`px-3 py-1.5 text-sm ${mode === 'existing' ? 'bg-[var(--brand-50)] text-[var(--brand-700)]' : 'text-[var(--text-secondary)]'}`} onClick={() => setMode('existing')}>{tr('Existing status')}</button>
          <button type="button" aria-pressed={mode === 'new'} className={`px-3 py-1.5 text-sm border-l border-[var(--surface-3)] ${mode === 'new' ? 'bg-[var(--brand-50)] text-[var(--brand-700)]' : 'text-[var(--text-secondary)]'}`} onClick={() => setMode('new')}>{tr('New status')}</button>
        </div>
        {mode === 'existing' ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const s = available.find((x) => String(x.id) === pick); if (s) onPlace(s) }}>
            <div>
              <label htmlFor={pickId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Status')}</label>
              <select id={pickId} className="veqsio-input w-full" value={pick} onChange={(e) => setPick(e.target.value)} required>
                <option value="">{tr('Choose…')}</option>
                {available.map((s) => <option key={s.id} value={s.id}>{s.name} ({CATEGORY_LABEL[normalizeCategory(s.category)]})</option>)}
              </select>
              {available.length === 0 && <p className="text-xs text-[var(--text-tertiary)] mt-1">{tr('Every existing status is already in this workflow.')}</p>}
            </div>
            <button type="submit" className="veqsio-btn-primary" disabled={!pick}>{tr('Add to workflow')}</button>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate({ name: name.trim(), category }) }}>
            <div>
              <label htmlFor={nameId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
              <input id={nameId} className="veqsio-input w-full" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div>
              <label htmlFor={catId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Category')}</label>
              <select id={catId} className="veqsio-input w-full" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
            </div>
            <button type="submit" className="veqsio-btn-primary" disabled={!name.trim() || creating}>{creating ? tr('Creating…') : tr('Create and add')}</button>
          </form>
        )}
      </div>
    </Modal>
  )
}

export function ConfirmDialog({ state, onClose }: { state: ConfirmState | null; onClose: () => void }) {
  const { tr } = useI18n();

  return (
    <Modal isOpen={!!state} onClose={onClose} title={state?.title ?? ''} size="sm">
      {state && (
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">{state.message}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="veqsio-btn-secondary" onClick={onClose} autoFocus>{tr('Cancel')}</button>
            <button type="button" className={state.danger ? 'veqsio-btn-primary !bg-[var(--error)] !border-[var(--error)]' : 'veqsio-btn-primary'} onClick={() => { const fn = state.onConfirm; onClose(); fn() }}>{state.confirmLabel}</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
