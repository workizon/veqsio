'use client'

import { useState, useCallback } from 'react'
import { Plus, Pencil, Trash2, Archive, ArchiveRestore, Tag, BarChart3 } from 'lucide-react'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import type { Version } from '@/hooks/use-project-admin'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'

interface VersionManagerProps {
  versions: Version[]
  isLoading: boolean
  onCreate: (data: {
    name: string
    description?: string
    startDate?: string
    releaseDate?: string
    archived?: boolean
  }) => void
  onUpdate: (
    id: number,
    data: {
      name?: string
      description?: string
      startDate?: string | null
      releaseDate?: string | null
      archived?: boolean
      released?: boolean
    }
  ) => void
  onDelete: (id: number) => void
  isMutating: boolean
  /** Link to the version report of a version (needs a board in the project); omitted when there is none. */
  reportHref?: (versionId: number) => string | null
}

export function VersionManager({
  versions,
  isLoading,
  onCreate,
  onUpdate,
  onDelete,
  isMutating,
  reportHref,
}: VersionManagerProps) {
  const ms = useMultiSort()
  const [isOpen, setIsOpen] = useState(false)
  const [editing, setEditing] = useState<Version | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [form, setForm] = useState({
    name: '',
    description: '',
    startDate: '',
    releaseDate: '',
    released: false,
    archived: false,
  })

  const openCreate = useCallback(() => {
    setEditing(null)
    setForm({ name: '', description: '', startDate: '', releaseDate: '', released: false, archived: false })
    setIsOpen(true)
  }, [])

  const openEdit = useCallback((ver: Version) => {
    setEditing(ver)
    setForm({
      name: ver.name,
      description: ver.description || '',
      startDate: ver.startDate || '',
      releaseDate: ver.releaseDate || '',
      released: ver.released ?? false,
      archived: ver.archived ?? false,
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
        startDate: form.startDate || undefined,
        releaseDate: form.releaseDate || undefined,
        released: form.released,
        archived: form.archived,
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

  const handleRelease = useCallback(
    (ver: Version) => {
      onUpdate(ver.id, { released: true })
    },
    [onUpdate]
  )

  const handleUnrelease = useCallback(
    (ver: Version) => {
      onUpdate(ver.id, { released: false })
    },
    [onUpdate]
  )

  const handleArchive = useCallback(
    (ver: Version) => {
      onUpdate(ver.id, { archived: true })
    },
    [onUpdate]
  )

  const handleUnarchive = useCallback(
    (ver: Version) => {
      onUpdate(ver.id, { archived: false })
    },
    [onUpdate]
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Versions</h3>
        <button onClick={openCreate} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add version
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 bg-[var(--surface-2)] rounded animate-pulse" />
          ))}
        </div>
      ) : versions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--text-secondary)]">
          <Tag className="w-10 h-10 mb-3 text-[var(--text-tertiary)]" />
          <p className="text-sm">No versions yet.</p>
          <p className="text-xs mt-1">Versions represent milestones or releases in your project.</p>
        </div>
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="veqsio-table-header">
                <SortableTh {...ms.th('name')} className="text-left px-4 py-2">Name</SortableTh>
                <SortableTh {...ms.th('description')} className="text-left px-4 py-2">Description</SortableTh>
                <SortableTh {...ms.th('start')} className="text-left px-4 py-2">Start date</SortableTh>
                <SortableTh {...ms.th('release')} className="text-left px-4 py-2">Release date</SortableTh>
                <SortableTh {...ms.th('status')} className="text-left px-4 py-2">Status</SortableTh>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ms.sort(versions, { name: (v) => v.name, description: (v) => v.description, start: (v) => v.startDate, release: (v) => v.releaseDate, status: (v) => (v.archived ? 2 : v.released ? 1 : 0) }).map((ver) => (
                <tr key={ver.id} className="veqsio-table-row">
                  <td className="px-4 py-3 font-medium text-[var(--text-primary)]">{ver.name}</td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{ver.description || '—'}</td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{ver.startDate || '—'}</td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{ver.releaseDate || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {ver.released ? (
                        <span className="veqsio-badge veqsio-badge-status-done">Released</span>
                      ) : (
                        <span className="veqsio-badge veqsio-badge-status-inprogress">Unreleased</span>
                      )}
                      {ver.archived && (
                        <span className="veqsio-badge veqsio-badge-status-todo">Archived</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {reportHref?.(ver.id) && (
                        <a
                          href={reportHref(ver.id)!}
                          className="p-1.5 hover:bg-[var(--surface-2)] rounded transition-colors"
                          title="Version report"
                          aria-label={`Version report for ${ver.name}`}
                        >
                          <BarChart3 className="w-4 h-4 text-[var(--brand-500)]" />
                        </a>
                      )}
                      {!ver.released ? (
                        <button
                          onClick={() => handleRelease(ver)}
                          className="p-1.5 hover:bg-[var(--surface-2)] rounded transition-colors"
                          title="Release"
                        >
                          <Archive className="w-4 h-4 text-[var(--success)]" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleUnrelease(ver)}
                          className="p-1.5 hover:bg-[var(--surface-2)] rounded transition-colors"
                          title="Unrelease"
                        >
                          <ArchiveRestore className="w-4 h-4 text-[var(--text-secondary)]" />
                        </button>
                      )}
                      {!ver.archived ? (
                        <button
                          onClick={() => handleArchive(ver)}
                          className="p-1.5 hover:bg-[var(--surface-2)] rounded transition-colors"
                          title="Archive"
                        >
                          <Archive className="w-4 h-4 text-[var(--text-tertiary)]" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleUnarchive(ver)}
                          className="p-1.5 hover:bg-[var(--surface-2)] rounded transition-colors"
                          title="Unarchive"
                        >
                          <ArchiveRestore className="w-4 h-4 text-[var(--text-tertiary)]" />
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(ver)}
                        className="p-1.5 hover:bg-[var(--surface-2)] rounded transition-colors"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4 text-[var(--text-secondary)]" />
                      </button>
                      <button
                        onClick={() => setConfirmDelete(ver.id)}
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
        title={editing ? 'Edit version' : 'Create version'}
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
              placeholder="Version name"
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
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Start date</label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                className="veqsio-input w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Release date</label>
              <input
                type="date"
                value={form.releaseDate}
                onChange={(e) => setForm((f) => ({ ...f, releaseDate: e.target.value }))}
                className="veqsio-input w-full"
              />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={form.released}
                onChange={(e) => setForm((f) => ({ ...f, released: e.target.checked }))}
                className="w-4 h-4"
              />
              Released
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={form.archived}
                onChange={(e) => setForm((f) => ({ ...f, archived: e.target.checked }))}
                className="w-4 h-4"
              />
              Archived
            </label>
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={() => setIsOpen(false)} className="veqsio-btn-secondary">
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
        title="Delete version"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Are you sure you want to delete this version? This action cannot be undone.
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
