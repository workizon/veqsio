/**
 * The module manifest (`veqsio.module.json`): the single declarative description of a module.
 * The API validates it when the module is discovered; the admin UI renders the catalogue, the
 * settings form and the permission consent from it; the web app reads the `contributes.web`
 * section (filtered by what is enabled and licensed) to place nav items, panels and gadgets.
 */
import { z } from 'zod'
import { SEMVER_RE, isValidRange } from './semver'

export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/

/** Veqsio permission keys a route may require (mirror of the API's rbac types; a test keeps them in sync). */
export const GLOBAL_PERMISSION_KEYS = ['SYSTEM_ADMIN', 'ADMINISTER', 'BROWSE_USERS', 'CREATE_PROJECT', 'MANAGE_GROUP_FILTER_SUBSCRIPTIONS'] as const
export const PROJECT_PERMISSION_KEYS = [
  'PROJECT_ADMIN', 'ADMINISTER_PROJECTS', 'BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'DELETE_ISSUES', 'TRANSITION_ISSUES',
  'ASSIGN_ISSUES', 'ASSIGNABLE_USER', 'RESOLVE_ISSUES', 'CLOSE_ISSUES', 'MODIFY_REPORTER', 'CREATE_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS',
  'DELETE_OWN_ATTACHMENTS', 'COMMENT_ISSUE', 'ADD_COMMENTS', 'DELETE_ALL_COMMENTS', 'DELETE_OWN_COMMENTS', 'EDIT_ALL_COMMENTS',
  'EDIT_OWN_COMMENTS', 'WORK_ON_ISSUES', 'LINK_ISSUES', 'MANAGE_WATCHERS', 'VIEW_VOTERS_AND_WATCHERS', 'MANAGE_SPRINTS', 'SET_ISSUE_SECURITY',
] as const
/** Pseudo permissions understood by the dispatcher in addition to the keys above. */
export const PSEUDO_PERMISSIONS = ['public', 'authenticated', 'admin'] as const

export type RoutePermission = (typeof PSEUDO_PERMISSIONS)[number] | (typeof GLOBAL_PERMISSION_KEYS)[number] | (typeof PROJECT_PERMISSION_KEYS)[number]
const ROUTE_PERMISSIONS = [...PSEUDO_PERMISSIONS, ...GLOBAL_PERMISSION_KEYS, ...PROJECT_PERMISSION_KEYS] as [RoutePermission, ...RoutePermission[]]

/** Capabilities a module asks for. Shown to the administrator at install time. */
export const MODULE_CAPABILITIES = [
  'issues:read', 'issues:write', 'comments:read', 'comments:write', 'worklogs:read', 'worklogs:write',
  'projects:read', 'users:read', 'sprints:read', 'events:subscribe', 'database:own-tables',
] as const
export type ModuleCapability = (typeof MODULE_CAPABILITIES)[number]

export const MODULE_EVENT_NAMES = [
  'issue.created', 'issue.updated', 'issue.transitioned', 'issue.deleted', 'comment.created',
  'worklog.created', 'worklog.updated', 'worklog.deleted', 'sprint.started', 'sprint.completed',
] as const
export type ModuleEventName = (typeof MODULE_EVENT_NAMES)[number]

/* ------------------------------------------------------------------ */
/*  Settings schema (JSON-schema-like subset)                          */
/* ------------------------------------------------------------------ */

const settingBase = {
  title: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  /** Rendered as a password input; never returned by the API once saved. */
  secret: z.boolean().optional(),
}

export const settingPropertySchema = z.discriminatedUnion('type', [
  z.object({
    ...settingBase,
    type: z.literal('string'),
    default: z.string().optional(),
    enum: z.array(z.string()).min(1).optional(),
    enumLabels: z.record(z.string()).optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).optional(),
    pattern: z.string().optional(),
    /** `textarea` renders a multi line input; `url` and `email` add format validation. */
    format: z.enum(['textarea', 'url', 'email']).optional(),
  }),
  z.object({
    ...settingBase,
    type: z.enum(['number', 'integer']),
    default: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  }),
  z.object({ ...settingBase, type: z.literal('boolean'), default: z.boolean().optional() }),
])
export type SettingProperty = z.infer<typeof settingPropertySchema>

