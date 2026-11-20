'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import {
  Plus,
  Trash2,
  Save,
  Users,
  UserPlus,
  X,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import {
  useAdminProjectRoles,
  useCreateProjectRole,
  useUpdateProjectRole,
  useDeleteProjectRole,
  useAddProjectRoleActor,
  useRemoveProjectRoleActor,
} from '@/hooks/use-admin'
import { useProjects } from '@/hooks/use-project-admin'
import { useUsers } from '@/hooks/use-admin'
import { useGroups } from '@/hooks/use-admin'
import type { AdminProjectRole, ProjectRoleActor } from '@/hooks/use-admin'
import { confirmDialog } from '@/components/dialogs'

export function ProjectRoleEditor() {
  const { tr } = useI18n();

  const [createOpen, setCreateOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<AdminProjectRole | null>(null)
  const [manageRole, setManageRole] = useState<AdminProjectRole | null>(null)

  const { data, isLoading } = useAdminProjectRoles()
  const createRole = useCreateProjectRole()
  const deleteRole = useDeleteProjectRole()

  const roles = data?.roles || []

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await createRole.mutateAsync({
        name: fd.get('name') as string,
        description: (fd.get('description') as string) || undefined,
      })
      toast(tr('Role created'), 'success')
      setCreateOpen(false)
      e.currentTarget.reset()
    } catch (err: any) {
      toast(err.message || tr('Failed to create role'), 'error')
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!(await confirmDialog(tr('Delete role "{name}"?', { name })))) return
    try {
      await deleteRole.mutateAsync(id)
      toast(tr('Role deleted'), 'success')
    } catch (err: any) {
      toast(err.message || tr('Failed to delete role'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Project roles')}</h2>
        <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          {tr('Create Role')} </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : roles.length === 0 ? (
        <EmptyState
          icon="folder"
          title={tr('No project roles found')}
          description={tr('Create roles to manage project membership and permissions.')}
          action={
            <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('Create Role')} </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {roles.map((r) => (
            <div key={r.id} className="veqsio-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
                    <Users className="w-5 h-5 text-[var(--text-secondary)]" />
                  </div>
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{r.name}</div>
                    {r.description && <div className="text-xs text-[var(--text-tertiary)]">{r.description}</div>}
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                      {r.actors.length === 1 ? tr('{n} actor', { n: 1 }) : tr('{n} actors', { n: r.actors.length })}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); setManageRole(r) }}
                    className="veqsio-btn-secondary text-sm flex items-center gap-1"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    {tr('Manage Actors')} </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingRole(r) }}
                    className="veqsio-btn-ghost p-1.5"
                  >
                    <Save className="w-4 h-4 text-[var(--text-tertiary)]" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(r.id, r.name) }}
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

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={tr('Create project role')}>
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
            <button type="submit" disabled={createRole.isPending} className="veqsio-btn-primary">
              {createRole.isPending ? tr('Creating...') : tr('Create')}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!editingRole} onClose={() => setEditingRole(null)} title={tr('Edit role')}>
        {editingRole && <RoleEditPanel role={editingRole} onClose={() => setEditingRole(null)} />}
      </Modal>

      <Modal isOpen={!!manageRole} onClose={() => setManageRole(null)} title={`Manage Actors: ${manageRole?.name}`} size="lg">
        {manageRole && <ManageActorsPanel role={manageRole} onClose={() => setManageRole(null)} />}
      </Modal>
    </div>
  )
}

