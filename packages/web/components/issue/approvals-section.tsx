'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import { ApproverPicker, DecisionForm, StatusChip, type PickedUser } from '@/components/approvals/shared'
import { useApprovalTemplates, useCancelApproval, useDecide, useIssueApprovals, useRequestApproval } from '@/hooks/use-approvals'
import { useMyself } from '@/hooks/use-issues'
import { ruleLabel, type ApprovalRule } from '@/lib/approvals'

/** "Approvals" panel of the issue view: list with decision history, request dialog, approve/decline for assigned approvers. */
export function ApprovalsSection({ issueKey, projectKey }: { issueKey: string; projectKey: string }) {
  const { tr } = useI18n();

  const list = useIssueApprovals(issueKey)
  const me = useMyself()
  const decide = useDecide()
  const cancel = useCancelApproval()
  const [open, setOpen] = useState(false)
  const [decideError, setDecideError] = useState<Record<number, string>>({})

  // Hidden for people who may not see any approval on this issue (the API answers 404).
  if (list.isLoading) return null
  if (list.error && (list.error as any).status === 404) return null
  const approvals = list.data?.values ?? []

  return (
    <section aria-labelledby="approvals-heading" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="approvals-heading" className="text-heading-3 text-[var(--text-primary)]">{tr('Approvals')}</h2>
        <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => setOpen(true)}>{tr('Request approval')}</button>
      </div>
      {list.error && <p role="alert" className="text-sm text-[var(--error)]">{list.error.message}</p>}
      {approvals.length === 0 && !list.error && <p className="text-sm text-[var(--text-tertiary)]">{tr('No approvals have been requested.')}</p>}
      <ul className="space-y-3">
        {approvals.map((a) => (
          <li key={a.id} className="veqsio-card p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{a.name}</strong>
              <StatusChip status={a.status} />
              <span className="text-xs text-[var(--text-tertiary)]">{ruleLabel(a.rule, a.ruleThreshold)}</span>
              {a.expires && a.status === 'pending' && <span className="text-xs text-[var(--text-tertiary)]">expires {new Date(a.expires).toLocaleString()}</span>}
              {a.status === 'pending' && a.createdBy === me.data?.id && (
                <button type="button" className="ml-auto text-xs underline text-[var(--text-secondary)]" disabled={cancel.isPending}
                  onClick={() => cancel.mutate(a.id, { onError: (e) => toast(e.message, 'error') })}>{tr('Cancel approval')}</button>
              )}
            </div>
            {a.approvers && (
              <p className="text-sm text-[var(--text-secondary)]">
                {tr('Approvers:')} {a.approvers.map((p) => `${p.displayName}${p.decided ? '' : ' (waiting)'}`).join(', ')}
              </p>
            )}
            {a.decisions && a.decisions.length > 0 && (
              <ul className="text-sm space-y-1" aria-label={`Decision history for ${a.name}`}>
                {a.decisions.map((d, i) => (
                  <li key={i}>
                    <span className="font-medium">{d.approver ?? 'Approver'}</span> {d.decision} · <time dateTime={d.decided}>{new Date(d.decided).toLocaleString()}</time>
                    {d.comment && <span className="block text-[var(--text-secondary)] whitespace-pre-wrap">{d.comment}</span>}
                  </li>
                ))}
              </ul>
            )}
            {a.canDecide && (
              <DecisionForm
                busy={decide.isPending}
                error={decideError[a.id]}
                onDecide={(decision, comment) => {
                  setDecideError((e) => ({ ...e, [a.id]: '' }))
                  decide.mutate({ id: a.id, decision, comment }, {
                    onSuccess: () => toast(decision === 'approved' ? 'Approved' : 'Declined', 'success'),
                    onError: (e) => setDecideError((er) => ({ ...er, [a.id]: e.message })),
                  })
                }}
              />
            )}
          </li>
        ))}
      </ul>
      {open && <RequestDialog issueKey={issueKey} projectKey={projectKey} onClose={() => setOpen(false)} />}
    </section>
  )
}

