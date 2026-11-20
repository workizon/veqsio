'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import {
  Plus,
  Trash2,
  ChevronRight,
  Save,
  Workflow,
  FolderKanban,
  Check,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import {
  useWorkflowSchemes,
  useCreateWorkflowScheme,
  useUpdateWorkflowScheme,
  useDeleteWorkflowScheme,
  useAssignWorkflowScheme,
} from '@/hooks/use-admin'
import { useWorkflows } from '@/hooks/use-admin'
import { useIssueTypes } from '@/hooks/use-admin'
import { useProjects } from '@/hooks/use-project-admin'
import type { WorkflowScheme, WorkflowSchemeItem } from '@/hooks/use-admin'
import { confirmDialog } from '@/components/dialogs'

export function WorkflowSchemeEditor() {
  const { tr } = useI18n();

  const [createOpen, setCreateOpen] = useState(false)
  const [editingScheme, setEditingScheme] = useState<WorkflowScheme | null>(null)
  const [assignScheme, setAssignScheme] = useState<WorkflowScheme | null>(null)

  const { data, isLoading } = useWorkflowSchemes()
  const createScheme = useCreateWorkflowScheme()
  const deleteScheme = useDeleteWorkflowScheme()

  const schemes = data?.schemes || []

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await createScheme.mutateAsync({
        name: fd.get('name') as string,
        description: (fd.get('description') as string) || undefined,
      })
      toast(tr('Workflow scheme created'), 'success')
      setCreateOpen(false)
      e.currentTarget.reset()
    } catch (err: any) {
      toast(err.message || tr('Failed to create scheme'), 'error')
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!(await confirmDialog(tr('Delete workflow scheme "{name}"?', { name })))) return
    try {
      await deleteScheme.mutateAsync(id)
      toast(tr('Scheme deleted'), 'success')
    } catch (err: any) {
      toast(err.message || tr('Failed to delete scheme'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Workflow schemes')}</h2>
          <Link href="/admin/workflows" className="text-sm text-[var(--brand-600)] hover:underline">{tr('Open the workflow designer to create or edit workflows')}</Link>
        </div>
        <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          {tr('Create Scheme')} </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : schemes.length === 0 ? (
        <EmptyState
          icon="folder"
          title={tr('No workflow schemes found')}
          description={tr('Create a scheme to assign workflows to issue types.')}
          action={
            <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('Create Scheme')} </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {schemes.map((s) => (
            <div key={s.id} className="veqsio-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
                    <Workflow className="w-5 h-5 text-[var(--text-secondary)]" />
                  </div>
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{s.name}</div>
                    {s.description && (
                      <div className="text-xs text-[var(--text-tertiary)]">{s.description}</div>
                    )}
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                      {s.items.length !== 1 ? tr('{n} mappings', { n: s.items.length }) : tr('{n} mapping', { n: s.items.length })}
                    </div>
                    {s.projects.length > 0 && (
                      <div className="text-xs text-[var(--text-tertiary)] mt-0.5 flex items-center gap-1">
                        <FolderKanban className="w-3 h-3" />
                        {s.projects.map(p => p.name).join(', ')}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); setAssignScheme(s) }}
                    className="veqsio-btn-secondary text-sm"
                  >
                    {tr('Assign to Project')} </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingScheme(s) }}
                    className="veqsio-btn-ghost p-1.5"
                  >
                    <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(s.id, s.name) }}
                    className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={tr('Create workflow scheme')}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
            <input name="name" type="text" required className="veqsio-input w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Description')}</label>
            <input name="description" type="text" className="veqsio-input w-full" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="veqsio-btn-secondary">{tr('Cancel')}</button>
            <button type="submit" disabled={createScheme.isPending} className="veqsio-btn-primary">
              {createScheme.isPending ? tr('Creating...') : tr('Create')}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!editingScheme} onClose={() => setEditingScheme(null)} title={editingScheme?.name || tr('Edit Scheme')} size="lg">
        {editingScheme && <SchemeEditPanel scheme={editingScheme} onClose={() => setEditingScheme(null)} />}
      </Modal>

      <Modal isOpen={!!assignScheme} onClose={() => setAssignScheme(null)} title={tr('Assign to Project')}>
        {assignScheme && <AssignPanel scheme={assignScheme} onClose={() => setAssignScheme(null)} />}
      </Modal>
    </div>
  )
}

