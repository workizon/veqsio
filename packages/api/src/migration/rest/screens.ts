import { eq } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import { SYSTEM_SCREEN_FIELD_KEYS } from '../../workflow/screen-fields'
import { isStoryPointsField, type FieldBinding, type JiraFieldMeta } from './customfields'
import type { JiraClient } from './client'

/**
 * Jira screens (the groups of fields shown when an issue moves through a workflow transition) with their tabs, and the
 * transitions that use them. Only Jira Cloud offers a screens API; Data Center has none, which the report says.
 */

export interface ScreensReport { created: number; matched: number; fields: number; skippedFields: number }

type Getter = Pick<JiraClient, 'get'>

/** Jira system field ids that have a counterpart key on a screen here. */
const SYSTEM_KEY: Record<string, string> = {
  assignee: 'assignee', priority: 'priority', labels: 'labels', fixVersions: 'fixVersions', components: 'components', duedate: 'duedate',
  environment: 'environment', resolution: 'resolution', comment: 'comment',
}

/** The key a Jira screen field has on a screen here: a system key, a custom field id, or null when it has none. */
export function screenFieldTarget(
  jiraFieldId: string, bindingByJira: Map<string, number>, storyPointIds: Set<string>,
): { custom: false; key: string } | { custom: true; fieldId: number } | null {
  if (SYSTEM_KEY[jiraFieldId] && SYSTEM_SCREEN_FIELD_KEYS.has(SYSTEM_KEY[jiraFieldId])) return { custom: false, key: SYSTEM_KEY[jiraFieldId] }
  if (storyPointIds.has(jiraFieldId)) return { custom: false, key: 'storyPoints' }
  const local = bindingByJira.get(jiraFieldId)
  return local !== undefined ? { custom: true, fieldId: local } : null
}

async function paged(c: Getter, path: string): Promise<any[]> {
  const out: any[] = []
  for (let startAt = 0, guard = 0; guard < 100; guard++) {
    const page: any = await c.get(path, { startAt, maxResults: 100 })
    const values: any[] = Array.isArray(page?.values) ? page.values : Array.isArray(page) ? page : []
    out.push(...values)
    if (!Array.isArray(page?.values) || page.isLast !== false || values.length === 0) break
    startAt += values.length
  }
  return out
}

/** Returns the local screen for each Jira screen id, so that workflow transitions can use them. */
export async function importScreens(
  client: Getter, bindings: FieldBinding[], metas: JiraFieldMeta[], warnings: string[],
): Promise<{ byJiraId: Map<string, number>; report: ScreensReport }> {
  const report: ScreensReport = { created: 0, matched: 0, fields: 0, skippedFields: 0 }
  const byJiraId = new Map<string, number>()
  let screens: any[]
  try { screens = await paged(client, '/rest/api/2/screens') } catch (e: any) {
    warnings.push(`Screens not imported: Jira has no screens API for this version (Data Center) or the token lacks the right (${String(e?.message ?? e).slice(0, 80)}); transitions have no screen`)
    return { byJiraId, report }
  }
  const bindingByJira = new Map(bindings.map((b) => [b.jiraId, b.veqsioId]))
  const storyPointIds = new Set(metas.filter(isStoryPointsField).map((f) => f.id))
  for (const s of screens) {
    const name = String(s?.name ?? '').slice(0, 255)
    if (!name || s.id === undefined) continue
    const [existing] = await db.select({ id: schema.screens.id }).from(schema.screens).where(eq(schema.screens.name, name)).limit(1)
    if (existing) { byJiraId.set(String(s.id), existing.id); report.matched++; continue }
    const [screen] = await db.insert(schema.screens).values({ name, description: s.description ? String(s.description).slice(0, 2000) : 'Imported from Jira' }).returning({ id: schema.screens.id })
    byJiraId.set(String(s.id), screen.id)
    report.created++
    let tabs: any[] = []
    try { tabs = await client.get<any[]>(`/rest/api/2/screens/${encodeURIComponent(String(s.id))}/tabs`) } catch { /* a screen without readable tabs stays empty */ }
    let tabOrder = 0
    for (const t of Array.isArray(tabs) ? tabs : []) {
      const [tab] = await db.insert(schema.screenTabs).values({ screenId: screen.id, name: String(t?.name ?? 'Field Tab').slice(0, 100), sortOrder: tabOrder++ }).returning({ id: schema.screenTabs.id })
      let fields: any[] = []
      try { fields = await client.get<any[]>(`/rest/api/2/screens/${encodeURIComponent(String(s.id))}/tabs/${encodeURIComponent(String(t.id))}/fields`) } catch { /* no fields */ }
      let order = 0
      for (const f of Array.isArray(fields) ? fields : []) {
        const target = f?.id ? screenFieldTarget(String(f.id), bindingByJira, storyPointIds) : null
        if (!target) { report.skippedFields++; continue }
        await db.insert(schema.screenTabFields).values(target.custom
          ? { tabId: tab.id, fieldId: target.fieldId, isCustomField: true, fieldKey: null, sortOrder: order++ }
          : { tabId: tab.id, fieldId: 0, isCustomField: false, fieldKey: target.key, sortOrder: order++ })
        report.fields++
      }
    }
  }
  return { byJiraId, report }
}
