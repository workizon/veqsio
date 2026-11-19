/**
 * The one table of navigable routes. The top navigation, the administration menu and the command palette
 * all read from here so a new page only has to be added once.
 */

export interface NavLink { label: string; href: string; hint?: string; feature?: string }
export interface NavGroup { label: string; match: string[]; items?: NavLink[]; href?: string; projects?: boolean; feature?: string }

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Your work',
    match: ['/dashboard', '/overview', '/profile'],
    items: [
      { label: 'Home', href: '/dashboard?home=1', hint: 'Assigned to me and recent activity' },
      { label: 'My dashboards', href: '/dashboards', hint: 'Your personal workspace and widgets', feature: 'dashboards' },
      { label: 'Workspace overview', href: '/overview', hint: 'Recent activity across the workspace' },
      { label: 'My approvals', href: '/approvals', hint: 'Requests waiting for your decision', feature: 'approvals' },
      { label: 'Profile', href: '/profile' },
    ],
  },
  { label: 'Projects', match: ['/projects', '/initiatives', '/teams', '/customers'], projects: true, items: [{ label: 'All projects', href: '/projects' }, { label: 'Customers', href: '/customers', hint: 'Who is waiting for which issue, and how much they matter' }, { label: 'Teamspaces', href: '/teams', hint: 'Teams, their projects and their open work' }, { label: 'Initiatives', href: '/initiatives', hint: 'Group epics and projects into one goal', feature: 'initiatives' }, { label: 'Intake', href: '/triage', hint: 'Triage incoming requests', feature: 'intake' }] },
  {
    label: 'Filters',
    match: ['/issues', '/filters', '/views'],
    items: [
      { label: 'Search issues', href: '/issues', hint: 'Basic or JQL search' },
      { label: 'Saved filters', href: '/filters' },
      { label: 'Views', href: '/views', hint: 'Saved queries as list, table, board, calendar or timeline', feature: 'views' },
      { label: 'Create issue', href: '/issues/create' },
    ],
  },
  {
    label: 'Dashboards',
    feature: 'dashboards',
    match: ['/dashboards'],
    items: [{ label: 'View all dashboards', href: '/dashboards' }],
  },
  {
    label: 'Boards',
    match: ['/boards', '/backlog'],
    items: [
      { label: 'Boards', href: '/boards', hint: 'Scrum and Kanban' },
      { label: 'Backlog', href: '/backlog', hint: 'Plan sprints' },
    ],
  },
  { label: 'Service Desk', match: ['/servicedesk', '/portal'], href: '/servicedesk', feature: 'servicedesk' },
  {
    label: 'More',
    match: ['/reports', '/automation', '/roadmap', '/calendar', '/pages'],
    items: [
      { label: 'Reports', href: '/reports', hint: 'Burndown, velocity, flow' },
      { label: 'Pages', href: '/pages', hint: 'Wiki for the workspace and projects', feature: 'pages' },
      { label: 'Roadmap', href: '/roadmap', feature: 'roadmap' },
      { label: 'Calendar', href: '/calendar', hint: 'Issues by due date' },
      { label: 'Automation', href: '/automation', feature: 'automation' },
    ],
  },
]