function RoleEditPanel({ role, onClose }: { role: AdminProjectRole; onClose: () => void }) {
  const { tr } = useI18n();

  const updateRole = useUpdateProjectRole()
  const [name, setName] = useState(role.name)
  const [description, setDescription] = useState(role.description || '')

  async function handleSave() {
    try {
      await updateRole.mutateAsync({ id: role.id, name, description: description || undefined })
      toast(tr('Role updated'), 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || tr('Failed to update role'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
        <input value={name} onChange={e => setName(e.target.value)} className="veqsio-input w-full" />
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Description')}</label>
        <input value={description} onChange={e => setDescription(e.target.value)} className="veqsio-input w-full" />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
        <button onClick={handleSave} disabled={updateRole.isPending} className="veqsio-btn-primary">
          {updateRole.isPending ? tr('Saving...') : tr('Save')}
        </button>
      </div>
    </div>
  )
}

function ManageActorsPanel({ role, onClose }: { role: AdminProjectRole; onClose: () => void }) {
  const { tr } = useI18n();

  const { data: projectsData } = useProjects()
  const { data: usersData } = useUsers(0, 200)
  const { data: groupsData } = useGroups()
  const addActor = useAddProjectRoleActor()
  const removeActor = useRemoveProjectRoleActor()

  const projects = projectsData || []
  const users = usersData?.values || []
  const groups = groupsData?.values || []

  const [selectedProject, setSelectedProject] = useState<number | ''>('')
  const [actorType, setActorType] = useState<'user' | 'group'>('user')
  const [selectedId, setSelectedId] = useState<number | ''>('')

  async function handleAdd() {
    if (!selectedProject || selectedId === '') return
    try {
      await addActor.mutateAsync({
        roleId: role.id,
        projectId: Number(selectedProject),
        [actorType === 'user' ? 'userId' : 'groupId']: Number(selectedId),
      })
      toast(tr('Actor added'), 'success')
      setSelectedId('')
    } catch (err: any) {
      toast(err.message || tr('Failed to add actor'), 'error')
    }
  }

  async function handleRemove(actorId: number) {
    try {
      await removeActor.mutateAsync({ roleId: role.id, actorId })
      toast(tr('Actor removed'), 'success')
    } catch (err: any) {
      toast(err.message || tr('Failed to remove actor'), 'error')
    }
  }

  const actorsByProject = role.actors.reduce((acc, actor) => {
    if (!acc[actor.projectId]) acc[actor.projectId] = []
    acc[actor.projectId].push(actor)
    return acc
  }, {} as Record<number, ProjectRoleActor[]>)

  return (
    <div className="space-y-4">
      <div className="bg-[var(--surface-1)] border border-[var(--surface-3)] rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Project')}</label>
            <select value={selectedProject} onChange={e => setSelectedProject(Number(e.target.value) || '')} className="veqsio-input w-full">
              <option value="">{tr('Select project...')}</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Type')}</label>
            <select value={actorType} onChange={e => { setActorType(e.target.value as any); setSelectedId(''); }} className="veqsio-input w-full">
              <option value="user">{tr('User')}</option>
              <option value="group">{tr('Group')}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">{actorType === 'user' ? tr('User') : tr('Group')}</label>
            <select value={selectedId} onChange={e => setSelectedId(Number(e.target.value) || '')} className="veqsio-input w-full">
              <option value="">{tr('Select...')}</option>
              {actorType === 'user'
                ? users.map(u => (<option key={u.key} value={Number(u.key)}>{u.name} ({u.key})</option>))
                : groups.map(g => (<option key={g.id} value={g.id}>{g.name}</option>))
              }
            </select>
          </div>
        </div>
        <div className="flex justify-end">
          <button
            onClick={handleAdd}
            disabled={!selectedProject || selectedId === '' || addActor.isPending}
            className="veqsio-btn-primary text-sm"
          >
            {tr('Add Actor')} </button>
        </div>
      </div>

      <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="veqsio-table-header">
              <th className="text-left">{tr('Project')}</th>
              <th className="text-left">{tr('Actor')}</th>
              <th className="text-left">{tr('Type')}</th>
              <th className="text-right">{tr('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {role.actors.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-0">
                  <EmptyState icon="folder" title={tr('No actors')} description={tr('Add users or groups to this role.')} />
                </td>
              </tr>
            ) : (
              role.actors.map(actor => (
                <tr key={actor.id} className="veqsio-table-row">
                  <td className="px-4 py-2">
                    {projects.find(p => p.id === actor.projectId)?.name || `Project ${actor.projectId}`}
                  </td>
                  <td className="px-4 py-2">
                    {actor.type === 'user' ? actor.user?.displayName || tr('Unknown') : actor.group?.name || tr('Unknown')}
                  </td>
                  <td className="px-4 py-2">
                    <span className="veqsio-badge veqsio-badge-status-todo capitalize">{actor.type}</span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => handleRemove(actor.id)}
                      className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end pt-2">
        <button onClick={onClose} className="veqsio-btn-secondary">{tr('Close')}</button>
      </div>
    </div>
  )
}
