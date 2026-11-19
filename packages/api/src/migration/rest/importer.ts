import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import { uploadFile } from '../../storage/service'
import { JiraClient } from './client'
import { Resolver } from '../resolver'
import { importAgile } from './agile'
import { importSchemes } from './schemes'
import { copyProjectAvatar, copyUserAvatars, type AvatarReport } from './avatars'
import { importScreens, type ScreensReport } from './screens'
import { importPeople, type PeopleReport } from './people'
import { importGlobalConfig, importProjectIssueTypes, type ConfigReport } from './config'
import { applyFieldMeta, importRequiredFlags, readFieldMeta, syncCustomFields, type FieldReport } from './fieldsync'
import type { FieldOverride } from './fieldmap'
import { WorkflowObservations, importWorkflows, type RealWorkflow } from './workflows'
import { extractStoryPoints, storyPointFieldIds, writeCustomValues, type FieldBinding, type JiraFieldMeta } from './customfields'
import { ISSUE_FIELDS, normalizeIssue, normalizeUser, parseKey, type NormalizedIssue, type NormalizedUser } from './mapper'

export interface RestImportOptions {
  projectKeys: string[]
  includeAttachments?: boolean
  includeHistory?: boolean
  /** Import boards (with columns) and sprints (default true). */
  includeAgile?: boolean
  /** Create matching custom fields and copy their values (default true). */
  includeCustomFields?: boolean
  /** Only import issues updated on/after this date (incremental re-sync). ISO date or "yyyy-MM-dd HH:mm". */
  updatedSince?: string
  /** What to do with issues that already exist: skip (default) or overwrite fields. */
  onExisting?: 'skip' | 'overwrite'
  /** Map Jira usernames/emails to existing Veqsio users: { "jira-login": "veqsio-username" } */
  userMapping?: Record<string, string>
  /** Create placeholder users for unknown Jira users (default true). */
  createMissingUsers?: boolean
  /** Create workflows/workflow schemes from Jira workflows or the status history of imported issues (default true). */
  includeWorkflows?: boolean
  /** Copy the permission and notification schemes of the projects (Jira Cloud, needs an admin token; default true). */
  includeSchemes?: boolean
  /** Per Jira field id: create a new field, map to an existing one, or skip (chosen in the preview). */
  fieldOverrides?: Record<string, FieldOverride>
  /** Copy issue types, priorities, statuses, resolutions and link types of the instance, and the issue types each project offers (default true). */
  includeConfig?: boolean
  /** Create the users and groups of the Jira with their project roles and administrator groups; people are matched by e-mail (default true). */
  includePeople?: boolean
  /** Copy Jira screens and put them on the transitions that use them (Jira Cloud; default true with the configuration). */
  includeScreens?: boolean
  /** Copy the pictures of people and projects (default true). */
  includeAvatars?: boolean
}

export interface RestImportReport {
  projects: Record<string, {
    total: number | null; created: number; updated: number; skipped: number; failed: number
    comments: number; worklogs: number; attachments: number; links: number
    boards: number; sprints: number; sprintIssues: number; customValues: number
    workflows: number; transitions: number
  }>
  warnings: string[]
  errors: string[]
  usersCreated: number
  /** What the scheme import created (absent when it was switched off or nothing was imported). */
  /** What happened to each Jira custom field: created, matched to an existing one, or skipped, with the reason. */
  fields?: FieldReport
  /** Issue types, priorities, statuses, resolutions, link types and issue type schemes that were created or matched. */
  config?: ConfigReport
  /** Jira screens (the fields a workflow transition asks for) that were created or matched. */
  screens?: ScreensReport
  /** Pictures copied from Jira. */
  avatars?: AvatarReport
  /** Users, groups and project role members that were created or matched. */
  people?: PeopleReport
  schemes?: { permissionSchemes: number; permissionEntries: number; notificationSchemes: number; assigned: number }
}

export type ProgressFn = (info: { processed: number; total: number; message: string }) => void | Promise<void>

type Db = typeof db

