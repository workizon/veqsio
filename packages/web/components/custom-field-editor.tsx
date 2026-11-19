'use client'

import { useState } from 'react'
import {
  Plus,
  Trash2,
  ChevronRight,
  Save,
  Puzzle,
  List,
  X,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import {
  useAdminCustomFields,
  useCreateCustomField,
  useUpdateCustomField,
  useDeleteCustomField,
  useAddCustomFieldContext,
  useRemoveCustomFieldContext,
  useAddCustomFieldOption,
  useRemoveCustomFieldOption,
  useUpdateCustomFieldOption,
} from '@/hooks/use-admin'
import { useProjects } from '@/hooks/use-project-admin'
import { useIssueTypes } from '@/hooks/use-admin'
import type { AdminCustomField } from '@/hooks/use-admin'
import { confirmDialog } from '@/components/dialogs'

const FIELD_TYPES = [
  { key: 'text', label: 'Text Field (single line)' },
  { key: 'textarea', label: 'Text Field (multi-line)' },
  { key: 'number', label: 'Number Field' },
  { key: 'date', label: 'Date Picker' },
  { key: 'datetime', label: 'Date Time Picker' },
  { key: 'select', label: 'Select List (single choice)' },
  { key: 'multiselect', label: 'Select List (multiple choices)' },
  { key: 'checkbox', label: 'Checkboxes' },
  { key: 'radio', label: 'Radio Buttons' },
  { key: 'userpicker', label: 'User Picker (single user)' },
  { key: 'multiuserpicker', label: 'User Picker (multiple users)' },
  { key: 'url', label: 'URL Field' },
  { key: 'labels', label: 'Labels' },
]

export function CustomFieldEditor() {
  const [createOpen, setCreateOpen] = useState(false)
  const [editingField, setEditingField] = useState<AdminCustomField | null>(null)

  const { data, isLoading } = useAdminCustomFields()
  const createField = useCreateCustomField()
  const deleteField = useDeleteCustomField()

  const fields = data?.customFields || []

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await createField.mutateAsync({
        name: fd.get('name') as string,
        fieldType: fd.get('fieldType') as string,
        description: (fd.get('description') as string) || undefined,
        isGlobal: fd.get('isGlobal') === 'on',
      })
      toast('Custom field created', 'success')
      setCreateOpen(false)
      e.currentTarget.reset()
    } catch (err: any) {
      toast(err.message || 'Failed to create custom field', 'error')
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!(await confirmDialog(`Delete custom field "${name}"?`))) return
    try {
      await deleteField.mutateAsync(id)
      toast('Custom field deleted', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to delete custom field', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">Custom fields</h2>
        <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Create Field
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : fields.length === 0 ? (
        <EmptyState
          icon="folder"
          title="No custom fields found"
          description="Create custom fields to capture additional issue data."
          action={
            <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Create Field
            </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.id} className="veqsio-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
                    <Puzzle className="w-5 h-5 text-[var(--text-secondary)]" />
                  </div>
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{f.name}</div>
                    <div className="text-xs text-[var(--text-tertiary)]">
                      Type: {FIELD_TYPES.find(t => t.key === f.fieldType)?.label || f.fieldType}
                      {f.isGlobal ? ' · Global' : ` · ${f.contexts.length} context${f.contexts.length !== 1 ? 's' : ''}`}
                      {['select', 'multiselect', 'checkbox', 'radio'].includes(f.fieldType) &&
                        ` · ${f.options.length} option${f.options.length !== 1 ? 's' : ''}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingField(f) }}
                    className="veqsio-btn-ghost p-1.5"
                  >
                    <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(f.id, f.name) }}
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

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Create custom field">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
            <input name="name" type="text" required className="veqsio-input w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Type</label>
            <select name="fieldType" required className="veqsio-input w-full">
              <option value="">Select type...</option>
              {FIELD_TYPES.map(t => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Description</label>
            <input name="description" type="text" className="veqsio-input w-full" />
          </div>
          <div className="flex items-center gap-2">
            <input id="isGlobal" name="isGlobal" type="checkbox" defaultChecked className="w-4 h-4 rounded border-[var(--surface-4)] text-[var(--brand-500)]" />
            <label htmlFor="isGlobal" className="text-sm text-[var(--text-secondary)]">Global (available in all projects)</label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="veqsio-btn-secondary">Cancel</button>
            <button type="submit" disabled={createField.isPending} className="veqsio-btn-primary">
              {createField.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!editingField} onClose={() => setEditingField(null)} title={editingField?.name || 'Edit Field'} size="lg">
        {editingField && <FieldEditPanel field={editingField} onClose={() => setEditingField(null)} />}
      </Modal>
    </div>
  )
}

function FieldEditPanel({ field, onClose }: { field: AdminCustomField; onClose: () => void }) {
  const updateField = useUpdateCustomField()
  const addContext = useAddCustomFieldContext()
  const removeContext = useRemoveCustomFieldContext()
  const addOption = useAddCustomFieldOption()
  const removeOption = useRemoveCustomFieldOption()
  const updateOption = useUpdateCustomFieldOption()
  const { data: projectsData } = useProjects()
  const { data: typesData } = useIssueTypes()

  const projects = projectsData || []
  const allTypes = typesData || []

  const [name, setName] = useState(field.name)
  const [description, setDescription] = useState(field.description || '')

  async function handleSave() {
    try {
      await updateField.mutateAsync({ id: field.id, name, description: description || undefined })
      toast('Field updated', 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || 'Failed to update field', 'error')
    }
  }

  async function handleAddContext(projectId?: number, issueTypeId?: number) {
    try {
      await addContext.mutateAsync({ fieldId: field.id, projectId, issueTypeId })
      toast('Context added', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to add context', 'error')
    }
  }

  async function handleRemoveContext(contextId: number) {
    try {
      await removeContext.mutateAsync({ fieldId: field.id, contextId })
      toast('Context removed', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to remove context', 'error')
    }
  }

  const [optionValue, setOptionValue] = useState('')
  const [optionContextId, setOptionContextId] = useState<number | ''>(field.contexts[0]?.id || '')

  async function handleAddOption() {
    if (!optionValue.trim() || !optionContextId) return
    try {
      await addOption.mutateAsync({ fieldId: field.id, contextId: Number(optionContextId), value: optionValue.trim() })
      toast('Option added', 'success')
      setOptionValue('')
    } catch (err: any) {
      toast(err.message || 'Failed to add option', 'error')
    }
  }

  async function handleRemoveOption(optionId: number) {
    try {
      await removeOption.mutateAsync({ fieldId: field.id, optionId })
      toast('Option removed', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to remove option', 'error')
    }
  }

  const hasOptions = ['select', 'multiselect', 'checkbox', 'radio'].includes(field.fieldType)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} className="veqsio-input w-full" />
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Description</label>
          <input value={description} onChange={e => setDescription(e.target.value)} className="veqsio-input w-full" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="veqsio-btn-secondary">Cancel</button>
        <button onClick={handleSave} disabled={updateField.isPending} className="veqsio-btn-primary flex items-center gap-1.5">
          <Save className="w-4 h-4" />
          Save
        </button>
      </div>

      <hr className="border-[var(--surface-3)]" />

      {!field.isGlobal && (
        <div className="space-y-3">
          <h3 className="text-heading-2 text-[var(--text-primary)]">Contexts</h3>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <select
              onChange={e => {
                const val = e.target.value
                if (val) {
                  const [type, id] = val.split(':')
                  handleAddContext(type === 'project' ? Number(id) : undefined, type === 'issueType' ? Number(id) : undefined)
                }
                e.target.value = ''
              }}
              className="veqsio-input flex-1 w-full"
            >
              <option value="">Add context...</option>
              <optgroup label="Projects">
                {projects.map(p => (
                  <option key={`project:${p.id}`} value={`project:${p.id}`}>Project: {p.name}</option>
                ))}
              </optgroup>
              <optgroup label="Issue types">
                {allTypes.map(t => (
                  <option key={`issueType:${t.id}`} value={`issueType:${t.id}`}>Issue Type: {t.name}</option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className="border border-[var(--surface-3)] rounded-lg divide-y divide-[var(--surface-3)]">
            {field.contexts.length === 0 && (
              <div className="p-3 text-sm text-[var(--text-tertiary)] text-center">No contexts defined</div>
            )}
            {field.contexts.map(ctx => (
              <div key={ctx.id} className="flex items-center justify-between px-3 py-2">
                <span className="text-sm text-[var(--text-primary)]">
                  {ctx.projectId ? `Project: ${projects.find(p => p.id === ctx.projectId)?.name || ctx.projectId}` : ''}
                  {ctx.projectId && ctx.issueTypeId ? ' · ' : ''}
                  {ctx.issueTypeId ? `Issue Type: ${allTypes.find(t => t.id === ctx.issueTypeId)?.name || ctx.issueTypeId}` : 'Global'}
                </span>
                <button
                  onClick={() => handleRemoveContext(ctx.id)}
                  className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasOptions && (
        <div className="space-y-3">
          <h3 className="text-heading-2 text-[var(--text-primary)] flex items-center gap-2">
            <List className="w-4 h-4" /> Options
          </h3>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <select
              value={optionContextId}
              onChange={e => setOptionContextId(Number(e.target.value) || '')}
              className="veqsio-input"
            >
              <option value="">Select context...</option>
              {(field.isGlobal ? [{ id: 0, label: 'Global' }] : field.contexts).map(ctx => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.id === 0 ? 'Global' : `Context ${ctx.id}`}
                </option>
              ))}
            </select>
            <input
              value={optionValue}
              onChange={e => setOptionValue(e.target.value)}
              placeholder="Option value..."
              className="veqsio-input flex-1 w-full"
              onKeyDown={e => { if (e.key === 'Enter') handleAddOption() }}
            />
            <button
              onClick={handleAddOption}
              disabled={!optionValue.trim() || !optionContextId || addOption.isPending}
              className="veqsio-btn-secondary flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
          <div className="border border-[var(--surface-3)] rounded-lg divide-y divide-[var(--surface-3)]">
            {field.options.length === 0 && (
              <div className="p-3 text-sm text-[var(--text-tertiary)] text-center">No options defined</div>
            )}
            {field.options.map(opt => (
              <div key={opt.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${opt.archived ? 'opacity-60' : ''}`}>
                <input
                  type="color" aria-label={`Colour of ${opt.value}`} className="h-7 w-7 cursor-pointer rounded border border-[var(--surface-3)] bg-transparent p-0"
                  value={opt.color ?? '#9ca3af'}
                  onChange={(e) => updateOption.mutate({ fieldId: field.id, optionId: opt.id, patch: { color: e.target.value } })}
                />
                <span className="text-sm text-[var(--text-primary)]">{opt.value}{opt.archived && <span className="ml-2 text-caption text-[var(--text-tertiary)]">archived</span>}</span>
                <input
                  aria-label={`Description of ${opt.value}`} placeholder="Description" maxLength={500}
                  className="veqsio-input !py-1 flex-1 min-w-[10rem] text-sm" defaultValue={opt.description ?? ''}
                  onBlur={(e) => { if ((e.target.value || null) !== (opt.description ?? null)) updateOption.mutate({ fieldId: field.id, optionId: opt.id, patch: { description: e.target.value || null } }) }}
                />
                <button type="button" onClick={() => updateOption.mutate({ fieldId: field.id, optionId: opt.id, patch: { archived: !opt.archived } })} className="veqsio-btn-ghost text-caption px-2">
                  {opt.archived ? 'Restore' : 'Archive'}
                </button>
                <button
                  onClick={() => handleRemoveOption(opt.id)}
                  className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                  title="Delete (archived instead when issues use it)"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
