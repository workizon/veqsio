'use client'


import { useI18n } from '@/hooks/use-i18n'
import { ProjectPermissionsPanel } from '@/components/project-permissions-panel'
import { ProjectRolesTable } from '@/components/project/project-roles-table'
import { ProjectAuditPanel } from '@/components/project/project-audit-panel'
import { ProjectMaintenancePanel } from '@/components/project/project-maintenance-panel'
import { ProjectNotificationsPanel } from '@/components/project/project-notifications-panel'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useState } from 'react'
import { Tabs } from '@/components/tabs'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { Modal } from '@/components/modal'
import { ProjectSettingsForm } from '@/components/project-settings-form'
import { PublicAccessPanel } from '@/components/public-access-panel'
import { ProjectSecurityPanel } from '@/components/project-security-panel'
import { ProjectSchemesPanel } from '@/components/project-schemes-panel'
import { ProjectFeaturesPanel } from '@/components/project-features-panel'
import { RepositoriesPanel } from '@/components/repositories-panel'
import { InboundSourcesPanel } from '@/components/integrations/inbound-sources-panel'
import { NotificationChannelsPanel } from '@/components/integrations/notification-channels-panel'
import { IntakeSettingsPanel } from '@/components/intake/intake-settings-panel'
import { TemplateManager } from '@/components/templates/template-manager'
import { RecurringPanel } from '@/components/templates/recurring-panel'
import { LifecyclePanel } from '@/components/templates/lifecycle-panel'
import { useFeatures } from '@/hooks/use-features'
import { ComponentManager } from '@/components/component-manager'
import { VersionManager } from '@/components/version-manager'
import { useBoards } from '@/hooks/use-boards'
import {
  useProject,
  useUpdateProject,
  useUploadProjectAvatar,
  useComponents,
  useCreateComponent,
  useUpdateComponent,
  useDeleteComponent,
  useVersions,
  useCreateVersion,
  useUpdateVersion,
  useDeleteVersion,
  useProjectRoles,
  useAddProjectRoleActor,
  useRemoveProjectRoleActor,
} from '@/hooks/use-project-admin'
import { useUsers } from '@/hooks/use-admin'
import { useGroups } from '@/hooks/use-admin'
import { Search, Trash2, UserPlus, Users } from 'lucide-react'