export const settingsSchema = z.object({
  type: z.literal('object').default('object'),
  properties: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), settingPropertySchema),
  required: z.array(z.string()).optional(),
})
export type SettingsSchema = z.infer<typeof settingsSchema>

/* ------------------------------------------------------------------ */
/*  Contributions                                                      */
/* ------------------------------------------------------------------ */

const key = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'keys are lowercase letters, digits and dashes')
const title = z.string().min(1).max(60)
const icon = z.string().min(1).max(40).optional()
const relPath = z.string().regex(/^[a-z0-9][a-z0-9/_-]*$/, 'paths are relative, e.g. "notes" or "reports/summary"')
/** Optional visibility gate for UI contributions, evaluated by the server in /modules/active. */
const uiPermission = z.enum(ROUTE_PERMISSIONS).optional()

export const contributesWebSchema = z.object({
  /** `hidden`: the page is served under /m/<id>/<path> but is not shown in the top navigation (the module links to it itself). */
  navItems: z.array(z.object({ key, title, path: relPath, icon, permission: uiPermission, hidden: z.boolean().optional() })).default([]),
  adminPages: z.array(z.object({ key, title, path: relPath, icon, description: z.string().max(200).optional() })).default([]),
  projectTabs: z.array(z.object({ key, title, path: relPath, icon, permission: uiPermission })).default([]),
  issuePanels: z.array(z.object({ key, title, location: z.enum(['sidebar', 'content']).default('sidebar'), permission: uiPermission })).default([]),
  gadgets: z.array(z.object({
    key, title,
    description: z.string().max(200).optional(),
    category: z.string().min(1).max(40).default('Apps'),
    icon,
    defaultSize: z.object({ w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(12) }).default({ w: 1, h: 1 }),
    configSchema: settingsSchema.optional(),
  })).default([]),
  issueListActions: z.array(z.object({ key, title, icon })).default([]),
  commands: z.array(z.object({ key, title, group: z.string().min(1).max(40).default('Apps') })).default([]),
}).default({})

const routeDeclSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*']),
  /** Hono style path relative to /rest/modules/<id>, e.g. `/notes/:id`. `*` matches any suffix. */
  path: z.string().regex(/^\/[A-Za-z0-9_:/*.-]*$/, 'route paths start with / and use :param or *'),
  permission: z.enum(ROUTE_PERMISSIONS),
  /** Name of a path or query parameter holding a project key: the permission is then checked in that project. */
  project: z.string().optional(),
  /** Name of a path or query parameter holding an issue key: the permission is checked in the issue's project. */
  issue: z.string().optional(),
}).refine((r) => !(r.project && r.issue), { message: 'declare either project or issue, not both' })
export type RouteDecl = z.infer<typeof routeDeclSchema>

export const contributesServerSchema = z.object({
  routes: z.array(routeDeclSchema).default([]),
  events: z.array(z.enum(MODULE_EVENT_NAMES)).default([]),
}).default({})

