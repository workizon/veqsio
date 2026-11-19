/** Pure helpers for project status updates (On track / At risk / Off track). */

export type UpdateState = 'on_track' | 'at_risk' | 'off_track'

export interface StatusUpdate {
  id: number
  state: UpdateState
  stateLabel: string
  body: string
  author: { id: number; displayName: string } | null
  created: string
}

export const UPDATE_OPTIONS: Array<{ value: UpdateState; label: string; color: string }> = [
  { value: 'on_track', label: 'On track', color: '#16A06A' },
  { value: 'at_risk', label: 'At risk', color: '#C77700' },
  { value: 'off_track', label: 'Off track', color: '#C9372C' },
]

export function updateBadge(state: string): { label: string; color: string } {
  const o = UPDATE_OPTIONS.find((x) => x.value === state)
  return o ? { label: o.label, color: o.color } : { label: state, color: '#667085' }
}

/** Why a draft cannot be posted yet (null when it can). The body is optional, the state is not. */
export function validateDraft(state: string | null, body: string): string | null {
  if (!UPDATE_OPTIONS.some((o) => o.value === state)) return 'Choose a state'
  if (body.length > 10_000) return 'The text is limited to 10,000 characters'
  return null
}

/** "3 days ago"-style label for the history; falls back to the date for old updates. */
export function whenLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(t).toISOString().slice(0, 10)
}
