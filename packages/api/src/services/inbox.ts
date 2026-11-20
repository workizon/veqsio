/**
 * In-app inbox (the bell in the header). Rows are written by the notification senders for the people they already
 * chose as recipients (issue security applied), so this never decides who may see what. Writing never throws:
 * a failed inbox row must not break the action that caused it.
 */
import { db } from '../db';
import * as schema from '@veqsio/db';

export type InboxKind = 'assignment' | 'mention' | 'comment' | 'update' | 'created' | 'sprint';
export interface InboxEntry { kind: InboxKind; title: string; body?: string; link?: string }

export async function recordInbox(userIds: number[], entry: InboxEntry): Promise<void> {
  try {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const row = { kind: entry.kind, title: entry.title.slice(0, 255), body: (entry.body ?? '').slice(0, 300), link: entry.link ? entry.link.slice(0, 500) : null };
    await db.insert(schema.inboxNotifications).values(ids.map((userId) => ({ userId, ...row })));
  } catch (e) {
    console.error('[inbox] failed:', e instanceof Error ? e.message : 'error');
  }
}
