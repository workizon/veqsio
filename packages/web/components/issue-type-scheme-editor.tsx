'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import {
  Plus,
  Trash2,
  ChevronRight,
  Save,
  ArrowUp,
  ArrowDown,
  Tag,
  FolderKanban,
  Check,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import {
  useIssueTypeSchemes,
  useCreateIssueTypeScheme,
  useUpdateIssueTypeScheme,
  useDeleteIssueTypeScheme,
  useAssignIssueTypeScheme,
} from '@/hooks/use-admin'
import { useIssueTypes } from '@/hooks/use-admin'
import { useProjects } from '@/hooks/use-project-admin'
import type { IssueTypeScheme } from '@/hooks/use-admin'
import { confirmDialog } from '@/components/dialogs'

export function IssueTypeSchemeEditor() {
  const { tr } = useI18n();

  const [createOpen, setCreateOpen] = useState(false)
  const [editingScheme, setEditingScheme] = useState<IssueTypeScheme | null>(null)
  const [assignScheme, setAssignScheme] = useState<IssueTypeScheme | null>(null)

  const { data, isLoading } = useIssueTypeSchemes()
  const createScheme = useCreateIssueTypeScheme()
  const deleteScheme = useDeleteIssueTypeScheme()

  const schemes = data?.schemes || []

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await createScheme.mutateAsync({
        name: fd.get('name') as string,
        defaultIssueTypeId: Number(fd.get('defaultIssueTypeId')) || undefined,
        issueTypeIds: (fd.getAll('issueTypeIds') as string[]).map(Number),
      })
      toast(tr('Issue type scheme created'), 'success')
      setCreateOpen(false)
      e.currentTarget.reset()
    } catch (err: any) {
      toast(err.message || 'Failed to create scheme', 'error')
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!(await confirmDialog(`Delete issue type scheme "${name}"?`))) return
    try {
      await deleteScheme.mutateAsync(id)
      toast(tr('Scheme deleted'), 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to delete scheme', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Issue type schemes')}</h2>
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
          title={tr('No issue type schemes found')}
          description={tr('Create a scheme to manage issue types for projects.')}
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
                    <Tag className="w-5 h-5 text-[var(--text-secondary)]" />
                  </div>
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{s.name}</div>
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                      {s.issueTypes.length} {tr('issue type')}{s.issueTypes.length !== 1 ? 's' : ''}
                      {s.defaultIssueTypeId ? ` · Default: ${s.issueTypes.find(t => t.id === s.defaultIssueTypeId)?.name || s.defaultIssueTypeId}` : ''}
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
                    onClick={(e) => {
                      e.stopPropagation()
                      setAssignScheme(s)
                    }}
                    className="veqsio-btn-secondary text-sm"
                  >
                    {tr('Assign to Project')} </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingScheme(s)
                    }}
                    className="veqsio-btn-ghost p-1.5"
                  >
                    <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(s.id, s.name)
                    }}
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

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={tr('Create issue type scheme')}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
            <input name="name" type="text" required className="veqsio-input w-full" />
          </div>
          <IssueTypeSelector />
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="veqsio-btn-secondary">
              {tr('Cancel')} </button>
            <button type="submit" disabled={createScheme.isPending} className="veqsio-btn-primary">
              {createScheme.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!editingScheme} onClose={() => setEditingScheme(null)} title={editingScheme?.name || 'Edit Scheme'} size="lg">
        {editingScheme && (
          <SchemeEditPanel scheme={editingScheme} onClose={() => setEditingScheme(null)} />
        )}
      </Modal>

      <Modal isOpen={!!assignScheme} onClose={() => setAssignScheme(null)} title={tr('Assign to Project')}>
        {assignScheme && (
          <AssignPanel scheme={assignScheme} onClose={() => setAssignScheme(null)} />
        )}
      </Modal>
    </div>
  )
}

