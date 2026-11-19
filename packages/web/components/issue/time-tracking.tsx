'use client'

import { useMemo, useState } from 'react'
import { Clock } from 'lucide-react'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import { WorklogForm } from '@/components/worklog-panel'
import { formatDuration, parseDuration } from '@/hooks/use-worklogs'
import type { ApiIssue } from '@/hooks/use-issues'
import { computeTimeTracking, formatSeconds } from '@/lib/issue-view'
import { CollapsibleSection, FieldRow, InlineValueButton, Popover } from './primitives'

export function TimeTrackingSection({ issue, onSaveEstimate }: { issue: ApiIssue; onSaveEstimate: (seconds: number) => void }) {
  const [logOpen, setLogOpen] = useState(false)
  const [estimateOpen, setEstimateOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const tt = useMemo(() => computeTimeTracking(issue.fields.timeestimate, issue.fields.timespent), [issue.fields.timeestimate, issue.fields.timespent])

  const saveEstimate = () => {
    const text = draft.trim()
    if (!text) {
      onSaveEstimate(0)
      setEstimateOpen(false)
      return
    }
    const seconds = parseDuration(text)
    if (!seconds) {
      toast('Invalid duration. Use e.g. 2h 30m, 1d or 1w', 'error')
      return
    }
    onSaveEstimate(seconds)
    setEstimateOpen(false)
  }

  return (
    <CollapsibleSection
      id="time-tracking"
      title="Time tracking"
      actions={
        <button
          type="button"
          onClick={() => setLogOpen(true)}
          className="flex items-center gap-1 text-caption text-[var(--brand-500)] hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
        >
          <Clock className="w-3.5 h-3.5" aria-hidden="true" /> Log work
        </button>
      }
    >
      {tt.hasData && (
        <div className="py-1">
          <div
            className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-3)]"
            role="progressbar"
            aria-label="Time spent against the estimate"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={tt.spentPercent}
            aria-valuetext={`${formatSeconds(tt.spent, '0m')} logged${tt.estimate ? ` of ${formatSeconds(tt.estimate)}` : ''}`}
          >
            <div className={tt.overrun ? 'bg-[var(--error)]' : 'bg-[var(--brand-500)]'} style={{ width: `${tt.spentPercent}%` }} />
          </div>
          <div className="flex justify-between text-caption text-[var(--text-tertiary)] mt-1">
            <span>{formatSeconds(tt.spent, '0m')} logged</span>
            <span>{tt.remaining === null ? 'No estimate' : `${formatSeconds(tt.remaining, '0m')} remaining`}</span>
          </div>
        </div>
      )}

      <FieldRow label="Original estimate" htmlFor="field-estimate">
        <Popover
          open={estimateOpen}
          onOpenChange={(o) => { setEstimateOpen(o); if (o) setDraft(tt.estimate ? formatDuration(tt.estimate) : '') }}
          label="Edit original estimate"
          align="right"
          panelClassName="w-[min(18rem,calc(100vw-2rem))] p-3 space-y-2"
          trigger={(p) => (
            <InlineValueButton id="field-estimate" {...p} aria-label={`Original estimate: ${formatSeconds(tt.estimate)}. Edit`}>
              {tt.estimate ? formatSeconds(tt.estimate) : <span className="text-[var(--text-tertiary)]">None</span>}
            </InlineValueButton>
          )}
        >
          <form onSubmit={(e) => { e.preventDefault(); saveEstimate() }} className="space-y-2">
            <label htmlFor="estimate-input" className="text-caption text-[var(--text-secondary)] block">Estimate (w, d, h, m)</label>
            <input id="estimate-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. 2d 4h" className="veqsio-input w-full text-sm" />
            <div className="flex gap-2">
              <button type="submit" className="veqsio-btn-primary text-sm">Save</button>
              <button type="button" onClick={() => setEstimateOpen(false)} className="veqsio-btn-secondary text-sm">Cancel</button>
            </div>
          </form>
        </Popover>
      </FieldRow>
      <FieldRow label="Time spent"><span className="py-1 inline-block">{formatSeconds(tt.spent, 'None')}</span></FieldRow>
      <FieldRow label="Remaining"><span className={`py-1 inline-block ${tt.overrun ? 'text-[var(--error)]' : ''}`}>{tt.remaining === null ? 'None' : formatSeconds(tt.remaining, '0m')}</span></FieldRow>

      <Modal isOpen={logOpen} onClose={() => setLogOpen(false)} title="Log work" size="md">
        <WorklogForm issueKey={issue.key} issueId={issue.id} onClose={() => setLogOpen(false)} />
      </Modal>
    </CollapsibleSection>
  )
}
