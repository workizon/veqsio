'use client'

import { useId } from 'react'
import { AlertCircle, Paperclip, X } from 'lucide-react'
import { fromLocalInput, toLocalInput, visibleKeys, type FieldDef } from '@/lib/request-form'

/**
 * The customer-facing request form. Used by the portal and by the form builder's live preview so what
 * the admin sees is exactly what customers get. Internal-only fields are never rendered here.
 */
export interface RequestFormFieldsProps {
  fields: FieldDef[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  files?: Record<string, File[]>
  onFiles?: (key: string, files: File[]) => void
  errors?: Record<string, string>
  idPrefix?: string
  disabled?: boolean
}

export function RequestFormFields({ fields, values, onChange, files = {}, onFiles, errors = {}, idPrefix = 'f', disabled }: RequestFormFieldsProps) {
  const visible = visibleKeys(fields, values)
  return (
    <>
      {fields.filter((f) => !f.internal && visible.has(f.key)).map((f) => (
        <FieldInput
          key={f.key} field={f} id={`${idPrefix}-${f.key}`} value={values[f.key]} error={errors[f.key]} disabled={disabled}
          onChange={(v) => onChange(f.key, v)} files={files[f.key] ?? []} onFiles={(fs) => onFiles?.(f.key, fs)}
        />
      ))}
    </>
  )
}

interface FieldInputProps {
  field: FieldDef; id: string; value: unknown; error?: string; disabled?: boolean
  onChange: (v: unknown) => void; files: File[]; onFiles: (f: File[]) => void
}

export function FieldInput({ field, id, value, error, disabled, onChange, files, onFiles }: FieldInputProps) {
  const uid = useId()
  const helpId = field.helpText ? `${uid}-help` : undefined
  const errId = error ? `${uid}-err` : undefined
  const describedBy = [helpId, errId].filter(Boolean).join(' ') || undefined
  const required = field.required && field.type !== 'checkbox'
  const labelText = <>{field.label}{required && <span aria-hidden className="text-[var(--error)]"> *</span>}{required && <span className="sr-only"> (required)</span>}</>
  const labelCls = 'block text-body-sm font-medium text-[var(--text-primary)]'
  const invalid = error ? 'border-[var(--error)] focus:border-[var(--error)]' : ''
  const help = field.helpText && field.type !== 'help' ? <p id={helpId} className="text-caption font-normal text-[var(--text-tertiary)]">{field.helpText}</p> : null
  const err = error ? <p id={errId} role="alert" className="flex items-center gap-1.5 text-caption text-[var(--error)]"><AlertCircle aria-hidden className="w-3.5 h-3.5 shrink-0" />{error}</p> : null
  const choice = 'flex items-center gap-3 min-h-[44px] px-3 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] text-body text-[var(--text-primary)] cursor-pointer hover:border-[var(--surface-4)] hover:bg-[var(--surface-1)] has-[:checked]:border-[var(--brand-400)] has-[:checked]:bg-[var(--brand-50)]'
  const common = { id, disabled, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, 'aria-required': required || undefined }
  const options = field.options ?? []
  const str = typeof value === 'string' ? value : ''
  const arr = Array.isArray(value) ? (value as string[]) : []

  switch (field.type) {
    case 'section':
      return <h3 className="pt-4 text-heading-3 text-[var(--text-primary)] border-b border-[var(--surface-3)] pb-2">{field.label}</h3>
    case 'help':
      return <p className="text-body-sm text-[var(--text-secondary)] rounded-lg border border-[var(--brand-100)] bg-[var(--brand-50)] px-4 py-3 whitespace-pre-wrap">{field.helpText || field.label}</p>
    case 'checkbox':
      return (
        <div className="space-y-1">
          <label htmlFor={id} className={choice}>
            <input type="checkbox" {...common} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
            {field.label}
          </label>
          {help}{err}
        </div>
      )
    case 'checkboxes':
    case 'radio': {
      const isRadio = field.type === 'radio'
      return (
        <fieldset className="space-y-1.5" aria-describedby={describedBy} aria-required={required || undefined}>
          <legend className={`${labelCls} mb-1.5`}>{labelText}</legend>
          {help}
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((o, i) => (
              <label key={o} htmlFor={`${id}-${i}`} className={choice}>
                <input
                  id={`${id}-${i}`} type={isRadio ? 'radio' : 'checkbox'} name={id} disabled={disabled}
                  checked={isRadio ? str === o : arr.includes(o)}
                  onChange={(e) => {
                    if (isRadio) onChange(o)
                    else onChange(e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))
                  }}
                />
                {o}
              </label>
            ))}
          </div>
          {err}
        </fieldset>
      )
    }
    case 'attachment':
      return (
        <div className="space-y-1.5">
          <label htmlFor={id} className={labelCls}>{labelText}</label>
          <div className="rounded-lg border border-dashed border-[var(--surface-4)] bg-[var(--surface-1)] p-3 focus-within:border-[var(--brand-500)] focus-within:shadow-[0_0_0_4px_var(--brand-100)]">
            <input
              id={id} type="file" multiple disabled={disabled} aria-describedby={describedBy}
              className="block w-full text-body-sm text-[var(--text-secondary)] file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-[var(--surface-4)] file:bg-[var(--surface-0)] file:px-3 file:py-2 file:text-body-sm file:font-medium file:text-[var(--text-primary)] hover:file:bg-[var(--surface-2)]"
              onChange={(e) => { onFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = '' }}
            />
          </div>
          {files.length > 0 && (
            <ul className="space-y-1.5">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] pl-3 pr-1 text-body-sm">
                  <Paperclip aria-hidden className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" />
                  <span className="truncate flex-1 py-2">{f.name}</span>
                  <button type="button" className="veqsio-btn-ghost min-w-[44px] min-h-[36px] inline-flex items-center justify-center" aria-label={`Remove ${f.name}`} onClick={() => onFiles(files.filter((_, j) => j !== i))}>
                    <X className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {help}{err}
        </div>
      )
    default:
  }

