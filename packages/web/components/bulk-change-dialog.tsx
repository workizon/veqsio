'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, X, XCircle } from 'lucide-react'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { runBulk, useBulkTransitions, useProjectSprints } from '@/hooks/use-bulk'
import { useProjectComponents, useProjectVersions, usePriorities, useProjectsList, useResolutions } from '@/hooks/use-issues'
import { useUsers } from '@/hooks/use-users'
import {
  OPERATIONS, buildParams, emptyForm, mergeRetry, operationDef, parseLabels, summarizeResult,
  type BulkForm, type BulkOperation, type BulkResult, type ListMode,
} from '@/lib/bulk'

export interface BulkIssueRef { key: string; projectId: number; projectKey: string }

interface Props {
  open: boolean
  issues: BulkIssueRef[]
  onClose: () => void
  /** Called when the dialog closes after at least one run (refresh the list, offer Undo). */
  onFinished: (result: BulkResult | null) => void
}

type Step = 'operation' | 'params' | 'review' | 'running' | 'result'
const STEPS: Array<{ id: Exclude<Step, 'running'>; label: string }> = [
  { id: 'operation', label: 'Operation' }, { id: 'params', label: 'Details' }, { id: 'review', label: 'Review' }, { id: 'result', label: 'Result' },
]

const field = 'veqsio-input w-full'
const MODES: Array<{ id: ListMode; label: string }> = [
  { id: 'add', label: 'Add to existing' }, { id: 'remove', label: 'Remove from existing' }, { id: 'set', label: 'Replace all' },
]

