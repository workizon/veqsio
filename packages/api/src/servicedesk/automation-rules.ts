/** Pure parts of the service desk automation: validation of a rule and the "is it due" tests. */

export const TRIGGERS = ['sla_percent', 'sla_breached', 'waiting_days', 'customer_reply', 'request_created'] as const
export const ACTIONS = ['notify', 'reassign', 'priority', 'transition', 'comment', 'label', 'request_type'] as const
export type Trigger = (typeof TRIGGERS)[number]
export type Action = (typeof ACTIONS)[number]

export interface RuleParams { userId?: number; priorityId?: number; status?: string; text?: string; slaId?: number; labels?: string[]; requestTypeId?: number }
export interface RuleConditions { contains?: string[]; channel?: string; requestTypeId?: number }
export interface RuleInput { name: string; trigger: Trigger; threshold: number | null; action: Action; params: RuleParams; conditions?: RuleConditions; enabled?: boolean }

const LABEL = /^[^\s,]{1,255}$/

/** Null when the combination is valid, otherwise the reason. */
export function validateRule(r: RuleInput): string | null {
  if (r.trigger === 'sla_percent' && !(Number.isInteger(r.threshold) && r.threshold! >= 1 && r.threshold! <= 99)) return 'An SLA percentage rule needs a threshold from 1 to 99';
  if (r.trigger === 'waiting_days' && !(Number.isInteger(r.threshold) && r.threshold! >= 1 && r.threshold! <= 365)) return 'A waiting rule needs a number of days from 1 to 365';
  if ((r.trigger === 'sla_breached' || r.trigger === 'customer_reply' || r.trigger === 'request_created') && r.threshold != null) return 'This kind of rule takes no threshold';
  if (r.trigger !== 'request_created' && (r.action === 'label' || r.action === 'request_type')) return 'Labels and request types can only be set on new requests';
  if (r.trigger !== 'request_created' && r.conditions && Object.keys(r.conditions).length) return 'Conditions are only available for new requests';
  if (r.trigger === 'customer_reply' && r.action !== 'transition' && r.action !== 'notify' && r.action !== 'comment') return 'After a customer reply a rule can transition, notify or comment';
  if (r.action === 'reassign' && !r.params.userId) return 'Choose who to reassign to';
  if (r.action === 'priority' && !r.params.priorityId) return 'Choose the priority';
  if (r.action === 'transition' && !r.params.status?.trim()) return 'Name the status to move to';
  if (r.action === 'comment' && !r.params.text?.trim()) return 'Write the comment text';
  if (r.action === 'label' && !(r.params.labels?.length && r.params.labels.every((l) => LABEL.test(l)))) return 'Give at least one label (no spaces or commas)';
  if (r.action === 'request_type' && !r.params.requestTypeId) return 'Choose the request type';
  const c = r.conditions;
  if (c?.contains && (c.contains.length > 20 || c.contains.some((k) => !k.trim() || k.length > 100))) return 'At most 20 keywords of up to 100 characters';
  if (r.params.text && r.params.text.length > 2000) return 'The comment text is too long (2000 characters at most)';
  return null;
}

/** True when `percent`% of the SLA target has been used (running, not already breached). */
export function slaPercentReached(elapsedMs: number, targetMs: number, percent: number): boolean {
  return targetMs > 0 && elapsedMs * 100 >= targetMs * percent;
}

/** True when a request has been waiting for the customer for at least `days` days. */
export function waitingExpired(since: Date | number, now: number, days: number): boolean {
  const t = typeof since === 'number' ? since : since.getTime();
  return now - t >= days * 86_400_000;
}

/** Placeholders in a comment text: {{issue.key}} and {{days}}; unknown ones stay as they are. */
export function renderRuleText(text: string, vars: { key: string; days?: number | null }): string {
  return text.replace(/\{\{\s*([a-zA-Z_.]+)\s*\}\}/g, (m, name: string) => {
    if (name === 'issue.key') return vars.key;
    if (name === 'days') return vars.days == null ? m : String(vars.days);
    return m;
  });
}

/** True when a new request satisfies the rule's conditions: any keyword in the summary or description, the channel, the request type. */
export function conditionsMatch(c: RuleConditions | null | undefined, req: { summary: string; description: string | null; channel: string; requestTypeId: number | null }): boolean {
  if (!c) return true;
  if (c.channel && c.channel !== req.channel) return false;
  if (c.requestTypeId && c.requestTypeId !== req.requestTypeId) return false;
  if (c.contains?.length) {
    const hay = `${req.summary}\n${req.description ?? ''}`.toLowerCase();
    if (!c.contains.some((k) => hay.includes(k.trim().toLowerCase()))) return false;
  }
  return true;
}
