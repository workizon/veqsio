'use client'

import { useState } from 'react'
import { toast } from '@/components/toast'
import { useIssueMilestones, useMilestones, useSetIssueMilestones } from '@/hooks/use-milestones'
import { useFeatures } from '@/hooks/use-features'

/**
 * Milestones field in the issue sidebar. Hidden when the feature is off, and for issues whose project has no milestones
 * (and no linked ones) so the sidebar stays quiet. Editing is offered to everyone; the server enforces EDIT_ISSUES.
 */
export function MilestonesField({ issueKey, projectKey }: { issueKey: string; projectKey: string }) {
  const features = useFeatures()
  const on = features.isEnabled('milestones')
  const mine = useIssueMilestones(issueKey, on)
  const all = useMilestones(projectKey, on && !mine.isError)
  const set = useSetIssueMilestones(issueKey)
  const [pick, setPick] = useState('')
  if (!on || mine.isError || mine.isLoading) return null
  const current = mine.data ?? []
  const available = (all.data?.milestones ?? []).filter((m) => !current.some((c) => c.id === m.id))
  if (current.length === 0 && available.length === 0) return null

  const save = async (ids: number[]) => {
    try { await set.mutateAsync(ids); setPick('') } catch (err: any) { toast(err?.message || 'Could not update milestones', 'error') }
  }

  return (
    <div className="veqsio-card space-y-2" data-testid="milestones-field">
      <h3 className="text-caption text-[var(--text-secondary)]" id="milestones-label">Milestones</h3>
      {current.length === 0 ? <p className="text-sm text-[var(--text-tertiary)]">None</p> : (
        <ul className="flex flex-wrap gap-2" aria-labelledby="milestones-label">
          {current.map((m) => (
            <li key={m.id} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs">
              <span>{m.name}{m.state === 'reached' ? ' (reached)' : m.targetDate ? ` · ${m.targetDate}` : ''}</span>
              <button type="button" aria-label={`Remove milestone ${m.name}`} className="text-[var(--text-tertiary)] hover:text-[var(--error)]" onClick={() => save(current.filter((c) => c.id !== m.id).map((c) => c.id))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <label className="text-xs block text-[var(--text-secondary)]">Add to a milestone
          <select className="veqsio-input block w-full text-sm" value={pick} disabled={set.isPending} onChange={(e) => { setPick(e.target.value); if (e.target.value) save([...current.map((c) => c.id), Number(e.target.value)]) }}>
            <option value="">Choose…</option>
            {available.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}
