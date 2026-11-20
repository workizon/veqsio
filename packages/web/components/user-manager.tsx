'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import {
  Search,
  Plus,
  UserX,
  UserCheck,
  Edit,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import { Pager } from './pager'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort, orderByParam } from '@/lib/table-sort'
import { useDebouncedValue } from '@/hooks/use-debounced'
import {
  useUsers,
  useCreateUser,
  useUpdateUser,
} from '@/hooks/use-admin'

export function UserManager() {
  const { tr } = useI18n();

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [editUser, setEditUser] = useState<{
    username: string
    name: string
    email: string
    active: boolean
    avatarUrl?: string
  } | null>(null)

  const pageSize = 20
  const startAt = (page - 1) * pageSize

  const searchQuery = useDebouncedValue(search.trim())
  useEffect(() => { setPage(1) }, [searchQuery])
  // sorting is done by the server so it covers every page, not just the one on screen
  const ms = useMultiSort()
  const orderBy = orderByParam(ms.keys)
  useEffect(() => { setPage(1) }, [orderBy])
  const { data, isLoading } = useUsers(startAt, pageSize, searchQuery, orderBy)
  const createUser = useCreateUser()
  const updateUser = useUpdateUser()

  const users = data?.values || []
  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const filteredUsers = users // searched on the server, so every user is found, not only the current page

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    try {
      await createUser.mutateAsync({
        username: fd.get('username') as string,
        email: fd.get('email') as string,
        displayName: fd.get('displayName') as string,
        password: fd.get('password') as string,
        active: fd.get('active') === 'on',
        avatarUrl: (fd.get('avatarUrl') as string) || undefined,
      })
      toast(tr('User created successfully'), 'success')
      setCreateOpen(false)
      form.reset()
    } catch (err: any) {
      toast(err.message || tr('Failed to create user'), 'error')
    }
  }

  async function handleUpdate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!editUser) return
    const form = e.currentTarget
    const fd = new FormData(form)
    try {
      await updateUser.mutateAsync({
        username: editUser.username,
        displayName: (fd.get('displayName') as string) || undefined,
        email: (fd.get('email') as string) || undefined,
        active: fd.get('active') === 'on',
        avatarUrl: (fd.get('avatarUrl') as string) || undefined,
      })
      toast(tr('User updated successfully'), 'success')
      setEditUser(null)
    } catch (err: any) {
      toast(err.message || tr('Failed to update user'), 'error')
    }
  }

  async function toggleActive(username: string, current: boolean) {
    try {
      await updateUser.mutateAsync({
        username,
        active: !current,
      })
      toast(current ? tr('User deactivated') : tr('User activated'), 'success')
    } catch (err: any) {
      toast(err.message || tr('Failed to update user'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type="text"
            placeholder={tr('Search users...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="veqsio-input w-full pl-9"
          />
        </div>
        <span className="text-sm text-[var(--text-secondary)] sm:ml-auto" aria-live="polite" data-testid="user-total">
          {total.toLocaleString(getIntlLocale())} {searchQuery ? (total === 1 ? 'user found' : 'users found') : (total === 1 ? 'user' : 'users')}
        </span>
        <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          {tr('Create User')} </button>
      </div>

      {/* Table */}
      <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="veqsio-table-header">
              <SortableTh {...ms.th('name')} className="text-left">{tr('User')}</SortableTh>
              <SortableTh {...ms.th('email')} className="text-left hidden sm:table-cell">{tr('Email')}</SortableTh>
              <SortableTh {...ms.th('status')} className="text-left">{tr('Status')}</SortableTh>
              <th className="text-right">{tr('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={4} className="p-8 text-center">
                  <Spinner className="mx-auto" />
                </td>
              </tr>
            ) : filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-0">
                  <EmptyState
                    icon="search"
                    title={search ? tr('No users match your search') : tr('No users found')}
                    description={search ? tr('Try adjusting your search terms.') : tr('Get started by creating a new user.')}
                    action={
                      !search && (
                        <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
                          <Plus className="w-4 h-4" />
                          {tr('Create User')} </button>
                      )
                    }
                  />
                </td>
              </tr>
            ) : (
              filteredUsers.map((u) => (
                <tr key={u.key} className="veqsio-table-row">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {u.avatarUrls['48x48'] ? (
                        <img src={u.avatarUrls['48x48']} alt="" className="w-8 h-8 rounded-full" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-[var(--surface-3)] flex items-center justify-center text-xs font-medium text-[var(--text-secondary)]">
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <div className="font-medium text-[var(--text-primary)]">{u.name}</div>
                        <div className="text-xs text-[var(--text-tertiary)]">{u.key}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-secondary)] hidden sm:table-cell">{u.emailAddress}</td>
                  <td className="px-4 py-3">
                    {u.active ? (
                      <span className="veqsio-badge veqsio-badge-status-done">{tr('Active')}</span>
                    ) : (
                      <span className="veqsio-badge veqsio-badge-status-todo">{tr('Inactive')}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() =>
                          setEditUser({
                            username: u.key,
                            name: u.name,
                            email: u.emailAddress,
                            active: u.active,
                            avatarUrl: u.avatarUrls['48x48'],
                          })
                        }
                        className="veqsio-btn-ghost p-1.5"
                        title={tr('Edit')}
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => toggleActive(u.key, u.active)}
                        className="veqsio-btn-ghost p-1.5"
                        title={u.active ? tr('Deactivate') : tr('Activate')}
                      >
                        {u.active ? (
                          <UserX className="w-4 h-4 text-[var(--error)]" />
                        ) : (
                          <UserCheck className="w-4 h-4 text-[var(--success)]" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pager startAt={startAt} pageSize={pageSize} total={total} shown={users.length} onPage={(n) => setPage(Math.floor(n / pageSize) + 1)} />

      {/* Create Modal */}
      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={tr('Create user')}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Username')}</label>
            <input name="username" type="text" required className="veqsio-input w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Email')}</label>
            <input name="email" type="email" required className="veqsio-input w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Display name')}</label>
            <input name="displayName" type="text" required className="veqsio-input w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Password')}</label>
            <input name="password" type="password" required minLength={6} className="veqsio-input w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Avatar URL')}</label>
            <input name="avatarUrl" type="url" className="veqsio-input w-full" />
          </div>
          <div className="flex items-center gap-2">
            <input id="active" name="active" type="checkbox" defaultChecked className="w-4 h-4 rounded border-[var(--surface-4)] text-[var(--brand-500)]" />
            <label htmlFor="active" className="text-sm text-[var(--text-secondary)]">{tr('Active')}</label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="veqsio-btn-secondary">
              {tr('Cancel')} </button>
            <button type="submit" disabled={createUser.isPending} className="veqsio-btn-primary">
              {createUser.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal isOpen={!!editUser} onClose={() => setEditUser(null)} title={tr('Edit user')}>
        {editUser && (
          <form onSubmit={handleUpdate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Display name')}</label>
              <input
                name="displayName"
                type="text"
                defaultValue={editUser.name}
                required
                className="veqsio-input w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Email')}</label>
              <input name="email" type="email" defaultValue={editUser.email} required className="veqsio-input w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Avatar URL')}</label>
              <input
                name="avatarUrl"
                type="url"
                defaultValue={editUser.avatarUrl || ''}
                className="veqsio-input w-full"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="edit-active"
                name="active"
                type="checkbox"
                defaultChecked={editUser.active}
                className="w-4 h-4 rounded border-[var(--surface-4)] text-[var(--brand-500)]"
              />
              <label htmlFor="edit-active" className="text-sm text-[var(--text-secondary)]">{tr('Active')}</label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditUser(null)} className="veqsio-btn-secondary">
                {tr('Cancel')} </button>
              <button type="submit" disabled={updateUser.isPending} className="veqsio-btn-primary">
                {updateUser.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
