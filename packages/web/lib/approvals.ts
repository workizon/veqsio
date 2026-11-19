/** Pure helpers for the approvals UI (status chips, rule descriptions, template form validation). */

export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'expired'
export type ApprovalRule = 'all' | 'any' | 'n_of_m' | 'percentage'

export const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: 'Pending', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired',
}

/** The chip always carries its text label, so status is never conveyed by colour alone. */
export const STATUS_CLASS: Record<ApprovalStatus, string> = {
  pending: 'bg-[var(--warning-bg,#fff7e0)] text-[var(--warning,#8a5a00)]',
  approved: 'bg-[var(--success-bg,#e3f6ec)] text-[var(--success,#16794c)]',
  declined: 'bg-[var(--error-bg,#fde8e8)] text-[var(--error,#b42318)]',
  cancelled: 'bg-[var(--surface-2)] text-[var(--text-secondary)]',
  expired: 'bg-[var(--surface-2)] text-[var(--text-secondary)]',
}

export function ruleLabel(rule: string, threshold?: number | null): string {
  switch (rule) {
    case 'all': return 'All approvers must approve'
    case 'any': return 'Any one approver'
    case 'n_of_m': return `${threshold ?? '?'} approvers must approve`
    case 'percentage': return `${threshold ?? '?'}% of approvers must approve`
    default: return rule
  }
}

export interface TemplateForm {
  name: string
  approverUserIds: number[]
  approverGroupIds: number[]
  rule: ApprovalRule
  ruleThreshold: string
  reminderIntervalHours: string
  expiryHours: string
  autoApproveField: '' | 'priority' | 'issuetype'
  autoApproveValue: string
  autoDeclineField: '' | 'priority' | 'issuetype'
  autoDeclineValue: string
  onApprovedTransitionId: string
  onDeclinedTransitionId: string
}

export const emptyTemplateForm = (): TemplateForm => ({
  name: '', approverUserIds: [], approverGroupIds: [], rule: 'all', ruleThreshold: '', reminderIntervalHours: '', expiryHours: '',
  autoApproveField: '', autoApproveValue: '', autoDeclineField: '', autoDeclineValue: '', onApprovedTransitionId: '', onDeclinedTransitionId: '',
})

const posInt = (s: string) => (s.trim() === '' ? null : /^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN)

/** Field level errors for the template form (the server validates again). */
export function validateTemplateForm(f: TemplateForm): Record<string, string> {
  const e: Record<string, string> = {}
  if (!f.name.trim()) e.name = 'Name is required'
  if (f.name.length > 120) e.name = 'Name is too long (120 characters)'
  if (f.approverUserIds.length + f.approverGroupIds.length === 0) e.approvers = 'Choose at least one approver user or group'
  const t = posInt(f.ruleThreshold)
  if (f.rule === 'n_of_m' && (t === null || Number.isNaN(t) || t < 1)) e.ruleThreshold = 'Enter how many approvals are needed'
  if (f.rule === 'percentage' && (t === null || Number.isNaN(t) || t < 1 || t > 100)) e.ruleThreshold = 'Enter a percentage from 1 to 100'
  for (const k of ['reminderIntervalHours', 'expiryHours', 'onApprovedTransitionId', 'onDeclinedTransitionId'] as const) {
    if (Number.isNaN(posInt(f[k]))) e[k] = 'Enter a whole number'
  }
  if (f.autoApproveField && !f.autoApproveValue.trim()) e.autoApproveValue = 'Enter a value'
  if (f.autoDeclineField && !f.autoDeclineValue.trim()) e.autoDeclineValue = 'Enter a value'
  return e
}

/** Request body for POST/PUT approval-template. */
export function templateBody(f: TemplateForm) {
  const num = (s: string) => { const v = posInt(s); return v === null || Number.isNaN(v) ? null : v }
  const auto = (field: string, value: string) => (field ? { field, op: 'eq', value: value.trim() } : null)
  return {
    name: f.name.trim(),
    approverUserIds: f.approverUserIds,
    approverGroupIds: f.approverGroupIds,
    rule: f.rule,
    ruleThreshold: f.rule === 'n_of_m' || f.rule === 'percentage' ? num(f.ruleThreshold) : null,
    reminderIntervalHours: num(f.reminderIntervalHours),
    expiryHours: num(f.expiryHours),
    autoApproveWhen: auto(f.autoApproveField, f.autoApproveValue),
    autoDeclineWhen: auto(f.autoDeclineField, f.autoDeclineValue),
    onApprovedTransitionId: num(f.onApprovedTransitionId),
    onDeclinedTransitionId: num(f.onDeclinedTransitionId),
  }
}
