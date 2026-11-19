/**
 * Server side of a module: `defineModule()`. A module's server entry (usually `src/server.ts`)
 * default-exports its result; the API imports it through its static bundled-module map.
 */
import type { Context, Hono } from 'hono'
import { parseManifest, type ModuleManifest, type ModuleManifestInput, type ModuleEventName } from './manifest'
import type { EventHandler, VeqsioEvents } from './events'
import type { SettingsValues } from './settings'

export interface ModuleLogger {
  debug(msg: string, data?: unknown): void
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
}

export interface ModuleUser {
  id: number
  username: string
  email: string
  displayName: string
}

export interface ModuleContext<DB = unknown> {
  /** The module id from the manifest. */
  moduleId: string
  /** Installed version of the module. */
  version: string
  /**
   * The application database (a drizzle instance). Phase 1 modules are trusted in-process code: stay inside your own
   * tables (prefixed with the module id, see migrations) and read core tables only as far as your declared permissions say.
   */
  db: DB
  logger: ModuleLogger
  settings: {
    /** Current settings with manifest defaults applied (secrets in clear text: server side only). */
    get(): Promise<SettingsValues>
  }
  /** The authenticated user of a request, or null. Only meaningful inside route handlers. */
  user(c: Context): ModuleUser | null
  permissions: {
    /** Global permission check for a user, e.g. `can(user, 'SYSTEM_ADMIN')`. */
    can(user: ModuleUser | null, permission: string): Promise<boolean>
    /** Project permission check by project key, e.g. `canInProject(user, 'BROWSE_PROJECTS', 'ACME')`. */
    canInProject(user: ModuleUser | null, permission: string, projectKey: string): Promise<boolean>
    /** Project permission check for the project that owns an issue key. */
    canOnIssue(user: ModuleUser | null, permission: string, issueKey: string): Promise<boolean>
  }
  licence: {
    /** True when the installed licence grants the feature (always true for community features). */
    has(feature: string): boolean
  }
  /** Core services (see CoreServices). */
  core: CoreServices
}

/** Desk role of a user: admin and agent are staff, customer is a portal user. */
export type DeskRole = 'admin' | 'agent' | 'customer' | 'none'

/** A notice e-mail rendered by core with the generic "module-notice" template (all strings are HTML-escaped by core). */
export interface ModuleNotice {
  /** Subject line (line breaks are removed by core). */
  subject: string
  heading: string
  lines?: string[]
  issueKey?: string
  summary?: string
  url?: string
  actionLabel?: string
}

/**
 * Services of the core application a module may use instead of reaching into its internals. Provided by the host;
 * optional so unit tests can build a context without them.
 */
export interface CoreServices {
  /** Role of a user on a service desk (admin when the user administers the instance or the desk project). */
  deskRole(userId: number, deskId: number): Promise<DeskRole>
  /** Ids of the service desks the user is staff (admin or agent) of. Empty for customers. */
  staffDeskIds(userId: number): Promise<number[]>
  /** Queue notice e-mails (one row per recipient address). */
  queueNotice(tos: string[], notice: ModuleNotice): Promise<void>
  /** Fire a webhook / plugin event in the background (core knows the event names; unknown names are ignored). */
  emitEvent(event: string, payload: Record<string, unknown>): Promise<void>
  /**
   * Start an approval from the approval template `templateName` of the issue's project. The requester is excluded from
   * the approvers. Returns null when an approval from the same template is already pending.
   */
  requestApproval(p: { issueId: number; userId: number | null; templateName: string }): Promise<{ approvalId: number } | null>
  /** Create an issue with the core issue service (key counter, default status of the workflow, automation events). */
  createIssue(p: { projectId: number; issueTypeId: number; summary: string; description?: string; priorityId?: number | null; assigneeId?: number | null }, userId: number): Promise<{ id: number; key: string }>
  /** Run a workflow transition through the core engine (validators and post-functions apply). */
  transition(p: { issueId: number; transitionId: number; userId: number; comment?: string }): Promise<void>
  /** Drop cached copies of an issue after a module changed it directly (priority, assignee, ...). */
  invalidateIssue(issueKey: string): Promise<void>
  /** Public base URL of the web app. */
  webUrl(): string
}

export interface DeskTemplateDef<DB = unknown> {
  id: string
  title: string
  description: string
  /** Applied inside the desk creation transaction (`tx` is a drizzle transaction). Idempotent. */
  apply: (tx: any, p: { deskId: number; projectId: number }, ctx: ModuleContext<DB>) => Promise<void>
}

export interface TransitionCheckInput {
  issueId: number
  issueKey: string
  projectId: number
  transitionId: number
  fromStatusId: number
  toStatusId: number
  toStatusName: string
  /** Drizzle transaction of the transition. */
  tx: any
}

export interface RequestCreatedInfo {
  issueId: number
  issueKey: string
  deskId: number
  requestTypeId: number | null
  fieldValues: Record<string, unknown>
}

export interface ModuleMigration {
  /** Unique, ordered name such as `0001_init`. Migrations run in name order and are forward-only. */
  name: string
  /** SQL text. Every table you create or alter must start with the module's table prefix (`example-notes` -> `example_notes_`). */
  sql: string
}

export interface UninstallOptions { deleteData: boolean }

