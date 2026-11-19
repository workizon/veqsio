/**
 * Pure helpers for the admin audit log: which requests count as admin actions,
 * and CSV serialisation. No DB access here so everything is unit-testable.
 *
 * Secrets: we never look at request or response bodies for values. Only the
 * method, the route, path/query identifiers and the *names* of JSON body fields
 * are ever recorded.
 */

export interface AuditClassification {
  action: string
  targetType: string
  /** Identifier taken from the route, or null. */
  target: string | null
}

type VerbMode = 'method' | 'member' | 'fixed'

interface Rule {
  re: RegExp
  type: string
  entity: string
  /** 'method' (default): derive CREATED/UPDATED/DELETED from the HTTP method. */
  mode?: VerbMode
  /** Verb used when mode === 'fixed'. */
  verb?: string
  /** Capture-group index for the target in the path. */
  idGroup?: number
  /** Query-string parameter holding the target identifier. */
  query?: string
  /** Append the first non-numeric sub-path segment (after `base`) to the entity. */
  subBase?: string
}

const END = '/?$'

// Order matters: first match wins, so specific rules precede generic ones.
const RULES: Rule[] = [
  // users & groups
  { re: new RegExp(`^/rest/api/2/user${END}`), type: 'user', entity: 'USER', query: 'username' },
  { re: new RegExp(`^/rest/api/2/group/(?:member|user)${END}`), type: 'group', entity: 'GROUP_MEMBER', mode: 'member', query: 'groupname' },
  { re: new RegExp(`^/rest/api/2/group${END}`), type: 'group', entity: 'GROUP', query: 'groupname' },
  // permission schemes
  { re: /^\/rest\/api\/2\/permissionscheme\/(\d+)\/assign$/, type: 'permission_scheme', entity: 'PERMISSION_SCHEME', mode: 'fixed', verb: 'ASSIGNED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/permissionscheme\/(\d+)\/copy$/, type: 'permission_scheme', entity: 'PERMISSION_SCHEME', mode: 'fixed', verb: 'COPIED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/permissionscheme(?:\/(\d+))?$/, type: 'permission_scheme', entity: 'PERMISSION_SCHEME', idGroup: 1 },
  // global permissions (for when an endpoint exposes them)
  { re: /^\/rest\/api\/2\/(?:admin\/)?globalpermission(?:\/([^/]+))?$/i, type: 'global_permission', entity: 'GLOBAL_PERMISSION', idGroup: 1 },
  // workflow schemes and other admin schemes
  { re: /^\/rest\/api\/2\/admin\/workflowscheme\/(\d+)\/assign$/, type: 'workflow_scheme', entity: 'WORKFLOW_SCHEME', mode: 'fixed', verb: 'ASSIGNED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/workflowscheme(?:\/(\d+))?$/, type: 'workflow_scheme', entity: 'WORKFLOW_SCHEME', idGroup: 1 },
  // workflow designer: workflows, their transitions/layout, and statuses
  { re: /^\/rest\/api\/2\/admin\/workflow(?:\/(\d+))?(?:\/.*)?$/, type: 'workflow', entity: 'WORKFLOW', idGroup: 1, subBase: 'workflow' },
  { re: /^\/rest\/api\/2\/admin\/status(?:\/(\d+))?$/, type: 'status', entity: 'STATUS', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/linktype(?:\/(\d+))?$/, type: 'link_type', entity: 'LINK_TYPE', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/issuetypescheme\/(\d+)\/assign$/, type: 'issue_type_scheme', entity: 'ISSUE_TYPE_SCHEME', mode: 'fixed', verb: 'ASSIGNED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/issuetypescheme(?:\/(\d+))?$/, type: 'issue_type_scheme', entity: 'ISSUE_TYPE_SCHEME', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/screen(?:\/(\d+))?(?:\/.*)?$/, type: 'screen', entity: 'SCREEN', idGroup: 1, subBase: 'screen' },
  { re: /^\/rest\/api\/2\/admin\/issuesecurity(?:\/(\d+))?(?:\/.*)?$/, type: 'issue_security', entity: 'ISSUE_SECURITY', idGroup: 1, subBase: 'issuesecurity' },
  { re: /^\/rest\/api\/2\/admin\/fieldconfiguration(?:\/(\d+))?$/, type: 'field_configuration', entity: 'FIELD_CONFIGURATION', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/projectrole(?:\/(\d+))?(?:\/.*)?$/, type: 'project_role', entity: 'PROJECT_ROLE', idGroup: 1, subBase: 'projectrole' },
  { re: /^\/rest\/api\/2\/admin\/customfield(?:\/(\d+))?(?:\/.*)?$/, type: 'custom_field', entity: 'CUSTOM_FIELD', idGroup: 1, subBase: 'customfield' },
  // licence key (the key itself is never recorded, only that it changed)
  { re: /^\/rest\/api\/2\/admin\/license$/, type: 'license', entity: 'LICENSE' },
  // custom branding (names of changed fields and the slot only; images are never recorded)
  { re: /^\/rest\/api\/2\/admin\/branding\/logo\/(light|dark|favicon)$/, type: 'branding', entity: 'BRANDING_FILE', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/branding$/, type: 'branding', entity: 'BRANDING' },
  // system configuration
  { re: /^\/rest\/api\/2\/admin\/system\/config$/, type: 'system_config', entity: 'GENERAL_CONFIG', mode: 'fixed', verb: 'UPDATED' },
  { re: /^\/rest\/api\/2\/admin\/system\/mail\/test$/, type: 'mail_config', entity: 'MAIL_CONFIG', mode: 'fixed', verb: 'TESTED' },
  { re: /^\/rest\/api\/2\/admin\/system\/mail$/, type: 'mail_config', entity: 'MAIL_CONFIG', mode: 'fixed', verb: 'UPDATED' },
  { re: /^\/rest\/api\/2\/admin\/system\/backup$/, type: 'backup', entity: 'BACKUP', mode: 'fixed', verb: 'CREATED' },
  { re: /^\/rest\/api\/2\/admin\/search\/setup$/, type: 'search_index', entity: 'SEARCH_INDEX', mode: 'fixed', verb: 'REBUILT' },
  // SAML providers and LDAP directories (names of changed fields only; keys, certificates and passwords are never recorded)
  { re: /^\/rest\/api\/2\/admin\/saml\/(\d+)\/test$/, type: 'sso_config', entity: 'SAML_PROVIDER', mode: 'fixed', verb: 'TESTED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/saml(?:\/(\d+))?$/, type: 'sso_config', entity: 'SAML_PROVIDER', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/ldap\/(\d+)\/test$/, type: 'ldap_directory', entity: 'LDAP_DIRECTORY', mode: 'fixed', verb: 'TESTED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/ldap\/(\d+)\/sync$/, type: 'ldap_directory', entity: 'LDAP_DIRECTORY', mode: 'fixed', verb: 'SYNCED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/admin\/ldap(?:\/(\d+))?$/, type: 'ldap_directory', entity: 'LDAP_DIRECTORY', idGroup: 1 },
  { re: /^\/rest\/auth\/1\/sso\/settings$/, type: 'sso_config', entity: 'SSO_CONFIG', mode: 'fixed', verb: 'UPDATED' },
  // application links, webhooks, migration
  { re: /^\/rest\/api\/2\/applicationlink(?:\/(\d+))?$/, type: 'application_link', entity: 'APPLICATION_LINK', idGroup: 1 },
  { re: /^\/rest\/api\/2\/webhook(?:\/(\d+))?(?:\/test)?$/, type: 'webhook', entity: 'WEBHOOK', idGroup: 1 },
  { re: /^\/rest\/api\/2\/migration\/(?:rest\/)?(run|upload|analyze|dry-run|test)$/, type: 'migration', entity: 'MIGRATION', mode: 'fixed', verb: 'STARTED' },
  { re: /^\/rest\/api\/2\/migration\/([^/]+)\/(pause|resume)$/, type: 'migration', entity: 'MIGRATION', mode: 'fixed', verb: 'CONTROLLED', idGroup: 1 },
  // API tokens (metadata only; the token value is never recorded)
  { re: /^\/rest\/api\/2\/mypersonalaccessTokens(?:\/(\d+))?$/i, type: 'api_token', entity: 'API_TOKEN', idGroup: 1 },
  // project configuration done from the project settings screens (target = the project key, so the project's audit log finds it)
  { re: /^\/rest\/api\/2\/project\/([^/]+)\/permissions\/grant$/, type: 'project_permission', entity: 'PROJECT_PERMISSION', mode: 'fixed', verb: 'GRANTED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/project\/([^/]+)\/permissions\/revoke$/, type: 'project_permission', entity: 'PROJECT_PERMISSION', mode: 'fixed', verb: 'REVOKED', idGroup: 1 },
  { re: /^\/rest\/api\/2\/project\/([^/]+)\/role\/\d+$/, type: 'project_role_member', entity: 'PROJECT_ROLE_MEMBER', mode: 'member', idGroup: 1 },
  { re: /^\/rest\/api\/2\/project\/([^/]+)\/reindex$/, type: 'project', entity: 'PROJECT_DATA', mode: 'fixed', verb: 'REFRESHED', idGroup: 1 },
  // project deletion is an admin action; creation/update are ordinary project actions
  { re: /^\/rest\/api\/2\/project\/([^/]+)$/, type: 'project', entity: 'PROJECT', idGroup: 1 },
  // service desk configuration: request types (form builder), portal settings, organizations
  { re: /^\/rest\/servicedeskapi\/servicedesk\/(\d+)\/requesttype\/reorder$/, type: 'request_type', entity: 'REQUEST_TYPE', mode: 'fixed', verb: 'REORDERED', idGroup: 1 },
  { re: /^\/rest\/servicedeskapi\/servicedesk\/\d+\/requesttype\/(\d+)\/duplicate$/, type: 'request_type', entity: 'REQUEST_TYPE', mode: 'fixed', verb: 'DUPLICATED', idGroup: 1 },
  { re: /^\/rest\/servicedeskapi\/servicedesk\/\d+\/requesttype(?:\/(\d+))?$/, type: 'request_type', entity: 'REQUEST_TYPE', idGroup: 1 },
  { re: /^\/rest\/servicedeskapi\/servicedesk\/(\d+)\/portal-settings$/, type: 'service_desk', entity: 'SERVICE_DESK_PORTAL', mode: 'fixed', verb: 'UPDATED', idGroup: 1 },
  { re: /^\/rest\/servicedeskapi\/servicedesk\/\d+\/organization(?:\/(\d+))?$/, type: 'service_desk_organization', entity: 'SERVICE_DESK_ORGANIZATION', idGroup: 1 },
  // sprint lifecycle (planning moves and edits are ordinary user actions)
  { re: /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/start$/, type: 'sprint', entity: 'SPRINT', mode: 'fixed', verb: 'STARTED', idGroup: 1 },
  { re: /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/complete$/, type: 'sprint', entity: 'SPRINT', mode: 'fixed', verb: 'COMPLETED', idGroup: 1 },
  { re: /^\/rest\/agile\/1\.0\/sprint\/(\d+)$/, type: 'sprint_delete', entity: 'SPRINT', idGroup: 1 },
  // service desk administration (portal requests and inbound email are end-user traffic, excluded below)
  { re: /^\/rest\/servicedeskapi\/servicedesk(?:\/(\d+))?(?:\/.*)?$/, type: 'service_desk', entity: 'SERVICE_DESK', idGroup: 1, subBase: 'servicedesk' },
]

const METHOD_VERB: Record<string, string> = { POST: 'CREATED', PUT: 'UPDATED', PATCH: 'UPDATED', DELETE: 'DELETED' }
const MEMBER_VERB: Record<string, string> = { POST: 'ADDED', DELETE: 'REMOVED', PUT: 'UPDATED', PATCH: 'UPDATED' }

/** Only DELETE is audited for these (create/update are ordinary user actions). */
const ONLY_DELETE = new Set(['project'])

export function classifyRequest(
  method: string,
  path: string,
  query: (name: string) => string | undefined = () => undefined,
): AuditClassification | null {
  const m = method.toUpperCase()
  if (!METHOD_VERB[m]) return null
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  if (/^\/rest\/servicedeskapi\/(portal|inbound-email)\//.test(p)) return null
  // read-only calculator used by the calendar editor
  if (/^\/rest\/servicedeskapi\/servicedesk\/\d+\/calendar\/preview$/.test(p)) return null

  for (const rule of RULES) {
    const match = rule.re.exec(p)
    if (!match) continue
    if ((ONLY_DELETE.has(rule.type) || rule.type === 'sprint_delete') && m !== 'DELETE') return null

    const mode = rule.mode ?? 'method'
    const verb = mode === 'fixed' ? rule.verb! : mode === 'member' ? MEMBER_VERB[m] : METHOD_VERB[m]

    let entity = rule.entity
    if (rule.subBase) {
      const parts = p.split('/').filter(Boolean)
      const rest = parts.slice(parts.indexOf(rule.subBase) + 1).filter((s) => !/^\d+$/.test(s))
      if (rest.length > 0) entity = `${rule.entity}_${rest[0].toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    }

    let target: string | null = rule.idGroup ? (match[rule.idGroup] ?? null) : null
    if (!target && rule.query) target = query(rule.query) ?? null
    return { action: `${entity}_${verb}`, targetType: rule.type === 'sprint_delete' ? 'sprint' : rule.type, target: target ? sanitizeTarget(target) : null }
  }
  return null
}

function sanitizeTarget(t: string): string {
  let v = t
  try { v = decodeURIComponent(t) } catch { /* keep raw */ }
  return v.replace(/[\r\n\t]+/g, ' ').slice(0, 255)
}

/* ------------------------------------------------------------------ */
/*  CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Escapes one CSV cell. Text that a spreadsheet could interpret as a formula
 * (leading = + - @ tab or CR) is prefixed with an apostrophe (OWASP guidance),
 * then quoted when it contains separators, quotes or line breaks.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s: string
  if (value instanceof Date) s = value.toISOString()
  else if (typeof value === 'object') s = JSON.stringify(value)
  else s = String(value)
  if (typeof value !== 'number' && typeof value !== 'boolean' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const r of rows) lines.push(r.map(csvCell).join(','))
  return lines.join('\r\n') + '\r\n'
}
