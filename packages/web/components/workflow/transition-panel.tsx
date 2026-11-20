'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useId, useMemo, useState } from 'react'
import { Trash2, Save, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { ItemListEditor } from './item-list-editor'
import { useScreenFieldCatalog, useScreens } from '@/hooks/use-admin'
import { missingParams, validateTransitionDraft, type DStatus, type DTransition } from '@/lib/workflow-graph'
import type { WfTransition, WorkflowTypes, TransitionInput } from '@/hooks/use-workflow-designer'

interface Props {
  transition: WfTransition
  allTransitions: DTransition[]
  statuses: DStatus[]
  types: WorkflowTypes
  saving: boolean
  onSave: (patch: TransitionInput) => Promise<void>
  onDelete: () => void
  onDirtyChange: (dirty: boolean) => void
}

type Draft = Omit<WfTransition, 'id'>

const toDraft = (t: WfTransition): Draft => ({
  name: t.name, fromStatusId: t.fromStatusId, toStatusId: t.toStatusId, screenId: t.screenId,
  conditions: t.conditions, validators: t.validators, postFunctions: t.postFunctions,
})

export function TransitionPanel({ transition, allTransitions, statuses, types, saving, onSave, onDelete, onDirtyChange }: Props) {
  const { tr } = useI18n();

  const [draft, setDraft] = useState<Draft>(() => toDraft(transition))
  const base = useMemo(() => JSON.stringify(toDraft(transition)), [transition])
  const nameId = useId(), fromId = useId(), toId = useId(), screenId = useId()

  // Reset when the server copy changes (after save) or another transition is chosen.
  useEffect(() => { setDraft(toDraft(transition)) }, [base, transition.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(draft) !== base
  useEffect(() => { onDirtyChange(dirty) }, [dirty]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirtyChange(false), []) // eslint-disable-line react-hooks/exhaustive-deps

  const errors = useMemo(() => {
    const e = validateTransitionDraft(draft, allTransitions, transition.id)
    for (const [list, defs, label] of [[draft.conditions, types.conditions, 'condition'], [draft.validators, types.validators, 'validator'], [draft.postFunctions, types.postFunctions, 'post-function']] as const) {
      list.forEach((it, i) => { const m = missingParams(it, defs); if (m.length) e.push(`${label[0].toUpperCase()}${label.slice(1)} ${i + 1}: fill in ${m.join(', ')}`) })
    }
    return e
  }, [draft, allTransitions, transition.id, types])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const screens = types.lookups.screen ?? []

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => { e.preventDefault(); if (errors.length === 0 && dirty) await onSave(draft) }}
      aria-label={tr('Edit transition {name}', { name: transition.name })}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-heading-2 text-[var(--text-primary)]">{tr('Transition')}</h3>
        {dirty && <span className="text-xs font-medium text-[var(--warning)]" role="status">{tr('Unsaved')}</span>}
      </div>

      <div>
        <label htmlFor={nameId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
        <input id={nameId} className="veqsio-input w-full" maxLength={255} value={draft.name} onChange={(e) => set('name', e.target.value)} required />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={fromId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('From')}</label>
          <select id={fromId} className="veqsio-input w-full" value={draft.fromStatusId ?? ''} onChange={(e) => set('fromStatusId', e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">{tr('Any status (global)')}</option>
            {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={toId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('To')}</label>
          <select id={toId} className="veqsio-input w-full" value={draft.toStatusId} onChange={(e) => set('toStatusId', Number(e.target.value))}>
            {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>
      {draft.fromStatusId === null && <p className="text-xs text-[var(--text-tertiary)] -mt-2">{tr('A global transition is offered from every status except its target.')}</p>}

      <div>
        <label htmlFor={screenId} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Transition screen')}</label>
        <select id={screenId} className="veqsio-input w-full" value={draft.screenId ?? ''} onChange={(e) => set('screenId', e.target.value === '' ? null : Number(e.target.value))}>
          <option value="">{tr('No screen')}</option>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <ScreenFieldSummary screenId={draft.screenId} />
      </div>

      <p className="text-xs rounded-md bg-[var(--surface-1)] border border-[var(--surface-3)] px-3 py-2 text-[var(--text-secondary)]" data-testid="who-may-move">
        <strong className="text-[var(--text-primary)]">{tr('Who may move issues here:')}</strong>{' '}
        {draft.conditions.length === 0
          ? tr('anyone who may transition issues in the project. Add a project role, group or permission condition to restrict it.')
          : draft.conditions.length === 1 ? tr('only users that pass all {n} condition below (project role, group, permission or assignee checks).', { n: 1 }) : tr('only users that pass all {n} conditions below (project role, group, permission or assignee checks).', { n: draft.conditions.length })}
      </p>
      <ItemListEditor label={tr('Condition')} hint={tr('All conditions must pass for the transition to be offered. Use them to decide who may move an issue through this transition.')} defs={types.conditions} lookups={types.lookups} items={draft.conditions} onChange={(v) => set('conditions', v)} />
      <ItemListEditor label={tr('Validator')} hint={tr('Checked when the transition is executed; failure blocks it.')} defs={types.validators} lookups={types.lookups} items={draft.validators} onChange={(v) => set('validators', v)} />
      <ItemListEditor label={tr('Post-function')} hint={tr('Run in order after the status changed.')} defs={types.postFunctions} lookups={types.lookups} items={draft.postFunctions} onChange={(v) => set('postFunctions', v)} />

      {errors.length > 0 && dirty && (
        <ul className="text-xs text-[var(--error)] list-disc pl-4 space-y-0.5" role="alert">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" className="veqsio-btn-primary flex items-center gap-1.5" disabled={!dirty || errors.length > 0 || saving}>
          <Save className="w-4 h-4" /> {saving ? tr('Saving…') : tr('Save transition')}
        </button>
        <button type="button" className="veqsio-btn-secondary flex items-center gap-1.5" disabled={!dirty} onClick={() => setDraft(toDraft(transition))}>
          <RotateCcw className="w-4 h-4" /> {tr('Revert')} </button>
        <button type="button" className="veqsio-btn-ghost ml-auto flex items-center gap-1.5 text-[var(--error)]" onClick={onDelete}>
          <Trash2 className="w-4 h-4" /> {tr('Delete')} </button>
      </div>
    </form>
  )
}

/** What the chosen screen asks for when the transition runs (fields in order, required ones marked). Edited under Screens. */
function ScreenFieldSummary({ screenId }: { screenId: number | null }) {
  const { tr } = useI18n();

  const { data: screens } = useScreens()
  const { data: catalog } = useScreenFieldCatalog()
  if (screenId === null) return <p className="text-xs text-[var(--text-tertiary)] mt-1">{tr('Without a screen the dialog only asks for what validators and the target status require (resolution, comment).')}</p>
  const screen = screens?.screens.find((x) => x.id === screenId)
  const fields = (screen?.tabs ?? []).flatMap((t) => t.fields)
  const nameOf = (f: (typeof fields)[number]) => catalog?.fields.find((c) => c.key === (f.isCustomField ? `customfield_${f.fieldId}` : f.fieldKey))?.name ?? `Field ${f.fieldKey ?? f.fieldId}`
  return (
    <div className="mt-1.5 text-xs text-[var(--text-secondary)]" data-testid="screen-field-summary">
      {fields.length === 0 ? (
        <span>{tr('This screen has no fields yet.')}</span>
      ) : (
        <ul className="flex flex-wrap gap-1" aria-label={tr('Fields collected by this screen')}>
          {fields.map((f) => (
            <li key={f.id} className="rounded bg-[var(--surface-2)] px-1.5 py-0.5">{nameOf(f)}{f.required ? <span className="text-[var(--error)]" title={tr('Required')}> *</span> : null}</li>
          ))}
        </ul>
      )}
      <Link href="/admin?tab=screens" className="text-[var(--brand-500)] hover:underline">{tr('Edit fields in Screens')}</Link>
    </div>
  )
}