export default function ProjectSettingsPage() {
  const { tr } = useI18n();

  const params = useParams()
  const router = useRouter()
  const requestedTab = useSearchParams()?.get('tab')
  const key = String(params.key)

  const { data: project, isLoading: projectLoading } = useProject(key)
  const { data: users } = useUsers()
  const { data: groupsData } = useGroups()
  const { data: components, isLoading: componentsLoading } = useComponents(key)
  const { data: versions, isLoading: versionsLoading } = useVersions(key)
  const { data: roles } = useProjectRoles(key)
  const { data: projectBoards } = useBoards(project?.id)
  const features = useFeatures()

  const updateProject = useUpdateProject(key)
  const uploadAvatar = useUploadProjectAvatar(key)
  const createComponent = useCreateComponent(key)
  const updateComponent = useUpdateComponent(key)
  const deleteComponent = useDeleteComponent(key)
  const createVersion = useCreateVersion(key)
  const updateVersion = useUpdateVersion(key)
  const deleteVersion = useDeleteVersion(key)
  const addActor = useAddProjectRoleActor(key)
  const removeActor = useRemoveProjectRoleActor(key)

  const isMutating =
    updateProject.isPending ||
    uploadAvatar.isPending ||
    createComponent.isPending ||
    updateComponent.isPending ||
    deleteComponent.isPending ||
    createVersion.isPending ||
    updateVersion.isPending ||
    deleteVersion.isPending ||
    addActor.isPending ||
    removeActor.isPending

  const handleUpdateProject = useCallback(
    (data: Parameters<typeof updateProject.mutate>[0]) => {
      updateProject.mutate(data, {
        onSuccess: () => toast(tr('Project updated'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [updateProject]
  )

  const handleUploadAvatar = useCallback(
    (file: File) => {
      uploadAvatar.mutate(file, {
        onSuccess: () => toast(tr('Avatar uploaded'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [uploadAvatar]
  )

  const handleCreateComponent = useCallback(
    (data: Parameters<typeof createComponent.mutate>[0]) => {
      createComponent.mutate(data, {
        onSuccess: () => toast(tr('Component created'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [createComponent]
  )

  const handleUpdateComponent = useCallback(
    (id: number, data: { name?: string; description?: string; leadId?: number }) => {
      updateComponent.mutate({ id, data }, {
        onSuccess: () => toast(tr('Component updated'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [updateComponent]
  )

  const handleDeleteComponent = useCallback(
    (id: number) => {
      deleteComponent.mutate(id, {
        onSuccess: () => toast(tr('Component deleted'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [deleteComponent]
  )

  const handleCreateVersion = useCallback(
    (data: Parameters<typeof createVersion.mutate>[0]) => {
      createVersion.mutate(data, {
        onSuccess: () => toast(tr('Version created'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [createVersion]
  )

  const handleUpdateVersion = useCallback(
    (id: number, data: Parameters<typeof updateVersion.mutate>[0]['data']) => {
      updateVersion.mutate({ id, data }, {
        onSuccess: () => toast(tr('Version updated'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [updateVersion]
  )

  const handleDeleteVersion = useCallback(
    (id: number) => {
      deleteVersion.mutate(id, {
        onSuccess: () => toast(tr('Version deleted'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [deleteVersion]
  )

  const handleAddActor = useCallback(
    (roleId: number, data: { userId?: number; groupId?: number; username?: string; groupName?: string }) => {
      addActor.mutate({ roleId, ...data }, {
        onSuccess: () => toast(tr('Actor added'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [addActor]
  )

  const handleRemoveActor = useCallback(
    (roleId: number, data: { user?: string; group?: string }) => {
      removeActor.mutate({ roleId, ...data }, {
        onSuccess: () => toast(tr('Actor removed'), 'success'),
        onError: (err) => toast(err.message, 'error'),
      })
    },
    [removeActor]
  )

  if (projectLoading || !project) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-[60vh]">
          <Spinner className="w-8 h-8" />
        </div>
      </AppLayout>
    )
  }

  const userList = users?.values?.map((u) => ({ id: Number(u.id || u.key), displayName: u.displayName || u.name })) || []
  const groups = groupsData?.values || []

  const archived = !!(project as { archived?: boolean }).archived
  const tabs = [
    {
      id: 'details',
      label: tr('Details'),
      content: (
        <div className="max-w-xl space-y-6">
          <ProjectSettingsForm
            project={project}
            users={userList}
            onUpdate={handleUpdateProject}
            onUploadAvatar={handleUploadAvatar}
            isUpdating={updateProject.isPending}
            isUploading={uploadAvatar.isPending}
          />
          <PublicAccessPanel projectKey={key} isPublic={!!(project as { isPublic?: boolean }).isPublic} publicIndexing={(project as { publicIndexing?: string }).publicIndexing} publicBoard={!!(project as { publicBoard?: boolean }).publicBoard} publicRoadmap={!!(project as { publicRoadmap?: boolean }).publicRoadmap} />
        </div>
      ),
    },
    {
      id: 'components',
      label: tr('Components'),
      content: (
        <ComponentManager
          components={components || []}
          users={userList}
          isLoading={componentsLoading}
          onCreate={handleCreateComponent}
          onUpdate={handleUpdateComponent}
          onDelete={handleDeleteComponent}
          isMutating={isMutating}
        />
      ),
    },
    {
      id: 'versions',
      label: tr('Versions'),
      content: (
        <VersionManager
          versions={versions || []}
          isLoading={versionsLoading}
          onCreate={handleCreateVersion}
          onUpdate={handleUpdateVersion}
          onDelete={handleDeleteVersion}
          isMutating={isMutating}
          reportHref={projectBoards?.values[0] ? (id) => `/reports?report=version&board=${projectBoards.values[0].id}&version=${id}` : undefined}
        />
      ),
    },
    { id: 'schemes', label: tr('Schemes'), content: <ProjectSchemesPanel projectKey={key} /> },
    { id: 'permissions', label: tr('Permissions'), content: <ProjectPermissionsPanel projectKey={key} /> },
    {
      id: 'features',
      label: tr('Features'),
      content: <ProjectFeaturesPanel projectKey={key} />,
    },
    {
      id: 'repositories',
      label: tr('Repositories'),
      content: <RepositoriesPanel projectKey={key} />,
    },
    { id: 'templates', label: tr('Templates'), content: <TemplateManager projectKey={key} /> },
    { id: 'recurring', label: tr('Recurring issues'), content: <RecurringPanel projectKey={key} /> },
    ...(features.isEnabled('integrations')
      ? [
          { id: 'webhooks', label: tr('Inbound webhooks'), content: <InboundSourcesPanel projectKey={key} /> },
          { id: 'chat', label: tr('Slack & Teams'), content: <NotificationChannelsPanel scope={{ project: key }} /> },
        ]
      : []),
    ...(features.isEnabled('intake')
      ? [{ id: 'intake', label: tr('Intake'), content: <IntakeSettingsPanel projectKey={key} /> }]
      : []),
    { id: 'people', label: tr('Users and roles'), content: <ProjectRolesTable projectKey={key} /> },
    { id: 'security', label: tr('Issue security'), content: <div className="max-w-xl"><ProjectSecurityPanel projectId={Number((project as { id: number | string }).id)} projectKey={key} /></div> },
    { id: 'notifications', label: tr('Notifications'), content: <ProjectNotificationsPanel projectKey={key} /> },
    { id: 'audit', label: tr('Audit log'), content: <ProjectAuditPanel projectKey={key} /> },
    { id: 'reindex', label: tr('Re-index'), content: <ProjectMaintenancePanel projectKey={key} /> },
    { id: 'lifecycle', label: tr('Archive and delete'), content: <LifecyclePanel projectKey={key} projectName={project.name} archived={archived} /> },
  ]

  return (
    <AppLayout>
      <div className="space-y-6">
        <Breadcrumb
          items={[
            { label: tr('Projects'), href: '/projects' },
            { label: project.name, href: `/projects/${key}/settings` },
            { label: tr('Settings') },
          ]}
        />
        <div>
          <h1 className="text-heading-1 text-[var(--text-primary)]">{tr('Project settings')}</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            {tr('Manage')} {project.name} {tr('details, components, versions and access.')}{' '}
            <a className="text-[var(--brand-500)] hover:underline" href={`/projects/${key}/settings/approvals`}>{tr('Approval templates')}</a>
            {features.isEnabled('intake') && <>{' · '}<a className="text-[var(--brand-500)] hover:underline" href={`/projects/${key}/intake`}>{tr('Intake queue')}</a></>}
          </p>
        </div>
        {archived && (
          <p role="status" className="rounded-lg border border-[var(--warning)] bg-[var(--surface-1)] px-4 py-3 text-[13px]">
            {tr('This project is archived and read-only. Changes are refused until a project administrator restores it (see the Archive and delete tab).')} </p>
        )}
        {/* the tabs are the "Project settings" links of the left menu; the URL (?tab=) says which one is open */}
        <Tabs tabs={tabs} activeTab={tabs.some((t) => t.id === requestedTab) ? requestedTab! : 'details'} onChange={(id) => router.replace(`/projects/${key}/settings?tab=${id}`)} hideNav />
      </div>
    </AppLayout>
  )
}

function ProjectRolePanel({
  roles,
  users,
  groups,
  isMutating,
  onAddActor,
  onRemoveActor,
}: {
  roles: { id: number; name: string; description: string | null; actors: { id: number; type: string; user: { id: number; displayName: string; username?: string } | null; group: { id: number; name: string } | null }[] }[]
  users: { id: number; username: string; displayName: string }[]
  groups: { id: string; name: string; description: string | null }[]
  isMutating: boolean
  onAddActor: (roleId: number, data: { userId?: number; groupId?: number; username?: string; groupName?: string }) => void
  onRemoveActor: (roleId: number, data: { user?: string; group?: string }) => void
}) {
  const { tr } = useI18n();

  const [activeRole, setActiveRole] = useState<number | null>(null)
  const [actorType, setActorType] = useState<'user' | 'group'>('user')
  const [search, setSearch] = useState('')

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-[var(--text-primary)]">{tr('Project roles')}</h3>
      {roles.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">{tr('No roles configured.')}</p>
      ) : (
        <div className="space-y-4">
          {roles.map((role) => (
            <div
              key={role.id}
              className="border border-[var(--surface-3)] rounded-lg p-4 bg-[var(--surface-0)]"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium text-[var(--text-primary)]">{role.name}</h4>
                  {role.description && (
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5">{role.description}</p>
                  )}
                </div>
                <span className="text-xs text-[var(--text-tertiary)]">
                  {role.actors.length === 1 ? tr('{n} actor', { n: role.actors.length }) : tr('{n} actors', { n: role.actors.length })}
                </span>
              </div>

              {role.actors.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {role.actors.map((actor) => (
                    <span
                      key={actor.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--surface-3)]"
                    >
                      {actor.user?.displayName || actor.group?.name || tr('Unknown')}
                      <button
                        onClick={() =>
                          onRemoveActor(role.id, {
                            user: actor.type === 'user' ? actor.user?.username || undefined : undefined,
                            group: actor.type === 'group' ? actor.group?.name || undefined : undefined,
                          })
                        }
                        disabled={isMutating}
                        className="text-[var(--text-tertiary)] hover:text-[var(--error)] disabled:opacity-50"
                        title={tr('Remove')}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => setActiveRole(activeRole === role.id ? null : role.id)}
                  className="veqsio-btn-secondary text-sm flex items-center gap-1.5"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  {tr('Add actor')} </button>
              </div>

              {activeRole === role.id && (
                <div className="mt-3 bg-[var(--surface-1)] border border-[var(--surface-3)] rounded-lg p-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <select
                      value={actorType}
                      onChange={(e) => {
                        setActorType(e.target.value as 'user' | 'group')
                        setSearch('')
                      }}
                      className="veqsio-input text-sm"
                    >
                      <option value="user">{tr('User')}</option>
                      <option value="group">{tr('Group')}</option>
                    </select>
                    <div className="relative flex-1">
                      <div className="flex items-center gap-2">
                        <Search className="w-4 h-4 text-[var(--text-tertiary)]" />
                        <input
                          type="text"
                          placeholder={actorType === 'user' ? tr('Search users...') : tr('Select group...')}
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          className="veqsio-input flex-1 text-sm"
                        />
                      </div>
                      {actorType === 'user' && search && (
                        <div className="absolute z-50 w-full mt-1 bg-[var(--surface-0)] border border-[var(--surface-3)] rounded-lg shadow-lg py-1 max-h-48 overflow-auto">
                          {users
                            .filter(
                              (u) =>
                                (u.displayName.toLowerCase().includes(search.toLowerCase()) ||
                                  u.username.toLowerCase().includes(search.toLowerCase())) &&
                                !role.actors.some(
                                  (a) => a.type === 'user' && a.user?.id === u.id
                                )
                            )
                            .slice(0, 10)
                            .map((u) => (
                              <button
                                key={u.id}
                                onClick={() => {
                                  onAddActor(role.id, { username: u.username })
                                  setSearch('')
                                }}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--surface-2)] text-[var(--text-primary)]"
                              >
                                {u.displayName}{' '}
                                <span className="text-[var(--text-tertiary)]">({u.username})</span>
                              </button>
                            ))}
                        </div>
                      )}
                      {actorType === 'group' && (
                        <div className="absolute z-50 w-full mt-1 bg-[var(--surface-0)] border border-[var(--surface-3)] rounded-lg shadow-lg py-1 max-h-48 overflow-auto">
                          {groups
                            .filter(
                              (g) =>
                                g.name.toLowerCase().includes(search.toLowerCase()) &&
                                !role.actors.some(
                                  (a) => a.type === 'group' && a.group?.id === Number(g.id)
                                )
                            )
                            .map((g) => (
                              <button
                                key={g.id}
                                onClick={() => {
                                  onAddActor(role.id, { groupName: g.name })
                                  setSearch('')
                                }}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--surface-2)] text-[var(--text-primary)]"
                              >
                                {g.name}
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
