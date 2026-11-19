import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, and, or, inArray, isNotNull } from 'drizzle-orm';
import { dependencyConflict, isScheduling, wouldCreateCycle, type DependencyEdge, type IssueDates } from './dependencies';

/** An error with an HTTP status the route maps through. */
export class LinkError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message); }
}

/** Dependency edges (predecessor -> successor) of all scheduling links. */
async function dependencyEdges(): Promise<DependencyEdge[]> {
  const rows = await db
    .select({ issueId: schema.issueLinks.issueId, linkedIssueId: schema.issueLinks.linkedIssueId })
    .from(schema.issueLinks)
    .innerJoin(schema.linkTypes, eq(schema.linkTypes.id, schema.issueLinks.linkTypeId))
    .where(isNotNull(schema.linkTypes.scheduling));
  return rows.map((r) => ({ predecessor: r.linkedIssueId, successor: r.issueId }));
}

/**
 * Links two issues. `issueId` is the issue that shows the type's inward sentence ("is blocked by", "starts after"),
 * `linkedIssueId` the one that shows the outward sentence ("blocks", "starts before"): the second is the predecessor
 * of a dependency. Rules: both issues and the type exist, no self links, no duplicate, at most one dependency per
 * pair of issues (in either direction) and no dependency cycles.
 */
export async function linkIssues(issueId: number, linkedIssueId: number, linkTypeId: number, userId: number) {
  if (issueId === linkedIssueId) throw new LinkError('Cannot link issue to itself');

  const [type] = await db.select().from(schema.linkTypes).where(eq(schema.linkTypes.id, linkTypeId)).limit(1);
  if (!type) throw new LinkError('Link type not found', 404);
  const found = await db.select({ id: schema.issues.id }).from(schema.issues).where(inArray(schema.issues.id, [issueId, linkedIssueId]));
  if (found.length !== 2) throw new LinkError('Issue not found', 404);

  const pairMatch = or(
    and(eq(schema.issueLinks.issueId, issueId), eq(schema.issueLinks.linkedIssueId, linkedIssueId)),
    and(eq(schema.issueLinks.issueId, linkedIssueId), eq(schema.issueLinks.linkedIssueId, issueId)),
  );
  const symmetric = type.inward === type.outward;
  const existing = await db
    .select({ issueId: schema.issueLinks.issueId, typeId: schema.issueLinks.linkTypeId, scheduling: schema.linkTypes.scheduling })
    .from(schema.issueLinks)
    .leftJoin(schema.linkTypes, eq(schema.linkTypes.id, schema.issueLinks.linkTypeId))
    .where(pairMatch);
  for (const e of existing) {
    if (e.typeId === linkTypeId && (e.issueId === issueId || symmetric)) throw new LinkError('Link already exists', 409);
    if (type.scheduling && e.scheduling) throw new LinkError('These issues already have a dependency; only one dependency per pair of issues is allowed', 409);
  }

  if (type.scheduling && wouldCreateCycle(await dependencyEdges(), linkedIssueId, issueId)) {
    throw new LinkError('This dependency would create a cycle between issues', 400);
  }

  await db.insert(schema.issueLinks).values({ issueId, linkedIssueId, linkTypeId });
}

export async function unlinkIssues(linkId: number, userId: number) {
  await db.delete(schema.issueLinks).where(eq(schema.issueLinks.id, linkId));
}

/** Project ids of the two issues of a link (for permission checks); null when the link does not exist. */
export async function linkProjects(linkId: number): Promise<number[] | null> {
  const [row] = await db.select({ a: schema.issueLinks.issueId, b: schema.issueLinks.linkedIssueId }).from(schema.issueLinks).where(eq(schema.issueLinks.id, linkId)).limit(1);
  if (!row) return null;
  const issues = await db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(inArray(schema.issues.id, [row.a, row.b]));
  return [...new Set(issues.map((i) => i.projectId))];
}

type LinkView = {
  id: number;
  type: any;
  issue: { id: number; key: string; summary: string };
  /** Only on dependency links: this issue's role and whether the dates of the two issues contradict it. */
  dependency?: { role: 'predecessor' | 'successor'; conflict: boolean; message: string | null };
};

const datesOf = (i: { startDate: Date | null; dueDate: Date | null }): IssueDates => ({ start: i.startDate?.getTime() ?? null, end: i.dueDate?.getTime() ?? null });

/** Links for many issues in a few queries (inward and outward), grouped by issue id. */
export async function getIssueLinksBulk(issueIds: number[]): Promise<Map<number, { inward: LinkView[]; outward: LinkView[] }>> {
  const out = new Map<number, { inward: LinkView[]; outward: LinkView[] }>();
  if (issueIds.length === 0) return out;
  const slot = (id: number) => {
    let v = out.get(id);
    if (!v) out.set(id, (v = { inward: [], outward: [] }));
    return v;
  };
  const [inward, outward, mine] = await Promise.all([
    db
      .select()
      .from(schema.issueLinks)
      .innerJoin(schema.linkTypes, eq(schema.linkTypes.id, schema.issueLinks.linkTypeId))
      .innerJoin(schema.issues, eq(schema.issues.id, schema.issueLinks.linkedIssueId))
      .where(inArray(schema.issueLinks.issueId, issueIds)),
    db
      .select()
      .from(schema.issueLinks)
      .innerJoin(schema.linkTypes, eq(schema.linkTypes.id, schema.issueLinks.linkTypeId))
      .innerJoin(schema.issues, eq(schema.issues.id, schema.issueLinks.issueId))
      .where(inArray(schema.issueLinks.linkedIssueId, issueIds)),
    db.select({ id: schema.issues.id, startDate: schema.issues.startDate, dueDate: schema.issues.dueDate }).from(schema.issues).where(inArray(schema.issues.id, issueIds)),
  ]);
  const own = new Map(mine.map((i) => [i.id, datesOf(i)]));
  const noDates: IssueDates = { start: null, end: null };
  const t = (r: typeof schema.linkTypes.$inferSelect) => ({ id: r.id, name: r.name, inward: r.inward, outward: r.outward, ...(r.scheduling ? { scheduling: r.scheduling } : {}) });

  // Rows where the requested issue is `issue_id`: it shows the inward sentence and is the successor of a dependency.
  for (const row of inward) {
    const view: LinkView = { id: row.issue_links.id, type: t(row.link_types), issue: { id: row.issues.id, key: row.issues.issueKey, summary: row.issues.summary } };
    const kind = row.link_types.scheduling;
    if (isScheduling(kind)) {
      const c = dependencyConflict(kind, datesOf(row.issues), own.get(row.issue_links.issueId) ?? noDates);
      view.dependency = { role: 'successor', conflict: c.conflict, message: c.message };
    }
    slot(row.issue_links.issueId).inward.push(view);
  }
  for (const row of outward) {
    const view: LinkView = { id: row.issue_links.id, type: t(row.link_types), issue: { id: row.issues.id, key: row.issues.issueKey, summary: row.issues.summary } };
    const kind = row.link_types.scheduling;
    if (isScheduling(kind)) {
      const c = dependencyConflict(kind, own.get(row.issue_links.linkedIssueId) ?? noDates, datesOf(row.issues));
      view.dependency = { role: 'predecessor', conflict: c.conflict, message: c.message };
    }
    slot(row.issue_links.linkedIssueId).outward.push(view);
  }
  return out;
}

export async function getIssueLinks(issueId: number) {
  return (await getIssueLinksBulk([issueId])).get(issueId) ?? { inward: [], outward: [] };
}
