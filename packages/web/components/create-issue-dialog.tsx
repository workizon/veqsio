'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Bug, BookOpen, CheckCircle2, GitBranch, Layers, Loader2, Paperclip, Settings2, UploadCloud, X } from 'lucide-react'
import { Modal } from './modal'
import { toast } from './toast'
import { DraftNotice } from './draft-notice'
import { RichTextEditor } from './rich-text-editor'
import { TemplatePicker } from './templates/template-picker'
import { useCreateIssue, useMyself } from '@/hooks/use-issues'
import { useProjects } from '@/hooks/use-project-admin'
import { useDraft } from '@/hooks/use-draft'
import { useTerm } from '@/hooks/use-term'
import { isDraftEmpty, quickCreateDraftKey } from '@/lib/drafts'
import type { TemplatePrefill } from '@/hooks/use-templates'
import { CustomFieldInput, type MetaField, type MetaProject } from './custom-field-input'

const TYPE_ICONS: Record<string, typeof Bug> = { Bug, Task: CheckCircle2, Story: BookOpen, Epic: Layers, 'Sub-task': GitBranch }

/** Optional fields an administrator or user may hide with "Configure Fields"; the rest are always shown. */
const OPTIONAL = [
  { key: 'attachment', label: 'Attachment' },
  { key: 'duedate', label: 'Due date' },
  { key: 'description', label: 'Description' },
  { key: 'priority', label: 'Priority' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'labels', label: 'Labels' },
  { key: 'components', label: 'Components' },
  { key: 'storyPoints', label: 'Story points' },
]
const HIDDEN_KEY = 'veqsio-create-hidden-fields'

function useHiddenFields(): [Set<string>, (key: string) => void] {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  useEffect(() => {
    try { setHidden(new Set(JSON.parse(window.localStorage.getItem(HIDDEN_KEY) || '[]'))) } catch { /* ignore */ }
  }, [])
  const toggle = (key: string) => setHidden((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key); else next.add(key)
    try { window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])) } catch { /* private mode */ }
    return next
  })
  return [hidden, toggle]
}

function isEmpty(v: unknown): boolean { return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) }

function Row({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 items-start">
      <label className="sm:text-right text-sm font-medium text-[var(--text-secondary)] sm:pt-2">
        {label}{required && <span className="text-[var(--error)]"> *</span>}
      </label>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1 text-caption text-[var(--text-tertiary)]">{hint}</p>}
      </div>
    </div>
  )
}

