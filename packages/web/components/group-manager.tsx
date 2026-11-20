'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useDismiss } from '@/hooks/use-dismiss'
import { useEffect, useState } from 'react'
import {
  Plus,
  Trash2,
  Users,
  ChevronRight,
  Search,
  UserPlus,
  UserMinus,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import { Pager } from './pager'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort, orderByParam } from '@/lib/table-sort'
import {
  useGroups,
  useCreateGroup,
  useDeleteGroup,
  useGroupMembers,
  useAddGroupMember,
  useRemoveGroupMember,
  useUserSearch,
} from '@/hooks/use-admin'
import { confirmDialog } from '@/components/dialogs'

const GROUP_PAGE = 50
const MEMBER_PAGE = 50

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

export function GroupManager() {
  const { tr } = useI18n();

  const [createOpen, setCreateOpen] = useState(false)
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const [memberSearch, setMemberSearch] = useState('')

  const [groupSearch, setGroupSearch] = useState('')
  const [groupStart, setGroupStart] = useState(0)
  const groupQuery = useDebounced(groupSearch.trim())
  useEffect(() => { setGroupStart(0) }, [groupQuery])
  const groupSort = useMultiSort() // sorted by the server, so it covers every page
  const groupOrder = orderByParam(groupSort.keys)
  useEffect(() => { setGroupStart(0) }, [groupOrder])
  const { data: groupsData, isLoading: groupsLoading, isFetching: groupsFetching } = useGroups({ startAt: groupStart, maxResults: GROUP_PAGE, query: groupQuery, orderBy: orderByParam(groupSort.keys) })
  const createGroup = useCreateGroup()
  const deleteGroup = useDeleteGroup()

  const groups = groupsData?.values || []

  async function handleCreateGroup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await createGroup.mutateAsync({
        name: fd.get('name') as string,
        description: (fd.get('description') as string) || undefined,
      })
      toast(tr('Group created successfully'), 'success')
      setCreateOpen(false)
      e.currentTarget.reset()
    } catch (err: any) {
      toast(err.message || 'Failed to create group', 'error')
    }
  }

  async function handleDeleteGroup(name: string) {
    if (!(await confirmDialog(`Delete group "${name}"?`))) return
    try {
      await deleteGroup.mutateAsync(name)
      toast(tr('Group deleted'), 'success')
      if (selectedGroup === name) setSelectedGroup(null)
    } catch (err: any) {
      toast(err.message || 'Failed to delete group', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Groups')}</h2>
        <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          {tr('Create Group')} </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
        <input
          type="search"
          value={groupSearch}
          onChange={(e) => setGroupSearch(e.target.value)}
          placeholder={tr('Search groups by name...')}
          aria-label={tr('Search groups')}
          className="veqsio-input w-full pl-9"
        />
      </div>

      {groupsLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={groupQuery ? 'search' : 'inbox'}
          title={groupQuery ? 'No groups match your search' : 'No groups found'}
          description={groupQuery ? 'Try a different name.' : 'Get started by creating a new group.'}
          action={groupQuery ? undefined : (
            <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('Create Group')} </button>
          )}
        />
      ) : (
        <div className={`border border-[var(--surface-3)] rounded-lg overflow-hidden transition-opacity ${groupsFetching ? 'opacity-70' : ''}`}>
          <table className="w-full text-sm">
            <caption className="sr-only">{tr('Groups')}</caption>
            <thead>
              <tr className="veqsio-table-header text-left">
                <SortableTh {...groupSort.th('name')} className="px-4 py-2">{tr('Name')}</SortableTh>
                <SortableTh {...groupSort.th('description')} className="px-4 py-2 hidden md:table-cell">{tr('Description')}</SortableTh>
                <SortableTh {...groupSort.th('members')} className="px-4 py-2 text-right">{tr('Members')}</SortableTh>
                <th scope="col" className="px-4 py-2"><span className="sr-only">{tr('Actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr
                  key={g.id}
                  onClick={() => setSelectedGroup(g.name)}
                  className={`veqsio-table-row cursor-pointer ${selectedGroup === g.name ? 'bg-[var(--brand-50)]' : ''}`}
                >
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-2 font-medium text-[var(--text-primary)]">
                      <Users className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
                      {g.name}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-[var(--text-secondary)] hidden md:table-cell max-w-md truncate">{g.description}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--text-secondary)]">{(g.memberCount ?? 0).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteGroup(g.name) }}
                      className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                      title={tr('Delete')}
                      aria-label={`Delete ${g.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <ChevronRight className="inline w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager startAt={groupStart} pageSize={GROUP_PAGE} total={groupsData?.total ?? 0} shown={groups.length} onPage={setGroupStart} />

      {/* Member Management Modal */}
      <Modal
        isOpen={!!selectedGroup}
        onClose={() => {
          setSelectedGroup(null)
          setMemberSearch('')
        }}
        title={`Members of ${selectedGroup || ''}`}
        size="lg"
      >
        {selectedGroup && <GroupMemberPanel groupName={selectedGroup} search={memberSearch} onSearchChange={setMemberSearch} />}
      </Modal>

      {/* Create Group Modal */}
      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={tr('Create group')}>
        <form onSubmit={handleCreateGroup} className="space-y-4">
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
            <button type="submit" disabled={createGroup.isPending} className="veqsio-btn-primary">
              {createGroup.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

function GroupMemberPanel({
  groupName,
  search,
  onSearchChange,
}: {
  groupName: string
  search: string
  onSearchChange: (v: string) => void
}) {
  const { tr } = useI18n();

  const [start, setStart] = useState(0)
  const query = useDebounced(search.trim())
  useEffect(() => { setStart(0) }, [query, groupName])
  const { data, isLoading } = useGroupMembers(groupName, { startAt: start, maxResults: MEMBER_PAGE, query })
  const addMember = useAddGroupMember()
  const removeMember = useRemoveGroupMember()
  const [addQuery, setAddQuery] = useState('')
  const [addListOpen, setAddListOpen] = useState(true)
  const addRef = useDismiss<HTMLDivElement>(addListOpen, () => setAddListOpen(false))
  const { data: searchResults } = useUserSearch(addQuery)

  const filtered = data?.values || []

  async function handleAdd(username: string) {
    try {
      await addMember.mutateAsync({ groupname: groupName, username })
      toast(`Added ${username} to ${groupName}`, 'success')
      setAddQuery('')
    } catch (err: any) {
      toast(err.message || 'Failed to add member', 'error')
    }
  }

  async function handleRemove(username: string) {
    try {
      await removeMember.mutateAsync({ groupname: groupName, username })
      toast(`Removed ${username} from ${groupName}`, 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to remove member', 'error')
    }
  }

  return (
    <div className="space-y-4">
      {/* Add member */}
      <div className="relative" ref={addRef}>
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type="text"
            placeholder={tr('Search users to add...')}
            value={addQuery}
            onChange={(e) => { setAddQuery(e.target.value); setAddListOpen(true) }}
            onFocus={() => setAddListOpen(true)}
            className="veqsio-input flex-1"
          />
        </div>
        {addListOpen && searchResults && searchResults.length > 0 && addQuery && (
          <div className="absolute z-50 w-full mt-1 bg-[var(--surface-0)] border border-[var(--surface-3)] rounded-lg shadow-lg py-1 max-h-48 overflow-auto">
            {searchResults.map((u) => (
              <button
                key={u.key}
                onClick={() => handleAdd(u.key)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-[var(--surface-2)] text-[var(--text-primary)]"
              >
                <span>
                  {u.name} <span className="text-[var(--text-tertiary)]">({u.key})</span>
                </span>
                <UserPlus className="w-4 h-4 text-[var(--brand-500)]" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Member list search */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder={tr('Search members by name, username or e-mail...')}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="veqsio-input flex-1"
        />
      </div>

      <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="veqsio-table-header">
              <th className="text-left">{tr('User')}</th>
              <th className="text-left hidden sm:table-cell">{tr('Email')}</th>
              <th className="text-right">{tr('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={3} className="p-6 text-center">
                  <Spinner className="mx-auto" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-0">
                  <EmptyState
                    icon="search"
                    title={search ? 'No members match your filter' : 'No members yet'}
                    description={search ? 'Try adjusting your filter terms.' : 'Search users above to add them to this group.'}
                  />
                </td>
              </tr>
            ) : (
              filtered.map((m) => (
                <tr key={m.id} className="veqsio-table-row">
                  <td className="px-4 py-2">
                    <div className="font-medium text-[var(--text-primary)]">{m.displayName}</div>
                    <div className="text-xs text-[var(--text-tertiary)]">{m.username}</div>
                  </td>
                  <td className="px-4 py-2 text-[var(--text-secondary)] hidden sm:table-cell">{m.email}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => handleRemove(m.username)}
                      className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                      title={tr('Remove')}
                    >
                      <UserMinus className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager startAt={start} pageSize={MEMBER_PAGE} total={data?.total ?? 0} shown={filtered.length} onPage={setStart} />
    </div>
  )
}
