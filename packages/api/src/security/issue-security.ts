/**
 * Issue security levels: the ONE place that decides "may this user see this issue because of its security level".
 *
 * An issue without a level (security_level_id IS NULL) is not affected. An issue with a level is visible only to members
 * of that level: a user, a group, a project role, "reporter", "assignee", "project lead" or "any logged in user".
 * Nobody else sees it: no bypass for project administrators, system administrators or the built-in admin (as in Jira).
 * Anonymous requests (user = null) never see a secured issue.
 *
 * This is a rule on top of BROWSE_PROJECTS: callers keep scoping by browsable projects and add `issueVisibleSql(...)`
 * to the WHERE clause, so lists, counts and aggregates are filtered in SQL and never post-filtered in memory.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '@veqsio/db';

export const LEVEL_MEMBER_TYPES = ['user', 'group', 'role', 'reporter', 'assignee', 'project_lead', 'any_user'] as const;
export type LevelMemberType = (typeof LEVEL_MEMBER_TYPES)[number];

const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Membership clause on a level member row `m`: does user `uid` match it for the issue row `alias`? Shared by the filter and the explanation. */
function memberMatches(uid: SQL, alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(
      m.member_type = 'any_user'
      OR (m.member_type = 'user' AND m.user_id = ${uid})
      OR (m.member_type = 'group' AND m.group_id IN (SELECT ug.group_id FROM user_groups ug WHERE ug.user_id = ${uid}))
      OR (m.member_type = 'role' AND m.project_role_id IN (
            SELECT pra.role_id FROM project_role_actors pra
            WHERE pra.project_id = ${a}.project_id
              AND (pra.user_id = ${uid} OR pra.group_id IN (SELECT ug.group_id FROM user_groups ug WHERE ug.user_id = ${uid}))))
      OR (m.member_type = 'reporter' AND ${a}.reporter_id = ${uid})
      OR (m.member_type = 'assignee' AND ${a}.assignee_id = ${uid})
      OR (m.member_type = 'project_lead' AND EXISTS (SELECT 1 FROM projects lp WHERE lp.id = ${a}.project_id AND lp.lead_id = ${uid}))
    )`;
}

/** SQL predicate that is true when the user is a member of the security level of the issue row `alias`. */
function memberOfLevel(uid: SQL, alias: string): SQL {
  const a = sql.raw(alias);
  return sql`EXISTS (SELECT 1 FROM issue_security_level_members m WHERE m.level_id = ${a}.security_level_id AND ${memberMatches(uid, alias)})`;
}

/**
 * Fast path. While no security level exists, no issue can carry one, so the predicate is always true and is left out of the SQL.
 * That lets PostgreSQL use plain index scans for counts and lists instead of evaluating a sub-plan per row (about 8 times faster on 100,000 issues).
 * The flag is refreshed every 5 seconds and at once when a level is created on this node; it starts as "in use" (the safe side),
 * and a failed refresh keeps the last known value. On another node a new level takes effect within the refresh interval.
 */
let levelsInUse = true;
let flagStarted = false;
export async function refreshSecurityLevelsFlag(): Promise<void> {
  try {
    const rows = (await db.execute(sql`SELECT EXISTS (SELECT 1 FROM issue_security_levels) AS used`)) as unknown as Array<{ used: boolean }>;
    levelsInUse = rows[0]?.used !== false;
  } catch { /* keep the last known value */ }
}
function startFlag() {
  if (flagStarted) return;
  flagStarted = true;
  void refreshSecurityLevelsFlag();
  const t = setInterval(() => void refreshSecurityLevelsFlag(), 5000);
  (t as { unref?: () => void }).unref?.();
}

/**
 * WHERE fragment: "the user passes the security level of the issue row `alias`" (default alias: issues).
 * `user` is a user id, a SQL expression yielding a user id (for per-user checks in a join) or null for anonymous.
 */
export function issueVisibleSql(user: number | null | SQL, alias = 'issues'): SQL {
  if (!ALIAS_RE.test(alias)) throw new Error('invalid alias');
  const a = sql.raw(alias);
  startFlag();
  if (!levelsInUse) return sql`TRUE`;
  if (user === null) return sql`(${a}.security_level_id IS NULL)`;
  const uid = typeof user === 'number' ? sql`${user}` : user;
  return sql`(${a}.security_level_id IS NULL OR ${memberOfLevel(uid, alias)})`;
}

/** Same predicate for callers that only have a user object or null. */
export const issueVisibleFor = (user: { id: number } | null | undefined, alias = 'issues'): SQL => issueVisibleSql(user ? user.id : null, alias);

/** Can this user (or anonymous) see the issue because of its security level? A missing issue is not visible. */
export async function canSeeIssue(userId: number | null, issueId: number): Promise<boolean> {
  const rows = (await db.execute(sql`SELECT 1 AS ok FROM issues WHERE issues.id = ${issueId} AND ${issueVisibleSql(userId)} LIMIT 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** The subset of `issueIds` the user may see (one query). */
export async function visibleIssueIds(userId: number | null, issueIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(issueIds.filter((n) => Number.isInteger(n)))];
  if (ids.length === 0) return new Set();
  const rows = (await db.execute(sql`
    SELECT issues.id FROM issues
    WHERE issues.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND ${issueVisibleSql(userId)}`)) as unknown as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/** The users among `userIds` who may see the issue (used to trim recipient lists: never mail someone who cannot see it). */
export async function usersWhoCanSee(issueId: number, userIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(userIds.filter((n) => Number.isInteger(n)))];
  if (ids.length === 0) return new Set();
  const rows = (await db.execute(sql`
    SELECT u.id FROM users u
    WHERE u.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      AND EXISTS (SELECT 1 FROM issues WHERE issues.id = ${issueId} AND ${issueVisibleSql(sql`u.id`)})`)) as unknown as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/** Blank out references to issues the user cannot see in already built responses (parent, subtasks, links). */
export async function redactIssueResponses<T extends { id: number; fields: Record<string, any> }>(userId: number | null, responses: T[]): Promise<T[]> {
  const refs = new Set<number>();
  const collect = (r: T) => {
    const f = r.fields;
    if (f.parent?.id) refs.add(f.parent.id);
    for (const s of f.subtasks ?? []) if (s?.id) refs.add(s.id);
    for (const l of f.issuelinks ?? []) {
      const i = l?.inwardIssue ?? l?.outwardIssue;
      if (i?.id) refs.add(i.id);
    }
  };
  responses.forEach(collect);
  if (refs.size === 0) return responses;
  const hidden = new Set<number>();
  const visible = await visibleIssueIds(userId, [...refs]);
  for (const id of refs) if (!visible.has(id)) hidden.add(id);
  if (hidden.size === 0) return responses;
  return responses.map((r) => {
    const f = r.fields;
    return {
      ...r,
      fields: {
        ...f,
        parent: f.parent && hidden.has(f.parent.id) ? null : f.parent,
        subtasks: (f.subtasks ?? []).filter((s: any) => !hidden.has(s.id)),
        issuelinks: (f.issuelinks ?? []).filter((l: any) => !hidden.has((l.inwardIssue ?? l.outwardIssue)?.id)),
      },
    };
  });
}

export async function redactIssueResponse<T extends { id: number; fields: Record<string, any> }>(userId: number | null, response: T): Promise<T> {
  return (await redactIssueResponses(userId, [response]))[0];
}

/** Level of an issue with the scheme it belongs to (null when the issue has none). */
export async function levelOfIssue(issueId: number) {
  const rows = await db
    .select({ id: schema.issueSecurityLevels.id, name: schema.issueSecurityLevels.name, description: schema.issueSecurityLevels.description, schemeId: schema.issueSecurityLevels.schemeId })
    .from(schema.issues)
    .innerJoin(schema.issueSecurityLevels, sql`${schema.issueSecurityLevels.id} = ${schema.issues.securityLevelId}`)
    .where(sql`${schema.issues.id} = ${issueId}`)
    .limit(1);
  return rows[0] ?? null;
}

/** The scheme of a project (null when none). */
export async function schemeOfProject(projectId: number) {
  const rows = await db
    .select({ id: schema.issueSecuritySchemes.id, name: schema.issueSecuritySchemes.name, defaultLevelId: schema.issueSecuritySchemes.defaultLevelId })
    .from(schema.issueSecuritySchemeAssociations)
    .innerJoin(schema.issueSecuritySchemes, sql`${schema.issueSecuritySchemes.id} = ${schema.issueSecuritySchemeAssociations.schemeId}`)
    .where(sql`${schema.issueSecuritySchemeAssociations.projectId} = ${projectId}`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Validate a requested level for a project: null clears; otherwise the level must belong to the project's scheme.
 * Returns the level id to store or throws an Error with a user-facing message.
 */
export async function resolveLevelForProject(projectId: number, requested: unknown): Promise<number | null> {
  if (requested === null || requested === '' || requested === undefined) return null;
  const id = typeof requested === 'object' ? Number((requested as { id?: unknown }).id) : Number(requested);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid security level');
  const scheme = await schemeOfProject(projectId);
  if (!scheme) throw new Error('This project has no issue security scheme');
  const rows = await db.select({ id: schema.issueSecurityLevels.id }).from(schema.issueSecurityLevels)
    .where(sql`${schema.issueSecurityLevels.id} = ${id} AND ${schema.issueSecurityLevels.schemeId} = ${scheme.id}`).limit(1);
  if (!rows[0]) throw new Error('Security level does not belong to the security scheme of this project');
  return id;
}

/** Default level for new issues of a project (null when the project has no scheme or the scheme has no default). */
export async function defaultLevelForProject(projectId: number): Promise<number | null> {
  return (await schemeOfProject(projectId))?.defaultLevelId ?? null;
}

export interface SecurityExplanation {
  /** The issue has a level and the user is not a member: the issue is hidden. */
  hidden: boolean
  level: { id: number; name: string } | null
  reasons: Array<{ kind: string; granted: boolean; decisive: boolean; text: string; link?: string }>
}

/** Ordered reasons why a user passes or fails the security level of an issue (the admin Permission helper shows them). */
export async function explainIssueSecurity(userId: number, issueId: number): Promise<SecurityExplanation> {
  const level = await levelOfIssue(issueId);
  if (!level) {
    return { hidden: false, level: null, reasons: [{ kind: 'security-none', granted: true, decisive: false, text: 'The issue has no security level, so no level restricts who can see it.', link: '/admin/issue-security' }] };
  }
  const link = '/admin/issue-security';
  const [issue] = await db.select({ reporterId: schema.issues.reporterId, assigneeId: schema.issues.assigneeId, projectId: schema.issues.projectId, key: schema.issues.issueKey }).from(schema.issues).where(sql`${schema.issues.id} = ${issueId}`).limit(1);
  const members = (await db.execute(sql`
    SELECT m.id, m.member_type, m.user_id, m.group_id, m.project_role_id,
           u.display_name AS user_name, g.name AS group_name, r.name AS role_name,
           ${memberMatches(sql`${userId}`, 'issues')} AS matches
    FROM issue_security_level_members m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN groups g ON g.id = m.group_id
    LEFT JOIN project_roles r ON r.id = m.project_role_id
    JOIN issues ON issues.id = ${issueId}
    WHERE m.level_id = ${level.id}
    ORDER BY m.id`)) as unknown as Array<{ member_type: LevelMemberType; user_name: string | null; group_name: string | null; role_name: string | null; matches: boolean }>;
  const reasons: SecurityExplanation['reasons'] = [];
  const lv = `security level "${level.name}"`;
  for (const m of members) {
    const yes = !!m.matches;
    let text: string;
    switch (m.member_type) {
      case 'any_user': text = `${lv} includes any logged-in user.`; break;
      case 'user': text = yes ? `Named directly as a member of ${lv}.` : `${lv} includes the single user ${m.user_name}, not this user.`; break;
      case 'group': text = yes ? `Member of group "${m.group_name}", which is a member of ${lv}.` : `${lv} includes group "${m.group_name}", which this user is not a member of.`; break;
      case 'role': text = yes ? `Has the project role "${m.role_name}" in this project, which is a member of ${lv}.` : `${lv} includes project role "${m.role_name}", which this user does not have in this project.`; break;
      case 'reporter': text = yes ? `Is the reporter of ${issue?.key}, and ${lv} includes the reporter.` : `${lv} includes the reporter, and this user is not the reporter of ${issue?.key}.`; break;
      case 'assignee': text = yes ? `Is the assignee of ${issue?.key}, and ${lv} includes the assignee.` : `${lv} includes the assignee, and this user is not the assignee of ${issue?.key}.`; break;
      case 'project_lead': text = yes ? `Is the project lead, and ${lv} includes the project lead.` : `${lv} includes the project lead, and this user is not the lead of this project.`; break;
      default: text = `${lv} has an unknown member type "${m.member_type}".`;
    }
    reasons.push({ kind: `security-${m.member_type}`, granted: yes, decisive: true, text, link });
  }
  const allowed = reasons.some((r) => r.granted);
  if (!allowed) {
    reasons.push({
      kind: 'security-missing', granted: false, decisive: true, link,
      text: `${issue?.key ?? 'The issue'} has ${lv} and this user is not a member of it, so the issue is hidden from them. Security levels apply even to project and system administrators.`,
    });
  }
  return { hidden: !allowed, level: { id: level.id, name: level.name }, reasons };
}
