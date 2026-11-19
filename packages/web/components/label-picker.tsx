'use client'

import { useId, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useLabels } from '@/hooks/use-labels'
import { LabelChip } from '@/components/label-chip'
import { addLabel, buildPickerRows, moveCursor } from '@/lib/label-picker'

/**
 * Combobox for labels: type to filter existing labels (colour dot, name, usage), pick with arrows and
 * Enter, or create a new one on the fly. Selected labels are shown as removable chips.
 * Any editor can attach labels; colours and the remove-on-resolution flag are managed on the admin page.
 */
export function LabelPicker({
  value,
  onChange,
  autoFocus = false,
  inputId,
  placeholder = 'Add a label',
}: {
  value: string[]
  onChange: (labels: string[]) => void
  autoFocus?: boolean
  inputId?: string
  placeholder?: string
}) {
  const { data } = useLabels()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [open, setOpen] = useState(false)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const options = data?.labels ?? []
  const colourOf = useMemo(() => new Map(options.map((o) => [o.name.toLowerCase(), o])), [options])
  const rows = useMemo(() => buildPickerRows(options, value, query), [options, value, query])
  const active = rows.length ? Math.min(cursor, rows.length - 1) : -1

  const commit = (name: string) => {
    onChange(addLabel(value, name))
    setQuery('')
    setCursor(0)
    inputRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setCursor(moveCursor(active, e.key === 'ArrowDown' ? 1 : -1, rows.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[active]
      if (row) commit(row.kind === 'option' ? row.option.name : row.name)
      else if (query.trim()) commit(query)
    } else if (e.key === 'Backspace' && !query && value.length > 0) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape' && open && query) {
      e.stopPropagation()
      setQuery('')
    }
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Selected labels">
          {value.map((name) => {
            const info = colourOf.get(name.toLowerCase())
            return (
              <li key={name}>
                <LabelChip name={name} color={info?.color} removeOnResolve={info?.removeOnResolve} onRemove={() => onChange(value.filter((v) => v !== name))} />
              </li>
            )
          })}
        </ul>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={open && rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="veqsio-input w-full text-sm"
          autoComplete="off"
        />
        {open && rows.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-40 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-1 shadow-lg"
          >
            {rows.map((row, i) => {
              const isActive = i === active
              const base = `flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${isActive ? 'bg-[var(--surface-2)]' : ''}`
              if (row.kind === 'create') {
                return (
                  <li key="create" id={`${listId}-${i}`} role="option" aria-selected={isActive} className={`${base} text-[var(--brand-600)]`} onMouseDown={(e) => { e.preventDefault(); commit(row.name) }}>
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    Create <strong className="font-semibold">{row.name}</strong>
                  </li>
                )
              }
              return (
                <li key={row.option.name} id={`${listId}-${i}`} role="option" aria-selected={isActive} className={base} onMouseDown={(e) => { e.preventDefault(); commit(row.option.name) }}>
                  <LabelChip name={row.option.name} color={row.option.color} removeOnResolve={(row.option as { removeOnResolve?: boolean }).removeOnResolve} />
                  {typeof row.option.issueCount === 'number' && <span className="ml-auto text-xs text-[var(--text-tertiary)]">{row.option.issueCount}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
