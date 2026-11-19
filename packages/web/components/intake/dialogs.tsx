'use client'

import { useId, useState } from 'react'
import { Modal } from '@/components/modal'
import { useIntakeAssignable, useIntakePriorities, useIntakeTypes, type ActionBody, type IntakeItem } from '@/hooks/use-intake'

export type DialogKind = 'accept' | 'decline' | 'snooze' | 'duplicate' | 'submit'

interface Common {
  project: string
  /** One item (detail panel) or several (bulk). */
  items: IntakeItem[]
  busy: boolean
  error: string | null
  onCancel: () => void
}

const Field = ({ label, hint, children, id }: { label: string; hint?: string; children: React.ReactNode; id: string }) => (
  <div>
    <label htmlFor={id} className="block text-sm font-medium text-[var(--text-primary)] mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{hint}</p>}
  </div>
)

const Footer = ({ busy, error, onCancel, submit }: { busy: boolean; error: string | null; onCancel: () => void; submit: string }) => (
  <>
    {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
    <div className="flex justify-end gap-2 pt-2">
      <button type="button" className="veqsio-btn-secondary" onClick={onCancel}>Cancel</button>
      <button type="submit" className="veqsio-btn-primary" disabled={busy}>{busy ? 'Working…' : submit}</button>
    </div>
  </>
)

const countLabel = (n: number) => (n === 1 ? 'this item' : `${n} items`)

export function AcceptDialog({ project, items, busy, error, onCancel, onSubmit }: Common & { onSubmit: (b: ActionBody) => void }) {
  const id = useId()
  const types = useIntakeTypes(project)
  const priorities = useIntakePriorities()
  const users = useIntakeAssignable()
  const [typeId, setTypeId] = useState('')
  const [priorityId, setPriorityId] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [summary, setSummary] = useState(items.length === 1 ? items[0].title : '')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const effectiveType = typeId || types.data?.[0]?.id || ''
  const single = items.length === 1
  const withEmail = items.filter((i) => i.requester.email).length
  return (
    <Modal isOpen onClose={onCancel} title={`Accept ${countLabel(items.length)}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!effectiveType) return
          onSubmit({
            issueTypeId: Number(effectiveType),
            priorityId: priorityId ? Number(priorityId) : undefined,
            assigneeId: assigneeId ? Number(assigneeId) : undefined,
            summary: single && summary.trim() ? summary.trim() : undefined,
            note: note.trim() || undefined,
            reason: reason.trim() || undefined,
          })
        }}
      >
        <p className="text-sm text-[var(--text-secondary)]">
          {single ? 'An issue is created from this submission.' : `An issue is created for each of the ${items.length} submissions, with the same settings.`}
        </p>
        <Field id={`${id}-type`} label="Issue type">
          <select id={`${id}-type`} className="veqsio-input w-full" value={effectiveType} onChange={(e) => setTypeId(e.target.value)} required autoFocus>
            {types.isLoading && <option value="">Loading…</option>}
            {(types.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field id={`${id}-prio`} label="Priority">
          <select id={`${id}-prio`} className="veqsio-input w-full" value={priorityId} onChange={(e) => setPriorityId(e.target.value)}>
            <option value="">Default</option>
            {(priorities.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field id={`${id}-assignee`} label="Assignee">
          <select id={`${id}-assignee`} className="veqsio-input w-full" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Unassigned</option>
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        {single && (
          <Field id={`${id}-summary`} label="Summary" hint="Defaults to the submitted title.">
            <input id={`${id}-summary`} className="veqsio-input w-full" maxLength={255} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
        )}
        <Field id={`${id}-note`} label="Note for the issue (optional)" hint="Added to the issue description.">
          <textarea id={`${id}-note`} className="veqsio-input w-full min-h-[60px]" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field id={`${id}-reason`} label="Message to the requester (optional)" hint={withEmail ? `${withEmail} requester(s) with an email address are notified.` : 'None of the requesters has an email address, nobody is notified.'}>
          <textarea id={`${id}-reason`} className="veqsio-input w-full min-h-[60px]" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Footer busy={busy || !effectiveType} error={error} onCancel={onCancel} submit="Accept" />
      </form>
    </Modal>
  )
}

export function DeclineDialog({ items, busy, error, onCancel, onSubmit }: Common & { onSubmit: (b: ActionBody) => void }) {
  const id = useId()
  const [reason, setReason] = useState('')
  const withEmail = items.filter((i) => i.requester.email).length
  return (
    <Modal isOpen onClose={onCancel} title={`Decline ${countLabel(items.length)}`}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit({ reason: reason.trim() || undefined }) }}>
        <Field id={`${id}-reason`} label="Reason (optional)" hint={withEmail ? `Sent to ${withEmail} requester(s) with an email address.` : 'None of the requesters has an email address, nobody is notified.'}>
          <textarea id={`${id}-reason`} className="veqsio-input w-full min-h-[80px]" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        <Footer busy={busy} error={error} onCancel={onCancel} submit="Decline" />
      </form>
    </Modal>
  )
}

const dayInput = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function SnoozeDialog({ items, busy, error, onCancel, onSubmit }: Common & { onSubmit: (b: ActionBody) => void }) {
  const id = useId()
  const [date, setDate] = useState(dayInput(7))
  const [reason, setReason] = useState('')
  return (
    <Modal isOpen onClose={onCancel} title={`Snooze ${countLabel(items.length)}`} size="sm">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          // Comes back at 08:00 local time on the chosen day.
          const [y, m, d] = date.split('-').map(Number)
          onSubmit({ until: new Date(y, m - 1, d, 8, 0, 0).toISOString(), reason: reason.trim() || undefined })
        }}
      >
        <Field id={`${id}-date`} label="Come back on" hint="The item moves back to Pending automatically.">
          <input id={`${id}-date`} type="date" className="veqsio-input w-full" value={date} min={dayInput(1)} max={dayInput(365)} onChange={(e) => setDate(e.target.value)} required autoFocus />
        </Field>
        <div className="flex gap-2" role="group" aria-label="Quick choices">
          {[['Tomorrow', 1], ['In a week', 7], ['In a month', 30]].map(([label, days]) => (
            <button key={label as string} type="button" className="veqsio-btn-secondary text-xs" onClick={() => setDate(dayInput(days as number))}>{label}</button>
          ))}
        </div>
        <Field id={`${id}-reason`} label="Note (optional)">
          <input id={`${id}-reason`} className="veqsio-input w-full" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Footer busy={busy} error={error} onCancel={onCancel} submit="Snooze" />
      </form>
    </Modal>
  )
}

export function DuplicateDialog({ project, items, busy, error, onCancel, onSubmit }: Common & { onSubmit: (b: ActionBody) => void }) {
  const id = useId()
  const [issue, setIssue] = useState('')
  const [reason, setReason] = useState('')
  return (
    <Modal isOpen onClose={onCancel} title={`Mark ${countLabel(items.length)} as duplicate`} size="sm">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit({ issue: issue.trim(), reason: reason.trim() || undefined }) }}>
        <Field id={`${id}-issue`} label="Existing issue" hint={`An issue key of this project, for example ${project}-12.`}>
          <input id={`${id}-issue`} className="veqsio-input w-full" value={issue} onChange={(e) => setIssue(e.target.value)} placeholder={`${project}-12`} required autoFocus pattern="[A-Za-z][A-Za-z0-9_]*-[0-9]+" title="An issue key such as ABC-12" />
        </Field>
        <Field id={`${id}-reason`} label="Note (optional)">
          <input id={`${id}-reason`} className="veqsio-input w-full" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Footer busy={busy} error={error} onCancel={onCancel} submit="Mark as duplicate" />
      </form>
    </Modal>
  )
}

export function SubmitDialog({ busy, error, onCancel, onSubmit }: Omit<Common, 'items' | 'project'> & { onSubmit: (b: { title: string; description?: string }) => void }) {
  const id = useId()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  return (
    <Modal isOpen onClose={onCancel} title="Submit to intake">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit({ title: title.trim(), description: description.trim() || undefined }) }}>
        <p className="text-sm text-[var(--text-secondary)]">Your submission waits in the queue until someone on the team accepts it. It becomes an issue only then.</p>
        <Field id={`${id}-title`} label="Title">
          <input id={`${id}-title`} className="veqsio-input w-full" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        </Field>
        <Field id={`${id}-desc`} label="Details (optional)">
          <textarea id={`${id}-desc`} className="veqsio-input w-full min-h-[120px]" maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Footer busy={busy} error={error} onCancel={onCancel} submit="Submit" />
      </form>
    </Modal>
  )
}
