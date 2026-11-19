/**
 * Mapping of an inbound payload to an issue action. A mapping is stored on the source as JSON: every text field is a
 * safe template (see template.ts). The result is a plain `Normalized` record, the same shape the built-in Sentry
 * source produces, so the service layer does not care where it came from.
 */
import { z } from 'zod';
import { getPath, renderTemplate, stringifyValue, templateError, parsePath } from './template';

export interface Normalized {
  summary: string;
  description: string;
  /** Priority name as written by the source ("critical", "High"...), resolved against the priority list later. */
  priority: string | null;
  labels: string[];
  /** Same key = same problem (alert fingerprint, Sentry issue id). Null = every payload is a new issue. */
  dedupKey: string | null;
  /** True when the payload reports the problem as resolved. */
  resolved: boolean;
  /** Text for a comment on an existing issue. */
  comment: string;
  /** Source-provided idempotency key (payload field), if the mapping defines one. */
  idempotencyKey: string | null;
}

const tpl = (max: number) => z.string().max(max).superRefine((v, ctx) => {
  const e = templateError(v);
  if (e) ctx.addIssue({ code: 'custom', message: e });
});

export const mappingSchema = z.object({
  summary: tpl(1000).optional(),
  description: tpl(4000).optional(),
  comment: tpl(4000).optional(),
  /** Template that renders to the source's severity ("critical", "P1"...). */
  priority: tpl(500).optional(),
  /** Lower-cased severity -> priority name of this instance. */
  priorityMap: z.record(z.string().max(100), z.string().max(100)).refine((m) => Object.keys(m).length <= 50, 'Too many priorityMap entries').optional(),
  labels: z.array(tpl(200)).max(10).optional(),
  dedupKey: tpl(500).optional(),
  idempotencyKey: tpl(500).optional(),
  /** The payload reports "resolved" when the value at `path` equals (case-insensitive) one of `equals`. */
  resolvedWhen: z.object({
    path: z.string().max(200).refine((p) => parsePath(p) !== null, 'Invalid path'),
    equals: z.union([z.string().max(100), z.array(z.string().max(100)).max(20)]),
  }).strict().optional(),
}).strict();

export type Mapping = z.infer<typeof mappingSchema>;

export const DEFAULT_MAPPING: Mapping = {
  summary: '{{title | default "Webhook event"}}',
  description: '{{message | default ""}}',
};

export function cleanLabel(s: string): string {
  return s.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._:-]/gu, '').slice(0, 100);
}

export function resolvedByMapping(m: Mapping, payload: unknown): boolean {
  const r = m.resolvedWhen;
  if (!r) return false;
  const actual = stringifyValue(getPath(payload, r.path)).trim().toLowerCase();
  if (!actual) return false;
  const wanted = (Array.isArray(r.equals) ? r.equals : [r.equals]).map((x) => x.trim().toLowerCase());
  return wanted.includes(actual);
}

export function applyMapping(raw: unknown, payload: unknown): Normalized {
  const parsed = mappingSchema.safeParse(raw ?? {});
  const m: Mapping = parsed.success && Object.keys(parsed.data).length ? parsed.data : DEFAULT_MAPPING;
  const r = (t: string | undefined, max: number) => (t ? renderTemplate(t, payload, { maxLength: max }).trim() : '');

  const summary = (r(m.summary ?? DEFAULT_MAPPING.summary, 1000).split(/\r?\n/)[0] || 'Webhook event').slice(0, 255);
  const description = r(m.description, 20_000);
  const severity = r(m.priority, 200).toLowerCase();
  const priority = severity ? (m.priorityMap?.[severity] ?? (m.priorityMap ? null : severity)) : null;
  const labels: string[] = [];
  for (const l of m.labels ?? []) {
    const c = cleanLabel(r(l, 200));
    if (c && !labels.includes(c)) labels.push(c);
  }
  const dedup = r(m.dedupKey, 300);
  const idem = r(m.idempotencyKey, 200);
  return {
    summary,
    description,
    priority,
    labels,
    dedupKey: dedup || null,
    resolved: resolvedByMapping(m, payload),
    comment: r(m.comment, 20_000) || description || summary,
    idempotencyKey: idem || null,
  };
}
