'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import { Plus, Trash2, Users, Star, ShieldCheck, X } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { toast } from '@/components/toast'
import { UserPicker, type PickedUser } from '@/components/admin/user-picker'
import { useGroups, useProjectRoles } from '@/hooks/use-admin'
import { useProjects } from '@/hooks/use-project-admin'
import {
  ApiError, useAddMember, useAssignProjectScheme, useCreateLevel, useCreateScheme, useDeleteLevel, useDeleteScheme, useRemoveMember,
  useSecuritySchemes, useUpdateLevel, useUpdateScheme,
} from '@/hooks/use-issue-security'
import {
  MEMBER_TYPES, MEMBER_TYPE_LABEL, describeDelete, mappingBody, needsTarget, summarizeMembers,
  type MemberType, type SecurityLevel, type SecurityScheme, type UsedLevel,
} from '@/lib/issue-security'
import { confirmDialog } from '@/components/dialogs'

const fail = (e: unknown, fallback: string) => toast(e instanceof Error ? e.message : fallback, 'error')

export function IssueSecurityEditor() {
  const { tr } = useI18n();

  const { data, isLoading, isError } = useSecuritySchemes()
  const createScheme = useCreateScheme()
  const [creating, setCreating] = useState(false)
  const schemes = data?.schemes ?? []

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-heading-1 text-[var(--text-primary)]">{tr('Issue security')}</h1>
          <p className="text-body text-[var(--text-secondary)] max-w-3xl">
            {tr('An issue with a security level is visible only to the members of that level, in every list, search, board and report. Project and system administrators see it only if they are members too.')} </p>
        </div>
        <button type="button" className="veqsio-btn-primary flex items-center gap-2" onClick={() => setCreating(true)}>
          <Plus className="w-4 h-4" aria-hidden /> {tr('New scheme')} </button>
      </div>

      {isLoading && <div className="py-10 flex justify-center"><Spinner /></div>}
      {isError && <p role="alert" className="text-[var(--error)]">{tr('Could not load the issue security schemes. System administrator rights are required.')}</p>}
      {!isLoading && !isError && schemes.length === 0 && (
        <EmptyState icon={ShieldCheck} title={tr('No issue security scheme yet')} description={tr('Create a scheme, add levels and members, then assign it to a project. Issues of that project can then be restricted.')} />
      )}
      {schemes.map((s) => <SchemeCard key={s.id} scheme={s} />)}

      <Modal isOpen={creating} onClose={() => setCreating(false)} title={tr('New issue security scheme')}>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            try {
              await createScheme.mutateAsync({ name: String(fd.get('name')).trim(), description: String(fd.get('description') || '').trim() || null })
              toast(tr('Scheme created'), 'success')
              setCreating(false)
            } catch (err) { fail(err, tr('Could not create the scheme')) }
          }}
        >
          <div>
            <label htmlFor="new-scheme-name" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
            <input id="new-scheme-name" name="name" required maxLength={255} className="veqsio-input w-full" />
          </div>
          <div>
            <label htmlFor="new-scheme-desc" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{tr('Description')}</label>
            <input id="new-scheme-desc" name="description" maxLength={2000} className="veqsio-input w-full" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="veqsio-btn-secondary" onClick={() => setCreating(false)}>{tr('Cancel')}</button>
            <button type="submit" className="veqsio-btn-primary" disabled={createScheme.isPending}>{tr('Create')}</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

