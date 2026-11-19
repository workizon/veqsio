'use client'

import { useState } from 'react'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { Select } from './select'

export interface ConflictItem {
  id: string
  type: string
  entityType: string
  sourceKey?: string
  message: string
  suggestedRename?: string
}

interface MigrationConflictsProps {
  conflicts: ConflictItem[]
  onResolve: (resolutions: Record<string, string>) => void
  onContinue: () => void
}

const resolutionOptions = [
  { value: 'skip', label: 'Skip' },
  { value: 'overwrite', label: 'Overwrite' },
  { value: 'rename', label: 'Rename' },
]

export function MigrationConflicts({ conflicts, onResolve, onContinue }: MigrationConflictsProps) {
  const [resolutions, setResolutions] = useState<Record<string, string>>(
    () => {
      const initial: Record<string, string> = {}
      conflicts.forEach((c) => {
        initial[c.id] = 'skip'
      })
      return initial
    }
  )

  const handleChange = (id: string, value: string) => {
    const next = { ...resolutions, [id]: value }
    setResolutions(next)
    onResolve(next)
  }

  const grouped = conflicts.reduce<Record<string, ConflictItem[]>>((acc, c) => {
    acc[c.type] = acc[c.type] || []
    acc[c.type].push(c)
    return acc
  }, {})

  return (
    <div className="veqsio-card p-6 space-y-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-5 h-5 text-[var(--warning)]" />
        <h3 className="text-heading-2 text-[var(--text-primary)]">
          {conflicts.length} Conflict{conflicts.length !== 1 ? 's' : ''} Detected
        </h3>
      </div>

      <div className="space-y-4">
        {Object.entries(grouped).map(([type, items]) => (
          <div key={type} className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              {type.replace(/_/g, ' ')}
            </h4>
            <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="veqsio-table-header">
                      <th className="text-left px-4 py-2">Entity</th>
                      <th className="text-left px-4 py-2">Key / ID</th>
                      <th className="text-left px-4 py-2">Issue</th>
                      <th className="text-left px-4 py-2">Resolution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((conflict) => (
                      <tr key={conflict.id} className="veqsio-table-row">
                        <td className="px-4 py-2 whitespace-nowrap text-[var(--text-primary)]">{conflict.entityType}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-[var(--text-secondary)] font-mono">
                          {conflict.sourceKey || conflict.id}
                        </td>
                        <td className="px-4 py-2 text-[var(--text-secondary)] max-w-xs truncate">
                          {conflict.message}
                          {resolutions[conflict.id] === 'rename' && conflict.suggestedRename && (
                            <span className="ml-1 text-[var(--brand-500)]">→ {conflict.suggestedRename}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 w-40">
                          <Select
                            value={resolutions[conflict.id] || 'skip'}
                            options={resolutionOptions}
                            onChange={(value) => handleChange(conflict.id, value)}
                            size="sm"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          onClick={onContinue}
          className="veqsio-btn-primary flex items-center gap-2"
        >
          <span>Continue with Migration</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