function SchemeEditPanel({ scheme, onClose }: { scheme: WorkflowScheme; onClose: () => void }) {
  const { tr } = useI18n();

  const updateScheme = useUpdateWorkflowScheme()
  const { data: workflowsData } = useWorkflows()
  const { data: typesData } = useIssueTypes()

  const workflows = workflowsData?.values || []
  const allTypes = typesData || []

  const [name, setName] = useState(scheme.name)
  const [description, setDescription] = useState(scheme.description || '')
  const [items, setItems] = useState<{ issueTypeId: number; workflowId: number }[]>(
    scheme.items.map(i => ({ issueTypeId: i.issueTypeId, workflowId: i.workflowId }))
  )

  async function handleSave() {
    try {
      await updateScheme.mutateAsync({
        id: scheme.id,
        name,
        description: description || undefined,
        items,
      })
      toast(tr('Scheme updated'), 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || tr('Failed to update scheme'), 'error')
    }
  }

  function addMapping() {
    const unusedType = allTypes.find(t => !items.some(i => i.issueTypeId === t.id))
    if (!unusedType || workflows.length === 0) return
    setItems(prev => [...prev, { issueTypeId: unusedType.id, workflowId: Number(workflows[0].id) }])
  }

  function removeMapping(idx: number) {
    setItems(prev => prev.filter((_, i) => i !== idx))
  }

  function updateMapping(idx: number, key: 'issueTypeId' | 'workflowId', val: number) {
    setItems(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [key]: val }
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
          <input value={name} onChange={e => setName(e.target.value)} className="veqsio-input w-full" />
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Description')}</label>
          <input value={description} onChange={e => setDescription(e.target.value)} className="veqsio-input w-full" />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-[var(--text-secondary)]">{items.length !== 1 ? tr('{n} mappings', { n: items.length }) : tr('{n} mapping', { n: items.length })} <Link href="/admin/workflows" className="ml-2 text-[var(--brand-600)] hover:underline">{tr('Edit workflows')}</Link></div>
        <button onClick={addMapping} className="veqsio-btn-secondary flex items-center gap-1.5 text-sm">
          <Plus className="w-4 h-4" />
          {tr('Add Mapping')} </button>
      </div>

      <div className="border border-[var(--surface-3)] rounded-lg divide-y divide-[var(--surface-3)] max-h-72 overflow-auto">
        {items.length === 0 && (
          <div className="p-4 text-sm text-[var(--text-tertiary)] text-center">{tr('No mappings configured')}</div>
        )}
        {items.map((item, idx) => (
          <div key={idx} className="flex items-center gap-2 px-3 py-2">
            <select
              value={item.issueTypeId}
              onChange={e => updateMapping(idx, 'issueTypeId', Number(e.target.value))}
              className="veqsio-input flex-1"
            >
              {allTypes.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <span className="text-xs text-[var(--text-tertiary)]">→</span>
            <select
              value={item.workflowId}
              onChange={e => updateMapping(idx, 'workflowId', Number(e.target.value))}
              className="veqsio-input flex-1"
            >
              {workflows.map(w => (
                <option key={w.id} value={Number(w.id)}>{w.name}</option>
              ))}
            </select>
            <button
              onClick={() => removeMapping(idx)}
              className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
        <button onClick={handleSave} disabled={updateScheme.isPending} className="veqsio-btn-primary flex items-center gap-1.5">
          <Save className="w-4 h-4" />
          {updateScheme.isPending ? tr('Saving...') : tr('Save')}
        </button>
      </div>
    </div>
  )
}

function AssignPanel({ scheme, onClose }: { scheme: WorkflowScheme; onClose: () => void }) {
  const { tr } = useI18n();

  const { data: projectsData } = useProjects()
  const assign = useAssignWorkflowScheme()
  const projects = projectsData || []

  async function handleAssign(projectId: number) {
    try {
      await assign.mutateAsync({ schemeId: scheme.id, projectId })
      toast(tr('Scheme assigned to project'), 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || tr('Failed to assign scheme'), 'error')
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-secondary)]">{tr('Assign "')}{scheme.name}{tr('" to a project:')}</p>
      <div className="border border-[var(--surface-3)] rounded-lg divide-y divide-[var(--surface-3)] max-h-72 overflow-auto">
        {projects.map(p => (
          <div key={p.id} className="flex items-center justify-between px-3 py-2">
            <span className="text-sm text-[var(--text-primary)]">{p.name}</span>
            <button
              onClick={() => handleAssign(p.id)}
              disabled={assign.isPending}
              className="veqsio-btn-secondary text-sm flex items-center gap-1"
            >
              <Check className="w-3 h-3" />
              {tr('Assign')} </button>
          </div>
        ))}
      </div>
      <div className="flex justify-end pt-2">
        <button onClick={onClose} className="veqsio-btn-secondary">{tr('Close')}</button>
      </div>
    </div>
  )
}
