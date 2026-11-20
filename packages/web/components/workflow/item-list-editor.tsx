'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useId } from 'react'
import { Plus, Trash2, AlertTriangle } from 'lucide-react'
import { newItem, missingParams, type TypeDef, type ParamDef, type Lookups } from '@/lib/workflow-graph'

type Item = Record<string, unknown> & { type: string }

interface Props {
  /** Singular label, e.g. "Condition". */
  label: string
  hint?: string
  defs: TypeDef[]
  lookups: Lookups
  items: Item[]
  onChange: (items: Item[]) => void
}

const OPTION_LOOKUPS = new Set(['role', 'group', 'resolution', 'user', 'screen'])

/** Form for a list of conditions / validators / post-functions, driven entirely by the server's type catalogue. */
export function ItemListEditor({ label, hint, defs, lookups, items, onChange }: Props) {
  const { tr } = useI18n();

  const addId = useId()

  const update = (i: number, next: Item) => onChange(items.map((it, idx) => (idx === i ? next : it)))
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i))

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-[var(--text-primary)]">{label}s</legend>
      {hint && <p className="text-xs text-[var(--text-tertiary)]">{hint}</p>}

      {items.length === 0 && <p className="text-xs text-[var(--text-tertiary)]">{tr('None configured.')}</p>}

      <ul className="space-y-2">
        {items.map((item, i) => {
          const def = defs.find((d) => d.type === item.type)
          const missing = def ? missingParams(item, defs) : []
          return (
            <li key={i} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] p-2.5 space-y-2">
              <div className="flex items-start gap-2">
                {def ? (
                  <TypeSelect
                    label={tr('{label} {n} type', { label, n: i + 1 })}
                    value={item.type}
                    defs={defs}
                    onChange={(t) => { const d = defs.find((x) => x.type === t); if (d) update(i, newItem(d) as Item) }}
                  />
                ) : (
                  <p className="flex-1 flex items-center gap-1.5 text-xs text-[var(--warning)]">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
                    <span>{tr('Unsupported type')} <code>{String(item.type)}</code>{tr(': the workflow engine ignores it. Remove it to save this transition.')}</span>
                  </p>
                )}
                <button type="button" className="veqsio-btn-ghost p-1.5" onClick={() => remove(i)} aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {def && <p className="text-xs text-[var(--text-tertiary)]">{def.description}</p>}
              {def?.params.filter((p) => !(p.options && p.options.length === 1)).map((p) => (
                <ParamField
                  key={p.name}
                  param={p}
                  value={item[p.name]}
                  lookups={lookups}
                  onChange={(v) => {
                    const next: Item = { ...item }
                    if (v === undefined || v === '') delete next[p.name]
                    else next[p.name] = v
                    update(i, next)
                  }}
                />
              ))}
              {missing.length > 0 && <p className="text-xs text-[var(--error)]" role="status">{tr('Required:')} {missing.join(', ')}</p>}
            </li>
          )
        })}
      </ul>

      <div className="flex items-center gap-2">
        <label htmlFor={addId} className="sr-only">{tr('Add')} {label.toLowerCase()}</label>
        <select
          id={addId}
          className="veqsio-input flex-1 text-sm"
          value=""
          onChange={(e) => { const d = defs.find((x) => x.type === e.target.value); if (d) onChange([...items, newItem(d) as Item]) }}
        >
          <option value="">{tr('+ Add')} {label.toLowerCase()}…</option>
          {defs.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
        </select>
        <Plus className="w-4 h-4 text-[var(--text-tertiary)] shrink-0" aria-hidden />
      </div>
    </fieldset>
  )
}

function TypeSelect({ label, value, defs, onChange }: { label: string; value: string; defs: TypeDef[]; onChange: (t: string) => void }) {
  const id = useId()
  return (
    <div className="flex-1 min-w-0">
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} className="veqsio-input w-full text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {defs.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
      </select>
    </div>
  )
}

function ParamField({ param, value, lookups, onChange }: { param: ParamDef; value: unknown; lookups: Lookups; onChange: (v: unknown) => void }) {
  const { tr } = useI18n();

  const id = useId()
  const label = (
    <label htmlFor={id} className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
      {param.label}{param.required && <span className="text-[var(--error)]" aria-hidden> *</span>}
    </label>
  )
  const help = param.help ? <p className="text-xs text-[var(--text-tertiary)] mt-1">{param.help}</p> : null

  if (OPTION_LOOKUPS.has(param.type)) {
    const opts = lookups[param.type] ?? []
    const known = opts.some((o) => o.id === value)
    return (
      <div>
        {label}
        <select
          id={id}
          className="veqsio-input w-full text-sm"
          value={value === undefined || value === null ? '' : String(value)}
          required={param.required}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        >
          <option value="">{param.required ? tr('Choose…') : param.type === 'user' ? tr('Person running the transition') : tr('None')}</option>
          {!known && typeof value === 'number' && <option value={value}>#{value} {tr('(not found)')}</option>}
          {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        {help}
      </div>
    )
  }
  if (param.type === 'enum' || param.type === 'permission') {
    return (
      <div>
        {label}
        <select id={id} className="veqsio-input w-full text-sm" value={String(value ?? '')} required={param.required} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{tr('Choose…')}</option>
          {(param.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        {help}
      </div>
    )
  }
  if (param.type === 'text') {
    return (
      <div>
        {label}
        <textarea id={id} className="veqsio-input w-full text-sm min-h-[64px]" maxLength={param.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        {help}
      </div>
    )
  }
  if (param.type === 'number') {
    return (
      <div>
        {label}
        <input id={id} type="number" className="veqsio-input w-full text-sm" value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
        {help}
      </div>
    )
  }
  return (
    <div>
      {label}
      <input id={id} type="text" className="veqsio-input w-full text-sm font-mono" maxLength={param.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      {help}
    </div>
  )
}
