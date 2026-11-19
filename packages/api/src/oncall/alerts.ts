/** Pure helpers for alert ingestion (unit tested without a database). */
import { createHash, randomBytes } from 'node:crypto';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

const ALIASES: Record<string, Severity> = {
  critical: 'critical', fatal: 'critical', p1: 'critical', sev1: 'critical', emergency: 'critical',
  high: 'high', error: 'high', p2: 'high', sev2: 'high',
  medium: 'medium', warning: 'medium', warn: 'medium', p3: 'medium', sev3: 'medium',
  low: 'low', p4: 'low', sev4: 'low',
  info: 'info', informational: 'info', p5: 'info', debug: 'info',
};

/** Maps the many names monitoring tools use onto our five levels; unknown or missing = high (do not lose an alert). */
export function normalizeSeverity(v: unknown): Severity {
  return typeof v === 'string' ? (ALIASES[v.trim().toLowerCase()] ?? 'high') : 'high';
}

export const newAlertKey = () => `vqa_${randomBytes(24).toString('base64url')}`;
export const hashAlertKey = (key: string) => createHash('sha256').update(key).digest('hex');

export interface AlertInput { title: string; description: string | null; severity: Severity; dedupKey: string; resolved: boolean }

/** Accepts our own payload plus the common "status: resolved/ok" convention. Returns an error text for unusable input. */
export function parseAlert(body: unknown): AlertInput | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'The alert must be a JSON object';
  const b = body as Record<string, unknown>;
  const title = typeof b.title === 'string' ? b.title.trim() : typeof b.summary === 'string' ? b.summary.trim() : '';
  if (!title) return 'title is required';
  const description = typeof b.description === 'string' && b.description.trim() ? b.description.slice(0, 10_000) : null;
  const dk = typeof b.dedupKey === 'string' && b.dedupKey.trim() ? b.dedupKey.trim() : title;
  const status = typeof b.status === 'string' ? b.status.toLowerCase() : '';
  return {
    title: title.slice(0, 500),
    description,
    severity: normalizeSeverity(b.severity),
    dedupKey: dk.slice(0, 255),
    resolved: ['resolved', 'ok', 'closed', 'recovered'].includes(status),
  };
}
