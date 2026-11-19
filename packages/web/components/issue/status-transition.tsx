'use client'

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ArrowRight, GitFork, AlertCircle } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { Skeleton } from '@/components/skeleton'
import { toast } from '@/components/toast'
import { RichTextEditor } from '@/components/rich-text-editor'
import { useIssue, useIssueTransitions, useTransitionIssue, useResolutions } from '@/hooks/use-issues'
import type { ApiTransition } from '@/hooks/use-issues'
import {
  sortTransitions, transitionCategory, transitionNeedsDialog, extraRequiredFields, validateTransitionForm,
  buildTransitionPayload, type TransitionFormState,
} from '@/lib/issue-view'
import { useOfferStatusUndo } from '@/hooks/use-status-move'
import {
  buildScreenPayload, generalScreenFields, initialScreenValues, screenFieldsOf, screenHasField, screenRequires, splitServerErrors, validateScreenValues,
  type ScreenValues,
} from '@/lib/transition-screen'
import { Popover, StatusLozenge } from './primitives'
import { TransitionScreenFields } from './transition-screen-fields'

export interface StatusButtonHandle {
  open: () => void
}

/** Jira-style status button: lozenge + caret, dropdown of every available transition, plus a "Workflow" link. */
export const StatusButton = forwardRef<StatusButtonHandle, {
  issueKey: string
  status: { name: string; category?: string | null }
}>(function StatusButton({ issueKey, status }, ref) {
  const [open, setOpen] = useState(false)
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [pending, setPending] = useState<ApiTransition | null>(null)
  const { data, isLoading, isError } = useIssueTransitions(issueKey)
  const transition = useTransitionIssue()
  const offerUndo = useOfferStatusUndo()
  const menuRef = useRef<HTMLDivElement>(null)
  const transitions = useMemo(() => sortTransitions(data?.transitions || []), [data])

  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), [])

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])

  const run = async (t: ApiTransition) => {
    setOpen(false)
    if (transitionNeedsDialog(t)) {
      setPending(t)
      return
    }
    try {
      await transition.mutateAsync({ key: issueKey, transitionId: t.id })
      await offerUndo(issueKey, status.name, t)
    } catch (err: any) {
      toast(err?.message || 'Transition failed', 'error')
    }
  }

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(i + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i - 1 + items.length) % items.length]?.focus()
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Popover
        open={open}
        onOpenChange={setOpen}
        label="Available transitions"
        haspopup="menu"
        panelClassName="min-w-[20rem] max-w-[calc(100vw-2rem)] py-1"
        trigger={(p) => (
          <button
            type="button"
            {...p}
            aria-label={`Status: ${status.name}. Change status`}
            className="rounded-md border border-[var(--surface-4)] bg-[var(--surface-0)] px-2 py-1.5 hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] transition-colors"
          >
            <StatusLozenge name={status.name} category={status.category} caret className="!bg-transparent" />
          </button>
        )}
      >
        <div ref={menuRef} onKeyDown={onMenuKey}>
          {isLoading ? (
            <div className="p-3 space-y-2" aria-busy="true">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-3/4" />
            </div>
          ) : isError ? (
            <p className="px-3 py-2 text-body-sm text-[var(--error)]">Could not load transitions.</p>
          ) : transitions.length === 0 ? (
            <p className="px-3 py-2 text-body-sm text-[var(--text-tertiary)]">No transitions available from this status.</p>
          ) : (
            transitions.map((t) => (
              <button
                key={t.id}
                role="menuitem"
                type="button"
                onClick={() => run(t)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-body-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none"
              >
                <span className="truncate">{t.name}</span>
                <span className="flex items-center gap-1.5 shrink-0 text-[var(--text-tertiary)]">
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                  <StatusLozenge name={t.to.name} category={transitionCategory(t)} />
                </span>
              </button>
            ))
          )}
          <div className="border-t border-[var(--surface-3)] mt-1 pt-1">
            <button
              role="menuitem"
              type="button"
              onClick={() => { setOpen(false); setWorkflowOpen(true) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-body-sm text-[var(--brand-500)] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none"
            >
              <GitFork className="w-4 h-4" aria-hidden="true" /> View workflow
            </button>
          </div>
        </div>
      </Popover>

      <button
        type="button"
        onClick={() => setWorkflowOpen(true)}
        className="flex items-center gap-1 text-body-sm text-[var(--brand-500)] hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
      >
        <GitFork className="w-4 h-4" aria-hidden="true" />
        Workflow
      </button>

      <WorkflowDialog
        isOpen={workflowOpen}
        onClose={() => setWorkflowOpen(false)}
        status={status}
        transitions={transitions}
        loading={isLoading}
        onPick={(t) => { setWorkflowOpen(false); void run(t) }}
      />

      {pending && (
        <TransitionDialog
          key={pending.id}
          issueKey={issueKey}
          fromStatus={status}
          transition={pending}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  )
})

function WorkflowDialog({
  isOpen, onClose, status, transitions, loading, onPick,
}: {
  isOpen: boolean
  onClose: () => void
  status: { name: string; category?: string | null }
  transitions: ApiTransition[]
  loading: boolean
  onPick: (t: ApiTransition) => void
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Workflow" size="md">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-caption text-[var(--text-tertiary)]">Current status</span>
          <StatusLozenge name={status.name} category={status.category} />
        </div>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : transitions.length === 0 ? (
          <p className="text-body-sm text-[var(--text-tertiary)]">No transitions are available to you from this status.</p>
        ) : (
          <ul className="space-y-2" aria-label="Transitions from the current status">
            {transitions.map((t) => {
              const needs: string[] = []
              if (t.requiresResolution) needs.push('resolution')
              if (t.requiresComment) needs.push('comment')
              for (const f of extraRequiredFields(t)) needs.push(f)
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onPick(t)}
                    className="w-full flex items-center gap-3 rounded-lg border border-[var(--surface-3)] px-3 py-2 text-left hover:border-[var(--brand-500)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] transition-colors"
                  >
                    <StatusLozenge name={status.name} category={status.category} />
                    <span className="flex flex-col items-center text-caption text-[var(--text-secondary)] min-w-0">
                      <span className="truncate max-w-[10rem]">{t.name}</span>
                      <ArrowRight className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
                    </span>
                    <StatusLozenge name={t.to.name} category={transitionCategory(t)} />
                    {needs.length > 0 && (
                      <span className="ml-auto text-caption text-[var(--text-tertiary)]">asks for {needs.join(', ')}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="text-caption text-[var(--text-tertiary)]">Only transitions you are allowed to run are listed. Pick one to run it.</p>
      </div>
    </Modal>
  )
}

/** Jira's "Resolve issue" dialog: resolution, comment, extra required fields, API validator messages. */
export function TransitionDialog({
  issueKey, fromStatus, transition, onClose,
}: {
  issueKey: string
  fromStatus: { name: string; category?: string | null }
  transition: ApiTransition
  onClose: () => void
}) {
  const { data: resolutions, isLoading: resolutionsLoading } = useResolutions()
  const mutation = useTransitionIssue()
  const { data: issue } = useIssue(issueKey)
  const screen = screenFieldsOf(transition)
  const screenGeneral = generalScreenFields(transition)
  const needsResolution = !!transition.requiresResolution || (transition.requiredFields || []).includes('resolution') || screenRequires(transition, 'resolution')
  // A screen that lists resolution or comment shows them even when no validator demands them.
  const showResolution = needsResolution || screenHasField(transition, 'resolution')
  const commentRequired = !!transition.requiresComment || screenRequires(transition, 'comment')
  const extra = extraRequiredFields(transition)
  const [form, setForm] = useState<TransitionFormState>({ resolutionId: '', comment: '', extra: {} })
  const [errors, setErrors] = useState<string[]>([])
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  // Start values come from the issue (once it is loaded), so required fields it already has are pre-filled.
  const [screenValues, setScreenValues] = useState<ScreenValues | null>(null)
  const values = screenValues ?? (issue ? initialScreenValues(screen, issue.fields) : {})
  const setValue = (key: string, value: unknown) => {
    setScreenValues({ ...values, [key]: value })
    setFieldErrors((e) => { if (!e[key]) return e; const n = { ...e }; delete n[key]; return n })
  }

  // Preselect the most natural resolution, like Jira ("Done"/"Fixed").
  useEffect(() => {
    if (!showResolution || form.resolutionId || !resolutions?.length) return
    const preferred = resolutions.find((r) => /^(done|fixed)$/i.test(r.name)) || resolutions[0]
    setForm((f) => ({ ...f, resolutionId: preferred.id }))
  }, [showResolution, resolutions, form.resolutionId])

  const submit = async () => {
    const clientErrors = validateTransitionForm(transition, form)
    // Screen fields: per-field messages inline (resolution and comment keep their own validation above).
    const screenErrors = validateScreenValues(screen, values, { resolutionId: form.resolutionId, comment: form.comment })
    setErrors(clientErrors)
    setFieldErrors(screenErrors)
    if (clientErrors.length > 0 || Object.keys(screenErrors).length > 0) return
    try {
      const base = buildTransitionPayload(transition, form)
      await mutation.mutateAsync({ key: issueKey, transitionId: base.transitionId, fields: { ...base.fields, ...buildScreenPayload(screenGeneral, values) } })
      toast(`Moved to ${transition.to.name}`, 'success')
      onClose()
    } catch (err: any) {
      // The server validates again: its per-field errors show inline, the rest in the list on top.
      const split = splitServerErrors(screen, err?.fieldErrors, err?.validationErrors?.length ? err.validationErrors : [err?.message || 'Transition failed'])
      setFieldErrors(split.byField)
      setErrors(split.general)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={transition.name} size="md">
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); void submit() }}
        noValidate
      >
        <div className="flex items-center gap-2 flex-wrap text-body-sm text-[var(--text-secondary)]">
          <span>Status</span>
          <StatusLozenge name={fromStatus.name} category={fromStatus.category} />
          <ArrowRight className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
          <StatusLozenge name={transition.to.name} category={transitionCategory(transition)} />
        </div>

        {errors.length > 0 && (
          <div role="alert" className="flex gap-2 rounded-lg border border-[var(--error)] bg-[var(--surface-2)] p-3 text-body-sm text-[var(--error)]">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <ul className="space-y-0.5">
              {errors.map((m, i) => <li key={`${i}-${m}`}>{m}</li>)}
            </ul>
          </div>
        )}

        {showResolution && (
          <div>
            <label htmlFor="transition-resolution" className="text-caption font-medium text-[var(--text-secondary)] block mb-1">
              Resolution {needsResolution ? <span className="text-[var(--error)]" aria-hidden="true">*</span> : <span className="text-[var(--text-tertiary)]">(optional)</span>}
            </label>
            {resolutionsLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <select
                id="transition-resolution"
                value={form.resolutionId}
                onChange={(e) => setForm({ ...form, resolutionId: e.target.value })}
                required={needsResolution}
                aria-required={needsResolution || undefined}
                className="veqsio-input w-full"
              >
                <option value="">Select a resolution</option>
                {(resolutions || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
            {fieldErrors.resolution && <p role="alert" className="text-caption text-[var(--error)] mt-1">{fieldErrors.resolution}</p>}
          </div>
        )}

        {screenGeneral.length > 0 && (
          <TransitionScreenFields
            fields={screenGeneral}
            values={values}
            onChange={setValue}
            errors={fieldErrors}
            projectKey={issue?.fields.project?.key || ''}
          />
        )}

        {extra.map((name) => (
          <div key={name}>
            <label htmlFor={`transition-field-${name}`} className="text-caption font-medium text-[var(--text-secondary)] block mb-1">
              {name} <span className="text-[var(--error)]" aria-hidden="true">*</span>
            </label>
            <input
              id={`transition-field-${name}`}
              value={form.extra[name] || ''}
              onChange={(e) => setForm({ ...form, extra: { ...form.extra, [name]: e.target.value } })}
              required
              aria-required="true"
              className="veqsio-input w-full"
            />
          </div>
        ))}

        <div>
          <span className="text-caption font-medium text-[var(--text-secondary)] block mb-1">
            Comment {commentRequired ? <span className="text-[var(--error)]" aria-hidden="true">*</span> : <span className="text-[var(--text-tertiary)]">(optional)</span>}
          </span>
          <RichTextEditor
            label="Comment"
            rows={4}
            value={form.comment}
            onChange={(v) => setForm((f) => ({ ...f, comment: v }))}
            issueKey={issueKey}
            maxLength={100000}
            onSubmit={() => void submit()}
          />
          {fieldErrors.comment && <p role="alert" className="text-caption text-[var(--error)] mt-1">{fieldErrors.comment}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="veqsio-btn-secondary">Cancel</button>
          <button type="submit" disabled={mutation.isPending} className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50">
            {mutation.isPending && <Spinner size="sm" />}
            {transition.name}
          </button>
        </div>
      </form>
    </Modal>
  )
}