export const ADMIN_LINKS: NavLink[] = [
  { label: 'Personal settings', href: '/settings' },
  { label: 'Workflows', href: '/admin/workflows' },
  { label: 'Issue link types', href: '/admin/link-types' },
  { label: 'Global issue templates', href: '/admin/issue-templates', hint: 'Templates offered in every project' },
  { label: 'Notifications', href: '/admin/notifications' },
  { label: 'Issue security', href: '/admin/issue-security', hint: 'Who can see issues with a security level' },
  { label: 'Permission helper', href: '/admin/permission-helper', hint: 'Why a user can or cannot do something' },
  { label: 'Permission review', href: '/admin/permission-review', hint: 'Who has access to which project, for audits' },
  { label: 'Notification helper', href: '/admin/notification-helper', hint: 'Would a user get an e-mail, and why' },
  { label: 'Audit log', href: '/admin/audit' },
  { label: 'Configuration health', href: '/admin/health', hint: 'Misconfiguration, background jobs, last verified backup' },
  { label: 'Logs and slow queries', href: '/admin/logs', hint: 'Application log, log level, slowest queries' },
  { label: 'Storage', href: '/admin/storage', hint: 'Attachment storage per project and limits' },
  { label: 'REST API reference', href: '/api-docs', hint: 'OpenAPI 3.1 description of every endpoint' },
  { label: 'Import from other tools', href: '/admin/migration' },
  { label: 'Single sign-on', href: '/admin/sso' },
  { label: 'AI agents', href: '/admin/agents', feature: 'agents' },
  { label: 'Integrations', href: '/admin/integrations', hint: 'Default Slack and Teams channels', feature: 'integrations' },
  { label: 'Features and modules', href: '/admin/features' },
  { label: 'Instance settings', href: '/admin/settings' },
  { label: 'Appearance', href: '/admin/appearance' },
  { label: 'System', href: '/admin/system' },
]

/** Settings that live as tabs of the main administration page (/admin?tab=...). Searchable from the admin helper and the palette. */
export const ADMIN_SETTINGS: NavLink[] = [
  { label: 'Users', href: '/admin?tab=users', hint: 'Create, deactivate and manage accounts' },
  { label: 'Groups', href: '/admin?tab=groups', hint: 'Group membership' },
  { label: 'Permission schemes', href: '/admin?tab=permissions', hint: 'Who can do what in a project' },
  { label: 'Issue type schemes', href: '/admin?tab=issue-types', hint: 'Which issue types a project offers' },
  { label: 'Screens', href: '/admin?tab=screens', hint: 'Fields shown when creating and editing' },
  { label: 'Field configurations', href: '/admin?tab=field-configs', hint: 'Required and hidden fields' },
  { label: 'Workflow schemes', href: '/admin?tab=workflows', hint: 'Which workflow each issue type uses' },
  { label: 'Project roles', href: '/admin?tab=roles', hint: 'Roles such as Developers and Administrators' },
  { label: 'Custom fields', href: '/admin?tab=custom-fields', hint: 'Extra fields on issues' },
  { label: 'OpenID Connect', href: '/admin?tab=oidc', hint: 'OIDC login' },
  { label: 'SAML single sign-on', href: '/admin?tab=saml', hint: 'SAML 2.0 identity providers' },
  { label: 'LDAP / Active Directory', href: '/admin?tab=ldap', hint: 'Directory sign-in and sync' },
  { label: 'SCIM provisioning', href: '/admin?tab=scim', hint: 'Automatic user provisioning' },
  { label: 'Application links', href: '/admin?tab=apps', hint: 'Link to other applications' },
  { label: 'CSV import', href: '/admin?tab=import', hint: 'Import issues from a CSV file' },
  { label: 'System info', href: '/admin?tab=info', hint: 'Version, uptime and database' },
]

export interface PageEntry { label: string; href: string; section: string; hint?: string }

/** Every distinct page reachable from the top navigation and the administration menu. */
export function allPages(): PageEntry[] {
  const seen = new Set<string>()
  const out: PageEntry[] = []
  const add = (label: string, href: string, section: string, hint?: string) => {
    if (seen.has(href)) return
    seen.add(href)
    out.push({ label, href, section, hint })
  }
  for (const g of NAV_GROUPS) {
    if (g.href) add(g.label, g.href, g.label)
    for (const l of g.items ?? []) add(l.label, l.href, g.label, l.hint)
  }
  for (const l of ADMIN_LINKS) add(l.label, l.href, 'Administration', l.hint)
  for (const l of ADMIN_SETTINGS) add(l.label, l.href, 'Administration', l.hint)
  return out
}

/** Pages on which the app chrome (palette, shortcuts) must stay out of the way. */
export function isChromeFreeRoute(pathname: string): boolean {
  return ['/login', '/forgot-password', '/reset-password', '/portal', '/intake'].some((p) => pathname === p || pathname.startsWith(p + '/'))
}
