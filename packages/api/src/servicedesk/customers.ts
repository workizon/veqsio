import { sql } from 'drizzle-orm'
import { randomBytes } from 'crypto'
import { db } from '../db'
import * as schema from '@veqsio/db'

/** Account with this (already normalized, lowercase) address, if any. */
export const findUserByEmail = async (email: string) =>
  (await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1))[0]

/**
 * Passwordless customer account for an address (portal sign-in happens later through password reset / SSO).
 * Race-safe: a concurrent insert of the same address returns the winner's row.
 */
export async function provisionUser(email: string, displayName: string): Promise<{ id: number } | null> {
  const name = (displayName || email.split('@')[0]).slice(0, 255)
  const insertUser = (username: string) => db.insert(schema.users)
    .values({ username, email, displayName: name, passwordHash: null, active: true })
    .onConflictDoNothing().returning({ id: schema.users.id })
  let [u] = await insertUser(email)
  if (!u) {
    const again = await findUserByEmail(email) // lost a race on email
    if (again) u = { id: again.id }
    else [u] = await insertUser(`${email}#${randomBytes(4).toString('hex')}`) // username taken by someone else
  }
  return u ?? null
}
