'use client'

import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from '@/components/modal'
import {
  addDays, dateInputToIso, formatPoints, isoToDateInput, pluralize, splitCompletion, validateSprintForm,
  type PlanSprint, type SprintForm, type SprintFormErrors,
} from '@/lib/planning'

const labelCls = 'text-caption font-medium text-[var(--text-secondary)] block mb-1'
const errCls = 'text-caption text-[var(--error)] mt-1'

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      {children}
      {error && <p id={`${id}-error`} role="alert" className={errCls}>{error}</p>}
    </div>
  )
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null
  return <div role="alert" className="p-2.5 rounded-lg bg-[var(--error)]/10 text-[var(--error)] text-body-sm">{message}</div>
}

function Actions({ onClose, pending, submitLabel, pendingLabel, danger, disabled }: {
  onClose: () => void; pending: boolean; submitLabel: string; pendingLabel: string; danger?: boolean; disabled?: boolean
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button type="button" onClick={onClose} className="veqsio-btn-secondary" disabled={pending}>Cancel</button>
      <button
        type="submit"
        disabled={pending || disabled}
        className={danger ? 'veqsio-btn-primary !bg-[var(--error)] hover:!bg-[var(--error)]' : 'veqsio-btn-primary'}
      >
        {pending ? pendingLabel : submitLabel}
      </button>
    </div>
  )
}

/* ---------------------------------------------------------------- */

interface SprintFormModalProps {
  mode: 'create' | 'edit'
  sprint?: PlanSprint
  suggestedName: string
  onClose: () => void
  onSubmit: (v: { name: string; goal: string | null; startDate: string | null; endDate: string | null }) => Promise<unknown>
}

