'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import { Spinner } from '@/components/spinner'
import { useDeleteTemplate, useIssueTemplates, useSaveTemplate, type IssueTemplate } from '@/hooks/use-templates'
import { useTerm } from '@/hooks/use-term'
import { confirmDialog } from '@/components/dialogs'

const getJson = (url: string) => fetch(url, { credentials: 'include' }).then((r) => (r.ok ? r.json() : null))

/** Issue types, priorities, assignable users and the project's components: what a template can point at. */
function useTemplateRefs(projectKey?: string) {
  const types = useQuery({ queryKey: ['issuetypes'], queryFn: () => getJson('/rest/api/2/issuetype').then((d) => (d ?? []) as Array<{ id: number; name: string }>) })
  const prios = useQuery({ queryKey: ['priorities-meta'], queryFn: () => getJson('/rest/api/2/priority').then((d) => (d ?? []) as Array<{ id: number; name: string }>) })
  const users = useQuery({ queryKey: ['assignable-users'], queryFn: () => getJson('/rest/api/2/user/search?username=').then((d) => (d?.users ?? []) as Array<{ id: number; displayName: string }>) })
  const comps = useQuery({
    queryKey: ['template-components', projectKey], enabled: !!projectKey,
    queryFn: () => getJson(`/rest/api/2/project/${encodeURIComponent(projectKey!)}/components`).then((d) => ((Array.isArray(d) ? d : d?.values ?? []) as Array<{ name: string }>)),
  })
  return { types: types.data ?? [], prios: prios.data ?? [], users: users.data ?? [], comps: comps.data ?? [] }
}

interface Draft { name: string; description: string; issueTypeId: string; summaryPattern: string; body: string; priorityId: string; labels: string; components: string; assigneeId: string }
const emptyDraft: Draft = { name: '', description: '', issueTypeId: '', summaryPattern: '', body: '', priorityId: '', labels: '', components: '', assigneeId: '' }
const toDraft = (t: IssueTemplate): Draft => ({
  name: t.name, description: t.description ?? '', issueTypeId: t.issueTypeId ? String(t.issueTypeId) : '', summaryPattern: t.summaryPattern, body: t.body,
  priorityId: t.priorityId ? String(t.priorityId) : '', labels: t.labels.join(', '), components: t.components.join(', '), assigneeId: t.assigneeId ? String(t.assigneeId) : '',
})
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

