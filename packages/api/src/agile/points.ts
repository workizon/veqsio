import { and, inArray } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { STORY_POINT_FIELD_NAMES, toPoints } from './planning'

/** Ids of the custom field(s) holding story points: the one source for planning totals and reports. */
export async function storyPointFieldIds(): Promise<number[]> {
  const rows = await db.select({ id: schema.customFields.id, name: schema.customFields.name }).from(schema.customFields)
  return rows.filter((r) => STORY_POINT_FIELD_NAMES.includes(r.name.trim().toLowerCase())).map((r) => r.id)
}

/**
 * Story points per issue id (issues without an estimate are absent). The `issues.story_points` column is the
 * primary store (inline editing, importers); the "Story Points" custom field is read as a fallback so estimates
 * entered or imported through it keep working.
 */
export async function pointsByIssue(issueIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (issueIds.length === 0) return out
  const direct = await db.select({ id: schema.issues.id, p: schema.issues.storyPoints }).from(schema.issues)
    .where(inArray(schema.issues.id, issueIds))
  for (const r of direct) {
    const p = toPoints(r.p)
    if (p !== null) out.set(r.id, p)
  }
  const fieldIds = await storyPointFieldIds()
  if (fieldIds.length === 0) return out
  const rows = await db.select({ issueId: schema.customFieldValues.issueId, v: schema.customFieldValues.numberValue })
    .from(schema.customFieldValues)
    .where(and(inArray(schema.customFieldValues.issueId, issueIds), inArray(schema.customFieldValues.customFieldId, fieldIds)))
  for (const r of rows) {
    const p = toPoints(r.v)
    if (p !== null && !out.has(r.issueId)) out.set(r.issueId, p)
  }
  return out
}
