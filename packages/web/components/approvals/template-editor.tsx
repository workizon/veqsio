'use client'

import { useState } from 'react'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useUsers } from '@/hooks/use-admin'
import { useApprovalTemplates, useDeleteTemplate, useSaveTemplate, type ApprovalTemplate } from '@/hooks/use-approvals'
import { emptyTemplateForm, ruleLabel, templateBody, validateTemplateForm, type TemplateForm } from '@/lib/approvals'
import { ApproverPicker, type PickedUser } from './shared'
import { confirmDialog } from '@/components/dialogs'

function fromTemplate(t: ApprovalTemplate): TemplateForm {
  const auto = (r: ApprovalTemplate['autoApproveWhen']) => (r && r.op === 'eq' && typeof r.value === 'string' ? { f: r.field as 'priority' | 'issuetype', v: r.value } : { f: '' as const, v: '' })
  const a = auto(t.autoApproveWhen); const d = auto(t.autoDeclineWhen)
  return {
    name: t.name, approverUserIds: t.approverUserIds ?? [], approverGroupIds: t.approverGroupIds ?? [], rule: t.rule as TemplateForm['rule'],
    ruleThreshold: t.ruleThreshold != null ? String(t.ruleThreshold) : '', reminderIntervalHours: t.reminderIntervalHours != null ? String(t.reminderIntervalHours) : '',
    expiryHours: t.expiryHours != null ? String(t.expiryHours) : '', autoApproveField: a.f, autoApproveValue: a.v, autoDeclineField: d.f, autoDeclineValue: d.v,
    onApprovedTransitionId: t.onApprovedTransitionId != null ? String(t.onApprovedTransitionId) : '',
    onDeclinedTransitionId: t.onDeclinedTransitionId != null ? String(t.onDeclinedTransitionId) : '',
  }
}

/** Approval templates of one project: list, create, edit, delete. Project administrators only (the API enforces it). */
export function ApprovalTemplateEditor({ projectKey }: { projectKey: string }) {
  const list = useApprovalTemplates(projectKey)
  const del = useDeleteTemplate(projectKey)
  const [editing, setEditing] = useState<{ id?: number; form: TemplateForm } | null>(null)
  const templates = list.data?.values ?? []

  return (
    <section className="space-y-4" aria-labelledby="apt-h">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="apt-h" className="text-heading-2">Approval templates</h2>
          <p className="text-sm text-[var(--text-secondary)]">Reusable approver rules. Use them from the workflow post-function “Request approval” or the Approvals panel on an issue.</p>
        </div>
        <button type="button" className="veqsio-btn-primary" onClick={() => setEditing({ form: emptyTemplateForm() })}>New template</button>
      </div>
      {list.isLoading && <Spinner />}
      {list.error && <p role="alert" className="text-[var(--error)]">{list.error.message}</p>}
      {list.data && templates.length === 0 && <p className="text-[var(--text-tertiary)]">No templates yet.</p>}
      <ul className="space-y-2">
        {templates.map((t) => (
          <li key={t.id} className="veqsio-card p-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <strong>{t.name}</strong>
              <div className="text-sm text-[var(--text-secondary)]">
                {ruleLabel(t.rule, t.ruleThreshold)} · {(t.approverUserIds?.length ?? 0)} user(s), {(t.approverGroupIds?.length ?? 0)} group(s)
                {t.reminderIntervalHours ? ` · reminder every ${t.reminderIntervalHours} h` : ''}{t.expiryHours ? ` · expires after ${t.expiryHours} h` : ''}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => setEditing({ id: t.id, form: fromTemplate(t) })}>Edit<span className="sr-only"> {t.name}</span></button>
              <button type="button" className="veqsio-btn-ghost text-sm text-[var(--error)]" disabled={del.isPending}
                onClick={async () => { if ((await confirmDialog(`Delete template "${t.name}"?`))) del.mutate(t.id, { onError: (e) => toast(e.message, 'error') }) }}>Delete<span className="sr-only"> {t.name}</span></button>
            </div>
          </li>
        ))}
      </ul>
      {editing && <TemplateDialog projectKey={projectKey} initial={editing} onClose={() => setEditing(null)} />}
    </section>
  )
}

