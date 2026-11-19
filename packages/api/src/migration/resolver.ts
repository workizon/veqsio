import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import * as schema from '@veqsio/db'
import type { NormalizedUser } from './rest/mapper'

type Db = typeof db

export interface ResolverOptions {
  /** Map source usernames/emails to existing Veqsio usernames. */
  userMapping?: Record<string, string>
  /** Create placeholder users for unknown people (default true). */
  createMissingUsers?: boolean
}

/** Find-or-create lookups for reference data shared by all importers. Caches live for one run. */

/** Find-or-create caches live for one import run. */
export class Resolver {
  private cache = new Map<string, number>()
  usersCreated = 0
  constructor(private d: Db, private opts: ResolverOptions = {}) {}

  private async memo(key: string, load: () => Promise<number>): Promise<number> {
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const id = await load()
    this.cache.set(key, id)
    return id
  }

  /** Look up an existing Veqsio user without creating anything (mapping, e-mail, username, display name). */
  async findUser(u: NormalizedUser): Promise<number | null> {
    const mapped = this.opts.userMapping?.[u.username] ?? this.opts.userMapping?.[u.email]
    if (mapped) {
      const [m] = await this.d.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, mapped)).limit(1)
      if (m) return m.id
    }
    const [byEmail] = await this.d.select({ id: schema.users.id }).from(schema.users).where(eq(sql`lower(${schema.users.email})`, u.email)).limit(1)
    if (byEmail) return byEmail.id
    const [byName] = await this.d.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, u.username)).limit(1)
    if (byName) return byName.id
    const [byDisplay] = await this.d.select({ id: schema.users.id }).from(schema.users).where(eq(sql`lower(${schema.users.displayName})`, u.displayName.toLowerCase())).limit(1)
    return byDisplay?.id ?? null
  }

  user(u: NormalizedUser | null): Promise<number | null> {
    if (!u) return Promise.resolve(null)
    return this.memo(`user:${u.email}:${u.username}`, async () => {
      const found = await this.findUser(u)
      if (found !== null) return found
      if (this.opts.createMissingUsers === false) return -1
      // Username must be unique: suffix on collision.
      let username = u.username
      for (let i = 2; ; i++) {
        const [clash] = await this.d.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username)).limit(1)
        if (!clash) break
        username = `${u.username}-${i}`
      }
      const [row] = await this.d.insert(schema.users).values({
        username, email: u.email, displayName: u.displayName, passwordHash: null, active: true,
      }).returning({ id: schema.users.id })
      this.usersCreated++
      return row.id
    }).then((id) => (id === -1 ? null : id))
  }

  issueType(name: string, subtask: boolean) {
    return this.memo(`it:${name}`, async () => {
      const [e] = await this.d.select().from(schema.issueTypes).where(eq(sql`lower(${schema.issueTypes.name})`, name.toLowerCase())).limit(1)
      if (e) return e.id
      const [r] = await this.d.insert(schema.issueTypes).values({ name, isSubtask: subtask }).returning()
      return r.id
    })
  }

  status(name: string, category: string) {
    return this.memo(`st:${name}`, async () => {
      const [e] = await this.d.select().from(schema.statuses).where(eq(sql`lower(${schema.statuses.name})`, name.toLowerCase())).limit(1)
      if (e) return e.id
      const [r] = await this.d.insert(schema.statuses).values({ name, category }).returning()
      return r.id
    })
  }

  priority(name: string) {
    return this.memo(`pr:${name}`, async () => {
      const [e] = await this.d.select().from(schema.priorities).where(eq(sql`lower(${schema.priorities.name})`, name.toLowerCase())).limit(1)
      if (e) return e.id
      const [r] = await this.d.insert(schema.priorities).values({ name }).returning()
      return r.id
    })
  }

  resolution(name: string) {
    return this.memo(`rs:${name}`, async () => {
      const [e] = await this.d.select().from(schema.resolutions).where(eq(sql`lower(${schema.resolutions.name})`, name.toLowerCase())).limit(1)
      if (e) return e.id
      const [r] = await this.d.insert(schema.resolutions).values({ name }).returning()
      return r.id
    })
  }

  label(name: string) {
    return this.memo(`lb:${name}`, async () => {
      const [e] = await this.d.select().from(schema.labels).where(eq(schema.labels.name, name.slice(0, 100))).limit(1)
      if (e) return e.id
      const [r] = await this.d.insert(schema.labels).values({ name: name.slice(0, 100) }).returning()
      return r.id
    })
  }

  component(projectId: number, name: string) {
    return this.memo(`cp:${projectId}:${name}`, async () => {
      const [e] = await this.d.select().from(schema.components).where(and(eq(schema.components.projectId, projectId), eq(schema.components.name, name))).limit(1)
      if (e) return e.id
      const [r] = await this.d.insert(schema.components).values({ projectId, name }).returning()
      return r.id
    })
  }

  version(projectId: number, name: string) {
    return this.memo(`vr:${projectId}:${name}`, async () => {
      const [e] = await this.d.select().from(schema.versions).where(and(eq(schema.versions.projectId, projectId), eq(schema.versions.name, name))).limit(1)
      if (e) return e.id
      const [r] = await this.d.insert(schema.versions).values({ projectId, name }).returning()
      return r.id
    })
  }

  linkType(t: { name: string; inward: string; outward: string }) {
    return this.memo(`lt:${t.name}`, async () => {
      const [e] = await this.d.select().from(schema.linkTypes).where(eq(schema.linkTypes.name, t.name)).limit(1)
      if (e) return e.id
      const [r] = await this.d.insert(schema.linkTypes).values(t).returning()
      return r.id
    })
  }
}

