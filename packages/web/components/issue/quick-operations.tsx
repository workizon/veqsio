'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/modal'

export interface QuickOperation {
  id: string
  label: string
  hint?: string
  run: () => void
}

/** The "." dialog from Jira: type to filter, Enter runs the highlighted operation. */
export function QuickOperations({ isOpen, onClose, operations }: { isOpen: boolean; onClose: () => void; operations: QuickOperation[] }) {
  const { tr } = useI18n();

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (isOpen) { setQuery(''); setActive(0) }
  }, [isOpen])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? operations.filter((o) => o.label.toLowerCase().includes(q)) : operations
  }, [operations, query])

  useEffect(() => { setActive(0) }, [query])

  const run = (op?: QuickOperation) => {
    if (!op) return
    onClose()
    // let the dialog unmount first so focus/popovers opened by the operation are not closed by it
    setTimeout(op.run, 0)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={tr('Operations')} size="sm">
      <div className="space-y-2">
        <label htmlFor="quick-ops-input" className="sr-only">{tr('Filter operations')}</label>
        <input
          id="quick-ops-input"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-ops-list"
          aria-activedescendant={filtered[active] ? `quick-op-${filtered[active].id}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
            if (e.key === 'Enter') { e.preventDefault(); run(filtered[active]) }
          }}
          placeholder={tr('Start typing to find an operation')}
          className="veqsio-input w-full"
        />
        <ul id="quick-ops-list" role="listbox" aria-label={tr('Operations')} className="max-h-72 overflow-y-auto">
          {filtered.length === 0 && <li className="px-3 py-2 text-body-sm text-[var(--text-tertiary)]">{tr('No matching operations')}</li>}
          {filtered.map((op, i) => (
            <li key={op.id} id={`quick-op-${op.id}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(op)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-left text-body-sm text-[var(--text-primary)] ${i === active ? 'bg-[var(--surface-2)]' : ''}`}
              >
                <span>{op.label}</span>
                {op.hint && <kbd className="px-1.5 rounded border border-[var(--surface-4)] bg-[var(--surface-2)] font-mono text-[11px] text-[var(--text-secondary)]">{op.hint}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
