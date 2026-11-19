import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';

export async function generateIssueKey(projectId: number, projectKey: string): Promise<string> {
  const result = await db.transaction(async (tx) => {
    const counters = await tx
      .select()
      .from(schema.projectIssueCounters)
      .where(eq(schema.projectIssueCounters.projectId, projectId))
      .for('update');

    let nextValue: number;
    if (counters.length === 0) {
      nextValue = 1;
      await tx.insert(schema.projectIssueCounters).values({
        projectId,
        currentValue: nextValue,
      });
    } else {
      nextValue = (counters[0].currentValue ?? 0) + 1;
      await tx
        .update(schema.projectIssueCounters)
        .set({ currentValue: nextValue })
        .where(eq(schema.projectIssueCounters.projectId, projectId));
    }

    return `${projectKey}-${nextValue}`;
  });

  return result;
}
