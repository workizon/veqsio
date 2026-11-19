'use client'

export interface MetaOption { id: string; name?: string; value?: string; color?: string | null }
export interface MetaField { name: string; key: string; required?: boolean; defaultValue?: string; description?: string; schema?: { type?: string; customId?: number }; allowedValues?: MetaOption[] }
export interface MetaType { id: string; name: string; subtask: boolean; fields?: Record<string, MetaField> }
export interface MetaProject { id: string; key: string; name: string; issuetypes: MetaType[] }


/** One custom field, drawn by its type (text, number, date, single or multiple choice, checkbox, URL). */
export function CustomFieldInput({ field, value, onChange }: { field: MetaField; value: unknown; onChange: (v: unknown) => void }) {
  const type = field.schema?.type ?? 'text'
  const options = field.allowedValues ?? []
  const label = field.name
  switch (type) {
    case 'textarea':
      return <textarea aria-label={label} className="veqsio-input w-full" rows={3} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
    case 'number':
      return <input aria-label={label} className="veqsio-input max-w-[10rem]" inputMode="decimal" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
    case 'date':
      return <input aria-label={label} type="date" className="veqsio-input max-w-[12rem]" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
    case 'datetime':
      return <input aria-label={label} type="datetime-local" className="veqsio-input max-w-[16rem]" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
    case 'select':
    case 'radio':
      return (
        <select aria-label={label} className="veqsio-input max-w-xs w-full" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">None</option>
          {options.map((o) => <option key={o.id} value={o.value}>{o.value}</option>)}
        </select>
      )
    case 'multiselect':
    case 'checkbox': {
      const selected = Array.isArray(value) ? (value as string[]) : []
      if (options.length === 0) return <input type="checkbox" aria-label={label} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {options.map((o) => (
            <label key={o.id} className="inline-flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={selected.includes(o.value ?? '')} onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))} /> {o.value}
            </label>
          ))}
        </div>
      )
    }
    case 'url':
      return <input aria-label={label} type="url" className="veqsio-input w-full" placeholder="https://" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
    default:
      return <input aria-label={label} className="veqsio-input w-full" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
  }
}
