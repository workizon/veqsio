import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, desc, count, inArray } from 'drizzle-orm';

export async function getIssueHistory(issueId: number, limit = 50, offset = 0) {
  const items = await db
    .select()
    .from(schema.issueHistory)
    .where(eq(schema.issueHistory.issueId, issueId))
    .orderBy(desc(schema.issueHistory.createdAt))
    .limit(limit)
    .offset(offset);

  const totalResult = await db
    .select({ count: count() })
    .from(schema.issueHistory)
    .where(eq(schema.issueHistory.issueId, issueId));

  const aIds = [...new Set(items.map((h) => h.authorId).filter((x): x is number => !!x))];
  const agentIds = new Set(aIds.length ? (await db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, aIds))).filter((u) => u.username.startsWith('agent:')).map((u) => u.id) : []);

  return {
    startAt: offset,
    maxResults: limit,
    total: Number(totalResult[0]?.count || 0),
    histories: items.map((h) => ({
      id: String(h.id),
      author: { id: h.authorId, ...(h.authorId && agentIds.has(h.authorId) ? { isAgent: true } : {}) },
      created: h.createdAt!.toISOString(),
      items: [
        {
          field: h.fieldName,
          fieldtype: 'jira',
          fieldId: h.fieldName,
          from: h.oldValue,
          fromString: h.oldValue,
          to: h.newValue,
          toString: h.newValue,
        },
      ],
    })),
  };
}
