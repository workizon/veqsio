'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'
import { toast } from '@/components/toast'
import { ApiError, useAssignProjectScheme, useProjectSecurity, useSecuritySchemes } from '@/hooks/use-issue-security'

/** Project setting: which issue security scheme this project uses. Everyone who can open the settings sees it, system administrators change it. */
export function ProjectSecurityPanel({ projectId, projectKey }: { projectId: number; projectKey: string }) {
  const { data: current } = useProjectSecurity(projectKey)
  const { data: all, isError: notAdmin } = useSecuritySchemes()
  const assign = useAssignProjectScheme()
  const [choice, setChoice] = useState<string | null>(null)
  const [needsMapping, setNeedsMapping] = useState(false)
  const currentValue = current?.scheme ? String(current.scheme.id) : ''
  const value = choice ?? currentValue

  const apply = async () => {
    try {
      await assign.mutateAsync({ projectId, schemeId: value ? Number(value) : null })
      setChoice(null); setNeedsMapping(false)
      toast('Issue security scheme updated', 'success')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNeedsMapping(true)
      else toast((e as Error).message, 'error')
    }
  }

  return (
    <section aria-labelledby="security-heading" className="max-w-xl rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 space-y-3">
      <h2 id="security-heading" className="text-heading-3 flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-[var(--brand-500)]" aria-hidden /> Issue security</h2>
      <p className="text-body-sm text-[var(--text-secondary)]">
        With a scheme, issues of this project can get a security level. Only members of the level see such an issue, including administrators.
      </p>
      {notAdmin || !all ? (
        <p className="text-body">
          Scheme: <span className="font-medium">{current?.scheme?.name ?? 'None'}</span>
          <span className="block text-body-sm text-[var(--text-tertiary)]">System administrators can change it.</span>
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="project-security-scheme" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">Scheme</label>
            <select id="project-security-scheme" className="veqsio-input" value={value} onChange={(e) => { setChoice(e.target.value); setNeedsMapping(false) }}>
              <option value="">None</option>
              {all.schemes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <button type="button" className="veqsio-btn-primary" onClick={() => void apply()} disabled={assign.isPending || value === currentValue}>Apply</button>
        </div>
      )}
      {needsMapping && (
        <p role="alert" className="text-body-sm text-[var(--warning)]">
          Issues of this project use levels of the current scheme. Map them on the <Link href="/admin/issue-security" className="underline">Issue security page</Link> (Assign project), so none of them becomes visible by accident.
        </p>
      )}
      {current?.scheme && (
        <p className="text-body-sm text-[var(--text-secondary)]">
          Levels: {current.levels.map((l) => l.name).join(', ') || 'none yet'}. <Link href="/admin/issue-security" className="text-[var(--brand-500)] hover:underline">Manage levels and members</Link>
        </p>
      )}
    </section>
  )
}
