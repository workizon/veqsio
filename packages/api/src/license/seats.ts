import { sql } from 'drizzle-orm'
import * as schema from '@veqsio/db'
import { db } from '../db'
import { getLicenseInfo } from './index'
import { planLimits } from '../cloud/limits'

/**
 * Seat limit. A seat is an active human user (`active` is not false). AI agents (username prefix `agent:`) are service accounts and do not use a seat. The limit comes from the licence and only applies
 * while the licence is valid or in its grace period; with no licence, or after it expired for good, the instance
 * runs as the community edition without a seat limit. Existing users are never deactivated by the limit: it only
 * refuses NEW active users (create, reactivate, auto-provision).
 */
export class SeatLimitError extends Error {
  readonly status = 402
  constructor(public limit: number, public inUse: number) {
    super(`The user limit of your plan or licence (${limit}) is reached: ${inUse} users are active. Deactivate a user or upgrade the licence.`)
    this.name = 'SeatLimitError'
  }
  body() {
    return {
      errorMessages: [this.message],
      feature: 'seats',
      seats: { limit: this.limit, inUse: this.inUse },
      upgrade: { plan: 'enterprise', manage: '/admin/license', message: 'Increase the seat count of your licence under Admin > Licence.' },
    }
  }
}

export async function countActiveUsers(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users).where(sql`${schema.users.active} is not false and ${schema.users.username} not like 'agent:%'`)
  return row?.n ?? 0
}

/** The enforced seat limit, or null when none applies. */
export function seatLimit(): number | null {
  const l = getLicenseInfo()
  const fromLicence = (l.state === 'valid' || l.state === 'grace') && typeof l.seats === 'number' && l.seats >= 0 ? l.seats : null
  const fromPlan = planLimits().users // set by the control plane on managed tenants (VEQSIO_LIMIT_USERS)
  if (fromLicence === null) return fromPlan
  return fromPlan === null ? fromLicence : Math.min(fromLicence, fromPlan)
}

/** Pure decision, exported for unit tests. */
export function exceedsSeats(limit: number | null, inUse: number, adding: number): boolean {
  return limit !== null && inUse + adding > limit
}

/** Throws SeatLimitError when `count` more active users would exceed the licence. */
export async function assertSeatAvailable(count = 1): Promise<void> {
  const limit = seatLimit()
  if (limit === null) return
  const inUse = await countActiveUsers()
  if (exceedsSeats(limit, inUse, count)) throw new SeatLimitError(limit, inUse)
}
