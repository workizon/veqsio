'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { AssigneeField, ComponentsField, DueDateField, LabelsField, PriorityField, VersionsField } from './details-panel'
import { useMyself } from '@/hooks/use-issues'
import type { ScreenField, ScreenValues, RefValue, UserValue, PriorityValue } from '@/lib/transition-screen'

/**
 * The fields of a transition screen, rendered with the SAME editors the issue view uses (assignee, priority, labels,
 * versions, components, due date) plus plain inputs for the rest. The values stay in the dialog until it is submitted.
 */
export function TransitionScreenFields({ fields, values, onChange, errors, projectKey }: {
  fields: ScreenField[]
  values: ScreenValues
  onChange: (key: string, value: unknown) => void
  errors: Record<string, string>
  projectKey: string
}) {
  return (
    <>
      {fields.map((f) => (
        <FieldBlock key={f.key} field={f} error={errors[f.key]}>
          <Editor field={f} values={values} onChange={onChange} projectKey={projectKey} error={errors[f.key]} />
        </FieldBlock>
      ))}
    </>
  )
}

function FieldBlock({ field, error, children }: { field: ScreenField; error?: string; children: React.ReactNode }) {
  const { tr } = useI18n();

  const id = `tf-${field.key}`
  return (
    <div data-testid={`transition-field-${field.key}`}>
      <label htmlFor={id} className="text-caption font-medium text-[var(--text-secondary)] block mb-1">
        {field.name} {field.required ? <span className="text-[var(--error)]" aria-hidden="true">*</span> : <span className="text-[var(--text-tertiary)]">{tr('(optional)')}</span>}
      </label>
      <div className={error ? 'rounded-md ring-1 ring-[var(--error)] px-1.5' : 'rounded-md border border-transparent px-1.5'}>{children}</div>
      {error && <p id={`${id}-error`} role="alert" className="text-caption text-[var(--error)] mt-1">{error}</p>}
    </div>
  )
}

function Editor({ field, values, onChange, projectKey, error }: {
  field: ScreenField
  values: ScreenValues
  onChange: (key: string, value: unknown) => void
  projectKey: string
  error?: string
}) {
  const { tr } = useI18n();

  const id = `tf-${field.key}`
  const v = values[field.key]
  const { data: myself } = useMyself()
  const [assigneeOpen, setAssigneeOpen] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const aria = { 'aria-invalid': !!error || undefined, 'aria-describedby': error ? `${id}-error` : undefined, 'aria-required': field.required || undefined }

  if (field.custom) {
    switch (field.type) {
      case 'select':
        return (
          <select id={id} className="veqsio-input w-full" value={String(v ?? '')} onChange={(e) => onChange(field.key, e.target.value)} {...aria}>
            <option value="">{field.required ? tr('Select an option') : tr('None')}</option>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )
      case 'boolean':
        return <label className="flex items-center gap-2 py-1.5 text-body-sm"><input id={id} type="checkbox" checked={v === 'true'} onChange={(e) => onChange(field.key, e.target.checked ? 'true' : '')} {...aria} /> {tr('Yes')}</label>
      case 'textarea':
        return <textarea id={id} rows={3} className="veqsio-input w-full" value={String(v ?? '')} onChange={(e) => onChange(field.key, e.target.value)} maxLength={500} {...aria} />
      case 'number':
        return <input id={id} inputMode="decimal" className="veqsio-input w-full" value={String(v ?? '')} onChange={(e) => onChange(field.key, e.target.value)} {...aria} />
      case 'date':
        return <input id={id} type="date" className="veqsio-input w-full" value={String(v ?? '')} onChange={(e) => onChange(field.key, e.target.value)} {...aria} />
      case 'datetime':
        return <input id={id} type="datetime-local" className="veqsio-input w-full" value={String(v ?? '')} onChange={(e) => onChange(field.key, e.target.value)} {...aria} />
      default:
        return <input id={id} type={field.type === 'url' ? 'url' : 'text'} className="veqsio-input w-full" value={String(v ?? '')} onChange={(e) => onChange(field.key, e.target.value)} maxLength={500} {...aria} />
    }
  }

  switch (field.key) {
    case 'assignee': {
      const a = v as UserValue | null
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="min-w-[10rem]">
            <AssigneeField
              id={id}
              open={assigneeOpen}
              onOpenChange={setAssigneeOpen}
              assignee={a}
              myself={myself ? { id: myself.id, displayName: myself.displayName || myself.name } : undefined}
              onPick={(u) => { setAssigneeOpen(false); onChange('assignee', u) }}
            />
          </div>
          {myself && a?.id !== myself.id && (
            <button type="button" onClick={() => onChange('assignee', { id: myself.id, displayName: myself.displayName || myself.name })} className="text-caption text-[var(--brand-500)] hover:underline">{tr('Assign to me')}</button>
          )}
        </div>
      )
    }
    case 'priority':
      return <PriorityField id={id} priority={(v as PriorityValue | null) ?? null} onPick={(p) => onChange('priority', p)} />
    case 'labels':
      return <LabelsField id={id} open={labelsOpen} onOpenChange={setLabelsOpen} labels={(v as string[] | undefined) ?? []} onChange={(labels) => onChange('labels', labels)} />
    case 'fixVersions':
      return <VersionsField id={id} label={tr('Fix versions')} projectKey={projectKey} selected={(v as RefValue[] | undefined) ?? []} onChange={(_ids, all) => onChange('fixVersions', all.filter((x) => _ids.includes(x.id)))} />
    case 'components':
      return <ComponentsField id={id} projectKey={projectKey} selected={(v as RefValue[] | undefined) ?? []} onChange={(_ids, all) => onChange('components', all.filter((x) => _ids.includes(x.id)))} />
    case 'duedate':
      return <DueDateField id={id} value={(v as string) || null} onChange={(d) => onChange('duedate', d ?? '')} />
    case 'storyPoints':
      return <input id={id} inputMode="decimal" className="veqsio-input w-32" value={String(v ?? '')} onChange={(e) => onChange('storyPoints', e.target.value)} placeholder="e.g. 3" {...aria} />
    case 'environment':
      return <textarea id={id} rows={2} className="veqsio-input w-full" value={String(v ?? '')} onChange={(e) => onChange('environment', e.target.value)} maxLength={10000} {...aria} />
    default:
      return <input id={id} className="veqsio-input w-full" value={String(v ?? '')} onChange={(e) => onChange(field.key, e.target.value)} {...aria} />
  }
}