async function ensureProject(client: JiraClient, key: string, resolver: Resolver, report: RestImportReport): Promise<{ id: number; key: string }> {
  const [existing] = await db.select().from(schema.projects).where(eq(schema.projects.projectKey, key)).limit(1)
  const detail = await client.project(key)
  let id = existing?.id
  if (!existing) {
    const lead = await resolver.user(normalizeUser(detail.lead))
    const [p] = await db.insert(schema.projects).values({
      projectKey: key, name: String(detail.name ?? key).slice(0, 255), description: detail.description ?? null,
      leadId: lead, category: detail.projectCategory?.name ?? null,
    }).returning()
    id = p.id
  }
  for (const c of detail.components ?? []) await resolver.component(id!, c.name)
  for (const v of detail.versions ?? []) {
    const vid = await resolver.version(id!, v.name)
    await db.update(schema.versions).set({
      released: !!v.released, archived: !!v.archived,
      releaseDate: v.releaseDate ?? null, startDate: v.startDate ?? null, description: v.description ?? null,
    }).where(eq(schema.versions.id, vid))
  }
  await db.insert(schema.projectIssueCounters).values({ projectId: id!, currentValue: 0 }).onConflictDoNothing()
  if (!existing) report.warnings.push(`${key}: project created; assign permission/notification schemes in project settings`)
  return { id: id!, key }
}

async function importOne(
  client: JiraClient, r: Resolver, projectId: number, n: NormalizedIssue, opts: RestImportOptions,
  stat: RestImportReport['projects'][string], fallbackUserId: number,
): Promise<number | null> {
  const [existing] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, n.key)).limit(1)
  if (existing && opts.onExisting !== 'overwrite') { stat.skipped++; return existing.id }

  const [typeId, statusId, prioId, resId, assignee, reporter] = await Promise.all([
    r.issueType(n.issueType.name, n.issueType.subtask),
    r.status(n.status.name, n.status.category),
    n.priority ? r.priority(n.priority) : Promise.resolve(null),
    n.resolution ? r.resolution(n.resolution) : Promise.resolve(null),
    r.user(n.assignee),
    r.user(n.reporter),
  ])

  const values = {
    projectId, issueTypeId: typeId, statusId, priorityId: prioId, resolutionId: resId,
    summary: n.summary || '(no summary)', description: n.description, assigneeId: assignee,
    reporterId: reporter ?? fallbackUserId, environment: n.environment,
    createdAt: n.created, updatedAt: n.updated, resolvedAt: n.resolved, dueDate: n.dueDate,
    timeEstimate: n.timeEstimate, timeSpent: n.timeSpent,
    storyPoints: n.storyPoints === null || n.storyPoints === undefined ? null : n.storyPoints.toFixed(2),
  }

  let issueId: number
  if (existing) {
    await db.update(schema.issues).set(values).where(eq(schema.issues.id, existing.id))
    issueId = existing.id
    // Re-sync child collections cleanly on overwrite.
    await db.delete(schema.issueLabels).where(eq(schema.issueLabels.issueId, issueId))
    await db.delete(schema.issueComponents).where(eq(schema.issueComponents.issueId, issueId))
    await db.delete(schema.issueFixVersions).where(eq(schema.issueFixVersions.issueId, issueId))
    await db.delete(schema.issueAffectsVersions).where(eq(schema.issueAffectsVersions.issueId, issueId))
    await db.delete(schema.comments).where(eq(schema.comments.issueId, issueId))
    await db.delete(schema.worklogs).where(eq(schema.worklogs.issueId, issueId))
    await db.delete(schema.issueHistory).where(eq(schema.issueHistory.issueId, issueId))
    stat.updated++
  } else {
    const [row] = await db.insert(schema.issues).values({ ...values, issueKey: n.key }).returning({ id: schema.issues.id })
    issueId = row.id
    stat.created++
  }

  for (const l of n.labels) await db.insert(schema.issueLabels).values({ issueId, labelId: await r.label(l) }).onConflictDoNothing()
  for (const c of n.components) await db.insert(schema.issueComponents).values({ issueId, componentId: await r.component(projectId, c) }).onConflictDoNothing()
  for (const v of n.fixVersions) await db.insert(schema.issueFixVersions).values({ issueId, versionId: await r.version(projectId, v) }).onConflictDoNothing()
  for (const v of n.affectsVersions) await db.insert(schema.issueAffectsVersions).values({ issueId, versionId: await r.version(projectId, v) }).onConflictDoNothing()

  // Comments (fetch the rest if the search payload was truncated)
  let comments = n.comments
  if (n.commentsTotal > comments.length) comments = await client.getAllPaged(`/rest/api/2/issue/${n.key}/comment`, 'comments')
  for (const c of comments) {
    await db.insert(schema.comments).values({
      issueId, body: String(c.body ?? ''), authorId: (await r.user(normalizeUser(c.author))) ?? fallbackUserId,
      createdAt: new Date(c.created), updatedAt: new Date(c.updated ?? c.created), isInternal: !!c.visibility,
    })
    stat.comments++
  }

  // Worklogs
  let logs = n.worklogs
  if (n.worklogsTotal > logs.length) logs = await client.getAllPaged(`/rest/api/2/issue/${n.key}/worklog`, 'worklogs')
  for (const w of logs) {
    const author = normalizeUser(w.author)
    await db.insert(schema.worklogs).values({
      issueId, issueKey: n.key, authorId: await r.user(author), authorName: author?.displayName, authorEmail: author?.email,
      description: w.comment ?? null, timeSpentSeconds: Math.max(1, Number(w.timeSpentSeconds) || 60),
      started: new Date(w.started), createdAt: new Date(w.created ?? w.started), updatedAt: new Date(w.updated ?? w.started),
    })
    stat.worklogs++
  }

  if (opts.includeHistory !== false) {
    for (const h of n.history) {
      await db.insert(schema.issueHistory).values({
        issueId, fieldName: h.field.slice(0, 100), oldValue: h.from, newValue: h.to, authorId: await r.user(h.author), createdAt: h.at,
      })
    }
  }
  return issueId
}

