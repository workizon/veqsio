'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useCloneIssue, useDeleteIssue, useIssueTypesMeta, useMoveIssue, useProjectsList } from '@/hooks/use-issues'
import { useApplyTypeChange, useMovePreview, useTypeChangePreview, type MovePlan, type TypeChangePlan } from '@/hooks/use-issue-history'
import type { ApiIssue } from '@/hooks/use-issues'

export type IssueDialogKind = 'clone' | 'move' | 'change-type' | 'delete' | null

export function IssueDialogs({ issue, dialog, onClose }: { issue: ApiIssue; dialog: IssueDialogKind; onClose: () => void }) {
  return (
    <>
      <CloneDialog issue={issue} isOpen={dialog === 'clone'} onClose={onClose} />
      <MoveDialog issue={issue} isOpen={dialog === 'move'} onClose={onClose} />
      <ChangeTypeDialog issue={issue} isOpen={dialog === 'change-type'} onClose={onClose} />
      <DeleteDialog issue={issue} isOpen={dialog === 'delete'} onClose={onClose} />
    </>
  )
}

function CloneDialog({ issue, isOpen, onClose }: { issue: ApiIssue; isOpen: boolean; onClose: () => void }) {
  const { tr } = useI18n();

  const router = useRouter()
  const clone = useCloneIssue()
  const [summary, setSummary] = useState('')
  useEffect(() => { if (isOpen) setSummary(`Clone of ${issue.fields.summary}`) }, [isOpen, issue.fields.summary])
  const submit = () => {
    clone.mutate(
      { key: issue.key, data: { summary } },
      {
        onSuccess: (data) => { toast(tr('Cloned to {key}', { key: data.key }), 'success'); onClose(); router.push(`/issues/${data.key}`) },
        onError: (err: any) => toast(err?.message || tr('Clone failed'), 'error'),
      },
    )
  }
  return (
    <Modal isOpen={isOpen} title={tr('Clone {key}', { key: issue.key })} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (summary.trim()) submit() }}>
        <div>
          <label htmlFor="clone-summary" className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Summary')}</label>
          <input id="clone-summary" autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} className="veqsio-input w-full" maxLength={500} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
          <button type="submit" disabled={clone.isPending || !summary.trim()} className="veqsio-btn-primary disabled:opacity-50">
            {clone.isPending ? <Spinner size="sm" /> : tr('Clone')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function MoveDialog({ issue, isOpen, onClose }: { issue: ApiIssue; isOpen: boolean; onClose: () => void }) {
  const { tr } = useI18n();

  const router = useRouter()
  const move = useMoveIssue()
  const preview = useMovePreview()
  const { mutate: runPreview } = preview
  const { data: projects, isLoading } = useProjectsList(isOpen)
  const [projectId, setProjectId] = useState('')
  const [typeId, setTypeId] = useState('')
  const [statusId, setStatusId] = useState('')
  const [plan, setPlan] = useState<MovePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (isOpen) { setProjectId(''); setTypeId(''); setStatusId(''); setPlan(null); setError(null) } }, [isOpen])
  const options = (projects || []).filter((p) => p.id !== issue.fields.project?.id)

  // Every change of the choice refreshes the check, so the dialog always shows what the move would do.
  useEffect(() => {
    if (!isOpen || !projectId) { setPlan(null); return }
    const input = { projectId: Number(projectId), ...(typeId ? { issueTypeId: Number(typeId) } : {}), ...(statusId ? { statusId: Number(statusId) } : {}) }
    const t = setTimeout(() => {
      runPreview({ key: issue.key, input }, {
        onSuccess: (p) => {
          setError(null); setPlan(p)
          if (p.status.needsMapping && !statusId && p.status.suggestedStatusId) setStatusId(String(p.status.suggestedStatusId))
        },
        onError: (e: any) => { setPlan(null); setError(e?.message || tr('The check failed')) },
      })
    }, 250)
    return () => clearTimeout(t)
  }, [isOpen, projectId, typeId, statusId, issue.key, runPreview])

  const typeBlocked = !!plan && !plan.allowedTypes.some((t) => t.id === plan.to.type.id)
  const removedAny = plan && (plan.removed.components.length || plan.removed.fixVersions.length || plan.removed.affectsVersions.length || plan.removed.sprints.length || plan.removed.milestones || plan.removed.parent)
  return (
    <Modal isOpen={isOpen} title={tr('Move {key}', { key: issue.key })} onClose={onClose} size="lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!projectId || !plan?.canApply) return
          move.mutate(
            { key: issue.key, data: { projectId: Number(projectId), ...(typeId ? { issueTypeId: Number(typeId) } : {}), ...(statusId ? { statusId: Number(statusId) } : {}) } },
            {
              onSuccess: (data) => { toast(tr('Moved to {key}', { key: data.key }), 'success'); onClose(); router.push(`/issues/${data.key}`) },
              onError: (err: any) => toast(err?.message || tr('Move failed'), 'error'),
            },
          )
        }}
      >
        <div>
          <label htmlFor="move-project" className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Target project')}</label>
          <select id="move-project" value={projectId} onChange={(e) => { setProjectId(e.target.value); setTypeId(''); setStatusId('') }} className="veqsio-input w-full" disabled={isLoading}>
            <option value="">{isLoading ? tr('Loading projects...') : tr('Select a project')}</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
          </select>
          <p className="text-caption text-[var(--text-tertiary)] mt-1">{tr('The issue gets a new key. Veqsio checks the issue type, the workflow and the fields of the target project before anything changes.')}</p>
        </div>

        {preview.isPending && !plan && <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]"><Spinner size="sm" /> {tr('Checking…')}</div>}
        {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}

        {plan && (
          <div className="space-y-4 rounded-lg border border-[var(--surface-3)] p-4" aria-live="polite">
            {typeBlocked && (
              <div>
                <label htmlFor="move-type" className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Issue type in')} {plan.to.project.name}</label>
                <select id="move-type" value={typeId} onChange={(e) => { setTypeId(e.target.value); setStatusId('') }} className="veqsio-input w-full">
                  <option value="">{tr('Choose a type…')}</option>
                  {plan.allowedTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <p className="text-caption text-[var(--text-tertiary)] mt-1">{plan.from.type.name} {tr('is not available there.')}</p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div><p className="text-caption text-[var(--text-tertiary)]">{tr('Workflow')}</p><p>{plan.workflow.from?.name ?? tr('Default')} {plan.workflow.changed ? <>→ <strong>{plan.workflow.to?.name ?? tr('Default')}</strong></> : <span className="text-[var(--text-tertiary)]">{tr('(unchanged)')}</span>}</p></div>
              <div><p className="text-caption text-[var(--text-tertiary)]">{tr('Issue type')}</p><p>{plan.from.type.name}{plan.from.type.id !== plan.to.type.id && <> → <strong>{plan.to.type.name}</strong></>}</p></div>
            </div>

            {plan.status.needsMapping ? (
              <div>
                <label htmlFor="move-status" className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Status “')}{plan.status.current.name}{tr('” does not exist in the target workflow. New status')}</label>
                <select id="move-status" value={statusId} onChange={(e) => setStatusId(e.target.value)} className="veqsio-input w-full">
                  <option value="">{tr('Choose a status…')}</option>
                  {plan.status.available.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            ) : (
              <p className="text-sm">{tr('Status stays')} <strong>{plan.status.target?.name ?? plan.status.current.name}</strong>.</p>
            )}

            {plan.droppedFields.length > 0 && (
              <div className="text-sm">
                <p className="font-medium">{tr('Fields the target project does not have')}</p>
                <p className="text-[var(--text-secondary)]">{tr('Their values are added to the description, nothing is lost:')} {plan.droppedFields.map((d) => d.name).join(', ')}.</p>
              </div>
            )}
            {removedAny ? (
              <div className="text-sm space-y-0.5">
                <p className="font-medium">{tr('Removed from the issue')}</p>
                <ul className="list-disc pl-5 text-[var(--text-secondary)]">
                  {plan.removed.components.length > 0 && <li>{tr('Components:')} {plan.removed.components.join(', ')}</li>}
                  {plan.removed.fixVersions.length > 0 && <li>{tr('Fix versions:')} {plan.removed.fixVersions.join(', ')}</li>}
                  {plan.removed.affectsVersions.length > 0 && <li>{tr('Affects versions:')} {plan.removed.affectsVersions.join(', ')}</li>}
                  {plan.removed.sprints.length > 0 && <li>{tr('Sprints:')} {plan.removed.sprints.join(', ')}</li>}
                  {plan.removed.milestones > 0 && <li>{plan.removed.milestones} {tr('milestone link(s)')}</li>}
                  {plan.removed.parent && <li>{tr('Link to')} {plan.removed.parent}</li>}
                </ul>
              </div>
            ) : null}
            {plan.subtasks.length > 0 && (
              <div className="text-sm">
                <p className="font-medium">{tr('Sub-tasks that move along')}</p>
                <ul className="text-[var(--text-secondary)]">
                  {plan.subtasks.map((s) => <li key={s.key}>{s.key} {s.summary} — {s.status}{s.status !== s.becomes && <> → <strong>{s.becomes}</strong></>}</li>)}
                </ul>
              </div>
            )}
            {plan.blockers.length > 0 && (
              <ul role="alert" className="text-sm text-[var(--error)] list-disc pl-5">{plan.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
          <button type="submit" disabled={move.isPending || !projectId || !plan?.canApply} className="veqsio-btn-primary disabled:opacity-50">
            {move.isPending ? <Spinner size="sm" /> : tr('Move')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function DeleteDialog({ issue, isOpen, onClose }: { issue: ApiIssue; isOpen: boolean; onClose: () => void }) {
  const { tr } = useI18n();

  const router = useRouter()
  const del = useDeleteIssue()
  return (
    <Modal isOpen={isOpen} title={tr('Delete issue')} onClose={onClose}>
      <p className="text-body text-[var(--text-primary)] mb-4">
        {tr('Are you sure you want to delete')} <strong>{issue.key}</strong>{tr('? This action cannot be undone.')} </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
        <button
          type="button"
          disabled={del.isPending}
          onClick={async () => {
            try {
              await del.mutateAsync(issue.key)
              toast(tr('Issue deleted'), 'success')
              router.push('/issues')
            } catch (err: any) {
              toast(err?.message || tr('Failed to delete issue'), 'error')
            }
          }}
          className="bg-[var(--error)] text-[var(--text-inverse)] px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-50 font-medium text-sm"
        >
          {del.isPending ? <Spinner size="sm" /> : tr('Delete')}
        </button>
      </div>
    </Modal>
  )
}

function ChangeTypeDialog({ issue, isOpen, onClose }: { issue: ApiIssue; isOpen: boolean; onClose: () => void }) {
  const { tr } = useI18n();

  const types = useIssueTypesMeta()
  const preview = useTypeChangePreview()
  const apply = useApplyTypeChange()
  const [typeId, setTypeId] = useState('')
  const [statusId, setStatusId] = useState('')
  const [parentKey, setParentKey] = useState('')
  const [plan, setPlan] = useState<TypeChangePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { mutate: runPreview } = preview

  useEffect(() => { if (isOpen) { setTypeId(''); setStatusId(''); setParentKey(''); setPlan(null); setError(null) } }, [isOpen])

  // Every change of the choice refreshes the preview, so the dialog always shows what would happen.
  useEffect(() => {
    if (!isOpen || !typeId) { setPlan(null); return }
    const input = { issueTypeId: Number(typeId), ...(statusId ? { statusId: Number(statusId) } : {}), ...(parentKey.trim() ? { parentKey: parentKey.trim() } : {}) }
    const t = setTimeout(() => {
      runPreview({ key: issue.key, input }, {
        onSuccess: (p) => {
          setError(null); setPlan(p)
          // pre-select the suggested status once
          if (p.status.needsMapping && !statusId && p.status.suggestedStatusId) setStatusId(String(p.status.suggestedStatusId))
        },
        onError: (e: any) => { setPlan(null); setError(e?.message || tr('Preview failed')) },
      })
    }, 250)
    return () => clearTimeout(t)
  }, [isOpen, typeId, statusId, parentKey, issue.key, runPreview])

  const options = (types.data || []).filter((t) => String(t.id) !== String(issue.fields.issuetype?.id))
  const submit = () => {
    if (!plan?.canApply) return
    apply.mutate(
      { key: issue.key, input: { issueTypeId: Number(typeId), ...(statusId ? { statusId: Number(statusId) } : {}), ...(parentKey.trim() ? { parentKey: parentKey.trim() } : {}) } },
      {
        onSuccess: () => { toast(tr('{key} is now a {type}', { key: issue.key, type: plan.to.name }), 'success'); onClose() },
        onError: (e: any) => toast(e?.message || tr('Type change failed'), 'error'),
      },
    )
  }

  return (
    <Modal isOpen={isOpen} title={tr('Change type of {key}', { key: issue.key })} onClose={onClose} size="lg">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div>
          <label htmlFor="ct-type" className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('New type (current:')} {issue.fields.issuetype?.name})</label>
          <select id="ct-type" value={typeId} onChange={(e) => { setTypeId(e.target.value); setStatusId(''); setParentKey('') }} className="veqsio-input w-full" disabled={types.isLoading}>
            <option value="">{types.isLoading ? tr('Loading types...') : tr('Select a type')}</option>
            {options.map((t) => <option key={t.id} value={t.id}>{t.name}{t.subtask ? tr(' (sub-task)') : ''}</option>)}
          </select>
        </div>

        {typeId && preview.isPending && <div className="flex items-center gap-2 text-caption text-[var(--text-tertiary)]"><Spinner size="sm" /> {tr('Checking what would change...')}</div>}
        {error && <p role="alert" className="text-body-sm text-[var(--error)]">{error}</p>}

        {plan && (
          <div className="space-y-3" aria-live="polite">
            {plan.status.needsMapping && (
              <div>
                <label htmlFor="ct-status" className="text-caption font-medium text-[var(--text-secondary)] block mb-1">
                  &quot;{plan.status.current.name}{tr('" does not exist in the workflow of')} {plan.to.name}{tr('. Move the issue to')}
                </label>
                <select id="ct-status" value={statusId} onChange={(e) => setStatusId(e.target.value)} className="veqsio-input w-full">
                  <option value="">{tr('Select a status')}</option>
                  {plan.status.available.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            {(plan.parent.required || plan.to.subtask) && !plan.parent.current && (
              <div>
                <label htmlFor="ct-parent" className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Parent issue key (sub-tasks need a parent)')}</label>
                <input id="ct-parent" value={parentKey} onChange={(e) => setParentKey(e.target.value)} className="veqsio-input w-full" placeholder={tr('PROJ-123')} />
              </div>
            )}

            <ul className="text-body-sm space-y-1 rounded-md bg-[var(--surface-1)] p-3" aria-label={tr('What happens')}>
              <li>{tr('Type:')} <strong>{plan.from.name}</strong> {tr('to')} <strong>{plan.to.name}</strong></li>
              <li>{tr('Status:')} <strong>{plan.status.target?.name ?? plan.status.current.name}</strong>{plan.workflow.changed && plan.workflow.name ? <> {tr('(workflow')} {plan.workflow.name})</> : ` ${tr('(unchanged)')}`}</li>
              {plan.parent.cleared && <li>{tr('The issue leaves its parent')} <strong>{plan.parent.current}</strong>.</li>}
            </ul>

            {plan.droppedFields.length > 0 && (
              <div role="alert" className="rounded-md border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-3 text-body-sm">
                <p className="font-medium text-[var(--text-primary)]">{tr('These field values are not available for')} {plan.to.name}.</p>
                <p className="text-[var(--text-secondary)]">{tr('They are removed and appended to the description as a labelled block:')}</p>
                <ul className="list-disc pl-5 mt-1">
                  {plan.droppedFields.map((f) => <li key={f.id}><strong>{f.name}:</strong> {f.value}</li>)}
                </ul>
              </div>
            )}
            {plan.warnings.filter((w) => !w.includes('custom field value')).map((w) => <p key={w} className="text-caption text-[var(--text-secondary)]">{w}</p>)}
            {plan.blockers.length > 0 && (
              <ul className="text-body-sm text-[var(--error)] list-disc pl-5" aria-label={tr('Blocking problems')}>
                {plan.blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
          <button type="submit" disabled={apply.isPending || !plan?.canApply} className="veqsio-btn-primary disabled:opacity-50">
            {apply.isPending ? <Spinner size="sm" /> : tr('Change type')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
