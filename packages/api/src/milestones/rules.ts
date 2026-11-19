/**
 * Milestones: pure rules (no database). Routes are in routes/milestones.ts.
 * A milestone belongs to one project; only issues of that project can be linked to it (an issue may be in several
 * milestones). Progress counts the linked issues by status group with cancelled issues left out.
 */
import { z } from 'zod';
import { summarizeProgress, type ProgressSummary } from '../workflow/status-groups';

export const MILESTONE_STATES = ['open', 'reached'] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd').refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date');

export const milestoneCreateBody = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(5000).optional().default(''),
  targetDate: dateStr.nullable().optional(),
}).strict();

export const milestoneUpdateBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  targetDate: dateStr.nullable().optional(),
  state: z.enum(MILESTONE_STATES).optional(),
}).strict();

export const milestoneIssueBody = z.object({ issueKey: z.string().trim().min(1).max(40) }).strict();
export const issueMilestonesBody = z.object({ milestoneIds: z.array(z.number().int().positive()).max(50) }).strict();

/** Issues that do not belong to `projectId` (the milestone/project rule). Empty means all are fine. */
export function issuesOutsideProject(issues: ReadonlyArray<{ key: string; projectId: number }>, projectId: number): string[] {
  return issues.filter((i) => i.projectId !== projectId).map((i) => i.key);
}

export interface MilestoneProgress extends ProgressSummary { issueCount: number }

export function milestoneProgress(issues: ReadonlyArray<{ category: string | null | undefined }>): MilestoneProgress {
  return { ...summarizeProgress(issues), issueCount: issues.length };
}

/** An open milestone whose target date lies before `today` (yyyy-mm-dd). */
export function isOverdue(m: { state: string; targetDate: string | null }, today: string): boolean {
  return m.state !== 'reached' && !!m.targetDate && m.targetDate < today;
}
