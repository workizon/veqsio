'use client'

import { useState, useCallback } from 'react'
import { Plus, Pencil, Trash2, Package } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Select } from '@/components/select'
import { toast } from '@/components/toast'
import type { Component } from '@/hooks/use-project-admin'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'

interface ComponentManagerProps {
  components: Component[]
  users: { id: number; displayName: string }[]
  isLoading: boolean
  onCreate: (data: { name: string; description?: string; leadId?: number }) => void
  onUpdate: (id: number, data: { name?: string; description?: string; leadId?: number }) => void
  onDelete: (id: number) => void
  isMutating: boolean
}

export function ComponentManager({
  components,
  users,
  isLoading,
  onCreate,
  onUpdate,
  onDelete,
  isMutating,
}: ComponentManagerProps) {
  const ms = useMultiSort()
  const [isOpen, setIsOpen] = useState(false)
  const [editing, setEditing] = useState<Component | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [form, setForm] = useState({ name: '', description: '', leadId: '' })

  const openCreate = useCallback(() => {
    setEditing(null)
    setForm({ name: '', description: '', leadId: '' })
    setIsOpen(true)
  }, [])

  const openEdit = useCallback((comp: Component) => {
    setEditing(comp)
    setForm({
      name: comp.name,
      description: comp.description || '',
      leadId: comp.lead?.id ? String(comp.lead.id) : '',
    })
    setIsOpen(true)
  }, [])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      if (!form.name.trim()) {
        toast('Name is required', 'error')
        return
      }
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        leadId: form.leadId ? Number(form.leadId) : undefined,
      }
      if (editing) {
        onUpdate(editing.id, payload)
      } else {
        onCreate(payload)
      }
      setIsOpen(false)
    },
    [form, editing, onCreate, onUpdate]
  )

  const handleDelete = useCallback(
    (id: number) => {
      onDelete(id)
      setConfirmDelete(null)
    },
    [onDelete]
  )

  const userOptions = [
    { value: '', label: 'No lead' },
    ...users.map((u) => ({ value: String(u.id), label: u.displayName })),
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Components</h3>
        <button onClick={openCreate} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add component
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 bg-[var(--surface-2)] rounded animate-pulse" />
          ))}
        </div>
      ) : components.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--text-secondary)]">
          <Package className="w-10 h-10 mb-3 text-[var(--text-tertiary)]" />
          <p className="text-sm">No components yet.</p>
          <p className="text-xs mt-1">Components help you group issues within a project.</p>
        </div>
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="veqsio-table-header">
                <SortableTh {...ms.th('name')} className="text-left px-4 py-2">Name</SortableTh>
                <SortableTh {...ms.th('description')} className="text-left px-4 py-2">Description</SortableTh>
                <SortableTh {...ms.th('lead')} className="text-left px-4 py-2">Lead</SortableTh>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ms.sort(components, { name: (c) => c.name, description: (c) => c.description, lead: (c) => c.lead?.displayName }).map((comp) => (
                <tr key={comp.id} className="veqsio-table-row">
                  <td className="px-4 py-3 font-medium text-[var(--text-primary)]">{comp.name}</td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{comp.description || '—'}</td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{comp.lead?.displayName || '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openEdit(comp)}
                        className="p-1.5 hover:bg-[var(--surface-2)] rounded transition-colors"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4 text-[var(--text-secondary)]" />
                      </button>
                      <button
                        onClick={() => setConfirmDelete(comp.id)}
                        className="p-1.5 hover:bg-[var(--surface-2)] rounded transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4 text-[var(--error)]" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit Modal */}
      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={editing ? 'Edit component' : 'Create component'}
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="veqsio-input w-full"
              placeholder="Component name"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="veqsio-input w-full min-h-[80px] resize-y"
              placeholder="Short description"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Component lead</label>
            <Select
              value={form.leadId}
              options={userOptions}
              onChange={(v) => setForm((f) => ({ ...f, leadId: v }))}
              placeholder="Select a lead"
            />
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="veqsio-btn-secondary"
            >
              Cancel
            </button>
            <button type="submit" disabled={isMutating} className="veqsio-btn-primary">
              {isMutating ? 'Saving...' : editing ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      <Modal
        isOpen={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete component"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Are you sure you want to delete this component? This action cannot be undone.
          </p>
          <div className="flex items-center justify-end gap-3">
            <button onClick={() => setConfirmDelete(null)} className="veqsio-btn-secondary">
              Cancel
            </button>
            <button
              onClick={() => confirmDelete !== null && handleDelete(confirmDelete)}
              disabled={isMutating}
              className="veqsio-btn-primary bg-[var(--error)] hover:bg-[var(--error)]/90"
            >
              {isMutating ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