export const manifestSchema = z.object({
  id: z.string().regex(MODULE_ID_RE, 'id must be a lowercase slug (3-40 chars: a-z, 0-9, dashes)'),
  name: z.string().min(1).max(60),
  version: z.string().regex(SEMVER_RE, 'version must be semver, e.g. 1.2.0'),
  vendor: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  /** Long description (plain text paragraphs) for the detail drawer. */
  longDescription: z.string().max(5000).optional(),
  /** Lucide icon name, e.g. `clock`, `map`, `sticky-note`. Unknown names fall back to a puzzle piece. */
  icon: z.string().min(1).max(40).default('puzzle'),
  tags: z.array(z.string().min(1).max(30)).max(10).default([]),
  /** SPDX id or free text, e.g. `AGPL-3.0-or-later` or `Proprietary`. */
  license: z.string().min(1).max(80),
  edition: z.enum(['community', 'enterprise']).default('community'),
  /** Licence feature key checked with licence.has(feature). Required for enterprise modules. */
  feature: z.string().regex(/^[a-z][a-z0-9._-]{1,59}$/).optional(),
  engines: z.object({ veqsio: z.string().refine(isValidRange, 'not a valid semver range') }),
  dependencies: z.record(z.string().regex(MODULE_ID_RE), z.string().refine(isValidRange, 'not a valid semver range')).default({}),
  permissions: z.array(z.enum(MODULE_CAPABILITIES)).default([]),
  settings: settingsSchema.optional(),
  contributes: z.object({ web: contributesWebSchema, server: contributesServerSchema }).default({}),
  changelog: z.array(z.object({ version: z.string().regex(SEMVER_RE), date: z.string().optional(), notes: z.string().max(1000) })).default([]),
  /** Screenshot URLs (relative to the web app or absolute). Rendered by the detail drawer. */
  screenshots: z.array(z.string()).max(8).default([]),
  /** Dev / reference modules are hidden from the catalogue unless VEQSIO_DEV_MODULES=1. */
  devOnly: z.boolean().default(false),
}).superRefine((m, ctx) => {
  if (m.edition === 'enterprise' && !m.feature) {
    ctx.addIssue({ code: 'custom', path: ['feature'], message: 'enterprise modules must declare the licence feature key they require' })
  }
  if (m.dependencies[m.id]) ctx.addIssue({ code: 'custom', path: ['dependencies', m.id], message: 'a module cannot depend on itself' })
  if (m.contributes.server.events.length && !m.permissions.includes('events:subscribe')) {
    ctx.addIssue({ code: 'custom', path: ['permissions'], message: 'subscribing to events requires the "events:subscribe" permission' })
  }
  for (const r of m.settings?.required ?? []) {
    if (!m.settings!.properties[r]) ctx.addIssue({ code: 'custom', path: ['settings', 'required'], message: `required setting "${r}" is not defined` })
  }
  const dup = (label: string, keys: string[]) => {
    const seen = new Set<string>()
    for (const k of keys) {
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['contributes', 'web', label], message: `duplicate key "${k}" in ${label}` })
      seen.add(k)
    }
  }
  const w = m.contributes.web
  dup('navItems', w.navItems.map((x) => x.key))
  dup('adminPages', w.adminPages.map((x) => x.key))
  dup('projectTabs', w.projectTabs.map((x) => x.key))
  dup('issuePanels', w.issuePanels.map((x) => x.key))
  dup('gadgets', w.gadgets.map((x) => x.key))
  dup('issueListActions', w.issueListActions.map((x) => x.key))
  dup('commands', w.commands.map((x) => x.key))
})

/** Input shape (before defaults are applied): what a module author writes. */
export type ModuleManifestInput = z.input<typeof manifestSchema>
/** Parsed shape (defaults applied). */
export type ModuleManifest = z.output<typeof manifestSchema>
export type WebContributions = ModuleManifest['contributes']['web']

export class ManifestError extends Error {
  constructor(public readonly moduleId: string, public readonly issues: string[]) {
    super(`Invalid manifest for module "${moduleId}":\n - ${issues.join('\n - ')}`)
    this.name = 'ManifestError'
  }
}

/** Validates unknown JSON. Throws ManifestError listing every problem with its path. */
export function parseManifest(raw: unknown): ModuleManifest {
  const r = manifestSchema.safeParse(raw)
  if (!r.success) {
    const id = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : '(unknown)'
    throw new ManifestError(id, r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  return r.data
}

/** Prefix every table of a module must use, derived from the id: `example-notes` -> `example_notes_`. */
export function moduleTablePrefix(id: string): string {
  return id.replace(/-/g, '_') + '_'
}