/** Jira-like "Bulk change": choose operation, set details, review a dry run, confirm, see the result and retry failures. */
export function BulkChangeDialog({ open, issues, onClose, onFinished }: Props) {
  const { tr } = useI18n();

  const panelRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useDialogFocus(open, panelRef)

  const [step, setStep] = useState<Step>('operation')
  const [op, setOp] = useState<BulkOperation>('assign')
  const [form, setForm] = useState<BulkForm>(emptyForm)
  const [labelText, setLabelText] = useState('')
  const [preview, setPreview] = useState<BulkResult | null>(null)
  const [result, setResult] = useState<BulkResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAllTransitions, setShowAllTransitions] = useState(false)
  const lastResult = useRef<BulkResult | null>(null)

  const keys = useMemo(() => issues.map((i) => i.key), [issues])
  const projects = useMemo(() => [...new Map(issues.map((i) => [i.projectId, i.projectKey])).entries()], [issues])
  const single = projects.length === 1 ? { id: projects[0][0], key: projects[0][1] } : null
  const def = operationDef(op)
  const set = (patch: Partial<BulkForm>) => setForm((f) => ({ ...f, ...patch }))

  // reset every time the dialog opens
  useEffect(() => {
    if (!open) return
    setStep('operation'); setOp('assign'); setForm(emptyForm()); setLabelText(''); setPreview(null); setResult(null)
    setError(null); setBusy(false); setShowAllTransitions(false); lastResult.current = null
  }, [open])

  // move focus to the step heading so screen readers announce the new step
  useEffect(() => { if (open) headingRef.current?.focus() }, [open, step])

  const params = useMemo(() => buildParams(op, { ...form, labels: op === 'label' ? parseLabels(labelText) : form.labels }), [op, form, labelText])
  const pickedLabels = useMemo(() => parseLabels(labelText), [labelText])

  const transitions = useBulkTransitions(keys, open && op === 'transition' && step === 'params')
  const users = useUsers()
  const priorities = usePriorities()
  const resolutions = useResolutions()
  const allProjects = useProjectsList(open && op === 'move')
  const versions = useProjectVersions(open && op === 'fixVersion' && single ? single.key : '')
  const components = useProjectComponents(open && op === 'component' && single ? single.key : '')
  const sprints = useProjectSprints(single?.id ?? null, open && op === 'sprint')

  const chosenTransition = transitions.data?.transitions.find((t) => t.id === form.transitionId)
  const needsSingle = !!def.singleProject && !single
  const canNext = !needsSingle && params !== null && (op !== 'transition' || !chosenTransition?.requiresComment || form.comment.trim() !== '')

  async function doPreview() {
    if (!params) return
    setBusy(true); setError(null)
    try { setPreview(await runBulk(keys, op, params, true)); setStep('review') }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  async function apply(onlyKeys?: string[]) {
    if (!params) return
    setStep('running'); setError(null)
    try {
      const r = await runBulk(onlyKeys ?? keys, op, params)
      const merged = onlyKeys && result ? mergeRetry(result, r) : r
      setResult(merged); lastResult.current = merged
      setStep('result')
    } catch (e) {
      setError((e as Error).message)
      setStep(onlyKeys ? 'result' : 'review')
    }
  }

  const close = () => {
    if (step === 'running') return
    onClose()
    onFinished(lastResult.current)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  })

  if (!open) return null

  const summary = step === 'review' && preview ? summarizeResult(preview) : step === 'result' && result ? summarizeResult(result) : null
  const stepIndex = STEPS.findIndex((s) => s.id === (step === 'running' ? 'result' : step))
  const title = step === 'operation' ? tr('Choose an operation') : step === 'params' ? tr(def.label) : step === 'review' ? tr('Review changes') : step === 'running' ? tr('Applying changes') : tr('Result')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 veqsio-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="bulk-title" aria-busy={step === 'running'} className="veqsio-modal-panel w-full max-w-2xl max-h-[calc(100dvh-2rem)] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--surface-3)]">
          <div>
            <p id="bulk-title" className="text-heading-2 text-[var(--text-primary)]">{tr('Bulk change')}</p>
            <p className="text-caption text-[var(--text-secondary)]">{keys.length === 1 ? tr('{n} issue selected', { n: keys.length }) : tr('{n} issues selected', { n: keys.length })}</p>
          </div>
          <button onClick={close} disabled={step === 'running'} aria-label={tr('Close dialog')} className="veqsio-btn-ghost p-1"><X className="w-5 h-5 text-[var(--text-tertiary)]" /></button>
        </div>

        <ol className="flex gap-1 px-6 pt-4 text-caption" aria-label={tr('Steps')}>
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={i === stepIndex ? 'step' : undefined}
              className={`flex-1 border-t-2 pt-1 ${i <= stepIndex ? 'border-[var(--brand-500)] text-[var(--text-primary)] font-medium' : 'border-[var(--surface-3)] text-[var(--text-tertiary)]'}`}>
              {i + 1}. {tr(s.label)}
            </li>
          ))}
        </ol>

        <div className="px-6 py-4 overflow-y-auto space-y-4">
          <h2 ref={headingRef} tabIndex={-1} className="text-heading-3 text-[var(--text-primary)] outline-none">{title}</h2>

          {step === 'operation' && (
            <fieldset className="grid sm:grid-cols-2 gap-2">
              <legend className="sr-only">{tr('Operation')}</legend>
              {OPERATIONS.map((o) => (
                <label key={o.id} className={`flex items-start gap-2 rounded-lg border p-3 cursor-pointer ${op === o.id ? 'border-[var(--brand-500)] bg-[var(--brand-50)]' : 'border-[var(--surface-3)] hover:bg-[var(--surface-1)]'}`}>
                  <input type="radio" name="bulk-op" className="mt-1" checked={op === o.id} onChange={() => { setOp(o.id); setForm(emptyForm()); setLabelText('') }} />
                  <span>
                    <span className={`block text-body-sm font-medium ${o.destructive ? 'text-[var(--error)]' : 'text-[var(--text-primary)]'}`}>{tr(o.label)}</span>
                    <span className="block text-caption text-[var(--text-secondary)]">{tr(o.description)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {step === 'params' && (
            <div className="space-y-3">
              {needsSingle && (
                <p role="alert" className="text-body-sm text-[var(--warning)] flex gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  {tr(def.label)} {tr('works on one project at a time. Your selection spans')} {projects.map((p) => p[1]).join(', ')}.</p>
              )}

              {op === 'transition' && (
                <div className="space-y-2">
                  {transitions.isLoading && <p className="text-body-sm text-[var(--text-secondary)]" role="status">{tr('Checking available transitions...')}</p>}
                  {transitions.error && <p role="alert" className="text-body-sm text-[var(--error)]">{transitions.error.message}</p>}
                  {transitions.data && (() => {
                    const common = transitions.data.transitions.filter((t) => transitions.data!.commonIds.includes(t.id))
                    const list = showAllTransitions || common.length === 0 ? transitions.data.transitions : common
                    return (
                      <>
                        <fieldset className="space-y-1">
                          <legend className="text-body-sm font-medium">{tr('Transition')}</legend>
                          {list.length === 0 && <p className="text-body-sm text-[var(--text-secondary)]">{tr('No transitions are available for the selected issues.')}</p>}
                          {list.map((t) => (
                            <label key={t.id} className="flex items-center gap-2 rounded-lg border border-[var(--surface-3)] p-2 cursor-pointer">
                              <input type="radio" name="bulk-transition" checked={form.transitionId === t.id} onChange={() => set({ transitionId: t.id })} />
                              <span className="flex-1 text-body-sm">{t.name} <span className="text-[var(--text-tertiary)]">{tr('to')} {t.to.name}</span></span>
                              <span className={`text-caption ${t.count === transitions.data!.total ? 'text-[var(--text-secondary)]' : 'text-[var(--warning)]'}`}>
                                {t.count === transitions.data!.total ? tr('all issues') : tr('{a} of {b} issues', { a: t.count, b: transitions.data!.total })}
                              </span>
                            </label>
                          ))}
                        </fieldset>
                        {common.length > 0 && common.length < transitions.data.transitions.length && (
                          <label className="flex items-center gap-2 text-body-sm"><input type="checkbox" checked={showAllTransitions} onChange={(e) => setShowAllTransitions(e.target.checked)} />{tr('Also show transitions available for only some issues (the others will fail)')}</label>
                        )}
                        {transitions.data.unavailable.length > 0 && <p className="text-caption text-[var(--text-secondary)]">{transitions.data.unavailable.length} {tr('selected issues cannot be transitioned by you.')}</p>}
                      </>
                    )
                  })()}
                  {chosenTransition?.requiresResolution && (
                    <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Resolution')}</span>
                      <select className={field} value={form.resolutionId ?? ''} onChange={(e) => set({ resolutionId: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">{tr('Default')}</option>
                        {resolutions.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select></label>
                  )}
                  <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Comment')}{chosenTransition?.requiresComment ? tr(' (required)') : tr(' (optional)')}</span>
                    <textarea className={field} rows={3} value={form.comment} onChange={(e) => set({ comment: e.target.value })} /></label>
                </div>
              )}

              {op === 'assign' && (
                <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Assignee')}</span>
                  <select className={field} value={form.assigneeId === undefined ? '' : form.assigneeId === null ? 'none' : String(form.assigneeId)}
                    onChange={(e) => set({ assigneeId: e.target.value === '' ? undefined : e.target.value === 'none' ? null : Number(e.target.value) })}>
                    <option value="">{tr('Choose...')}</option>
                    <option value="none">{tr('Unassigned')}</option>
                    {users.data?.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                  </select></label>
              )}

              {op === 'priority' && (
                <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Priority')}</span>
                  <select className={field} value={form.priorityId ?? ''} onChange={(e) => set({ priorityId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">{tr('Choose...')}</option>
                    {priorities.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select></label>
              )}

              {op === 'label' && (
                <div className="space-y-2">
                  <ModeSelect value={form.labelMode} onChange={(m) => set({ labelMode: m })} />
                  <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Labels')}</span>
                    <input className={field} value={labelText} onChange={(e) => setLabelText(e.target.value)} placeholder={tr('urgent, customer-facing')} aria-describedby="bulk-label-hint" />
                    <span id="bulk-label-hint" className="block text-caption text-[var(--text-secondary)]">{tr('Separate with commas or spaces.')} {pickedLabels.length} {pickedLabels.length === 1 ? tr('label') : tr('labels')}.</span></label>
                </div>
              )}

              {(op === 'fixVersion' || op === 'component') && !needsSingle && (
                <div className="space-y-2">
                  <ModeSelect value={form.listMode} onChange={(m) => set({ listMode: m })} />
                  <fieldset className="space-y-1 max-h-48 overflow-y-auto">
                    <legend className="text-body-sm font-medium">{op === 'fixVersion' ? tr('Versions') : tr('Components')}</legend>
                    {(op === 'fixVersion' ? versions.data : components.data)?.map((v) => (
                      <label key={v.id} className="flex items-center gap-2 text-body-sm">
                        <input type="checkbox" checked={form.ids.includes(v.id)} onChange={(e) => set({ ids: e.target.checked ? [...form.ids, v.id] : form.ids.filter((x) => x !== v.id) })} />{v.name}
                      </label>
                    ))}
                    {(op === 'fixVersion' ? versions.data : components.data)?.length === 0 && <p className="text-body-sm text-[var(--text-secondary)]">{tr('This project has none yet.')}</p>}
                  </fieldset>
                </div>
              )}

              {op === 'move' && (
                <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Target project')}</span>
                  <select className={field} value={form.projectId ?? ''} onChange={(e) => set({ projectId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">{tr('Choose...')}</option>
                    {allProjects.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
                  </select>
                  <span className="block text-caption text-[var(--text-secondary)]">{tr('Moved issues get new keys and start in the target workflow\'s first status.')}</span></label>
              )}

              {op === 'sprint' && !needsSingle && (
                <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Sprint')}</span>
                  <select className={field} value={form.sprintId === undefined ? '' : form.sprintId === null ? 'backlog' : String(form.sprintId)}
                    onChange={(e) => set({ sprintId: e.target.value === '' ? undefined : e.target.value === 'backlog' ? null : Number(e.target.value) })}>
                    <option value="">{tr('Choose...')}</option>
                    <option value="backlog">{tr('Backlog (remove from sprint)')}</option>
                    {sprints.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === 'active' ? ' (active)' : ''}</option>)}
                  </select></label>
              )}

              {op === 'edit' && (
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Due date')}</span>
                      <input type="date" className={field} value={form.dueDate} disabled={form.clearDueDate} onChange={(e) => set({ dueDate: e.target.value })} /></label>
                    <label className="flex items-center gap-2 text-body-sm"><input type="checkbox" checked={form.clearDueDate} onChange={(e) => set({ clearDueDate: e.target.checked })} />{tr('Clear due date')}</label>
                  </div>
                  <div className="space-y-1">
                    <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('Story points')}</span>
                      <input type="number" min={0} step="0.5" className={field} value={form.storyPoints} disabled={form.clearStoryPoints} onChange={(e) => set({ storyPoints: e.target.value })} /></label>
                    <label className="flex items-center gap-2 text-body-sm"><input type="checkbox" checked={form.clearStoryPoints} onChange={(e) => set({ clearStoryPoints: e.target.checked })} />{tr('Clear story points')}</label>
                  </div>
                </div>
              )}

              {op === 'delete' && (
                <div className="rounded-lg border border-[var(--error)]/40 bg-[var(--error)]/5 p-3 space-y-2">
                  <p className="text-body-sm text-[var(--text-primary)]">{tr('The selected issues will be deleted permanently, with their comments, attachments and history. This cannot be undone.')}</p>
                  <label className="flex items-center gap-2 text-body-sm"><input type="checkbox" checked={form.confirmDelete} onChange={(e) => set({ confirmDelete: e.target.checked })} />{tr('I understand that')} {keys.length} {keys.length === 1 ? tr('issue') : tr('issues')} {tr('will be deleted')}</label>
                </div>
              )}

              {(op === 'watch' || op === 'unwatch') && <p className="text-body-sm text-[var(--text-secondary)]">{op === 'watch' ? tr('You will be notified about changes to these issues.') : tr('You will stop receiving notifications for these issues.')}</p>}
              {error && <p role="alert" className="text-body-sm text-[var(--error)]">{error}</p>}
            </div>
          )}

          {(step === 'review' || step === 'result') && summary && (
            <div className="space-y-3">
              <div role="status" aria-live="polite" className={`flex items-start gap-2 rounded-lg p-3 border ${summary.tone === 'success' ? 'border-[var(--success)]/40 bg-[var(--success)]/5' : summary.tone === 'warning' ? 'border-[var(--warning)]/40 bg-[var(--warning)]/5' : 'border-[var(--error)]/40 bg-[var(--error)]/5'}`}>
                {summary.tone === 'success' ? <CheckCircle2 className="w-5 h-5 text-[var(--success)] shrink-0" aria-hidden="true" /> : summary.tone === 'warning' ? <AlertTriangle className="w-5 h-5 text-[var(--warning)] shrink-0" aria-hidden="true" /> : <XCircle className="w-5 h-5 text-[var(--error)] shrink-0" aria-hidden="true" />}
                <p className="text-body-sm text-[var(--text-primary)] font-medium">{summary.headline}</p>
              </div>
              {step === 'review' && summary.failed === 0 && <p className="text-body-sm text-[var(--text-secondary)]">{tr(def.label)}: {describeParams(op, params, tr)}</p>}
              {summary.failed > 0 && (
                <div>
                  <h3 className="text-body-sm font-medium mb-1">{step === 'review' ? tr('Would fail') : tr('Failed')}</h3>
                  <ul className="space-y-2 max-h-56 overflow-y-auto" aria-label={tr('Failed issues')}>
                    {summary.groups.map((g) => (
                      <li key={g.reason} className="rounded-lg border border-[var(--surface-3)] p-2">
                        <p className="text-body-sm text-[var(--text-primary)]">{g.reason} <span className="text-[var(--text-tertiary)]">({g.count})</span></p>
                        <p className="text-caption text-[var(--text-secondary)] break-words">
                          {g.keys.map((k, i) => <span key={k}>{i > 0 && ', '}{step === 'result' ? <Link className="text-[var(--brand-500)] hover:underline" href={`/issues/${k}`}>{k}</Link> : k}</span>)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {error && <p role="alert" className="text-body-sm text-[var(--error)]">{error}</p>}
            </div>
          )}

          {step === 'running' && (
            <div className="space-y-2" role="status" aria-live="polite">
              <p className="text-body-sm text-[var(--text-primary)]">{tr('Applying {op} to {n} issues...', { op: tr(def.label).toLowerCase(), n: keys.length })}</p>
              <div className="h-2 rounded bg-[var(--surface-2)] overflow-hidden" aria-hidden="true"><div className="h-full w-1/3 bg-[var(--brand-500)] animate-pulse" /></div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-[var(--surface-3)]">
          {step === 'operation' && (<>
            <button className="veqsio-btn-secondary" onClick={close}>{tr('Cancel')}</button>
            <button className="veqsio-btn-primary" onClick={() => setStep('params')}>{tr('Next')}</button>
          </>)}
          {step === 'params' && (<>
            <button className="veqsio-btn-secondary" onClick={() => { setStep('operation'); setError(null) }}>{tr('Back')}</button>
            <button className="veqsio-btn-primary" disabled={!canNext || busy} onClick={doPreview}>{busy ? tr('Checking...') : tr('Review')}</button>
          </>)}
          {step === 'review' && preview && (<>
            <button className="veqsio-btn-secondary" onClick={() => setStep('params')}>{tr('Back')}</button>
            <button className={def.destructive ? 'veqsio-btn-primary bg-[var(--error)]' : 'veqsio-btn-primary'} disabled={preview.succeeded.length === 0} onClick={() => apply()}>
              {preview.failed.length > 0 ? tr('Apply ({a} of {b} will change)', { a: preview.succeeded.length, b: keys.length }) : def.destructive ? (keys.length === 1 ? tr('Delete {n} issue', { n: keys.length }) : tr('Delete {n} issues', { n: keys.length })) : (keys.length === 1 ? tr('Apply to {n} issue', { n: keys.length }) : tr('Apply to {n} issues', { n: keys.length }))}
            </button>
          </>)}
          {step === 'result' && result && summary && (<>
            {summary.canRetry && <button className="veqsio-btn-secondary" onClick={() => apply(summary.failedKeys)}>{tr('Retry failed (')}{summary.failed})</button>}
            <button className="veqsio-btn-primary" onClick={close}>{tr('Done')}</button>
          </>)}
        </div>
      </div>
    </div>
  )
}

function ModeSelect({ value, onChange }: { value: ListMode; onChange: (m: ListMode) => void }) {
  const { tr } = useI18n();

  return (
    <label className="block space-y-1"><span className="text-body-sm font-medium">{tr('How')}</span>
      <select className={field} value={value} onChange={(e) => onChange(e.target.value as ListMode)}>
        {MODES.map((m) => <option key={m.id} value={m.id}>{tr(m.label)}</option>)}
      </select></label>
  )
}

function describeParams(op: BulkOperation, params: Record<string, unknown> | null, tr: (k: string) => string): string {
  if (!params) return ''
  if (op === 'label') return Object.entries(params).map(([m, v]) => `${m} ${(v as string[]).join(', ') || tr('nothing')}`).join('; ')
  return tr('ready to apply.')
}