function SchemeCard({ scheme }: { scheme: SecurityScheme }) {
  const { tr } = useI18n();

  const updateScheme = useUpdateScheme()
  const deleteScheme = useDeleteScheme()
  const createLevel = useCreateLevel()
  const [newLevel, setNewLevel] = useState('')
  const [membersOf, setMembersOf] = useState<SecurityLevel | null>(null)
  const [assigning, setAssigning] = useState(false)

  const addLevel = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newLevel.trim()) return
    try { await createLevel.mutateAsync({ schemeId: scheme.id, name: newLevel.trim() }); setNewLevel('') } catch (err) { fail(err, tr('Could not add the level')) }
  }

  return (
    <section aria-label={`Scheme ${scheme.name}`} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-heading-3 text-[var(--text-primary)] flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-[var(--brand-500)]" aria-hidden /> {scheme.name}</h2>
          {scheme.description && <p className="text-body-sm text-[var(--text-secondary)]">{scheme.description}</p>}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-caption text-[var(--text-secondary)]">
            {tr('Default level')} <select
              className="veqsio-input text-sm"
              value={scheme.defaultLevelId ?? ''}
              aria-label={tr('Default level of {name}', { name: scheme.name })}
              onChange={async (e) => { try { await updateScheme.mutateAsync({ id: scheme.id, defaultLevelId: e.target.value ? Number(e.target.value) : null }) } catch (err) { fail(err, tr('Could not set the default')) } }}
            >
              <option value="">{tr('None (new issues are not secured)')}</option>
              {scheme.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="text-body-sm text-[var(--error)] hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
            onClick={async () => {
              if (!(await confirmDialog(tr('Delete the scheme "{name}"?', { name: scheme.name })))) return
              try { await deleteScheme.mutateAsync(scheme.id); toast(tr('Scheme deleted'), 'success') } catch (err) { fail(err, tr('Could not delete the scheme')) }
            }}
          >{tr('Delete scheme')}</button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-body-sm">
          <caption className="sr-only">{tr('Levels of')} {scheme.name}</caption>
          <thead>
            <tr className="text-left text-caption text-[var(--text-tertiary)] border-b border-[var(--surface-3)]">
              <th scope="col" className="py-2 pr-3 font-medium">{tr('Level')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{tr('Who can see issues of this level')}</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">{tr('Issues')}</th>
              <th scope="col" className="py-2 font-medium"><span className="sr-only">{tr('Actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {scheme.levels.length === 0 && (
              <tr><td colSpan={4} className="py-4 text-[var(--text-tertiary)]">{tr('No levels yet. Add one below.')}</td></tr>
            )}
            {scheme.levels.map((l) => (
              <LevelRow key={l.id} scheme={scheme} level={l} onMembers={() => setMembersOf(l)} />
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={addLevel} className="flex flex-wrap items-center gap-2">
        <label htmlFor={`new-level-${scheme.id}`} className="sr-only">{tr('New level name')}</label>
        <input id={`new-level-${scheme.id}`} className="veqsio-input" placeholder={tr('New level, e.g. Confidential')} value={newLevel} onChange={(e) => setNewLevel(e.target.value)} maxLength={255} />
        <button type="submit" className="veqsio-btn-secondary flex items-center gap-1.5" disabled={!newLevel.trim() || createLevel.isPending}><Plus className="w-4 h-4" aria-hidden /> {tr('Add level')}</button>
      </form>

      <div className="border-t border-[var(--surface-3)] pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-body font-medium text-[var(--text-primary)]">{tr('Projects using this scheme')}</h3>
          <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => setAssigning(true)}>{tr('Assign project')}</button>
        </div>
        {scheme.projects.length === 0 ? (
          <p className="text-body-sm text-[var(--text-tertiary)] mt-1">{tr('No project uses this scheme yet. Its levels cannot be set on issues until a project is assigned.')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2 mt-2">
            {scheme.projects.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.key}/settings`} className="inline-flex items-center gap-1.5 rounded bg-[var(--surface-2)] px-2 py-1 text-body-sm text-[var(--text-primary)] hover:underline">
                  <span className="font-mono text-caption text-[var(--text-secondary)]">{p.key}</span> {p.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {membersOf && <MembersDialog scheme={scheme} levelId={membersOf.id} onClose={() => setMembersOf(null)} />}
      {assigning && <AssignDialog scheme={scheme} onClose={() => setAssigning(false)} />}
    </section>
  )
}

function LevelRow({ scheme, level, onMembers }: { scheme: SecurityScheme; level: SecurityLevel; onMembers: () => void }) {
  const { tr } = useI18n();

  const updateLevel = useUpdateLevel()
  const deleteLevel = useDeleteLevel()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(level.name)
  const blocked = describeDelete(level)
  const isDefault = scheme.defaultLevelId === level.id
  return (
    <tr className="border-b border-[var(--surface-3)] last:border-0 align-top">
      <td className="py-3 pr-3 min-w-[10rem]">
        {editing ? (
          <form onSubmit={async (e) => { e.preventDefault(); try { await updateLevel.mutateAsync({ schemeId: scheme.id, levelId: level.id, name: name.trim() }); setEditing(false) } catch (err) { fail(err, tr('Could not rename')) } }} className="flex gap-1">
            <label htmlFor={`lvl-${level.id}`} className="sr-only">{tr('Level name')}</label>
            <input id={`lvl-${level.id}`} autoFocus className="veqsio-input text-sm" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="veqsio-btn-primary text-sm" type="submit" disabled={!name.trim()}>{tr('Save')}</button>
          </form>
        ) : (
          <button type="button" onClick={() => { setName(level.name); setEditing(true) }} className="text-left font-medium text-[var(--text-primary)] hover:underline" aria-label={tr('Rename level {name}', { name: level.name })}>
            {level.name}
          </button>
        )}
        {isDefault && <span className="ml-2 inline-flex items-center gap-1 text-caption text-[var(--brand-500)]"><Star className="w-3 h-3" aria-hidden /> {tr('default')}</span>}
        {level.description && <p className="text-caption text-[var(--text-tertiary)]">{level.description}</p>}
      </td>
      <td className="py-3 pr-3 text-[var(--text-secondary)]">
        {summarizeMembers(level.members)}
      </td>
      <td className="py-3 pr-3 text-right tabular-nums">{level.issueCount}</td>
      <td className="py-3 text-right whitespace-nowrap">
        <button type="button" onClick={onMembers} className="veqsio-btn-secondary text-sm inline-flex items-center gap-1.5"><Users className="w-4 h-4" aria-hidden /> {tr('Members (')}{level.members.length})</button>
        <button
          type="button"
          title={blocked ? tr(blocked) : undefined}
          aria-label={tr('Delete level {name}', { name: level.name })}
          className="ml-2 p-1.5 rounded text-[var(--error)] hover:bg-[var(--surface-2)] disabled:opacity-40"
          disabled={!!blocked}
          onClick={async () => {
            if (!(await confirmDialog(tr('Delete the level "{name}"?', { name: level.name })))) return
            try { await deleteLevel.mutateAsync({ schemeId: scheme.id, levelId: level.id }); toast(tr('Level deleted'), 'success') } catch (err) { fail(err, tr('Could not delete the level')) }
          }}
        ><Trash2 className="w-4 h-4" aria-hidden /></button>
      </td>
    </tr>
  )
}

function MembersDialog({ scheme, levelId, onClose }: { scheme: SecurityScheme; levelId: number; onClose: () => void }) {
  const { tr } = useI18n();

  const level = scheme.levels.find((l) => l.id === levelId)
  const add = useAddMember()
  const remove = useRemoveMember()
  const { data: groups } = useGroups()
  const { data: roles } = useProjectRoles()
  const [type, setType] = useState<MemberType>('user')
  const [user, setUser] = useState<PickedUser | null>(null)
  const [groupId, setGroupId] = useState('')
  const [roleId, setRoleId] = useState('')
  if (!level) return null

  const ready = type === 'user' ? !!user : type === 'group' ? !!groupId : type === 'role' ? !!roleId : true
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await add.mutateAsync({
        schemeId: scheme.id, levelId, type,
        ...(type === 'user' ? { userId: user!.id } : type === 'group' ? { groupId: Number(groupId) } : type === 'role' ? { roleId: Number(roleId) } : {}),
      })
      setUser(null); setGroupId(''); setRoleId('')
    } catch (err) { fail(err, tr('Could not add the member')) }
  }

  return (
    <Modal isOpen onClose={onClose} title={tr('Members of "{name}"', { name: level.name })} size="lg">
      <div className="space-y-4">
        <p className="text-body-sm text-[var(--text-secondary)]">{tr('Only these people see issues with this level. The reporter and assignee rules apply per issue.')}</p>
        {level.members.length === 0 ? (
          <p className="text-body-sm text-[var(--warning)]">{tr('Nobody is a member: issues with this level are hidden from everyone.')}</p>
        ) : (
          <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)]">
            {level.members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-body-sm text-[var(--text-primary)]">
                  <span className="text-[var(--text-tertiary)]">{tr(MEMBER_TYPE_LABEL[m.type])}</span>{needsTarget(m.type) && <>: <span className="font-medium">{m.label}</span></>}
                </span>
                <button
                  type="button"
                  aria-label={`${tr('Remove')} ${tr(MEMBER_TYPE_LABEL[m.type])} ${needsTarget(m.type) ? m.label : ''}`.trim()}
                  className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
                  onClick={async () => { try { await remove.mutateAsync({ schemeId: scheme.id, levelId, memberId: m.id }) } catch (err) { fail(err, tr('Could not remove the member')) } }}
                ><X className="w-4 h-4" aria-hidden /></button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] items-end">
          <div>
            <label htmlFor="member-type" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{tr('Add')}</label>
            <select id="member-type" className="veqsio-input w-full" value={type} onChange={(e) => setType(e.target.value as MemberType)}>
              {MEMBER_TYPES.map((t) => <option key={t} value={t}>{tr(MEMBER_TYPE_LABEL[t])}</option>)}
            </select>
          </div>
          <div>
            {type === 'user' && <UserPicker label={tr('User')} value={user} onChange={setUser} />}
            {type === 'group' && (
              <>
                <label htmlFor="member-group" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{tr('Group')}</label>
                <select id="member-group" className="veqsio-input w-full" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">{tr('Select a group')}</option>
                  {(groups?.values ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </>
            )}
            {type === 'role' && (
              <>
                <label htmlFor="member-role" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{tr('Project role')}</label>
                <select id="member-role" className="veqsio-input w-full" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  <option value="">{tr('Select a role')}</option>
                  {(roles?.roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </>
            )}
            {!needsTarget(type) && <p className="text-body-sm text-[var(--text-tertiary)] pb-2">{tr('No further choice needed.')}</p>}
          </div>
          <button type="submit" className="veqsio-btn-primary" disabled={!ready || add.isPending}>{tr('Add member')}</button>
        </form>
        <div className="flex justify-end"><button type="button" className="veqsio-btn-secondary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </Modal>
  )
}

function AssignDialog({ scheme, onClose }: { scheme: SecurityScheme; onClose: () => void }) {
  const { tr } = useI18n();

  const { data: projects } = useProjects()
  const { data } = useSecuritySchemes()
  const assign = useAssignProjectScheme()
  const [projectId, setProjectId] = useState('')
  const [used, setUsed] = useState<UsedLevel[] | null>(null)
  const [choices, setChoices] = useState<Record<number, string>>({})
  const allLevels = new Map((data?.schemes ?? []).flatMap((s) => s.levels.map((l) => [l.id, `${l.name} (${s.name})`] as const)))

  const run = async (withMapping: boolean) => {
    try {
      const body = withMapping ? mappingBody(used ?? [], choices) : null
      if (body && !body.ok) return toast(tr('Choose a level (or none) for every level in use'), 'error')
      await assign.mutateAsync({ projectId: Number(projectId), schemeId: scheme.id, levelMapping: body?.levelMapping })
      toast(tr('Project assigned'), 'success')
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.used?.length) { setUsed(err.used); return }
      fail(err, tr('Could not assign the project'))
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={tr('Assign a project to "{name}"', { name: scheme.name })}>
      <div className="space-y-4">
        <div>
          <label htmlFor="assign-project" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{tr('Project')}</label>
          <select id="assign-project" className="veqsio-input w-full" value={projectId} onChange={(e) => { setProjectId(e.target.value); setUsed(null) }}>
            <option value="">{tr('Select a project')}</option>
            {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
          </select>
        </div>
        {used && (
          <div role="alert" className="rounded-lg border border-[var(--warning)] p-3 space-y-3">
            <p className="text-body-sm text-[var(--text-primary)]">{tr('Issues of this project already use levels of its current scheme. Choose what happens to them. They are never made public silently.')}</p>
            {used.map((u) => (
              <div key={u.levelId} className="grid gap-2 sm:grid-cols-2 items-center">
                <span className="text-body-sm">{allLevels.get(u.levelId) ?? tr('Level {id}', { id: u.levelId })} ({u.n} {u.n === 1 ? tr('issue') : tr('issues')})</span>
                <select className="veqsio-input text-sm" aria-label={tr('New level for {name}', { name: String(allLevels.get(u.levelId) ?? u.levelId) })} value={choices[u.levelId] ?? ''} onChange={(e) => setChoices({ ...choices, [u.levelId]: e.target.value })}>
                  <option value="">{tr('No security level')}</option>
                  {scheme.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="veqsio-btn-primary" disabled={!projectId || assign.isPending} onClick={() => void run(!!used)}>
            {used ? tr('Apply mapping') : tr('Assign')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
