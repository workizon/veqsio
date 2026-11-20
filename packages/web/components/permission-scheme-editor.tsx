'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState, useMemo } from 'react'
import {
  Plus,
  Trash2,
  Shield,
  ChevronRight,
  X,
  Save,
  Copy,
  Briefcase,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import {
  usePermissionSchemes,
  useCreatePermissionScheme,
  useUpdatePermissionScheme,
  useDeletePermissionScheme,
  useAssignPermissionScheme,
  useCopyPermissionScheme,
  usePermissions,
  useGroups,
  useProjectRoles,
  useUsers,
} from '@/hooks/use-admin'
import type { PermissionEntry, PermissionScheme } from '@/hooks/use-admin'
import { useProjects } from '@/hooks/use-project-admin'
import { confirmDialog, promptDialog } from '@/components/dialogs'

const ALL_PERMISSIONS = [
  'ADMINISTER_PROJECTS',
  'BROWSE_PROJECTS',
  'CREATE_ISSUES',
  'EDIT_ISSUES',
  'DELETE_ISSUES',
  'ADD_COMMENTS',
  'EDIT_OWN_COMMENTS',
  'EDIT_ALL_COMMENTS',
  'DELETE_OWN_COMMENTS',
  'DELETE_ALL_COMMENTS',
  'CREATE_ATTACHMENTS',
  'DELETE_OWN_ATTACHMENTS',
  'DELETE_ALL_ATTACHMENTS',
  'WORK_ON_ISSUES',
  'EDIT_ALL_WORKLOGS',
  'DELETE_ALL_WORKLOGS',
  'RESOLVE_ISSUES',
  'CLOSE_ISSUES',
  'MANAGE_SPRINTS',
  'SET_ISSUE_SECURITY',
]

const PERMISSION_LABELS: Record<string, string> = {
  ADMINISTER_PROJECTS: 'Administer Projects',
  BROWSE_PROJECTS: 'Browse Projects',
  CREATE_ISSUES: 'Create Issues',
  EDIT_ISSUES: 'Edit Issues',
  DELETE_ISSUES: 'Delete Issues',
  ADD_COMMENTS: 'Add Comments',
  EDIT_OWN_COMMENTS: 'Edit Own Comments',
  EDIT_ALL_COMMENTS: 'Edit All Comments',
  DELETE_OWN_COMMENTS: 'Delete Own Comments',
  DELETE_ALL_COMMENTS: 'Delete All Comments',
  CREATE_ATTACHMENTS: 'Create Attachments',
  DELETE_OWN_ATTACHMENTS: 'Delete Own Attachments',
  DELETE_ALL_ATTACHMENTS: 'Delete All Attachments',
  WORK_ON_ISSUES: 'Work On Issues',
  EDIT_ALL_WORKLOGS: 'Edit All Worklogs',
  DELETE_ALL_WORKLOGS: 'Delete All Worklogs',
  RESOLVE_ISSUES: 'Resolve Issues',
  CLOSE_ISSUES: 'Close Issues',
  MANAGE_SPRINTS: 'Manage Sprints',
  SET_ISSUE_SECURITY: 'Set Issue Security',
}

export function PermissionSchemeEditor() {
  const { tr } = useI18n();

  const [createOpen, setCreateOpen] = useState(false)
  const [editingScheme, setEditingScheme] = useState<PermissionScheme | null>(null)
  const [copyingScheme, setCopyingScheme] = useState<PermissionScheme | null>(null)

  const { data, isLoading } = usePermissionSchemes()
  const createScheme = useCreatePermissionScheme()
  const deleteScheme = useDeletePermissionScheme()

  const schemes = data?.permissionSchemes || []

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await createScheme.mutateAsync({
        name: fd.get('name') as string,
        description: (fd.get('description') as string) || undefined,
      })
      toast(tr('Permission scheme created'), 'success')
      setCreateOpen(false)
      e.currentTarget.reset()
    } catch (err: any) {
      toast(err.message || tr('Failed to create scheme'), 'error')
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!(await confirmDialog(tr('Delete permission scheme "{name}"?', { name })))) return
    try {
      await deleteScheme.mutateAsync(id)
      toast(tr('Permission scheme deleted'), 'success')
    } catch (err: any) {
      toast(err.message || tr('Failed to delete scheme'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Permission schemes')}</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            title={tr('Creates a scheme where Viewers, Commenters, Developers and Administrators each have their own permissions (missing roles are created)')}
            className="veqsio-btn-secondary"
            onClick={async () => {
              const name = (await promptDialog(tr('Name of the new role-based scheme'), { defaultValue: tr('Role-based scheme') }))
              if (!name) return
              try {
                const res = await fetch('/rest/api/2/permissionscheme/templates/role-based', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
                toast(tr('Role-based scheme created. Add people to the roles in each project, then assign the scheme.'), 'success')
                window.location.reload()
              } catch (err) { toast((err as Error).message, 'error') }
            }}
          >{tr('From role template')}</button>
          <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" />
            {tr('Create Scheme')} </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : schemes.length === 0 ? (
        <EmptyState
          icon="folder"
          title={tr('No permission schemes found')}
          description={tr('Create a scheme to manage project permissions.')}
          action={
            <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('Create Scheme')} </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {schemes.map((s) => (
            <div
              key={s.id}
              onClick={() => setEditingScheme(s)}
              className="veqsio-card cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
                    <Shield className="w-5 h-5 text-[var(--text-secondary)]" />
                  </div>
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{s.name}</div>
                    {s.description && (
                      <div className="text-xs text-[var(--text-tertiary)]">{s.description}</div>
                    )}
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                      {s.permissions.length === 1 ? tr('{n} permission', { n: 1 }) : tr('{n} permissions', { n: s.permissions.length })}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); setCopyingScheme(s) }}
                    className="veqsio-btn-ghost p-1.5"
                    title={tr('Copy')}
                  >
                    <Copy className="w-4 h-4 text-[var(--text-tertiary)]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(s.id, s.name)
                    }}
                    className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                    title={tr('Delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={tr('Create permission scheme')}>
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
            <button type="button" onClick={() => setCreateOpen(false)} className="veqsio-btn-secondary">
              {tr('Cancel')} </button>
            <button type="submit" disabled={createScheme.isPending} className="veqsio-btn-primary">
              {createScheme.isPending ? tr('Creating...') : tr('Create')}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!editingScheme}
        onClose={() => setEditingScheme(null)}
        title={editingScheme?.name || tr('Edit Scheme')}
        size="lg"
      >
        {editingScheme && (
          <SchemeEditPanel
            scheme={editingScheme}
            onClose={() => setEditingScheme(null)}
          />
        )}
      </Modal>

      <Modal isOpen={!!copyingScheme} onClose={() => setCopyingScheme(null)} title={tr('Copy permission scheme')}>
        {copyingScheme && (
          <CopySchemePanel scheme={copyingScheme} onClose={() => setCopyingScheme(null)} />
        )}
      </Modal>
    </div>
  )
}

function CopySchemePanel({ scheme, onClose }: { scheme: PermissionScheme; onClose: () => void }) {
  const { tr } = useI18n();

  const copyScheme = useCopyPermissionScheme()
  const [name, setName] = useState(tr('Copy of {name}', { name: scheme.name }))

  async function handleCopy() {
    try {
      await copyScheme.mutateAsync({ id: scheme.id, name })
      toast(tr('Permission scheme copied'), 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || tr('Failed to copy scheme'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('New name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="veqsio-input w-full" />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
        <button onClick={handleCopy} disabled={copyScheme.isPending} className="veqsio-btn-primary">
          {copyScheme.isPending ? tr('Copying...') : tr('Copy')}
        </button>
      </div>
    </div>
  )
}

function SchemeEditPanel({ scheme, onClose }: { scheme: PermissionScheme; onClose: () => void }) {
  const { tr } = useI18n();

  const [permissions, setPermissions] = useState<PermissionEntry[]>(scheme.permissions)
  const updateScheme = useUpdatePermissionScheme()
  const assignScheme = useAssignPermissionScheme()

  const { data: allPermissions } = usePermissions()
  const { data: groupsData } = useGroups()
  const { data: rolesData } = useProjectRoles()
  const { data: projectsData } = useProjects()
  const { data: usersData } = useUsers(0, 200)

  const groups = groupsData?.values || []
  const roles = rolesData?.roles || []
  const projects = projectsData || []
  const users = usersData?.values || []

  const availablePermissions = useMemo(() => {
    if (!allPermissions) return []
    return allPermissions.permissions
  }, [allPermissions])

  const matrixColumns = useMemo(() => {
    const cols = [
      { type: 'anonymous', id: -1, name: 'Anyone' },
      { type: 'anyUser', id: -2, name: 'Logged-in Users' },
      { type: 'projectLead', id: -3, name: 'Project lead' },
      ...roles.map((r) => ({ type: 'projectRole' as const, id: r.id, name: r.name })),
      ...groups.map((g) => ({ type: 'group' as const, id: Number(g.id), name: g.name })),
      ...users.filter((u) => u.id).map((u) => ({ type: 'user' as const, id: Number(u.id), name: u.displayName || u.name })),
    ]
    return cols
  }, [roles, groups, users])

  async function handleSave() {
    try {
      await updateScheme.mutateAsync({
        id: scheme.id,
        permissions: permissions.map((p) => ({
          permission: p.permission,
          userId: p.holder?.type === 'user' ? p.holder.id : undefined,
          groupId: p.holder?.type === 'group' ? p.holder.id : undefined,
          projectRoleId: p.holder?.type === 'projectRole' ? p.holder.id : undefined,
          anyUser: p.holder?.type === 'anyUser' ? true : undefined,
          projectLead: p.holder?.type === 'projectLead' ? true : undefined,
          anonymous: p.holder?.type === 'anonymous' ? true : undefined,
        })),
      })
      toast(tr('Permission scheme updated'), 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || tr('Failed to update scheme'), 'error')
    }
  }

  async function handleAssign(projectId: number) {
    try {
      await assignScheme.mutateAsync({ schemeId: scheme.id, projectId })
      toast(tr('Scheme assigned to project'), 'success')
    } catch (err: any) {
      toast(err.message || tr('Failed to assign scheme'), 'error')
    }
  }

  function isGranted(permissionKey: string, col: { type: string; id: number; name: string }) {
    if (col.type === 'anonymous') {
      return permissions.some((p) => p.permission === permissionKey && p.holder?.type === 'anonymous')
    }
    if (col.type === 'anyUser') {
      return permissions.some((p) => p.permission === permissionKey && p.holder?.type === 'anyUser')
    }
    if (col.type === 'projectLead') {
      return permissions.some((p) => p.permission === permissionKey && p.holder?.type === 'projectLead')
    }
    return permissions.some(
      (p) =>
        p.permission === permissionKey &&
        p.holder &&
        ((col.type === 'projectRole' && p.holder.type === 'projectRole' && p.holder.id === col.id) ||
          (col.type === 'group' && p.holder.type === 'group' && p.holder.id === col.id) ||
          (col.type === 'user' && p.holder.type === 'user' && p.holder.id === col.id))
    )
  }

  function togglePermission(permissionKey: string, col: { type: string; id: number; name: string }) {
    const exists = permissions.some(
      (p) =>
        p.permission === permissionKey &&
        p.holder &&
        ((col.type === 'anonymous' && p.holder.type === 'anonymous') ||
          (col.type === 'anyUser' && p.holder.type === 'anyUser') ||
          (col.type === 'projectLead' && p.holder.type === 'projectLead') ||
          (col.type === 'projectRole' && p.holder.type === 'projectRole' && p.holder.id === col.id) ||
          (col.type === 'group' && p.holder.type === 'group' && p.holder.id === col.id) ||
          (col.type === 'user' && p.holder.type === 'user' && p.holder.id === col.id))
    )

    if (exists) {
      setPermissions((prev) =>
        prev.filter(
          (p) =>
            !(
              p.permission === permissionKey &&
              p.holder &&
              ((col.type === 'anonymous' && p.holder.type === 'anonymous') ||
                (col.type === 'anyUser' && p.holder.type === 'anyUser') ||
                (col.type === 'projectLead' && p.holder.type === 'projectLead') ||
                (col.type === 'projectRole' && p.holder.type === 'projectRole' && p.holder.id === col.id) ||
                (col.type === 'group' && p.holder.type === 'group' && p.holder.id === col.id) ||
                (col.type === 'user' && p.holder.type === 'user' && p.holder.id === col.id))
            )
        )
      )
    } else {
      setPermissions((prev) => [
        ...prev,
        {
          id: `temp-${Date.now()}`,
          permission: permissionKey,
          holder: { type: col.type, id: col.id, name: col.name },
        },
      ])
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-[var(--text-secondary)]">
          {permissions.length === 1 ? tr('{n} permission', { n: 1 }) : tr('{n} permissions', { n: permissions.length })}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="veqsio-input text-sm"
            onChange={(e) => {
              const pid = Number(e.target.value)
              if (pid) handleAssign(pid)
              e.target.value = ''
            }}
            defaultValue=""
          >
            <option value="" disabled>{tr('Assign to project...')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button onClick={handleSave} disabled={updateScheme.isPending} className="veqsio-btn-primary flex items-center gap-1.5 text-sm">
            <Save className="w-4 h-4" />
            {tr('Save')} </button>
        </div>
      </div>

      <div className="border border-[var(--surface-3)] rounded-lg overflow-auto max-h-[60vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="veqsio-table-header">
              <th className="text-left min-w-[180px]">{tr('Permission')}</th>
              {matrixColumns.map((col) => (
                <th key={`${col.type}-${col.id}`} className="text-center min-w-[100px] text-xs">
                  <div className="flex flex-col items-center gap-0.5">
                    <span>{col.name}</span>
                    <span className="text-[10px] text-[var(--text-tertiary)] capitalize">{col.type === 'projectRole' ? 'role' : col.type}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ALL_PERMISSIONS.map((perm) => (
              <tr key={perm} className="veqsio-table-row">
                <td className="px-4 py-2 font-medium text-[var(--text-primary)] whitespace-nowrap">
                  {PERMISSION_LABELS[perm] ? tr(PERMISSION_LABELS[perm]) : perm}
                </td>
                {matrixColumns.map((col) => (
                  <td key={`${perm}-${col.type}-${col.id}`} className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={isGranted(perm, col)}
                      onChange={() => togglePermission(perm, col)}
                      className="w-4 h-4 accent-[var(--brand-500)] cursor-pointer"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
