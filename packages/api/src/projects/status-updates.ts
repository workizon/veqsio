/**
 * Project status updates: a state (On track / At risk / Off track) with free text, posted on a project or on an
 * epic. The newest update is the current state. Pure helpers only; routes are in routes/status-updates.ts.
 */
import { z } from 'zod';

export const UPDATE_STATES = ['on_track', 'at_risk', 'off_track'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export const UPDATE_STATE_LABEL: Record<UpdateState, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};

export const MAX_BODY = 10_000;

export const statusUpdateBody = z.object({
  state: z.enum(UPDATE_STATES),
  body: z.string().max(MAX_BODY).optional().default(''),
}).strict();

export const isUpdateState = (v: unknown): v is UpdateState => (UPDATE_STATES as readonly unknown[]).includes(v);

export interface UpdateRow { id: number; state: string; body: string; createdAt: Date | string; authorId: number | null }

/** Newest first; ties on the timestamp are broken by id so the order is stable. */
export function sortNewestFirst<T extends { id: number; createdAt: Date | string }>(rows: readonly T[]): T[] {
  const t = (d: Date | string) => new Date(d).getTime();
  return [...rows].sort((a, b) => t(b.createdAt) - t(a.createdAt) || b.id - a.id);
}

/** The current state: the newest update, or null when there is none. */
export function latestOf<T extends { id: number; createdAt: Date | string }>(rows: readonly T[]): T | null {
  return sortNewestFirst(rows)[0] ?? null;
}

/** Colour and text for the badge; unknown states (never stored) fall back to a neutral grey. */
export function badgeFor(state: string): { label: string; color: string } {
  switch (state) {
    case 'on_track': return { label: UPDATE_STATE_LABEL.on_track, color: '#16A06A' };
    case 'at_risk': return { label: UPDATE_STATE_LABEL.at_risk, color: '#C77700' };
    case 'off_track': return { label: UPDATE_STATE_LABEL.off_track, color: '#C9372C' };
    default: return { label: state, color: '#667085' };
  }
}
