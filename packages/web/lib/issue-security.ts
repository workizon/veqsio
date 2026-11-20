/** Pure helpers of the issue security UI (admin page, issue field, project settings). */
import { trNow } from './tr'

export const MEMBER_TYPES = ['user', 'group', 'role', 'reporter', 'assignee', 'project_lead', 'any_user'] as const
export type MemberType = (typeof MEMBER_TYPES)[number]

export const MEMBER_TYPE_LABEL: Record<MemberType, string> = {
  user: 'Single user',
  group: 'Group',
  role: 'Project role',
  reporter: 'Reporter',
  assignee: 'Assignee',
  project_lead: 'Project lead',
  any_user: 'Any logged-in user',
}

/** Types that need a picker value (user / group / role) versus rules that stand alone. */
export const needsTarget = (t: MemberType): boolean => t === 'user' || t === 'group' || t === 'role'

export interface LevelMember { id: number; type: MemberType; userId: number | null; groupId: number | null; roleId: number | null; label: string }
export interface SecurityLevel { id: number; name: string; description: string | null; sortOrder: number; issueCount: number; members: LevelMember[] }
export interface SecurityScheme { id: number; name: string; description: string | null; defaultLevelId: number | null; levels: SecurityLevel[]; projects: Array<{ id: number; key: string; name: string }> }

/** Short "who sees it" summary of a level, e.g. "Alice, Group dev, Reporter +1". */
export function summarizeMembers(members: LevelMember[], max = 3): string {
  if (members.length === 0) return trNow('Nobody (the level hides issues from everyone)')
  const shown = members.slice(0, max).map((m) => (m.type === 'group' ? trNow('Group {name}', { name: m.label }) : m.type === 'role' ? trNow('Role {name}', { name: m.label }) : m.label))
  return shown.join(', ') + (members.length > max ? ` +${members.length - max}` : '')
}

export interface LevelChoice { value: string; label: string; description?: string | null }

/** Options of the issue security select: "None" first (when allowed), the scheme default marked. */
export function levelChoices(levels: Array<{ id: number; name: string; description?: string | null }>, defaultLevelId: number | null, allowNone = true): LevelChoice[] {
  const out: LevelChoice[] = allowNone ? [{ value: '', label: 'None' }] : []
  for (const l of levels) out.push({ value: String(l.id), label: l.id === defaultLevelId ? `${l.name} (default)` : l.name, description: l.description })
  return out
}

/** Value for the REST payload (`fields.security`): null clears, {id} sets; undefined = leave as it is. */
export function securityPayload(selected: string, current: number | null | undefined): { id: number } | null | undefined {
  const next = selected === '' ? null : Number(selected)
  if ((current ?? null) === next) return undefined
  return next === null ? null : { id: next }
}

export interface UsedLevel { levelId: number; n: number }

/** Body for changing a project's scheme: every level in use must be mapped (to a level of the new scheme or null). */
export function mappingBody(used: UsedLevel[], choices: Record<number, string>): { ok: boolean; levelMapping: Record<string, number | null> } {
  const levelMapping: Record<string, number | null> = {}
  let ok = true
  for (const u of used) {
    const c = choices[u.levelId]
    if (c === undefined) { ok = false; continue }
    levelMapping[String(u.levelId)] = c === '' ? null : Number(c)
  }
  return { ok, levelMapping }
}

export function describeDelete(level: { name: string; issueCount: number }): string | null {
  return level.issueCount > 0 ? `${level.issueCount} issue${level.issueCount === 1 ? '' : 's'} use "${level.name}". Change their level first.` : null
}