async function importAttachments(
  client: JiraClient, r: Resolver, projectKey: string, issueId: number, n: NormalizedIssue,
  stat: RestImportReport['projects'][string], report: RestImportReport,
) {
  const [have] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.attachments).where(eq(schema.attachments.issueId, issueId))
  if (have.c > 0) return // already imported on a previous run
  for (const a of n.attachments) {
    try {
      const buf = await client.download(a.content)
      const up = await uploadFile(projectKey, n.key, buf, a.filename, a.mimeType)
      await db.insert(schema.attachments).values({
        issueId, filename: a.filename.slice(0, 255), filesize: buf.length, mimetype: a.mimeType.slice(0, 100),
        storageKey: up.storageKey, authorId: await r.user(a.author), createdAt: a.created,
      })
      stat.attachments++
    } catch (e: any) {
      report.warnings.push(`${n.key}: attachment "${a.filename}" skipped (${e.message})`)
    }
  }
}

export async function runRestImport(
  client: JiraClient, opts: RestImportOptions, actingUserId: number, onProgress?: ProgressFn,
): Promise<RestImportReport> {
  const report: RestImportReport = { projects: {}, warnings: [], errors: [], usersCreated: 0 }
  const resolver = new Resolver(db, opts)
  let processed = 0
  let grandTotal = 0
  const workflowCache: { real?: RealWorkflow[] } = {}
  const importedProjects: Array<{ id: number; key: string }> = []

  const since = opts.updatedSince ? ` AND updated >= "${opts.updatedSince.replace(/[^0-9:\- ]/g, '').trim()}"` : ''
  const jqlFor = (key: string) => `project = "${key.replace(/[^A-Za-z0-9_]/g, '')}"${since} ORDER BY key ASC`

  // Pre-count for a meaningful progress bar.
  const totals = new Map<string, number | null>()
  for (const key of opts.projectKeys) {
    const t = await client.countIssues(jqlFor(key))
    totals.set(key, t)
    grandTotal += t ?? 0
  }

  // the instance's own configuration first, so that issues find their types, priorities and statuses as Jira defines them
  if (opts.includeConfig !== false) report.config = await importGlobalConfig(client, report.warnings)

  const avatarSources = new Map<number, string>()
  // the people first, with their groups: issues, comments and roles then find them instead of making bare placeholders
  if (opts.includePeople !== false) {
    try { report.people = await importPeople(client, resolver, [], report.warnings, 'accounts', avatarSources) } catch (e: any) { report.warnings.push(`People not imported (${e.message})`) }
  }

  let bindings: FieldBinding[] = []
  let fieldSync: Awaited<ReturnType<typeof syncCustomFields>> | null = null
  let spFieldIds: string[] = []
  try {
    const metas = await client.get<JiraFieldMeta[]>('/rest/api/2/field')
    // Story points always go to issues.story_points (even when generic custom fields are skipped).
    spFieldIds = storyPointFieldIds(metas)
    if (opts.includeCustomFields !== false) {
      const synced = await syncCustomFields(metas, report.warnings, opts.fieldOverrides)
      bindings = synced.bindings
      fieldSync = synced
      report.fields = synced.report
    }
  } catch (e: any) {
    if (opts.includeCustomFields !== false) report.warnings.push(`Custom fields not imported (${e.message})`)
  }
  // screens (the fields a workflow transition asks for), before the workflows that use them
  let screenByJiraId = new Map<string, number>()
  if (opts.includeScreens !== false && opts.includeConfig !== false && opts.includeWorkflows !== false) {
    try {
      const metasForScreens = await client.get<JiraFieldMeta[]>('/rest/api/2/field')
      const sc = await importScreens(client, bindings, metasForScreens, report.warnings)
      screenByJiraId = sc.byJiraId
      report.screens = sc.report
    } catch (e: any) { report.warnings.push(`Screens not imported (${e.message})`) }
  }
  const fieldList = [ISSUE_FIELDS, ...bindings.map((b) => b.jiraId), ...spFieldIds].join(',')

  for (const key of opts.projectKeys) {
    const stat = { total: totals.get(key) ?? null, created: 0, updated: 0, skipped: 0, failed: 0, comments: 0, worklogs: 0, attachments: 0, links: 0, boards: 0, sprints: 0, sprintIssues: 0, customValues: 0, workflows: 0, transitions: 0 }
    report.projects[key] = stat
    let project: { id: number; key: string }
    try {
      project = await ensureProject(client, key, resolver, report)
    } catch (e: any) {
      report.errors.push(`${key}: ${e.message}`)
      continue
    }
    importedProjects.push({ id: project.id, key: project.key })
    if (opts.includeAvatars !== false) {
      try { const d = await client.project(key); report.avatars ??= { users: 0, projects: 0, failed: 0 }; await copyProjectAvatar(client, project.id, project.key, d?.avatarUrls, report.avatars) } catch { /* a missing picture is not worth a warning */ }
    }
    if (opts.includeConfig !== false && report.config) {
      try { await importProjectIssueTypes(await client.project(key), project.id, report.config, report.warnings) } catch (e: any) { report.warnings.push(`${key}: issue types of the project not imported (${e.message})`) }
    }

    const idByKey = new Map<string, number>()
    const parents: Array<[string, string]> = []
    const linkQueue: Array<{ from: string; to: string; type: NormalizedIssue['links'][number]['type'] }> = []
    let maxNumber = 0
    const observations = new WorkflowObservations()

    const expand = opts.includeHistory === false ? undefined : 'changelog'
    for await (const raw of client.searchIssues(jqlFor(key), fieldList, expand)) {
      const n = normalizeIssue(raw)
      n.storyPoints = extractStoryPoints(raw.fields, spFieldIds)
      try {
        const id = await importOne(client, resolver, project.id, n, opts, stat, actingUserId)
        if (id !== null) {
          idByKey.set(n.key, id)
          if (opts.includeWorkflows !== false) observations.add(project.key, n)
          if (bindings.length) stat.customValues += await writeCustomValues(id, raw.fields ?? {}, bindings, resolver)
          if (opts.includeAttachments && n.attachments.length) await importAttachments(client, resolver, project.key, id, n, stat, report)
          if (n.parentKey) parents.push([n.key, n.parentKey])
          for (const l of n.links) linkQueue.push({ from: n.key, to: l.outwardKey, type: l.type })
        }
        const p = parseKey(n.key)
        if (p && p.number > maxNumber) maxNumber = p.number
      } catch (e: any) {
        stat.failed++
        report.errors.push(`${n.key}: ${e.message}`)
      }
      processed++
      if (onProgress && processed % 10 === 0) await onProgress({ processed, total: Math.max(grandTotal, processed), message: `${key}: ${n.key}` })
    }

    // Second pass: parent/sub-task relations and issue links need all issues present.
    for (const [child, parent] of parents) {
      const childId = idByKey.get(child)
      let parentId = idByKey.get(parent)
      if (!parentId) {
        const [p] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, parent)).limit(1)
        parentId = p?.id
      }
      if (childId && parentId) await db.update(schema.issues).set({ parentId }).where(eq(schema.issues.id, childId))
      else report.warnings.push(`${child}: parent ${parent} not found in Veqsio (import its project too)`)
    }
    for (const l of linkQueue) {
      const fromId = idByKey.get(l.from)
      let toId = idByKey.get(l.to)
      if (!toId) {
        const [t] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, l.to)).limit(1)
        toId = t?.id
      }
      if (!fromId || !toId) { report.warnings.push(`${l.from}: link target ${l.to} not found`); continue }
      const typeId = await resolver.linkType(l.type)
      const [dup] = await db.select({ id: schema.issueLinks.id }).from(schema.issueLinks)
        .where(and(eq(schema.issueLinks.issueId, fromId), eq(schema.issueLinks.linkedIssueId, toId), eq(schema.issueLinks.linkTypeId, typeId))).limit(1)
      if (!dup) {
        await db.insert(schema.issueLinks).values({ issueId: fromId, linkedIssueId: toId, linkTypeId: typeId })
        stat.links++
      }
    }

    if (opts.includeAgile !== false) {
      Object.assign(stat, await importAgile(client, resolver, project, idByKey, report.warnings))
    }

    if (opts.includeWorkflows !== false) {
      try {
        const ws = (await importWorkflows(client, resolver, observations, [project], report.warnings, workflowCache, screenByJiraId)).get(project.key)
        if (ws) { stat.workflows = ws.workflows; stat.transitions = ws.transitions }
      } catch (e: any) {
        report.warnings.push(`${key}: workflows not imported (${e.message})`)
      }
    }

    // Keep the key generator ahead of imported keys so new issues never collide.
    await db.update(schema.projectIssueCounters)
      .set({ currentValue: sql`greatest(coalesce(${schema.projectIssueCounters.currentValue}, 0), ${maxNumber})` })
      .where(eq(schema.projectIssueCounters.projectId, project.id))
  }

  // contexts and list options of the custom fields (after the issues: the projects and issue types they refer to exist now)
  if (fieldSync && report.fields && bindings.length) {
    try {
      const metaMap = await readFieldMeta(client, bindings, importedProjects.map((p) => p.key), report.warnings)
      await applyFieldMeta(bindings, fieldSync.createdIds, metaMap, report.fields, report.warnings)
      await importRequiredFlags(client, bindings, importedProjects, report.fields, report.warnings)
    } catch (e: any) {
      report.warnings.push(`Custom field contexts and list options not imported (${e.message})`)
    }
  }

  if (opts.includeAvatars !== false && avatarSources.size > 0) {
    report.avatars ??= { users: 0, projects: 0, failed: 0 }
    try { await copyUserAvatars(client, avatarSources, report.avatars) } catch (e: any) { report.warnings.push(`Avatars not copied (${e.message})`) }
  }

  if (opts.includePeople !== false && importedProjects.length) {
    try {
      const roles = await importPeople(client, resolver, importedProjects, report.warnings, 'roles')
      if (report.people) report.people.roleActors = roles.roleActors
    } catch (e: any) { report.warnings.push(`Project role members not imported (${e.message})`) }
  }

  if (opts.includeSchemes !== false && importedProjects.length) {
    try {
      const sr = await importSchemes(client, resolver, importedProjects, report.warnings)
      report.schemes = sr
    } catch (e: any) {
      report.warnings.push(`Permission and notification schemes not imported (${e.message})`)
    }
  }

  report.usersCreated = resolver.usersCreated
  report.warnings.push(opts.includeWorkflows === false
    ? 'Workflows were not imported (disabled); imported issues use the default workflow until a scheme is assigned.'
    : 'Workflows are inferred from issue history (or read from Jira Cloud); transition conditions, validators and post-functions are not migrated.'
    + (opts.includeSchemes === false ? ' Permission and notification schemes were not imported (disabled).' : ''))
  if (onProgress) await onProgress({ processed, total: Math.max(grandTotal, processed), message: 'done' })
  return report
}
