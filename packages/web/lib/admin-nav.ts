/**
 * Administration is organised in sections, like Jira's settings: each page is reachable from the sidebar in the
 * section where an administrator expects it. Entries of ADMIN_LINKS / ADMIN_SETTINGS that are not placed here
 * (for example a page added later) still show up under "More".
 */
import { ADMIN_LINKS, ADMIN_SETTINGS, type NavLink } from './routes'

export interface AdminSection { id: string; title: string; description: string; items: NavLink[] }

const L = (label: string, href: string, hint?: string, feature?: string): NavLink => ({ label, href, hint, feature })

const BASE: AdminSection[] = [
  {
    id: 'users', title: 'User management', description: 'Accounts, groups and how people sign in',
    items: [
      L('Users', '/admin?tab=users', 'Create, deactivate and manage accounts'),
      L('Groups', '/admin?tab=groups', 'Group membership'),
      L('Single sign-on', '/admin/sso', 'Sign in through an identity provider'),
      L('SAML single sign-on', '/admin?tab=saml', 'SAML 2.0 identity provider'),
      L('OpenID Connect', '/admin?tab=oidc', 'OIDC login'),
      L('LDAP / Active Directory', '/admin?tab=ldap', 'Directory sync and directory login'),
      L('SCIM provisioning', '/admin?tab=scim', 'Automatic user provisioning'),
      L('AI agents', '/admin/agents', 'Service accounts for AI agents', 'agents'),
    ],
  },
  {
    id: 'projects', title: 'Projects', description: 'Roles, templates and what a new project starts with',
    items: [
      L('All projects', '/projects', 'Browse, archive and restore projects'),
      L('Project roles', '/admin?tab=roles', 'Roles such as Developers and Administrators'),
      L('Global issue templates', '/admin/issue-templates', 'Templates offered in every project'),
    ],
  },
  {
    id: 'issues', title: 'Issues', description: 'Types, fields, workflows and notifications',
    items: [
      L('Issue types', '/admin/issue-types', 'Create your own issue types'),
      L('Issue type schemes', '/admin?tab=issue-types', 'Which issue types a project offers'),
      L('Priority schemes', '/admin/priority-schemes', 'Which priorities a project offers'),
      L('Custom fields', '/admin?tab=custom-fields', 'Extra fields on issues'),
      L('Screens', '/admin?tab=screens', 'Fields shown when creating and editing'),
      L('Field configurations', '/admin?tab=field-configs', 'Required and hidden fields'),
      L('Workflows', '/admin/workflows', 'Statuses and transitions'),
      L('Workflow schemes', '/admin?tab=workflows', 'Which workflow each issue type uses'),
      L('Issue link types', '/admin/link-types'),
      L('Notifications', '/admin/notifications', 'Notification schemes and e-mail'),
      L('Notification helper', '/admin/notification-helper', 'Would a user get an e-mail, and why'),
    ],
  },
  {
    id: 'security', title: 'Security', description: 'Permissions, audit and policies',
    items: [
      L('Permission schemes', '/admin?tab=permissions', 'Who can do what in a project'),
      L('Permission helper', '/admin/permission-helper', 'Why a user can or cannot do something'),
      L('Permission review', '/admin/permission-review', 'Who has access to which project, for audits'),
      L('Issue security', '/admin/issue-security', 'Security levels that hide issues'),
      L('On-call schedules', '/admin/oncall', 'Who is on call, rotations and overrides'),
      L('Audit log', '/admin/audit'),
      L('Instance settings', '/admin/settings', 'Password policy, attachments, public access, announcement'),
    ],
  },
  {
    id: 'apps', title: 'Apps and integrations', description: 'Features, modules, plugins and connections',
    items: [
      L('Features and modules', '/admin/features', 'Switch parts of the product on or off'),
      L('Plugins', '/admin/plugins'),
      L('Integrations', '/admin/integrations', 'Default Slack and Teams channels', 'integrations'),
      L('Application links', '/admin?tab=apps', 'Link to other applications'),
      L('AI assist', '/admin/ai'),
      L('REST API reference', '/api-docs', 'OpenAPI description of the REST API'),
    ],
  },
  {
    id: 'import', title: 'Import and migration', description: 'Bring data in from other tools',
    items: [
      L('Import from other tools', '/admin/migration', 'Jira, Linear, Asana, ClickUp, JSON'),
      L('CSV import', '/admin?tab=import', 'Import issues from a CSV file'),
    ],
  },
  {
    id: 'system', title: 'System', description: 'Licence, health, appearance and server',
    items: [
      L('General configuration', '/admin/system', 'Site name, mail server, backup'),
      L('Licence', '/admin/license'),
      L('Appearance', '/admin/appearance'),
      L('Configuration health', '/admin/health'),
      L('Logs and slow queries', '/admin/logs', 'Application log, log level, slowest queries'),
      L('Storage', '/admin/storage', 'Attachment storage per project and limits'),
      L('System info', '/admin?tab=info', 'Version, uptime and database'),
    ],
  },
]

export function adminSections(extra: NavLink[] = [], links: NavLink[] = [...ADMIN_LINKS, ...ADMIN_SETTINGS]): AdminSection[] {
  const placed = new Set(BASE.flatMap((s) => s.items.map((i) => i.href)))
  const sections = BASE.map((s) => ({ ...s, items: [...s.items] }))
  const loose = [...links, ...extra].filter((l) => !placed.has(l.href) && l.href !== '/settings' && !placed.has(l.href))
  const seen = new Set<string>()
  const more = loose.filter((l) => (seen.has(l.href) ? false : (seen.add(l.href), true)))
  if (more.length) sections.push({ id: 'more', title: 'More', description: 'Other administration pages', items: more })
  return sections
}

/** The entry that is "current" for a path and query (the `tab` query selects entries of /admin). */
export function isActiveAdminLink(href: string, pathname: string, tab: string | null): boolean {
  const [path, query] = href.split('?')
  const wantTab = query?.startsWith('tab=') ? query.slice(4) : null
  if (path === '/admin') return pathname === '/admin' && wantTab !== null && wantTab === tab
  return pathname === path || pathname.startsWith(path + '/')
}