  let control: React.ReactNode
  switch (field.type) {
    case 'textarea':
      control = <textarea {...common} rows={4} placeholder={field.placeholder} className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`} value={str} onChange={(e) => onChange(e.target.value)} />
      break
    case 'select':
      control = (
        <select {...common} className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.placeholder || 'Select…'}</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
      break
    case 'multiselect':
      control = (
        <select {...common} multiple size={Math.min(Math.max(options.length, 2), 6)} className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`}
          value={arr} onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
      break
    case 'number':
      control = (
        <input {...common} type="number" placeholder={field.placeholder} min={field.validation?.min} max={field.validation?.max} className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`}
          value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      )
      break
    case 'date':
      control = <input {...common} type="date" className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`} value={str} onChange={(e) => onChange(e.target.value)} />
      break
    case 'datetime':
      control = <input {...common} type="datetime-local" className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`} value={toLocalInput(value)} onChange={(e) => onChange(fromLocalInput(e.target.value))} />
      break
    case 'url':
      control = <input {...common} type="url" placeholder={field.placeholder || 'https://'} className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`} value={str} onChange={(e) => onChange(e.target.value)} />
      break
    case 'email':
      control = <input {...common} type="email" placeholder={field.placeholder || 'name@example.com'} className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`} value={str} onChange={(e) => onChange(e.target.value)} />
      break
    case 'user':
      control = <input {...common} type="email" placeholder={field.placeholder || 'Email of a colleague'} autoComplete="off" className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`} value={str} onChange={(e) => onChange(e.target.value)} />
      break
    default: // text and unknown future types
      control = <input {...common} type="text" placeholder={field.placeholder} maxLength={field.validation?.maxLength} className={`veqsio-input w-full min-h-[44px] px-3 ${invalid}`} value={str} onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={labelCls}>{labelText}</label>
      {control}
      {help}{err}
    </div>
  )
}
