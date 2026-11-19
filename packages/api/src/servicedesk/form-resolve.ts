import { and, eq, ilike, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import type { FieldDef, MappedIssueFields } from './form'

type Desk = typeof schema.serviceDesks.$inferSelect

/** Escape LIKE wildcards so a name is matched literally. */
const likeLiteral = (s: string) => s.replace(/[%_\\]/g, '\\$&')

/** Users that belong to the desk (agents or customers), by lower-cased email. */
async function deskMembersByEmail(desk: Desk, emails: string[]): Promise<Map<string, { id: number; agent: boolean }>> {
  const out = new Map<string, { id: number; agent: boolean }>()
  if (emails.length === 0) return out
  const lower = emails.map((e) => e.toLowerCase())
  const agents = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.serviceDeskAgents)
    .innerJoin(schema.users, eq(schema.users.id, schema.serviceDeskAgents.userId))
    .where(and(eq(schema.serviceDeskAgents.serviceDeskId, desk.id), inArray(sql`lower(${schema.users.email})`, lower)))
  const customers = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.serviceDeskCustomers)
    .innerJoin(schema.users, eq(schema.users.id, schema.serviceDeskCustomers.userId))
    .where(and(eq(schema.serviceDeskCustomers.serviceDeskId, desk.id), inArray(sql`lower(${schema.users.email})`, lower)))
  for (const c of customers) out.set(c.email.toLowerCase(), { id: c.id, agent: false })
  for (const a of agents) out.set(a.email.toLowerCase(), { id: a.id, agent: true })
  return out
}

/**
 * Customers may only pick people the help center already knows (its agents and customers), never
 * arbitrary directory users. Returns validation messages for user-picker fields that do not match.
 */
export async function checkUserFields(desk: Desk, defs: FieldDef[], values: Record<string, unknown>): Promise<string[]> {
  const fields = defs.filter((f) => f.type === 'user' && typeof values[f.key] === 'string')
  if (fields.length === 0) return []
  const members = await deskMembersByEmail(desk, fields.map((f) => values[f.key] as string))
  return fields.filter((f) => !members.has((values[f.key] as string).toLowerCase()))
    .map((f) => `${f.label} must be a person known to this help center`)
}

export interface ResolvedIssueFields {
  priorityId?: number
  labels: string[]
  componentIds: number[]
  dueDate?: string
  assigneeId?: number
  customFields: Array<{ fieldId: number; value: unknown }>
}

/** Turn mapped names/emails into ids. Anything that does not resolve is ignored (never an error for the customer). */
export async function resolveMappedFields(desk: Desk, defs: FieldDef[], mapped: MappedIssueFields): Promise<ResolvedIssueFields> {
  const out: ResolvedIssueFields = { labels: mapped.labels, componentIds: [], dueDate: mapped.dueDate, customFields: [] }

  if (mapped.priorityName) {
    const [p] = await db.select({ id: schema.priorities.id }).from(schema.priorities)
      .where(ilike(schema.priorities.name, likeLiteral(mapped.priorityName))).limit(1)
    if (p) out.priorityId = p.id
  }

  if (mapped.componentNames.length) {
    const comps = await db.select({ id: schema.components.id, name: schema.components.name }).from(schema.components)
      .where(eq(schema.components.projectId, desk.projectId))
    const want = new Set(mapped.componentNames.map((n) => n.toLowerCase()))
    out.componentIds = comps.filter((c) => want.has(c.name.toLowerCase())).map((c) => c.id)
  }

  const emails = [...(mapped.assigneeEmail ? [mapped.assigneeEmail] : [])]
  const cfDefs = mapped.customFields.length
    ? await db.select().from(schema.customFields).where(inArray(schema.customFields.id, mapped.customFields.map((c) => c.customFieldId)))
    : []
  const cfById = new Map(cfDefs.map((c) => [c.id, c]))
  for (const cf of mapped.customFields) {
    if (cfById.get(cf.customFieldId)?.fieldType === 'user' && typeof cf.value === 'string') emails.push(cf.value)
  }
  const members = await deskMembersByEmail(desk, emails)

  if (mapped.assigneeEmail) {
    const m = members.get(mapped.assigneeEmail)
    // Only desk agents may be assigned through a customer-filled form.
    if (m?.agent) out.assigneeId = m.id
  }

  for (const cf of mapped.customFields) {
    const def = cfById.get(cf.customFieldId)
    if (!def) continue
    let value = cf.value
    if (def.fieldType === 'user') value = typeof value === 'string' ? members.get(value.toLowerCase())?.id : undefined
    else if (def.fieldType === 'number') value = typeof value === 'number' ? value : Number.isFinite(Number(value)) ? Number(value) : undefined
    else if (def.fieldType === 'date' || def.fieldType === 'datetime') value = Number.isNaN(Date.parse(String(value))) ? undefined : value
    else if (def.fieldType === 'checkbox' || def.fieldType === 'boolean') value = typeof value === 'boolean' ? value : undefined
    else value = typeof value === 'string' ? value.slice(0, 500) : String(value).slice(0, 500)
    if (value !== undefined) out.customFields.push({ fieldId: cf.customFieldId, value })
  }
  return out
}
