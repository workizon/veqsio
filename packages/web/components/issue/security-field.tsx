'use client'

import { useState } from 'react'
import { Check, Lock } from 'lucide-react'
import { FieldRow, InlineValueButton, Popover } from './primitives'
import { useProjectSecurity } from '@/hooks/use-issue-security'
import { levelChoices, securityPayload } from '@/lib/issue-security'

const optionClass = 'w-full flex items-start gap-2 px-3 py-2 text-left text-body-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none'

/** The row in the details panel: hidden unless the issue has a level or the viewer may set one. */
export function SecurityRow(props: { projectKey: string; level: { id: number; name: string; description?: string | null } | null | undefined; onChange: (next: { id: number } | null) => void }) {
  const { data } = useProjectSecurity(props.projectKey)
  const canSet = !!data?.canSet && data.levels.length > 0
  if (!props.level && !canSet) return null
  return (
    <FieldRow label="Security level" htmlFor="field-security">
      <SecurityField {...props} />
    </FieldRow>
  )
}

/**
 * Issue view field "Security level". Shown when the issue has a level, or when the project offers levels and the viewer
 * may set them (SET_ISSUE_SECURITY). Everyone else never sees the row.
 */
export function SecurityField({ projectKey, level, onChange }: {
  projectKey: string
  level: { id: number; name: string; description?: string | null } | null | undefined
  onChange: (next: { id: number } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const { data } = useProjectSecurity(projectKey)
  const canSet = !!data?.canSet && (data.levels.length ?? 0) > 0
  const display = level ? (
    <span className="flex items-center gap-1.5 text-[var(--warning)]"><Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{level.name}</span></span>
  ) : <span className="text-[var(--text-tertiary)]">None</span>

  if (!canSet) return <span className="py-1 inline-block" title={level?.description ?? undefined}>{display}</span>

  const choices = levelChoices(data!.levels, data!.defaultLevelId)
  const current = level ? String(level.id) : ''
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Set security level"
      align="right"
      haspopup="listbox"
      panelClassName="w-[min(18rem,calc(100vw-2rem))] py-1"
      trigger={(p) => (
        <InlineValueButton id="field-security" {...p} aria-label={`Security level: ${level?.name ?? 'None'}. Change security level`}>{display}</InlineValueButton>
      )}
    >
      <ul>
        {choices.map((c) => (
          <li key={c.value || 'none'}>
            <button
              type="button"
              role="option"
              aria-selected={current === c.value}
              className={optionClass}
              onClick={() => {
                setOpen(false)
                const next = securityPayload(c.value, level?.id ?? null)
                if (next !== undefined) onChange(next)
              }}
            >
              <span className="min-w-0">
                <span className="block">{c.label}</span>
                {c.description && <span className="block text-caption text-[var(--text-tertiary)]">{c.description}</span>}
              </span>
              {current === c.value && <Check className="w-4 h-4 ml-auto shrink-0 text-[var(--brand-500)]" aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ul>
      <p className="px-3 py-2 text-caption text-[var(--text-tertiary)] border-t border-[var(--surface-3)]">Only members of the level can see the issue afterwards.</p>
    </Popover>
  )
}
