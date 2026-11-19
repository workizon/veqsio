'use client'

import { useId, useState } from 'react'
import { Pencil, Trash2, Plus } from 'lucide-react'
import { describeItem, normalizeCategory, CATEGORY_LABEL, CATEGORY_VAR, validateTransitionDraft, type DStatus } from '@/lib/workflow-graph'
import type { WorkflowDetail, WfTransition, WorkflowTypes } from '@/hooks/use-workflow-designer'
import type { Selection } from './designer-canvas'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'

interface Props {
  workflow: WorkflowDetail
  placed: DStatus[]
  types: WorkflowTypes | undefined
  selected: Selection | null
  onSelect: (s: Selection) => void
  onDeleteTransition: (t: WfTransition) => void
  onAddTransition: (name: string, from: number | null, to: number) => Promise<boolean>
}

/** Accessible, pointer-free alternative to the canvas: every status and transition is reachable and editable from here. */
export function TransitionsTable({ workflow, placed, types, selected, onSelect, onDeleteTransition, onAddTransition }: Props) {
  const ms = useMultiSort()
  const nameOf = (id: number | null) => (id === null ? 'Any status' : placed.find((s) => s.id === id)?.name ?? workflow.statuses.find((s) => s.id === id)?.name ?? `#${id}`)
  const summarize = (items: Record<string, unknown>[], key: 'conditions' | 'validators' | 'postFunctions') =>
    items.length === 0 ? <span className="text-[var(--text-tertiary)]">None</span> : (
      <ul className="space-y-0.5">{items.map((it, i) => <li key={i}>{types ? describeItem(it, types[key], types.lookups) : String(it.type)}</li>)}</ul>
    )

  return (
    <div className="space-y-5">
      <section aria-labelledby="wf-statuses-h">
        <h2 id="wf-statuses-h" className="text-sm font-semibold text-[var(--text-primary)] mb-2">Statuses ({placed.length})</h2>
        {placed.length === 0 ? <p className="text-sm text-[var(--text-tertiary)]">No statuses yet. Use “Add status”.</p> : (
          <ul className="flex flex-wrap gap-2">
            {placed.map((s) => {
              const cat = normalizeCategory(s.category)
              const isSel = selected?.kind === 'status' && selected.id === s.id
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelect({ kind: 'status', id: s.id })}
                    aria-pressed={isSel}
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${isSel ? 'border-[var(--brand-500)] bg-[var(--brand-50)]' : 'border-[var(--surface-3)] bg-[var(--surface-0)]'} text-[var(--text-primary)]`}
                  >
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: CATEGORY_VAR[cat] }} aria-hidden />
                    {s.name}<span className="sr-only"> ({CATEGORY_LABEL[cat]}), edit</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="wf-transitions-h">
        <h2 id="wf-transitions-h" className="text-sm font-semibold text-[var(--text-primary)] mb-2">Transitions ({workflow.transitions.length})</h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--surface-3)]">
          <table className="w-full text-sm">
            <caption className="sr-only">Transitions of {workflow.name}</caption>
            <thead>
              <tr className="veqsio-table-header text-left">
                <SortableTh {...ms.th('name')} className="px-3 py-2">Name</SortableTh>
                <SortableTh {...ms.th('from')} className="px-3 py-2">From</SortableTh>
                <SortableTh {...ms.th('to')} className="px-3 py-2">To</SortableTh>
                <th scope="col" className="px-3 py-2">Conditions</th>
                <th scope="col" className="px-3 py-2">Validators</th>
                <th scope="col" className="px-3 py-2">Post-functions</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {workflow.transitions.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-[var(--text-tertiary)]">No transitions yet.</td></tr>
              )}
              {ms.sort(workflow.transitions, { name: (t) => t.name, from: (t) => nameOf(t.fromStatusId), to: (t) => nameOf(t.toStatusId) }).map((t) => {
                const isSel = selected?.kind === 'transition' && selected.id === t.id
                return (
                  <tr key={t.id} className={`veqsio-table-row align-top ${isSel ? 'bg-[var(--brand-50)]' : ''}`}>
                    <th scope="row" className="px-3 py-2 text-left font-medium text-[var(--text-primary)]">{t.name}</th>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">{nameOf(t.fromStatusId)}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">{nameOf(t.toStatusId)}</td>
                    <td className="px-3 py-2 text-xs text-[var(--text-secondary)]">{summarize(t.conditions, 'conditions')}</td>
                    <td className="px-3 py-2 text-xs text-[var(--text-secondary)]">{summarize(t.validators, 'validators')}</td>
                    <td className="px-3 py-2 text-xs text-[var(--text-secondary)]">{summarize(t.postFunctions, 'postFunctions')}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button type="button" className="veqsio-btn-ghost p-1.5" onClick={() => onSelect({ kind: 'transition', id: t.id })} aria-label={`Edit transition ${t.name}`}><Pencil className="w-4 h-4" /></button>
                      <button type="button" className="veqsio-btn-ghost p-1.5 text-[var(--error)]" onClick={() => onDeleteTransition(t)} aria-label={`Delete transition ${t.name}`}><Trash2 className="w-4 h-4" /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <AddTransitionForm workflow={workflow} placed={placed} onAdd={onAddTransition} />
    </div>
  )
}

function AddTransitionForm({ workflow, placed, onAdd }: { workflow: WorkflowDetail; placed: DStatus[]; onAdd: Props['onAddTransition'] }) {
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const nameId = useId(), fromId = useId(), toId = useId()
  const fromVal = from === '' ? null : Number(from)
  const errors = validateTransitionDraft({ name, fromStatusId: fromVal, toStatusId: to === '' ? null : Number(to) }, workflow.transitions)
  const disabled = errors.length > 0 || placed.length === 0
  return (
    <form
      className="veqsio-card p-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] items-end"
      onSubmit={async (e) => {
        e.preventDefault()
        if (disabled) return
        if (await onAdd(name.trim(), fromVal, Number(to))) { setName(''); setFrom(''); setTo('') }
      }}
      aria-label="Add transition"
    >
      <div>
        <label htmlFor={nameId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">New transition name</label>
        <input id={nameId} className="veqsio-input w-full" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label htmlFor={fromId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">From</label>
        <select id={fromId} className="veqsio-input w-full" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Any status (global)</option>
          {placed.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={toId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">To</label>
        <select id={toId} className="veqsio-input w-full" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose…</option>
          {placed.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <button type="submit" className="veqsio-btn-primary flex items-center gap-1.5" disabled={disabled}><Plus className="w-4 h-4" /> Add</button>
      {errors.length > 0 && (name || to) && <p className="text-xs text-[var(--text-tertiary)] sm:col-span-4">{errors.join('. ')}</p>}
    </form>
  )
}
