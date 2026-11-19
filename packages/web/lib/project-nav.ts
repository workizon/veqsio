/**
 * Navigation of one project: the work links everybody with access sees, and the settings links that only project
 * administrators see (the left menu inside a project, like Jira's). Pure, so the rules are unit tested.
 */

export interface ProjectLink { id: string; label: string; href: string; feature?: string; group?: string }

const ISSUE_PATH = /^\/issues\/([A-Za-z][A-Za-z0-9_]*)-\d+(?:\/|$)/
export const PROJECT_PATH = /^\/projects\/([A-Za-z][A-Za-z0-9_]*)(?:\/|$)/

/** The project key when the path is inside a project (not the project list), else null. */
export function projectKeyFromPath(pathname: string): string | null {
  const m = PROJECT_PATH.exec(pathname)
  if (m) return m[1]
  // An issue page (/issues/ABC-12) belongs to the project in its key, so the project menu stays at hand there too.
  const issue = ISSUE_PATH.exec(pathname)
  return issue ? issue[1] : null
}

/** Global pages the project menu links to (Issues, Board, Backlog...): the project menu stays visible there for the project you came from. */
export const PROJECT_CONTEXT_PATHS = ['/issues', '/boards', '/backlog', '/roadmap', '/reports']
export const isProjectContextPath = (pathname: string) => PROJECT_CONTEXT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

/**
 * Which project's menu to show: the project in the path, else (on the global pages above) the last project visited
 * in this tab, else none. Pure; the layout keeps `remembered` in sessionStorage.
 */
export function resolveProjectContext(pathname: string, remembered: string | null): { key: string | null; remember: string | null } {
  const fromPath = projectKeyFromPath(pathname)
  if (fromPath) return { key: fromPath, remember: fromPath }
  if (isProjectContextPath(pathname) && remembered) return { key: remembered, remember: remembered }
  return { key: null, remember: null }
}

export function projectWorkLinks(key: string): ProjectLink[] {
  const k = encodeURIComponent(key)
  return [
    { id: 'overview', label: 'Overview', href: `/projects/${k}` },
    { id: 'issues', label: 'Issues', href: `/issues?jql=${encodeURIComponent(`project = ${key}`)}` },
    { id: 'board', label: 'Board', href: '/boards' },
    { id: 'backlog', label: 'Backlog', href: '/backlog' },
    { id: 'roadmap', label: 'Roadmap', href: '/roadmap', feature: 'roadmap' },
    { id: 'releases', label: 'Releases', href: `/projects/${k}/releases` },
    { id: 'reports', label: 'Reports', href: '/reports' },
  ]
}

/** Ids match the tabs of the project settings page; `group` is the heading they sit under in the left menu (Jira-style sections). */
export const PROJECT_SETTINGS_TABS: Array<{ id: string; label: string; group: string; feature?: string }> = [
  { id: 'details', label: 'Details', group: 'General' },
  { id: 'features', label: 'Features', group: 'General' },
  { id: 'audit', label: 'Audit log', group: 'General' },
  { id: 'reindex', label: 'Re-index', group: 'General' },
  { id: 'lifecycle', label: 'Archive and delete', group: 'General' },
  { id: 'schemes', label: 'Schemes', group: 'Issues' },
  { id: 'templates', label: 'Templates', group: 'Issues' },
  { id: 'recurring', label: 'Recurring issues', group: 'Issues' },
  { id: 'versions', label: 'Versions', group: 'Structure' },
  { id: 'components', label: 'Components', group: 'Structure' },
  { id: 'people', label: 'Users and roles', group: 'Access' },
  { id: 'permissions', label: 'Permissions', group: 'Access' },
  { id: 'security', label: 'Issue security', group: 'Access' },
  { id: 'notifications', label: 'Notifications', group: 'Access' },
  { id: 'repositories', label: 'Repositories', group: 'Integrations' },
  { id: 'webhooks', label: 'Inbound webhooks', group: 'Integrations', feature: 'integrations' },
  { id: 'chat', label: 'Slack & Teams', group: 'Integrations', feature: 'integrations' },
  { id: 'intake', label: 'Intake', group: 'Integrations', feature: 'intake' },
]

export function projectSettingsLinks(key: string, isEnabled: (feature?: string) => boolean): ProjectLink[] {
  const k = encodeURIComponent(key)
  return PROJECT_SETTINGS_TABS.filter((t) => isEnabled(t.feature)).map((t) => ({ id: t.id, label: t.label, href: `/projects/${k}/settings?tab=${t.id}`, feature: t.feature, group: t.group }))
}

/** Which link is current. Settings links are matched by their `tab` query value, the rest by path. */
export function isActiveProjectLink(link: ProjectLink, pathname: string, tab: string | null): boolean {
  const [path, query] = link.href.split('?')
  if (link.href.includes('/settings?tab=')) return pathname === path && (tab ?? 'details') === new URLSearchParams(query).get('tab')
  if (link.id === 'overview') return pathname === path
  return pathname === path
}

/** A project administrator: the project permission, or a system administrator. */
export function canAdministerProject(perms: Record<string, { havePermission?: boolean } | undefined> | undefined): boolean {
  return !!(perms?.PROJECT_ADMIN?.havePermission || perms?.ADMINISTER_PROJECTS?.havePermission || perms?.SYSTEM_ADMIN?.havePermission)
}