function IssueTypeSelector() {
  const { tr } = useI18n();

  const { data } = useIssueTypes()
  const types = data || []

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Default issue type')}</label>
        <select name="defaultIssueTypeId" className="veqsio-input w-full">
          <option value="">{tr('Select default...')}</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Issue types')}</label>
        <div className="border border-[var(--surface-3)] rounded-lg p-3 space-y-2 max-h-60 overflow-auto">
          {types.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm text-[var(--text-primary)] cursor-pointer">
              <input type="checkbox" name="issueTypeIds" value={t.id} className="w-4 h-4 rounded border-[var(--surface-4)] text-[var(--brand-500)]" />
              {t.name}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

function SchemeEditPanel({ scheme, onClose }: { scheme: IssueTypeScheme; onClose: () => void }) {
  const { tr } = useI18n();

  const { data: typesData } = useIssueTypes()
  const updateScheme = useUpdateIssueTypeScheme()

  const allTypes = typesData || []
  const [name, setName] = useState(scheme.name)
  const [defaultId, setDefaultId] = useState<number | ''>(scheme.defaultIssueTypeId ?? '')
  const [selectedIds, setSelectedIds] = useState<number[]>(scheme.issueTypes.map(t => t.id))

  async function handleSave() {
    try {
      await updateScheme.mutateAsync({
        id: scheme.id,
        name,
        defaultIssueTypeId: Number(defaultId) || undefined,
        issueTypeIds: selectedIds,
      })
      toast(tr('Scheme updated'), 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || 'Failed to update scheme', 'error')
    }
  }

  function toggleType(id: number) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  function move(id: number, dir: -1 | 1) {
    const idx = selectedIds.indexOf(id)
    if (idx < 0) return
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= selectedIds.length) return
    const next = [...selectedIds]
    ;[next[idx], next[newIdx]] = [next[newIdx], next[idx]]
    setSelectedIds(next)
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
        <input value={name} onChange={e => setName(e.target.value)} className="veqsio-input w-full" />
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Default issue type')}</label>
        <select value={defaultId} onChange={e => setDefaultId(Number(e.target.value) || '')} className="veqsio-input w-full">
          <option value="">{tr('None')}</option>
          {selectedIds.map(id => {
            const t = allTypes.find(x => x.id === id)
            return t ? <option key={id} value={id}>{t.name}</option> : null
          })}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">{tr('Issue Types (reorder enabled)')}</label>
        <div className="border border-[var(--surface-3)] rounded-lg divide-y divide-[var(--surface-3)]">
          {allTypes.map(t => {
            const checked = selectedIds.includes(t.id)
            const idx = selectedIds.indexOf(t.id)
            return (
              <div key={t.id} className="flex items-center justify-between px-3 py-2">
                <label className="flex items-center gap-2 text-sm text-[var(--text-primary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleType(t.id)}
                    className="w-4 h-4 rounded border-[var(--surface-4)] text-[var(--brand-500)]"
                  />
                  {t.name}
                </label>
                {checked && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => move(t.id, -1)} disabled={idx === 0} className="veqsio-btn-ghost p-1 disabled:opacity-30">
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button onClick={() => move(t.id, 1)} disabled={idx === selectedIds.length - 1} className="veqsio-btn-ghost p-1 disabled:opacity-30">
                      <ArrowDown className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
        <button onClick={handleSave} disabled={updateScheme.isPending} className="veqsio-btn-primary flex items-center gap-1.5">
          <Save className="w-4 h-4" />
          {updateScheme.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function AssignPanel({ scheme, onClose }: { scheme: IssueTypeScheme; onClose: () => void }) {
  const { tr } = useI18n();

  const { data: projectsData } = useProjects()
  const assign = useAssignIssueTypeScheme()

  const projects = projectsData || []

  async function handleAssign(projectId: number) {
    try {
      await assign.mutateAsync({ schemeId: scheme.id, projectId })
      toast(tr('Scheme assigned to project'), 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || 'Failed to assign scheme', 'error')
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
