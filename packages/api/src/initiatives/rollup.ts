/**
 * Initiatives: pure rules (no database). Routes are in routes/initiatives.ts.
 *
 * - Progress rolls up from the child issues of the linked epics and from the issues of the linked projects
 *   (epics themselves are containers and are not counted). Cancelled issues are neither done nor outstanding
 *   (see workflow/status-groups.ts), an issue reached twice (through an epic and through its project) counts once.
 * - Permission trimming: a viewer only ever sees, and is only ever counted against, the linked epics and projects
 *   they may browse. Nothing reveals how many linked items were hidden.
 * - Who may do what (a "global-style" rule, not tied to a project): everybody signed in may create an initiative and
 *   becomes its owner; the owner and administrators may edit, link, unlink, post status updates and delete it.
 *   Everybody signed in may read an initiative that has at least one visible linked item, or that they own;
 *   administrators may read all of them.
 */
import { z } from 'zod';
import { summarizeProgress, type ProgressSummary } from '../workflow/status-groups';

export const INITIATIVE_STATUSES = ['planned', 'active', 'completed', 'cancelled'] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];
export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  planned: 'Planned', active: 'Active', completed: 'Completed', cancelled: 'Cancelled',
};

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd').refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date');

export const initiativeCreateBody = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(20_000).optional().default(''),
  ownerId: z.number().int().positive().optional(),
  status: z.enum(INITIATIVE_STATUSES).optional().default('planned'),
  startDate: dateStr.nullable().optional(),
  targetDate: dateStr.nullable().optional(),
}).strict();

export const initiativeUpdateBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(20_000).optional(),
  ownerId: z.number().int().positive().nullable().optional(),
  status: z.enum(INITIATIVE_STATUSES).optional(),
  startDate: dateStr.nullable().optional(),
  targetDate: dateStr.nullable().optional(),
}).strict();

export const initiativeLinkBody = z.object({
  projectKey: z.string().trim().min(1).max(20).optional(),
  issueKey: z.string().trim().min(1).max(40).optional(),
}).strict().refine((b) => (b.projectKey ? 1 : 0) + (b.issueKey ? 1 : 0) === 1, { message: 'Give exactly one of projectKey or issueKey' });

/** Why the dates are invalid (null when fine): the target must not be before the start. */
export function validateInitiativeDates(start: string | null | undefined, target: string | null | undefined): string | null {
  if (start && target && target < start) return 'targetDate must not be before startDate';
  return null;
}

export const canManageInitiative = (a: { isAdmin: boolean; isOwner: boolean }): boolean => a.isAdmin || a.isOwner;

/** Read rule: admin, owner, or at least one linked epic/project the viewer can browse. */
export function canReadInitiative(a: { isAdmin: boolean; isOwner: boolean; visibleLinkCount: number }): boolean {
  return a.isAdmin || a.isOwner || a.visibleLinkCount > 0;
}

/** Keep only the items whose project the viewer can browse. */
export function trimToVisible<T extends { projectId: number }>(items: readonly T[], visibleProjectIds: ReadonlySet<number>): T[] {
  return items.filter((i) => visibleProjectIds.has(i.projectId));
}

export interface RollupIssue { id: number; projectId: number; category: string | null | undefined }
export interface RollupResult extends ProgressSummary { issueCount: number }

/** Progress over the given issues: each counted once, only those in visible projects, cancelled excluded. */
export function rollupProgress(issues: readonly RollupIssue[], visibleProjectIds: ReadonlySet<number>): RollupResult {
  const seen = new Set<number>();
  const items: Array<{ category: string | null | undefined }> = [];
  for (const i of issues) {
    if (seen.has(i.id) || !visibleProjectIds.has(i.projectId)) continue;
    seen.add(i.id);
    items.push({ category: i.category });
  }
  return { ...summarizeProgress(items), issueCount: items.length };
}