/**
 * What a module sees before a worklog is created, changed or deleted through the core worklog service (REST API,
 * UI and other modules alike). `started` is the new start time (for deletes: the current one); `previousStarted` is
 * the start time stored today (null on create).
 */
export interface WorklogChange {
  action: 'create' | 'update' | 'delete'
  worklogId: number | null
  issueId: number
  issueKey: string
  /** User the worklog belongs to (for create: the actor). */
  authorId: number | null
  /** User performing the change. */
  actorId: number | null
  started: Date
  previousStarted: Date | null
}

/** Returned by a worklog guard to veto a change. Returning nothing (or `undefined`) allows it. */
export interface WorklogVeto { allow: false; message: string; status?: 403 | 409 | 423 }

/**
 * A background job. The host runs it on an interval with an overlap guard (a run is skipped while the previous one
 * is still going) and logs failures without crashing the process.
 */
export interface ModuleJob<DB = unknown> {
  name: string
  everyMs: number
  run: (ctx: ModuleContext<DB>) => void | Promise<void>
}

export interface ModuleDefinition<DB = unknown> {
  manifest: ModuleManifest
  /** Registers HTTP routes on a sub-app mounted at /rest/modules/<id>. Declare each route's permission in the manifest. */
  routes?: (app: Hono<any>, ctx: ModuleContext<DB>) => void | Promise<void>
  migrations?: ModuleMigration[]
  /** Event subscriptions. Each key must also be listed in manifest.contributes.server.events. */
  events?: { [K in keyof VeqsioEvents]?: (payload: VeqsioEvents[K], ctx: ModuleContext<DB>) => void | Promise<void> }
  /**
   * Veto hooks into core operations. A guard that throws is treated as a veto (fail closed), because guards enforce
   * rules such as "approved timesheets are read-only".
   */
  hooks?: {
    beforeWorklogChange?: (change: WorklogChange, ctx: ModuleContext<DB>) => void | WorklogVeto | Promise<void | WorklogVeto>
    /** Runs after a customer portal request was stored (failures are logged, never fail the request). */
    afterRequestCreated?: (info: RequestCreatedInfo, ctx: ModuleContext<DB>) => void | Promise<void>
  }
  /**
   * Named checks for workflow validators of type `module_check` (`{ "type": "module_check", "check": "<name>" }`).
   * Return an error message to refuse the transition. Names should start with the module id (`itsm.postmortem`).
   */
  transitionChecks?: Record<string, (input: TransitionCheckInput, ctx: ModuleContext<DB>) => string | null | undefined | Promise<string | null | undefined>>
  /** Service desk templates offered in the desk creation wizard while the module is licensed and enabled. */
  deskTemplates?: DeskTemplateDef<DB>[]
  /** Background jobs (reminders, clean-ups). Only run while the module is enabled and licensed. */
  jobs?: ModuleJob<DB>[]
  onInstall?: (ctx: ModuleContext<DB>) => void | Promise<void>
  onEnable?: (ctx: ModuleContext<DB>) => void | Promise<void>
  onDisable?: (ctx: ModuleContext<DB>) => void | Promise<void>
  onUpdate?: (ctx: ModuleContext<DB>, info: { from: string; to: string }) => void | Promise<void>
  /** Called before the module row is removed. When `deleteData` is true the host drops the module's tables afterwards. */
  onUninstall?: (ctx: ModuleContext<DB>, opts: UninstallOptions) => void | Promise<void>
}

export interface DefineModuleInput<DB = unknown> extends Omit<ModuleDefinition<DB>, 'manifest'> {
  /** The parsed contents of veqsio.module.json (import it with `import manifest from '../veqsio.module.json'`). */
  manifest: ModuleManifestInput
}

/**
 * Validates the manifest and cross-checks it against the code (event subscriptions, migrations),
 * then returns the definition. Throws a descriptive error at import time, so a broken module is
 * rejected by the registry instead of failing at request time.
 */
export function defineModule<DB = unknown>(input: DefineModuleInput<DB>): ModuleDefinition<DB> {
  const manifest = parseManifest(input.manifest)
  const problems: string[] = []
  const declared = new Set<ModuleEventName>(manifest.contributes.server.events)
  for (const ev of Object.keys(input.events ?? {})) {
    if (!declared.has(ev as ModuleEventName)) problems.push(`event "${ev}" is handled but not listed in manifest.contributes.server.events`)
  }
  for (const ev of declared) {
    if (!(input.events as Record<string, unknown> | undefined)?.[ev]) problems.push(`event "${ev}" is declared in the manifest but has no handler`)
  }
  if (input.migrations?.length && !manifest.permissions.includes('database:own-tables')) {
    problems.push('migrations require the "database:own-tables" permission')
  }
  const names = (input.migrations ?? []).map((m) => m.name)
  if (new Set(names).size !== names.length) problems.push('migration names must be unique')
  for (const n of names) if (!/^\d{4}_[a-z0-9_]+$/.test(n)) problems.push(`migration name "${n}" must look like 0001_create_tables`)
  if (problems.length) throw new Error(`Invalid module "${manifest.id}":\n - ${problems.join('\n - ')}`)
  return { ...input, manifest, migrations: input.migrations ? [...input.migrations].sort((a, b) => a.name.localeCompare(b.name)) : undefined }
}

export type { EventHandler }
