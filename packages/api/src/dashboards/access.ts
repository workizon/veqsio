/**
 * Who may do what with a dashboard. Pure so the visibility matrix can be unit tested without a database.
 *
 *   owner  - everything: read, edit, share, delete
 *   edit   - read and change name, layout and gadgets (not sharing, not deletion)
 *   view   - read only (may favourite, clone and set as own default)
 *   null   - the dashboard does not exist as far as this user is concerned (callers answer 404)
 */

export type DashboardAccess = 'owner' | 'edit' | 'view' | null
export type SharePermission = 'view' | 'edit'
export type ShareType = 'user' | 'group' | 'project' | 'everyone'

export interface ShareRow {
  shareType: ShareType | string
  userId?: number | null
  groupId?: number | null
  projectId?: number | null
  permission: SharePermission | string
}

export interface AccessInput {
  ownerId: number | null
  userId: number
  shares: ShareRow[]
  groupIds: number[]
  /** Projects the user may browse; a project share reaches everyone who can browse that project. */
  browsableProjectIds: number[]
}

const RANK: Record<string, number> = { view: 1, edit: 2 }

export function resolveAccess(input: AccessInput): DashboardAccess {
  if (input.ownerId !== null && input.ownerId === input.userId) return 'owner'
  const groups = new Set(input.groupIds)
  const projects = new Set(input.browsableProjectIds)
  let best = 0
  for (const s of input.shares) {
    const rank = RANK[s.permission] ?? 0
    if (!rank) continue
    const hit =
      s.shareType === 'everyone' ||
      (s.shareType === 'user' && s.userId === input.userId) ||
      (s.shareType === 'group' && s.groupId != null && groups.has(s.groupId)) ||
      (s.shareType === 'project' && s.projectId != null && projects.has(s.projectId))
    if (hit && rank > best) best = rank
  }
  return best === 2 ? 'edit' : best === 1 ? 'view' : null
}

export const canView = (a: DashboardAccess) => a !== null
export const canEdit = (a: DashboardAccess) => a === 'owner' || a === 'edit'
export const canManage = (a: DashboardAccess) => a === 'owner'

export interface ShareInput {
  type: ShareType
  id?: number
  permission: SharePermission
}

/** Normalise a share list: drop duplicates (edit beats view) and an "everyone" entry shadows nothing but itself. */
export function normaliseShares(list: ShareInput[]): ShareInput[] {
  const map = new Map<string, ShareInput>()
  for (const s of list) {
    const key = s.type === 'everyone' ? 'everyone' : `${s.type}:${s.id}`
    const prev = map.get(key)
    if (!prev || RANK[s.permission] > RANK[prev.permission]) map.set(key, s)
  }
  return [...map.values()]
}
