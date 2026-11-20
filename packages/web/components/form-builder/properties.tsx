'use client'


import { useI18n } from '@/hooks/use-i18n'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { PALETTE, allowedMappings, conditionCandidates, MAPPING_LABELS, typeLabel } from '@/lib/form-builder'
import { isChoice, isLayout, type ConditionOp, type FieldDef, type FieldType, type FieldValue, type MappingTarget } from '@/lib/request-form'
import { REQUEST_TYPE_ICONS } from '@/components/request-type-icon'
import type { FormContext, RequestTypeInput } from '@/hooks/use-servicedesk-admin'

/* ------------------------------------------------------------------ */
/*  Palette                                                             */
/* ------------------------------------------------------------------ */

export function Palette({ onAdd, disabled }: { onAdd: (type: FieldType) => void; disabled?: boolean }) {
  const { tr } = useI18n();

  return (
    <div>
      <p className="text-xs text-[var(--text-tertiary)] mb-2">{tr('Choose a field type to add it below the selected field.')}</p>
      <ul className="grid grid-cols-2 gap-2">
        {PALETTE.map((p) => (
          <li key={p.type}>
            <button
              type="button" disabled={disabled} onClick={() => onAdd(p.type)} title={p.description}
              className="w-full text-left rounded-md border border-[var(--surface-3)] bg-[var(--surface-0)] px-2.5 py-2 text-sm hover:border-[var(--brand-500)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-500)] disabled:opacity-50"
            >
              <span className="flex items-center gap-1.5"><Plus className="w-3.5 h-3.5 text-[var(--brand-500)]" aria-hidden /><span className="font-medium">{p.label}</span></span>
              <span className="block text-[11px] text-[var(--text-tertiary)] leading-tight mt-0.5">{p.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Field properties                                                    */
/* ------------------------------------------------------------------ */

interface FieldPropsProps {
  fields: FieldDef[]
  index: number
  ctx?: FormContext
  problems?: string[]
  readOnly?: boolean
  onChange: (patch: Partial<FieldDef>) => void
  onRelabel: (label: string) => void
  onRekey: (key: string) => void
}

const TEXTUAL = ['text', 'textarea', 'url', 'email', 'user']
const num = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v))

export function FieldProperties({ fields, index, ctx, problems, readOnly, onChange, onRelabel, onRekey }: FieldPropsProps) {
  const { tr } = useI18n();

  const f = fields[index]
  if (!f) return <p className="text-sm text-[var(--text-tertiary)]">{tr('Select a field on the canvas to edit it.')}</p>
  const layout = isLayout(f.type)
  const valueField = !layout && f.type !== 'attachment'
  const idp = `fp-${index}`
  const candidates = conditionCandidates(fields, index)
  const cond = f.visibleWhen
  const condField = fields.find((x) => x.key === cond?.field)
  const setVal = (patch: Partial<NonNullable<FieldDef['validation']>>) => {
    const next = { ...(f.validation ?? {}), ...patch }
    for (const k of Object.keys(next) as Array<keyof typeof next>) if (next[k] === undefined || next[k] === '') delete next[k]
    onChange({ validation: Object.keys(next).length ? next : undefined })
  }
  const mappings = allowedMappings(f.type).filter((t) => !(f.internal && (t === 'summary' || t === 'description')))
  const mappingValue = f.mapping ? f.mapping.target : '__default'

  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <legend className="sr-only">{tr('Properties of')} {f.label}</legend>
      <p className="text-xs text-[var(--text-tertiary)]">{typeLabel(f.type)}</p>
      {problems?.length ? (
        <ul role="alert" className="rounded-md bg-[var(--error)]/10 p-2 text-xs text-[var(--error)] list-disc list-inside">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      ) : null}

      <Row id={`${idp}-label`} label={layout && f.type === 'section' ? tr('Heading') : tr('Label')}>
        <input id={`${idp}-label`} className="veqsio-input w-full" maxLength={200} value={f.label} onChange={(e) => onRelabel(e.target.value)} />
      </Row>

      {(f.type === 'help' || valueField || f.type === 'attachment') && (
        <Row id={`${idp}-help`} label={f.type === 'help' ? tr('Text') : tr('Help text')}>
          <textarea id={`${idp}-help`} rows={f.type === 'help' ? 4 : 2} maxLength={2000} className="veqsio-input w-full" value={f.helpText ?? ''} onChange={(e) => onChange({ helpText: e.target.value || undefined })} />
        </Row>
      )}

      {valueField && TEXTUAL.concat(['select', 'number']).includes(f.type) && (
        <Row id={`${idp}-ph`} label={tr('Placeholder')}>
          <input id={`${idp}-ph`} className="veqsio-input w-full" maxLength={200} value={f.placeholder ?? ''} onChange={(e) => onChange({ placeholder: e.target.value || undefined })} />
        </Row>
      )}

      {!layout && (
        <div className="space-y-2">
          {f.type !== 'checkbox' && (
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.required && !f.internal} disabled={f.internal} onChange={(e) => onChange({ required: e.target.checked || undefined })} />{tr('Required')}</label>
          )}
          {valueField && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={!f.internal} onChange={(e) => onChange({ internal: e.target.checked ? undefined : true, ...(e.target.checked ? {} : { required: undefined }) })} />
              <span>{tr('Visible to customers')}<span className="block text-xs text-[var(--text-tertiary)]">{tr('Untick to keep this an internal field. Customers never see it and cannot fill it in; its default is applied.')}</span></span>
            </label>
          )}
        </div>
      )}

      {isChoice(f.type) && <OptionsEditor idp={idp} options={f.options ?? []} onChange={(options) => {
        const keep = (v: FieldValue | undefined) => (Array.isArray(v) ? v.filter((x) => options.includes(x)) : typeof v === 'string' && !options.includes(v) ? undefined : v)
        onChange({ options, defaultValue: keep(f.defaultValue) as FieldValue | undefined })
      }} />}

      {valueField && <DefaultEditor idp={idp} f={f} onChange={(v) => onChange({ defaultValue: v })} />}

      {valueField && TEXTUAL.includes(f.type) && f.type !== 'user' && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">{tr('Validation')}</h4>
          {(f.type === 'text' || f.type === 'textarea') && (
            <div className="grid grid-cols-2 gap-2">
              <Row id={`${idp}-minl`} label={tr('Min length')}><input id={`${idp}-minl`} type="number" min={0} className="veqsio-input w-full" value={f.validation?.minLength ?? ''} onChange={(e) => setVal({ minLength: num(e.target.value) })} /></Row>
              <Row id={`${idp}-maxl`} label={tr('Max length')}><input id={`${idp}-maxl`} type="number" min={1} className="veqsio-input w-full" value={f.validation?.maxLength ?? ''} onChange={(e) => setVal({ maxLength: num(e.target.value) })} /></Row>
            </div>
          )}
          <Row id={`${idp}-pat`} label={tr('Pattern (regular expression)')}>
            <input id={`${idp}-pat`} className="veqsio-input w-full font-mono" maxLength={200} placeholder="^[A-Z]{2}-\d+$" value={f.validation?.pattern ?? ''} onChange={(e) => setVal({ pattern: e.target.value || undefined })} />
          </Row>
        </div>
      )}
      {valueField && f.type === 'number' && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">{tr('Validation')}</h4>
          <div className="grid grid-cols-2 gap-2">
            <Row id={`${idp}-min`} label={tr('Minimum')}><input id={`${idp}-min`} type="number" className="veqsio-input w-full" value={f.validation?.min ?? ''} onChange={(e) => setVal({ min: num(e.target.value) })} /></Row>
            <Row id={`${idp}-max`} label={tr('Maximum')}><input id={`${idp}-max`} type="number" className="veqsio-input w-full" value={f.validation?.max ?? ''} onChange={(e) => setVal({ max: num(e.target.value) })} /></Row>
          </div>
        </div>
      )}

      {/* conditional visibility */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{tr('Conditional visibility')}</h4>
        {candidates.length === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)]">{tr('Add a field above this one to show or hide this field depending on its answer.')}</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!cond} onChange={(e) => onChange({ visibleWhen: e.target.checked ? { field: candidates[0].key, op: 'equals', value: candidates[0].options?.[0] ?? '' } : undefined })} />
              {tr('Show only when another field has a value')} </label>
            {cond && (
              <div className="space-y-2 rounded-md bg-[var(--surface-1)] p-2">
                <Row id={`${idp}-cf`} label={tr('Field')}>
                  <select id={`${idp}-cf`} className="veqsio-input w-full" value={cond.field} onChange={(e) => onChange({ visibleWhen: { ...cond, field: e.target.value, value: '' } })}>
                    {candidates.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </Row>
                <Row id={`${idp}-co`} label={tr('Condition')}>
                  <select id={`${idp}-co`} className="veqsio-input w-full" value={cond.op ?? 'equals'} onChange={(e) => onChange({ visibleWhen: { ...cond, op: e.target.value as ConditionOp, value: e.target.value === 'in' ? [] : '' } })}>
                    <option value="equals">equals</option><option value="notEquals">{tr('does not equal')}</option><option value="in">{tr('is one of')}</option><option value="filled">{tr('has any value')}</option>
                  </select>
                </Row>
                {(cond.op ?? 'equals') !== 'filled' && (
                  <ConditionValue idp={idp} cond={cond} source={condField} onChange={(value) => onChange({ visibleWhen: { ...cond, value } })} />
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* mapping */}
      {!layout && f.type !== 'attachment' && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">{tr('Issue field mapping')}</h4>
          <Row id={`${idp}-map`} label={tr('Save the answer to')}>
            <select
              id={`${idp}-map`} className="veqsio-input w-full" value={mappingValue}
              onChange={(e) => onChange({ mapping: e.target.value === '__default' ? undefined : { target: e.target.value as MappingTarget } })}
            >
              <option value="__default">{tr('Description (appended as text)')}</option>
              {mappings.map((t) => <option key={t} value={t}>{MAPPING_LABELS[t]}</option>)}
            </select>
          </Row>
          {f.mapping?.target === 'customField' && (
            <Row id={`${idp}-cfid`} label={tr('Custom field')}>
              <select id={`${idp}-cfid`} className="veqsio-input w-full" value={f.mapping.customFieldId ?? ''} onChange={(e) => onChange({ mapping: { target: 'customField', customFieldId: e.target.value ? Number(e.target.value) : undefined } })}>
                <option value="">{tr('Choose…')}</option>
                {ctx?.customFields.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.fieldType})</option>)}
              </select>
            </Row>
          )}
          {f.mapping?.target === 'priority' && <p className="text-xs text-[var(--text-tertiary)]">{tr('Options are matched to priorities by name (')}{ctx?.priorities.map((p) => p.name).join(', ') || 'none defined'}{tr('). Unmatched answers use the default priority.')}</p>}
          {f.mapping?.target === 'components' && <p className="text-xs text-[var(--text-tertiary)]">{tr('Options are matched to project components by name (')}{ctx?.components.map((c) => c.name).join(', ') || 'none defined'}).</p>}
          {f.mapping?.target === 'assignee' && <p className="text-xs text-[var(--text-tertiary)]">{tr('Only agents of this service desk can be assigned this way.')}</p>}
          {f.mapping?.target === 'none' && <p className="text-xs text-[var(--text-tertiary)]">{tr('Kept with the request but not copied to the issue or its description.')}</p>}
        </div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-[var(--text-secondary)]">{tr('Advanced')}</summary>
        <div className="mt-2">
          <Row id={`${idp}-key`} label={tr('Field key')}>
            <input id={`${idp}-key`} className="veqsio-input w-full font-mono" maxLength={50} value={f.key} onChange={(e) => onRekey(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
          </Row>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{tr('Identifies the answer in stored requests. Renaming it detaches answers already stored under the old key.')}</p>
        </div>
      </details>
    </fieldset>
  )
}

function Row({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label htmlFor={id} className="block text-sm font-medium">{label}</label>{children}</div>
}

function OptionsEditor({ idp, options, onChange }: { idp: string; options: string[]; onChange: (o: string[]) => void }) {
  const { tr } = useI18n();

  const set = (i: number, v: string) => onChange(options.map((o, j) => (j === i ? v : o)))
  const swap = (i: number, j: number) => { const n = [...options]; [n[i], n[j]] = [n[j], n[i]]; onChange(n) }
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium" id={`${idp}-opts`}>{tr('Options')}</h4>
      <ul className="space-y-1.5" aria-labelledby={`${idp}-opts`}>
        {options.map((o, i) => (
          <li key={i} className="flex items-center gap-1">
            <input aria-label={`Option ${i + 1}`} className="veqsio-input w-full" maxLength={200} value={o} onChange={(e) => set(i, e.target.value)} />
            <button type="button" className="veqsio-btn-ghost p-1.5" aria-label={`Move option ${i + 1} up`} disabled={i === 0} onClick={() => swap(i, i - 1)}><ArrowUp className="w-3.5 h-3.5" /></button>
            <button type="button" className="veqsio-btn-ghost p-1.5" aria-label={`Move option ${i + 1} down`} disabled={i === options.length - 1} onClick={() => swap(i, i + 1)}><ArrowDown className="w-3.5 h-3.5" /></button>
            <button type="button" className="veqsio-btn-ghost p-1.5 text-[var(--error)]" aria-label={`Remove option ${i + 1}`} onClick={() => onChange(options.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></button>
          </li>
        ))}
      </ul>
      <button type="button" className="veqsio-btn-secondary text-sm inline-flex items-center gap-1" onClick={() => onChange([...options, `Option ${options.length + 1}`])} disabled={options.length >= 100}>
        <Plus className="w-3.5 h-3.5" aria-hidden />{tr('Add option')} </button>
    </div>
  )
}

function DefaultEditor({ idp, f, onChange }: { idp: string; f: FieldDef; onChange: (v: FieldValue | undefined) => void }) {
  const { tr } = useI18n();

  const id = `${idp}-def`
  const v = f.defaultValue
  if (f.type === 'attachment') return null
  let control: React.ReactNode
  if (f.type === 'select' || f.type === 'radio') {
    control = (
      <select id={id} className="veqsio-input w-full" value={typeof v === 'string' ? v : ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{tr('No default')}</option>
        {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  } else if (f.type === 'multiselect' || f.type === 'checkboxes') {
    const arr = Array.isArray(v) ? v : []
    control = (
      <div id={id} role="group" className="space-y-1">
        {(f.options ?? []).map((o, i) => (
          <label key={`${o}-${i}`} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={arr.includes(o)} onChange={(e) => { const n = e.target.checked ? [...arr, o] : arr.filter((x) => x !== o); onChange(n.length ? n : undefined) }} />{o}</label>
        ))}
      </div>
    )
  } else if (f.type === 'checkbox') {
    control = <label className="flex items-center gap-2 text-sm"><input id={id} type="checkbox" checked={v === true} onChange={(e) => onChange(e.target.checked ? true : undefined)} />{tr('Checked by default')}</label>
  } else if (f.type === 'number') {
    control = <input id={id} type="number" className="veqsio-input w-full" value={typeof v === 'number' ? v : ''} onChange={(e) => onChange(num(e.target.value))} />
  } else if (f.type === 'date') {
    control = <input id={id} type="date" className="veqsio-input w-full" value={typeof v === 'string' ? v : ''} onChange={(e) => onChange(e.target.value || undefined)} />
  } else if (f.type === 'datetime') {
    control = <input id={id} type="datetime-local" className="veqsio-input w-full" value={typeof v === 'string' ? v.slice(0, 16) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)} />
  } else {
    control = <input id={id} className="veqsio-input w-full" maxLength={10000} value={typeof v === 'string' ? v : ''} onChange={(e) => onChange(e.target.value || undefined)} />
  }
  return <Row id={id} label={tr('Default value')}>{control}</Row>
}

function ConditionValue({ idp, cond, source, onChange }: {
  idp: string; cond: NonNullable<FieldDef['visibleWhen']>; source?: FieldDef; onChange: (v: NonNullable<FieldDef['visibleWhen']>['value']) => void
}) {
  const { tr } = useI18n();

  const id = `${idp}-cv`
  const opts = source && isChoice(source.type) ? source.options ?? [] : null
  const many = cond.op === 'in'
  if (source?.type === 'checkbox') {
    return (
      <Row id={id} label={tr('Value')}>
        <select id={id} className="veqsio-input w-full" value={String(cond.value ?? 'true')} onChange={(e) => onChange(e.target.value === 'true')}>
          <option value="true">{tr('Checked')}</option><option value="false">{tr('Not checked')}</option>
        </select>
      </Row>
    )
  }
  if (opts && !many) {
    return (
      <Row id={id} label={tr('Value')}>
        <select id={id} className="veqsio-input w-full" value={String(cond.value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">{tr('Choose…')}</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Row>
    )
  }
  if (opts && many) {
    const sel = Array.isArray(cond.value) ? cond.value.map(String) : []
    return (
      <div role="group" aria-label={tr('Values')} className="space-y-1">
        {opts.map((o) => <label key={o} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sel.includes(o)} onChange={(e) => onChange(e.target.checked ? [...sel, o] : sel.filter((x) => x !== o))} />{o}</label>)}
      </div>
    )
  }
  return (
    <Row id={id} label={many ? tr('Values (comma separated)') : tr('Value')}>
      <input
        id={id} className="veqsio-input w-full" value={many ? (Array.isArray(cond.value) ? cond.value.join(', ') : '') : String(cond.value ?? '')}
        onChange={(e) => onChange(many ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value)}
      />
    </Row>
  )
}

/* ------------------------------------------------------------------ */
/*  Request type properties                                             */
/* ------------------------------------------------------------------ */

export type TypeDraft = Required<Pick<RequestTypeInput, 'name' | 'issueTypeId' | 'enabled' | 'visibility' | 'organizationIds' | 'sortOrder'>> &
  Pick<RequestTypeInput, 'description' | 'helpText' | 'icon' | 'groupName' | 'defaultPriorityId'>

export function TypeProperties({ draft, ctx, groups, readOnly, onChange }: {
  draft: TypeDraft; ctx?: FormContext; groups: string[]; readOnly?: boolean; onChange: (patch: Partial<TypeDraft>) => void
}) {
  const { tr } = useI18n();

  const toggleOrg = (id: number, on: boolean) => onChange({ organizationIds: on ? [...draft.organizationIds, id] : draft.organizationIds.filter((x) => x !== id) })
  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <legend className="sr-only">{tr('Request type properties')}</legend>
      <Row id="rt-name" label={tr('Name')}><input id="rt-name" required maxLength={255} className="veqsio-input w-full" value={draft.name} onChange={(e) => onChange({ name: e.target.value })} /></Row>
      <Row id="rt-desc" label={tr('Description')}><textarea id="rt-desc" rows={2} maxLength={5000} className="veqsio-input w-full" value={draft.description ?? ''} onChange={(e) => onChange({ description: e.target.value })} /></Row>
      <Row id="rt-help" label={tr('Help text shown above the form')}><textarea id="rt-help" rows={2} maxLength={5000} className="veqsio-input w-full" value={draft.helpText ?? ''} onChange={(e) => onChange({ helpText: e.target.value })} /></Row>

      <div className="space-y-1">
        <span id="rt-icon-label" className="block text-sm font-medium">{tr('Icon')}</span>
        <div role="radiogroup" aria-labelledby="rt-icon-label" className="grid grid-cols-5 gap-1.5">
          {Object.entries(REQUEST_TYPE_ICONS).map(([key, { Icon, label }]) => (
            <button
              key={key} type="button" role="radio" aria-checked={(draft.icon ?? 'help-circle') === key} aria-label={tr(label)} title={tr(label)}
              onClick={() => onChange({ icon: key })}
              className={`h-9 rounded-md border flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-500)] ${(draft.icon ?? 'help-circle') === key ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-500)]' : 'border-[var(--surface-3)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'}`}
            >
              <Icon className="w-4 h-4" aria-hidden />
            </button>
          ))}
        </div>
      </div>

      <Row id="rt-group" label={tr('Portal group')}>
        <input id="rt-group" list="rt-groups" maxLength={100} className="veqsio-input w-full" placeholder={tr('General')} value={draft.groupName ?? ''} onChange={(e) => onChange({ groupName: e.target.value })} />
        <datalist id="rt-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
      </Row>

      <Row id="rt-issuetype" label={tr('Issue type created')}>
        <select id="rt-issuetype" className="veqsio-input w-full" value={draft.issueTypeId} onChange={(e) => onChange({ issueTypeId: Number(e.target.value) })}>
          {ctx?.issueTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          {ctx && !ctx.issueTypes.some((t) => t.id === draft.issueTypeId) && <option value={draft.issueTypeId}>{tr('Current issue type')}</option>}
        </select>
      </Row>
      <Row id="rt-prio" label={tr('Default priority')}>
        <select id="rt-prio" className="veqsio-input w-full" value={draft.defaultPriorityId ?? ''} onChange={(e) => onChange({ defaultPriorityId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{tr('Not set')}</option>
          {ctx?.priorities.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Row>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{tr('Who can see this request type')}</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="rt-vis" checked={draft.visibility === 'all'} onChange={() => onChange({ visibility: 'all', organizationIds: [] })} />{tr('All customers')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="rt-vis" checked={draft.visibility === 'organizations'} onChange={() => onChange({ visibility: 'organizations' })} />{tr('Only customers in selected organizations')}</label>
        {draft.visibility === 'organizations' && (
          <div className="ml-6 space-y-1" role="group" aria-label={tr('Organizations')}>
            {ctx?.organizations.length === 0 && <p className="text-xs text-[var(--text-tertiary)]">{tr('No organizations yet. Create them under Customers and organizations.')}</p>}
            {ctx?.organizations.map((o) => <label key={o.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.organizationIds.includes(o.id)} onChange={(e) => toggleOrg(o.id, e.target.checked)} />{o.name}</label>)}
          </div>
        )}
      </fieldset>

      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />{tr('Enabled (offered in the portal)')}</label>
      <Row id="rt-order" label={tr('Order in the portal')}><input id="rt-order" type="number" min={0} className="veqsio-input w-24" value={draft.sortOrder} onChange={(e) => onChange({ sortOrder: Math.max(0, Number(e.target.value) || 0) })} /></Row>

      <div className="rounded-md bg-[var(--surface-1)] p-2 text-xs text-[var(--text-secondary)]">
        <strong>{tr('Status of new requests')}</strong><br />
        {tr('New requests start in the first status of the workflow used for the chosen issue type. Change it under Workflows in the administration area.')} </div>
    </fieldset>
  )
}

