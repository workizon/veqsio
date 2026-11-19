/**
 * Pure approval logic (no I/O): decision rules, reminder / expiry calculation and auto-approve rules.
 * Persistence and side effects live in service.ts; everything here is unit tested.
 */

export const RULES = ['all', 'any', 'n_of_m', 'percentage'] as const
export type Rule = (typeof RULES)[number]
export type Outcome = 'pending' | 'approved' | 'declined'
export type DecisionValue = 'approved' | 'declined'

export interface RuleSpec { rule: Rule; threshold?: number | null }
export interface DecisionLike { approverId: number; decision: DecisionValue }

const HOUR_MS = 3_600_000

/** Returns an error message for an invalid rule / threshold combination for `approverCount` approvers, else null. */
export function validateRuleSpec(spec: RuleSpec, approverCount: number): string | null {
  if (!RULES.includes(spec.rule)) return `Unknown rule '${String(spec.rule)}'`
  const t = spec.threshold
  if (spec.rule === 'n_of_m') {
    if (t == null || !Number.isInteger(t) || t < 1) return 'n_of_m needs a threshold of at least 1'
    if (t > approverCount) return `Threshold ${t} is larger than the number of approvers (${approverCount})`
  } else if (spec.rule === 'percentage') {
    if (t == null || !Number.isInteger(t) || t < 1 || t > 100) return 'percentage needs a threshold between 1 and 100'
  } else if (t != null) {
    return `Rule '${spec.rule}' does not take a threshold`
  }
  return null
}

/** How many approvals are needed out of `m` approvers (always between 1 and m for m >= 1). */
export function requiredApprovals(spec: RuleSpec, m: number): number {
  if (m <= 0) return 0
  switch (spec.rule) {
    case 'all': return m
    case 'any': return 1
    case 'n_of_m': return Math.min(Math.max(1, Math.trunc(spec.threshold ?? m)), m)
    case 'percentage': return Math.min(m, Math.max(1, Math.ceil((m * (spec.threshold ?? 100)) / 100)))
    default: return m
  }
}

/**
 * Outcome of an approval. Only decisions of listed approvers count and each approver counts once
 * (the first decision wins). The result is `declined` as soon as the required number of approvals can
 * no longer be reached (early decline), `approved` as soon as it is reached, otherwise `pending`.
 */
export function evaluate(spec: RuleSpec, approverIds: number[], decisions: DecisionLike[]): Outcome {
  const approvers = new Set(approverIds)
  const m = approvers.size
  if (m === 0) return 'pending'
  const seen = new Map<number, DecisionValue>()
  for (const d of decisions) if (approvers.has(d.approverId) && !seen.has(d.approverId)) seen.set(d.approverId, d.decision)
  let approved = 0
  let declined = 0
  for (const v of seen.values()) v === 'approved' ? approved++ : declined++
  const needed = requiredApprovals(spec, m)
  if (approved >= needed) return 'approved'
  const remaining = m - approved - declined
  if (approved + remaining < needed) return 'declined'
  return 'pending'
}

/** Approvers that have not decided yet. */
export function pendingApprovers(approverIds: number[], decisions: DecisionLike[]): number[] {
  const decided = new Set(decisions.map((d) => d.approverId))
  return [...new Set(approverIds)].filter((id) => !decided.has(id))
}

/* ---------------------------- reminders / expiry ---------------------------- */

export function computeExpiry(createdAt: Date, expiryHours: number | null | undefined): Date | null {
  return expiryHours && expiryHours > 0 ? new Date(createdAt.getTime() + expiryHours * HOUR_MS) : null
}

export function firstReminderAt(createdAt: Date, intervalHours: number | null | undefined): Date | null {
  return intervalHours && intervalHours > 0 ? new Date(createdAt.getTime() + intervalHours * HOUR_MS) : null
}

/** Next reminder after one was sent at `now`. Never returns a time in the past, even after downtime. */
export function nextReminderAfter(now: Date, intervalHours: number): Date {
  return new Date(now.getTime() + intervalHours * HOUR_MS)
}

export function isExpired(expiresAt: Date | null | undefined, now: Date): boolean {
  return !!expiresAt && expiresAt.getTime() <= now.getTime()
}

export interface ReminderState {
  status: string
  nextReminderAt: Date | null
  expiresAt: Date | null
}

/** A reminder is due for a pending, not yet expired approval whose next reminder time has come. */
export function isReminderDue(a: ReminderState, now: Date): boolean {
  if (a.status !== 'pending' || !a.nextReminderAt) return false
  if (isExpired(a.expiresAt, now)) return false
  return a.nextReminderAt.getTime() <= now.getTime()
}

/* ------------------------------ auto rules ---------------------------------- */

export const AUTO_FIELDS = ['priority', 'issuetype'] as const
export const AUTO_OPS = ['eq', 'neq', 'in'] as const
export interface AutoRule { field: (typeof AUTO_FIELDS)[number]; op: (typeof AUTO_OPS)[number]; value: string | string[] }
export interface AutoContext { priority?: string | null; issuetype?: string | null }

/** Validates untrusted JSON into an AutoRule (null means "no rule"). Returns an error string for bad input. */
export function parseAutoRule(raw: unknown): { ok: true; rule: AutoRule | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, rule: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Auto rule must be an object' }
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(r)) if (!['field', 'op', 'value'].includes(k)) return { ok: false, error: `Unknown auto rule key '${k}'` }
  if (!AUTO_FIELDS.includes(r.field as any)) return { ok: false, error: `Auto rule field must be one of ${AUTO_FIELDS.join(', ')}` }
  if (!AUTO_OPS.includes(r.op as any)) return { ok: false, error: `Auto rule op must be one of ${AUTO_OPS.join(', ')}` }
  const okStr = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 100
  if (r.op === 'in') {
    if (!Array.isArray(r.value) || r.value.length === 0 || r.value.length > 20 || !r.value.every(okStr)) return { ok: false, error: "Auto rule 'in' needs 1 to 20 values" }
  } else if (!okStr(r.value)) {
    return { ok: false, error: 'Auto rule value must be a non-empty string' }
  }
  return { ok: true, rule: { field: r.field as AutoRule['field'], op: r.op as AutoRule['op'], value: r.value as AutoRule['value'] } }
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

export function matchesAutoRule(rule: AutoRule | null | undefined, ctx: AutoContext): boolean {
  if (!rule) return false
  const actual = norm(ctx[rule.field])
  if (!actual) return false
  switch (rule.op) {
    case 'eq': return actual === norm(rule.value as string)
    case 'neq': return actual !== norm(rule.value as string)
    case 'in': return (rule.value as string[]).some((v) => norm(v) === actual)
    default: return false
  }
}

/** Auto decision at creation time. Decline wins over approve if both rules match (fail safe). */
export function evaluateAutoRules(approveWhen: AutoRule | null | undefined, declineWhen: AutoRule | null | undefined, ctx: AutoContext): 'approved' | 'declined' | null {
  if (matchesAutoRule(declineWhen, ctx)) return 'declined'
  if (matchesAutoRule(approveWhen, ctx)) return 'approved'
  return null
}