function TemplateEditor({ projectKey, template, onClose }: { projectKey?: string; template: IssueTemplate | null; onClose: () => void }) {
  const { tr } = useI18n();

  const { t } = useTerm()
  const refs = useTemplateRefs(projectKey)
  const save = useSaveTemplate()
  const [d, setD] = useState<Draft>(emptyDraft)
  useEffect(() => { setD(template ? toDraft(template) : emptyDraft) }, [template])
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setD((x) => ({ ...x, [k]: e.target.value }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const data = {
      name: d.name.trim(), description: d.description.trim() || null, issueTypeId: Number(d.issueTypeId), summaryPattern: d.summaryPattern, body: d.body,
      priorityId: d.priorityId ? Number(d.priorityId) : null, labels: csv(d.labels), components: csv(d.components), assigneeId: d.assigneeId ? Number(d.assigneeId) : null,
      ...(template ? {} : { projectKey: projectKey ?? null }),
    }
    save.mutate({ id: template?.id, data }, {
      onSuccess: () => { toast(tr('Template saved'), 'success'); onClose() },
      onError: (err) => toast(err.message, 'error'),
    })
  }
  const label = 'block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5'
  return (
    <Modal isOpen onClose={onClose} title={template ? 'Edit template' : 'New template'} size="md">
      <form onSubmit={submit} className="space-y-4">
        <div><label htmlFor="tpl-name" className={label}>{tr('Name')}</label><input id="tpl-name" className="veqsio-input w-full" value={d.name} onChange={set('name')} maxLength={100} required autoFocus /></div>
        <div><label htmlFor="tpl-desc" className={label}>{tr('Description')} <span className="font-normal text-[var(--text-tertiary)]">{tr('(shown in the template picker)')}</span></label><input id="tpl-desc" className="veqsio-input w-full" value={d.description} onChange={set('description')} maxLength={500} /></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label htmlFor="tpl-type" className={label}>{t('Issue type')}</label>
            <select id="tpl-type" className="veqsio-input w-full" value={d.issueTypeId} onChange={set('issueTypeId')} required><option value="">{tr('Select type')}</option>{refs.types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
          <div><label htmlFor="tpl-prio" className={label}>{tr('Default priority')}</label>
            <select id="tpl-prio" className="veqsio-input w-full" value={d.priorityId} onChange={set('priorityId')}><option value="">{tr('None')}</option>{refs.prios.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        </div>
        <div>
          <label htmlFor="tpl-summary" className={label}>{tr('Summary pattern')}</label>
          <input id="tpl-summary" className="veqsio-input w-full" value={d.summaryPattern} onChange={set('summaryPattern')} maxLength={255} placeholder="Weekly report {date} (week {week})" aria-describedby="tpl-summary-hint" />
          <p id="tpl-summary-hint" className="mt-1 text-[12px] text-[var(--text-tertiary)]">{tr('Placeholders:')} {'{date}'} {'{year}'} {'{month}'} {'{monthName}'} {'{day}'} {'{week}'} {'{weekday}'} {'{project}'}. Anyone can still edit the summary when creating.</p>
        </div>
        <div><label htmlFor="tpl-body" className={label}>{tr('Description (Markdown)')}</label><textarea id="tpl-body" className="veqsio-input w-full font-mono text-[13px]" rows={8} value={d.body} onChange={set('body')} maxLength={20000} /></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label htmlFor="tpl-labels" className={label}>{tr('Labels')}</label><input id="tpl-labels" className="veqsio-input w-full" value={d.labels} onChange={set('labels')} placeholder={tr('bug, frontend')} /></div>
          <div><label htmlFor="tpl-comps" className={label}>{tr('Components')}</label>
            <input id="tpl-comps" className="veqsio-input w-full" value={d.components} onChange={set('components')} placeholder={tr('Backend, API')} list="tpl-comp-list" />
            <datalist id="tpl-comp-list">{refs.comps.map((c) => <option key={c.name} value={c.name} />)}</datalist></div>
        </div>
        <div><label htmlFor="tpl-assignee" className={label}>{tr('Default assignee')}</label>
          <select id="tpl-assignee" className="veqsio-input w-full sm:w-1/2" value={d.assigneeId} onChange={set('assigneeId')}><option value="">{tr('Unassigned')}</option>{refs.users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
          <button type="submit" disabled={save.isPending || !d.name.trim() || !d.issueTypeId} className="veqsio-btn-primary">{save.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{tr('Save template')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** List and editor of issue templates: those of one project (plus the read-only global ones), or only the global ones without a key. */
export function TemplateManager({ projectKey }: { projectKey?: string }) {
  const { tr } = useI18n();

  const { t, Issue } = useTerm()
  const list = useIssueTemplates(projectKey)
  const del = useDeleteTemplate()
  const [editing, setEditing] = useState<IssueTemplate | 'new' | null>(null)
  const canManage = (x: IssueTemplate) => (x.scope === 'global' ? list.data?.canManageGlobal : list.data?.canManageProject)
  const canCreate = projectKey ? list.data?.canManageProject : list.data?.canManageGlobal

  if (list.isLoading) return <div className="py-8 flex justify-center"><Spinner /></div>
  if (list.error) return <p role="alert" className="text-[13px] text-[var(--error)]">{tr('Could not load templates:')} {list.error.message}</p>
  const templates = list.data?.templates ?? []
  return (
    <section aria-labelledby="tpl-heading" className="space-y-4 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="tpl-heading" className="text-heading-3">{projectKey ? `${Issue} templates` : `Global ${t('issue')} templates`}</h2>
          <p className="text-body-sm text-[var(--text-secondary)] mt-1">
            {projectKey ? t('Pre-filled issues for this project. Global templates are listed too.') : t('Available in every project when creating an issue.')} {tr('Pick one in the create dialog.')} </p>
        </div>
        {canCreate && <button onClick={() => setEditing('new')} className="veqsio-btn-primary"><Plus className="w-4 h-4" />{tr('New template')}</button>}
      </div>
      {templates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--surface-4)] p-6 text-center text-[13px] text-[var(--text-secondary)]">{tr('No templates yet.')}</p>
      ) : (
        <ul className="rounded-lg border border-[var(--surface-3)] divide-y divide-[var(--surface-3)]">
          {templates.map((x) => (
            <li key={x.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold truncate">{x.name} {x.scope === 'global' && <span className="ml-1 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">{tr('Global')}</span>}</p>
                <p className="text-[12px] text-[var(--text-tertiary)] truncate">{x.description || x.summaryPattern || 'No summary pattern'}</p>
              </div>
              {canManage(x) && (
                <div className="flex gap-0.5">
                  <button className="veqsio-btn-ghost !p-1.5" aria-label={`Edit ${x.name}`} onClick={() => setEditing(x)}><Pencil className="w-4 h-4" aria-hidden="true" /></button>
                  <button
                    className="veqsio-btn-ghost !p-1.5" aria-label={`Delete ${x.name}`}
                    onClick={async () => { if ((await confirmDialog(`Delete the template "${x.name}"?`))) del.mutate(x.id, { onSuccess: () => toast(tr('Template deleted'), 'success'), onError: (e) => toast(e.message, 'error') }) }}
                  ><Trash2 className="w-4 h-4" aria-hidden="true" /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <TemplateEditor projectKey={projectKey} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  )
}