function TemplateDialog({ projectKey, initial, onClose }: { projectKey: string; initial: { id?: number; form: TemplateForm }; onClose: () => void }) {
  const save = useSaveTemplate(projectKey)
  const users = useUsers(0, 200)
  const [f, setF] = useState<TemplateForm>(initial.form)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState('')
  const set = <K extends keyof TemplateForm>(k: K, v: TemplateForm[K]) => setF((x) => ({ ...x, [k]: v }))
  const nameOf = (id: number) => users.data?.values.find((u) => Number(u.id) === id)?.displayName ?? `User ${id}`
  const picked: PickedUser[] = f.approverUserIds.map((id) => ({ id, name: nameOf(id) }))

  const submit = () => {
    const e = validateTemplateForm(f)
    setErrors(e); setServerError('')
    if (Object.keys(e).length) return
    save.mutate({ id: initial.id, body: templateBody(f) }, {
      onSuccess: () => { toast('Template saved', 'success'); onClose() },
      onError: (err) => setServerError(err.message),
    })
  }

  const field = (id: string, label: string, key: keyof TemplateForm, props: { hint?: string; narrow?: boolean } = {}) => (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <input id={id} className={`veqsio-input ${props.narrow ? 'w-28' : 'w-full'}`} value={String(f[key])} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `${id}-e` : undefined}
        onChange={(e) => set(key, e.target.value as never)} inputMode={props.narrow ? 'numeric' : undefined} />
      {props.hint && <p className="text-xs text-[var(--text-tertiary)]">{props.hint}</p>}
      {errors[key] && <p id={`${id}-e`} role="alert" className="text-sm text-[var(--error)]">{errors[key]}</p>}
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={initial.id ? 'Edit approval template' : 'New approval template'} size="lg">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
        {field('apt-name', 'Name', 'name')}
        <ApproverPicker users={picked} groupIds={f.approverGroupIds} error={errors.approvers}
          onChange={(v) => setF((x) => ({ ...x, approverUserIds: v.users.map((u) => u.id), approverGroupIds: v.groupIds }))} />
        <div>
          <label htmlFor="apt-rule" className="block text-sm font-medium">Decision rule</label>
          <select id="apt-rule" className="veqsio-input w-full" value={f.rule} onChange={(e) => set('rule', e.target.value as TemplateForm['rule'])}>
            <option value="all">All approvers must approve</option>
            <option value="any">Any one approver</option>
            <option value="n_of_m">A number of approvers (n of m)</option>
            <option value="percentage">A percentage of approvers</option>
          </select>
        </div>
        {(f.rule === 'n_of_m' || f.rule === 'percentage') && field('apt-th', f.rule === 'n_of_m' ? 'Approvals needed' : 'Percent needed', 'ruleThreshold', { narrow: true })}
        <div className="grid grid-cols-2 gap-3">
          {field('apt-rem', 'Reminder every (hours)', 'reminderIntervalHours', { narrow: true, hint: 'Empty: no reminders' })}
          {field('apt-exp', 'Expires after (hours)', 'expiryHours', { narrow: true, hint: 'Empty: never expires' })}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Automatic decision when the request is created</legend>
          <div className="flex flex-wrap items-end gap-2">
            <span className="text-sm">Approve automatically if</span>
            <label className="sr-only" htmlFor="apt-af">Approve field</label>
            <select id="apt-af" className="veqsio-input" value={f.autoApproveField} onChange={(e) => set('autoApproveField', e.target.value as TemplateForm['autoApproveField'])}>
              <option value="">(never)</option><option value="priority">priority</option><option value="issuetype">issue type</option>
            </select>
            {f.autoApproveField && <><span className="text-sm">is</span><label className="sr-only" htmlFor="apt-av">Approve value</label><input id="apt-av" className="veqsio-input" value={f.autoApproveValue} onChange={(e) => set('autoApproveValue', e.target.value)} placeholder="e.g. Low" /></>}
          </div>
          {errors.autoApproveValue && <p role="alert" className="text-sm text-[var(--error)]">{errors.autoApproveValue}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <span className="text-sm">Decline automatically if</span>
            <label className="sr-only" htmlFor="apt-df">Decline field</label>
            <select id="apt-df" className="veqsio-input" value={f.autoDeclineField} onChange={(e) => set('autoDeclineField', e.target.value as TemplateForm['autoDeclineField'])}>
              <option value="">(never)</option><option value="priority">priority</option><option value="issuetype">issue type</option>
            </select>
            {f.autoDeclineField && <><span className="text-sm">is</span><label className="sr-only" htmlFor="apt-dv">Decline value</label><input id="apt-dv" className="veqsio-input" value={f.autoDeclineValue} onChange={(e) => set('autoDeclineValue', e.target.value)} /></>}
          </div>
          {errors.autoDeclineValue && <p role="alert" className="text-sm text-[var(--error)]">{errors.autoDeclineValue}</p>}
        </fieldset>
        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="text-sm font-medium">Move the issue when finished (workflow transition ids)</legend>
          {field('apt-ta', 'When approved', 'onApprovedTransitionId', { narrow: true, hint: 'Runs as a system user; other validators still apply' })}
          {field('apt-td', 'When declined', 'onDeclinedTransitionId', { narrow: true })}
        </fieldset>
        {serverError && <p role="alert" className="text-sm text-[var(--error)]">{serverError}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="veqsio-btn-primary" disabled={save.isPending}>Save</button>
        </div>
      </form>
    </Modal>
  )
}