/** The Create dialog (header button): project and type, then the fields of that project, with Configure Fields. */
export function CreateIssueDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const router = useRouter()
  const { t } = useTerm()
  const createIssue = useCreateIssue()
  const { data: projects = [] } = useProjects()
  const { data: me } = useMyself()
  const [hidden, toggleHidden] = useHiddenFields()
  const [configOpen, setConfigOpen] = useState(false)

  const [projectId, setProjectId] = useState('')
  const [issueTypeId, setIssueTypeId] = useState('')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [priorityId, setPriorityId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [labels, setLabels] = useState('')
  const [storyPoints, setStoryPoints] = useState('')
  const [componentIds, setComponentIds] = useState<number[]>([])
  const [assignee, setAssignee] = useState<{ id: number; name: string } | null>(null)
  const [assigneeQuery, setAssigneeQuery] = useState('')
  const [custom, setCustom] = useState<Record<string, unknown>>({})
  const [files, setFiles] = useState<File[]>([])
  const [createAnother, setCreateAnother] = useState(false)
  const [extras, setExtras] = useState<Omit<TemplatePrefill, 'projectId' | 'issueTypeId' | 'summary'>>({})
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const projectKey = projects.find((p) => String(p.id) === projectId)?.key

  // Types, priorities, components and custom fields that apply to the chosen project (and its issue type scheme).
  const meta = useQuery({
    queryKey: ['createmeta', projectKey],
    enabled: isOpen && !!projectKey,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await fetch(`/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey!)}&expand=projects.issuetypes.fields`, { credentials: 'include' })
      if (!r.ok) throw new Error('Could not load the fields of this project')
      return ((await r.json()) as { projects: MetaProject[] }).projects[0] ?? null
    },
  })
  const types = (meta.data?.issuetypes ?? []).filter((x) => !x.subtask)
  const currentType = types.find((x) => x.id === issueTypeId)
  const fields = currentType?.fields ?? {}
  const priorities = fields.priority?.allowedValues ?? []
  const components = fields.components?.allowedValues ?? []
  const customFields = Object.values(fields).filter((f) => f.key.startsWith('customfield_'))

  const assigneeSearch = useQuery({
    queryKey: ['create-assignee', assigneeQuery],
    enabled: isOpen && assigneeQuery.trim().length > 0,
    queryFn: async () => {
      const r = await fetch(`/rest/api/2/user/search?query=${encodeURIComponent(assigneeQuery.trim())}`, { credentials: 'include' })
      return r.ok ? ((await r.json()) as Array<{ id: number; name: string; key: string }>) : []
    },
  })

  // defaults: first project, first type of that project, medium priority
  useEffect(() => { if (isOpen && projects[0] && !projectId) setProjectId(String(projects[0].id)) }, [isOpen, projects, projectId])
  useEffect(() => {
    if (!types.length) return
    if (!types.some((x) => x.id === issueTypeId)) setIssueTypeId(types[0].id)
  }, [meta.data]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (priorities.length && !priorities.some((p) => p.id === priorityId)) {
      setPriorityId((priorities.find((p) => p.name === 'Medium') ?? priorities[0]).id)
    }
  }, [meta.data, issueTypeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Autosaved draft of the main fields (kept while the dialog is closed, cleared after a successful create).
  const draftValue = useMemo(() => ({ projectId, issueTypeId, summary, description }), [projectId, issueTypeId, summary, description])
  const draft = useDraft({
    key: me ? quickCreateDraftKey(me.id, 'new', 'form') : null,
    value: draftValue,
    isEmpty: (d) => isDraftEmpty(d, ['projectId', 'issueTypeId']),
    onRestore: (d) => {
      if (d.projectId) setProjectId(String(d.projectId))
      if (d.issueTypeId) setIssueTypeId(String(d.issueTypeId))
      setSummary(d.summary ?? '')
      setDescription(d.description ?? '')
    },
    onDiscard: () => { setSummary(''); setDescription('') },
  })

  const show = (key: string) => !hidden.has(key)
  const addFiles = (list: FileList | File[] | null) => { if (list) setFiles((cur) => [...cur, ...Array.from(list)]) }

  function reset() {
    setSummary(''); setDescription(''); setDueDate(''); setLabels(''); setStoryPoints(''); setComponentIds([])
    setCustom({}); setFiles([]); setExtras({}); setAssignee(null); setAssigneeQuery('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!summary.trim() || !projectId || !issueTypeId) { toast('Please fill in required fields', 'error'); return }
    const points = storyPoints.trim() === '' ? undefined : Number(storyPoints)
    if (points !== undefined && (!Number.isFinite(points) || points < 0 || points > 1000)) { toast('Story points must be a number between 0 and 1000', 'error'); return }
    // required custom fields (set by the field configuration of the project and issue type); a default counts as filled in
    const emptyRequired = customFields.filter((f) => f.required && isEmpty(custom[f.key] ?? f.defaultValue))
    if (emptyRequired.length) { toast(`Please fill in: ${emptyRequired.map((f) => f.name).join(', ')}`, 'error'); return }
    const customFieldValues = [
      ...(extras.customFields ?? []),
      ...[...Object.entries(custom), ...customFields.filter((f) => custom[f.key] === undefined && f.defaultValue !== undefined).map((f) => [f.key, f.defaultValue] as [string, unknown])]
        .filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
        .map(([key, v]) => ({ fieldId: Number(key.replace('customfield_', '')), value: Array.isArray(v) ? v.join(', ') : v })),
    ]
    try {
      const result = await createIssue.mutateAsync({
        fields: {
          project: { id: Number(projectId) },
          issuetype: { id: Number(issueTypeId) },
          summary: summary.trim(),
          description: (show('description') ? description : '') || extras.description || undefined,
          priority: show('priority') && priorityId ? { id: Number(priorityId) } : extras.priorityId ? { id: extras.priorityId } : undefined,
          assignee: show('assignee') && assignee ? { id: assignee.id } : extras.assigneeId ? { id: extras.assigneeId } : undefined,
          labels: show('labels') && labels.trim() ? labels.split(',').map((l) => l.trim()).filter(Boolean) : extras.labels,
          components: show('components') && componentIds.length ? componentIds.map((id) => ({ id })) : extras.components?.map((id) => ({ id })),
          duedate: show('duedate') && dueDate ? dueDate : undefined,
          storyPoints: show('storyPoints') ? points : undefined,
          customFields: customFieldValues.length ? customFieldValues : undefined,
        },
      } as Parameters<typeof createIssue.mutateAsync>[0])

      if (files.length) {
        const form = new FormData()
        files.forEach((f) => form.append('file', f))
        const up = await fetch(`/rest/api/2/issue/${encodeURIComponent(result.key)}/attachments`, { method: 'POST', body: form, credentials: 'include' })
        if (!up.ok) toast('The issue was created, but the attachments could not be uploaded', 'error')
      }
      toast(t(`Issue ${result.key} created`), 'success')
      draft.clear()
      reset()
      if (createAnother) return
      onClose()
      router.push(`/issues/${result.key}`)
    } catch (err: any) {
      toast(err?.message || t('Failed to create issue'), 'error')
    }
  }

  const TypeIcon = TYPE_ICONS[currentType?.name ?? ''] ?? Bug

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('Create issue')} size="xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-start justify-between gap-3 -mt-1">
          <p className="text-caption text-[var(--text-tertiary)]">Required fields are marked with an asterisk <span className="text-[var(--error)]">*</span></p>
          <div className="relative">
            <button type="button" onClick={() => setConfigOpen((o) => !o)} aria-expanded={configOpen} className="veqsio-btn-secondary text-sm inline-flex items-center gap-1.5">
              <Settings2 className="w-4 h-4" aria-hidden="true" /> Configure fields
            </button>
            {configOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-2 shadow-lg">
                <p className="px-2 pb-1 text-caption text-[var(--text-tertiary)]">Show these fields</p>
                {OPTIONAL.map((f) => (
                  <label key={f.key} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-[var(--surface-1)] rounded">
                    <input type="checkbox" checked={show(f.key)} onChange={() => toggleHidden(f.key)} /> {f.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        <DraftNotice savedAt={draft.restored?.savedAt ?? null} onDiscard={draft.discard} />

        <Row label="Project" required>
          <select className="veqsio-input w-full" value={projectId} onChange={(e) => { setProjectId(e.target.value); setIssueTypeId(''); setPriorityId(''); setExtras({}); setCustom({}); setComponentIds([]) }} required>
            <option value="">Select project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
          </select>
        </Row>
        <Row label={t('Issue Type')} required>
          <div className="relative max-w-xs">
            <TypeIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
            <select className="veqsio-input w-full pl-9" value={issueTypeId} onChange={(e) => { setIssueTypeId(e.target.value); setCustom({}) }} required disabled={meta.isLoading}>
              {types.length === 0 && <option value="">{meta.isLoading ? 'Loading…' : 'No issue types'}</option>}
              {types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </div>
        </Row>

        <hr className="border-[var(--surface-3)]" />

        <TemplatePicker
          key={projectId}
          projectKey={projectKey}
          onApply={(p) => { setIssueTypeId(String(p.issueTypeId)); setSummary(p.summary); setDescription(p.description ?? ''); const { projectId: _p, issueTypeId: _t, summary: _s, ...rest } = p; setExtras(rest) }}
          onClear={() => setExtras({})}
        />

        <Row label="Summary" required>
          <input type="text" className="veqsio-input w-full" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What needs to be done?" required autoFocus />
        </Row>
        <Row label="Reporter" required>
          <input className="veqsio-input w-full" value={me ? `${me.displayName || me.name}` : ''} readOnly aria-readonly="true" />
        </Row>

        {show('attachment') && (
          <Row label="Attachment">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
              className={`rounded-lg border border-dashed px-4 py-4 text-center text-sm text-[var(--text-secondary)] ${dragging ? 'border-[var(--brand-500)] bg-[var(--brand-50)]' : 'border-[var(--surface-4)]'}`}
            >
              <UploadCloud className="w-5 h-5 mx-auto mb-1 text-[var(--text-tertiary)]" aria-hidden="true" />
              Drop files to attach, or <button type="button" className="text-[var(--brand-500)] hover:underline" onClick={() => fileInput.current?.click()}>browse</button>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            </div>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <Paperclip className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{f.name}</span>
                    <span className="text-caption text-[var(--text-tertiary)]">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                    <button type="button" aria-label={`Remove ${f.name}`} className="ml-auto p-0.5 hover:text-[var(--error)]" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}><X className="w-3.5 h-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
          </Row>
        )}

        {show('duedate') && (
          <Row label="Due date"><input type="date" className="veqsio-input max-w-[12rem]" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Row>
        )}

        {show('description') && (
          <Row label="Description">
            <RichTextEditor label="Description" placeholder="Add a description… (Markdown supported, @ to mention)" rows={7} maxLength={100000} value={description} onChange={setDescription} />
          </Row>
        )}

        {show('priority') && priorities.length > 0 && (
          <Row label="Priority">
            <select className="veqsio-input max-w-xs w-full" value={priorityId} onChange={(e) => setPriorityId(e.target.value)}>
              {priorities.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Row>
        )}

        {show('assignee') && (
          <Row label="Assignee">
            <div className="relative flex items-center gap-3">
              <div className="relative flex-1">
                <input
                  className="veqsio-input w-full"
                  value={assignee ? assignee.name : assigneeQuery}
                  placeholder="Automatic"
                  onChange={(e) => { setAssignee(null); setAssigneeQuery(e.target.value) }}
                  aria-label="Assignee"
                />
                {!assignee && assigneeQuery.trim() && (assigneeSearch.data?.length ?? 0) > 0 && (
                  <ul className="absolute z-20 left-0 right-0 top-full mt-1 max-h-48 overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-lg py-1">
                    {assigneeSearch.data!.map((u) => (
                      <li key={u.id}><button type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--surface-1)]" onClick={() => { setAssignee({ id: u.id, name: u.name }); setAssigneeQuery('') }}>{u.name} <span className="text-[var(--text-tertiary)]">({u.key})</span></button></li>
                    ))}
                  </ul>
                )}
              </div>
              {assignee && <button type="button" className="text-sm text-[var(--text-secondary)] hover:underline" onClick={() => setAssignee(null)}>Automatic</button>}
              {me && <button type="button" className="text-sm text-[var(--brand-500)] hover:underline whitespace-nowrap" onClick={() => setAssignee({ id: me.id, name: me.displayName || me.name })}>Assign to me</button>}
            </div>
          </Row>
        )}

        {show('labels') && (
          <Row label="Labels" hint="Separate labels with commas">
            <input className="veqsio-input w-full" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, frontend, urgent" />
          </Row>
        )}

        {show('components') && components.length > 0 && (
          <Row label="Components">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {components.map((c) => (
                <label key={c.id} className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={componentIds.includes(Number(c.id))} onChange={(e) => setComponentIds((cur) => e.target.checked ? [...cur, Number(c.id)] : cur.filter((x) => x !== Number(c.id)))} /> {c.name}</label>
              ))}
            </div>
          </Row>
        )}

        {show('storyPoints') && (
          <Row label="Story points"><input className="veqsio-input max-w-[8rem]" inputMode="decimal" value={storyPoints} onChange={(e) => setStoryPoints(e.target.value)} placeholder="e.g. 5" /></Row>
        )}

        {customFields.map((f) => (
          <Row key={f.key} label={f.name} hint={f.description} required={f.required}>
            <CustomFieldInput field={f} value={custom[f.key] ?? f.defaultValue} onChange={(v) => setCustom((cur) => ({ ...cur, [f.key]: v }))} />
          </Row>
        ))}

        <div className="sticky bottom-0 -mx-6 -mb-4 px-6 py-3 flex items-center justify-end gap-3 border-t border-[var(--surface-3)] bg-[var(--surface-0)]">
          <label className="mr-auto inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={createAnother} onChange={(e) => setCreateAnother(e.target.checked)} /> Create another
          </label>
          <button type="submit" disabled={createIssue.isPending || !summary.trim()} className="veqsio-btn-primary disabled:opacity-50">
            {createIssue.isPending && <Loader2 className="w-4 h-4 animate-spin inline mr-1" />}Create
          </button>
          <button type="button" onClick={onClose} className="veqsio-btn-secondary">Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