function RequestDialog({ issueKey, projectKey, onClose }: { issueKey: string; projectKey: string; onClose: () => void }) {
  const { tr } = useI18n();

  const templates = useApprovalTemplates(projectKey)
  const request = useRequestApproval(issueKey)
  const [mode, setMode] = useState<'template' | 'adhoc'>('template')
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('Approval')
  const [users, setUsers] = useState<PickedUser[]>([])
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [rule, setRule] = useState<ApprovalRule>('all')
  const [threshold, setThreshold] = useState('')
  const [error, setError] = useState('')
  const tpls = templates.data?.values ?? []

  const submit = () => {
    setError('')
    const body: Record<string, unknown> = mode === 'template'
      ? { templateId: Number(templateId) }
      : {
          name: name.trim() || 'Approval', approverUserIds: users.map((u) => u.id), approverGroupIds: groupIds, rule,
          ...(rule === 'n_of_m' || rule === 'percentage' ? { ruleThreshold: Number(threshold) } : {}),
        }
    if (mode === 'template' && !templateId) { setError('Choose a template'); return }
    if (mode === 'adhoc' && users.length + groupIds.length === 0) { setError('Choose at least one approver'); return }
    request.mutate(body, {
      onSuccess: () => { toast(tr('Approval requested'), 'success'); onClose() },
      onError: (e) => setError(e.message),
    })
  }

  return (
    <Modal isOpen onClose={onClose} title={tr('Request approval')}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <fieldset className="flex gap-4">
          <legend className="sr-only">{tr('Source')}</legend>
          <label className="text-sm"><input type="radio" name="mode" checked={mode === 'template'} onChange={() => setMode('template')} /> {tr('From a template')}</label>
          <label className="text-sm"><input type="radio" name="mode" checked={mode === 'adhoc'} onChange={() => setMode('adhoc')} /> {tr('Choose approvers')}</label>
        </fieldset>
        {mode === 'template' ? (
          <div>
            <label htmlFor="ap-tpl" className="block text-sm font-medium">{tr('Template')}</label>
            <select id="ap-tpl" className="veqsio-input w-full" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">{tr('Choose a template...')}</option>
              {tpls.map((t) => <option key={t.id} value={t.id}>{t.name} ({ruleLabel(t.rule, t.ruleThreshold)})</option>)}
            </select>
            {tpls.length === 0 && !templates.isLoading && <p className="text-sm text-[var(--text-tertiary)] mt-1">{tr('No templates yet. Project administrators create them in project settings.')}</p>}
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="ap-name" className="block text-sm font-medium">{tr('Name')}</label>
              <input id="ap-name" className="veqsio-input w-full" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </div>
            <ApproverPicker users={users} groupIds={groupIds} onChange={(v) => { setUsers(v.users); setGroupIds(v.groupIds) }} />
            <div>
              <label htmlFor="ap-rule" className="block text-sm font-medium">{tr('Decision rule')}</label>
              <select id="ap-rule" className="veqsio-input w-full" value={rule} onChange={(e) => setRule(e.target.value as ApprovalRule)}>
                <option value="all">{tr('All must approve')}</option>
                <option value="any">{tr('Any one approver')}</option>
                <option value="n_of_m">{tr('A number of approvers')}</option>
                <option value="percentage">{tr('A percentage of approvers')}</option>
              </select>
            </div>
            {(rule === 'n_of_m' || rule === 'percentage') && (
              <div>
                <label htmlFor="ap-th" className="block text-sm font-medium">{rule === 'n_of_m' ? 'Approvals needed' : 'Percent needed'}</label>
                <input id="ap-th" inputMode="numeric" className="veqsio-input w-24" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              </div>
            )}
          </>
        )}
        {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-ghost" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="veqsio-btn-primary" disabled={request.isPending}>{tr('Request approval')}</button>
        </div>
      </form>
    </Modal>
  )
}
