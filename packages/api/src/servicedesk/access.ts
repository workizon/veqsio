import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import { ensureCustomer } from './service'

type User = typeof schema.users.$inferSelect
type Desk = typeof schema.serviceDesks.$inferSelect

/** Enabled desk by slug that the user may use as a customer (auto-enrols on public-signup desks). Null otherwise. */
export async function loadPortalDesk(user: User, slug: string): Promise<Desk | null> {
  const [desk] = await db.select().from(schema.serviceDesks)
    .where(and(eq(schema.serviceDesks.slug, slug), eq(schema.serviceDesks.enabled, true))).limit(1)
  if (!desk) return null
  return (await ensureCustomer(user, desk)) ? desk : null
}

/**
 * Request by issue key, only if the user is its customer or a participant.
 * Same rule as the portal comment routes; callers answer 404 on null.
 */
export async function loadCustomerRequest(user: User, desk: Desk, issueKey: string) {
  const [row] = await db.select({ issue: schema.issues, req: schema.serviceRequests })
    .from(schema.serviceRequests).innerJoin(schema.issues, eq(schema.issues.id, schema.serviceRequests.issueId))
    .where(and(eq(schema.issues.issueKey, issueKey), eq(schema.serviceRequests.serviceDeskId, desk.id))).limit(1)
  if (!row) return null
  if (row.req.customerId === user.id) return row
  const [p] = await db.select().from(schema.requestParticipants)
    .where(and(eq(schema.requestParticipants.requestId, row.req.id), eq(schema.requestParticipants.userId, user.id))).limit(1)
  return p ? row : null
}

/** User ids whose uploads on a request are visible to customers: the requester and participants. */
export async function customerSideUserIds(req: { id: number; customerId: number }): Promise<number[]> {
  const ps = await db.select({ userId: schema.requestParticipants.userId }).from(schema.requestParticipants)
    .where(eq(schema.requestParticipants.requestId, req.id))
  return [req.customerId, ...ps.map((p) => p.userId)]
}