export function SprintFormModal({ mode, sprint, suggestedName, onClose, onSubmit }: SprintFormModalProps) {
  const [form, setForm] = useState<SprintForm>({
    name: sprint?.name ?? suggestedName,
    goal: sprint?.goal ?? '',
    startDate: isoToDateInput(sprint?.startDate),
    endDate: isoToDateInput(sprint?.endDate),
  })
  const [errors, setErrors] = useState<SprintFormErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const set = (k: keyof SprintForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs = validateSprintForm(form)
    setErrors(errs)
    if (Object.keys(errs).length) return
    setPending(true)
    setServerError(null)
    try {
      await onSubmit({
        name: form.name.trim(),
        goal: form.goal.trim() || null,
        startDate: dateInputToIso(form.startDate, 'start'),
        endDate: dateInputToIso(form.endDate, 'end'),
      })
    } catch (err) {
      setServerError((err as Error).message)
      setPending(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={mode === 'create' ? 'Create sprint' : `Edit ${sprint?.name ?? 'sprint'}`}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field id="sprint-name" label="Sprint name" error={errors.name}>
          <input id="sprint-name" autoFocus value={form.name} onChange={set('name')} className="veqsio-input w-full" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'sprint-name-error' : undefined} />
        </Field>
        <Field id="sprint-goal" label="Sprint goal (optional)" error={errors.goal}>
          <textarea id="sprint-goal" rows={2} value={form.goal} onChange={set('goal')} placeholder="What should this sprint achieve?" className="veqsio-input w-full" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="sprint-start" label="Start date" error={errors.startDate}>
            <input id="sprint-start" type="date" value={form.startDate} onChange={set('startDate')} className="veqsio-input w-full" />
          </Field>
          <Field id="sprint-end" label="End date" error={errors.endDate}>
            <input id="sprint-end" type="date" value={form.endDate} onChange={set('endDate')} className="veqsio-input w-full" aria-invalid={!!errors.endDate} aria-describedby={errors.endDate ? 'sprint-end-error' : undefined} />
          </Field>
        </div>
        <ErrorBanner message={serverError} />
        <Actions onClose={onClose} pending={pending} submitLabel={mode === 'create' ? 'Create sprint' : 'Save'} pendingLabel="Saving…" />
      </form>
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

interface StartSprintModalProps {
  sprint: PlanSprint
  otherActive: PlanSprint[]
  allowParallel: boolean
  onClose: () => void
  onSubmit: (v: { goal: string | null; startDate: string; endDate: string }) => Promise<unknown>
}

export function StartSprintModal({ sprint, otherActive, allowParallel, onClose, onSubmit }: StartSprintModalProps) {
  const today = isoToDateInput(new Date().toISOString())
  const startDefault = isoToDateInput(sprint.startDate) || today
  const [form, setForm] = useState<SprintForm>({
    name: sprint.name,
    goal: sprint.goal ?? '',
    startDate: startDefault,
    endDate: isoToDateInput(sprint.endDate) || addDays(startDefault, 14),
  })
  const [errors, setErrors] = useState<SprintFormErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const blocked = otherActive.length > 0 && !allowParallel

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs = validateSprintForm(form, { requireDates: true })
    setErrors(errs)
    if (Object.keys(errs).length) return
    setPending(true)
    setServerError(null)
    try {
      await onSubmit({ goal: form.goal.trim() || null, startDate: dateInputToIso(form.startDate, 'start')!, endDate: dateInputToIso(form.endDate, 'end')! })
    } catch (err) {
      setServerError((err as Error).message)
      setPending(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Start ${sprint.name}`}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-body-sm text-[var(--text-secondary)]">
          This sprint contains <strong className="text-[var(--text-primary)]">{pluralize(sprint.issueCount, 'issue')}</strong>
          {' '}worth <strong className="text-[var(--text-primary)]">{formatPoints(sprint.storyPoints)} story {sprint.storyPoints === 1 ? 'point' : 'points'}</strong>.
        </p>
        {otherActive.length > 0 && (
          <div role="status" className="flex gap-2 p-2.5 rounded-lg bg-[var(--warning)]/10 text-[var(--warning)] text-body-sm">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              {blocked
                ? `${otherActive.map((s) => s.name).join(', ')} is already active and this board does not allow parallel sprints. Complete it first.`
                : `${otherActive.map((s) => s.name).join(', ')} is already active on this board. Starting this sprint runs both in parallel.`}
            </span>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="start-start" label="Start date" error={errors.startDate}>
            <input id="start-start" type="date" autoFocus value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} className="veqsio-input w-full" />
          </Field>
          <Field id="start-end" label="End date" error={errors.endDate}>
            <input id="start-end" type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} className="veqsio-input w-full" />
          </Field>
        </div>
        <Field id="start-goal" label="Sprint goal (optional)" error={errors.goal}>
          <textarea id="start-goal" rows={2} value={form.goal} onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))} className="veqsio-input w-full" />
        </Field>
        <ErrorBanner message={serverError} />
        <Actions onClose={onClose} pending={pending} disabled={blocked} submitLabel="Start sprint" pendingLabel="Starting…" />
      </form>
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

interface CompleteSprintModalProps {
  sprint: PlanSprint
  /** Other sprints that can receive the incomplete issues (future, or other active ones). */
  targets: PlanSprint[]
  onClose: () => void
  onSubmit: (moveIncompleteTo: 'backlog' | number) => Promise<unknown>
}

export function CompleteSprintModal({ sprint, targets, onClose, onSubmit }: CompleteSprintModalProps) {
  const split = splitCompletion(sprint.issues)
  const [choice, setChoice] = useState<string>('backlog')
  const [pending, setPending] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setServerError(null)
    try {
      await onSubmit(choice === 'backlog' ? 'backlog' : Number(choice))
    } catch (err) {
      setServerError((err as Error).message)
      setPending(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Complete ${sprint.name}`} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-body-sm text-[var(--text-secondary)]">
          <strong className="text-[var(--text-primary)]">{pluralize(split.done.length, 'issue')}</strong> done
          ({formatPoints(split.donePoints)} points) and{' '}
          <strong className="text-[var(--text-primary)]">{pluralize(split.incomplete.length, 'issue')}</strong> not done
          ({formatPoints(split.incompletePoints)} points).
        </p>

        {split.incomplete.length > 0 ? (
          <>
            <div>
              <p className={labelCls}>Issues that are not done</p>
              <ul className="max-h-44 overflow-auto rounded-lg border border-[var(--surface-3)] divide-y divide-[var(--surface-3)]">
                {split.incomplete.map((i) => (
                  <li key={i.key} className="flex items-center gap-2 px-3 py-1.5 text-body-sm">
                    <span className="text-caption text-[var(--text-secondary)] w-20 shrink-0">{i.key}</span>
                    <span className="truncate flex-1 text-[var(--text-primary)]">{i.summary}</span>
                    <span className="text-caption text-[var(--text-tertiary)] shrink-0">{i.status}</span>
                  </li>
                ))}
              </ul>
            </div>
            <fieldset className="space-y-2">
              <legend className={labelCls}>Move the issues that are not done to</legend>
              <label className="flex items-center gap-2 text-body-sm text-[var(--text-primary)]">
                <input type="radio" name="move-to" value="backlog" checked={choice === 'backlog'} onChange={() => setChoice('backlog')} className="accent-[var(--brand-600)]" />
                Backlog
              </label>
              {targets.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-body-sm text-[var(--text-primary)]">
                  <input type="radio" name="move-to" value={String(t.id)} checked={choice === String(t.id)} onChange={() => setChoice(String(t.id))} className="accent-[var(--brand-600)]" />
                  {t.name} <span className="text-caption text-[var(--text-tertiary)]">{t.state === 'active' ? 'active' : 'planned'}</span>
                </label>
              ))}
              {targets.length === 0 && <p className="text-caption text-[var(--text-tertiary)]">Create another sprint to move the open issues there instead.</p>}
            </fieldset>
          </>
        ) : (
          <p className="text-body-sm text-[var(--success)]">Every issue in this sprint is done.</p>
        )}

        <ErrorBanner message={serverError} />
        <Actions onClose={onClose} pending={pending} submitLabel="Complete sprint" pendingLabel="Completing…" />
      </form>
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

export function DeleteSprintModal({ sprint, onClose, onSubmit }: { sprint: PlanSprint; onClose: () => void; onSubmit: () => Promise<unknown> }) {
  const [pending, setPending] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setServerError(null)
    try { await onSubmit() } catch (err) { setServerError((err as Error).message); setPending(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title={`Delete ${sprint.name}`} size="sm">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-body-sm text-[var(--text-secondary)]">
          {sprint.issueCount > 0
            ? `${pluralize(sprint.issueCount, 'issue')} will return to the backlog. `
            : ''}
          This cannot be undone.
        </p>
        <ErrorBanner message={serverError} />
        <Actions onClose={onClose} pending={pending} danger submitLabel="Delete sprint" pendingLabel="Deleting…" />
      </form>
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

export function CreateBoardModal({ projects, onClose, onSubmit }: {
  projects: Array<{ id: number; key: string; name: string }>
  onClose: () => void
  onSubmit: (v: { name: string; projectId: number }) => Promise<unknown>
}) {
  const [name, setName] = useState('')
  const [projectId, setProjectId] = useState(projects[0] ? String(projects[0].id) : '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !projectId) { setError('Choose a project and give the board a name'); return }
    setPending(true)
    setError(null)
    try { await onSubmit({ name: name.trim(), projectId: Number(projectId) }) } catch (err) { setError((err as Error).message); setPending(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title="Create Scrum board" size="sm">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field id="board-project" label="Project">
          <select id="board-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="veqsio-input w-full">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
          </select>
        </Field>
        <Field id="board-name" label="Board name">
          <input id="board-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team board" className="veqsio-input w-full" />
        </Field>
        <ErrorBanner message={error} />
        <Actions onClose={onClose} pending={pending} submitLabel="Create board" pendingLabel="Creating…" />
      </form>
    </Modal>
  )
}
