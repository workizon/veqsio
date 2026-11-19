/**
 * Builds the SLA timeline of an issue from stored facts (issue row, status/priority/assignee/resolution
 * history rows and public comments). Pure so it can be unit tested.
 */
import type { TimelineEvent } from './sla-engine'

export interface TimelineHistoryRow { field: string; at: number; oldValue: string | null; newValue: string | null }
export interface TimelineCommentRow { at: number; authorId: number | null }

export interface TimelineIssue {
  createdAt: number
  statusId: number
  assigneeId: number | null
  reporterId: number | null
  /** Resolved now (resolution set, resolvedAt set, or status category done). */
  resolved: boolean
  resolvedAt: number | null
  updatedAt: number | null
}

export function buildTimeline(args: {
  issue: TimelineIssue
  history: TimelineHistoryRow[]
  /** Public comments only. */
  comments: TimelineCommentRow[]
  statusIdByName: (name: string | null) => number | null
}): TimelineEvent[] {
  const { issue, comments, statusIdByName } = args
  const history = [...args.history].sort((a, b) => a.at - b.at)
  const events: TimelineEvent[] = []

  const statusRows = history.filter((h) => h.field === 'status')
  const initialStatus = statusRows.length ? statusIdByName(statusRows[0].oldValue) ?? issue.statusId : issue.statusId
  const assignRows = history.filter((h) => h.field === 'assignee')
  const initiallyAssigned = assignRows.length ? assignRows[0].oldValue != null && assignRows[0].oldValue !== '' : issue.assigneeId != null

  events.push({ at: issue.createdAt, kind: 'issue_created', toStatusId: initialStatus, assigned: initiallyAssigned })

  for (const h of history) {
    const set = h.newValue != null && h.newValue !== ''
    switch (h.field) {
      case 'status':
        events.push({ at: h.at, kind: 'status_changed', fromStatusId: statusIdByName(h.oldValue), toStatusId: statusIdByName(h.newValue) })
        break
      case 'assignee': events.push({ at: h.at, kind: set ? 'assignee_set' : 'assignee_cleared' }); break
      case 'resolution': events.push({ at: h.at, kind: set ? 'resolution_set' : 'resolution_cleared' }); break
      case 'priority': events.push({ at: h.at, kind: 'priority_changed' }); break
      default: break
    }
  }

  // Issues resolved without history (imports, direct updates, "done" status): synthesise the resolution fact.
  if (issue.resolved && !history.some((h) => h.field === 'resolution')) {
    events.push({ at: issue.resolvedAt ?? issue.updatedAt ?? issue.createdAt, kind: 'resolution_set' })
  }

  for (const c of comments) {
    events.push({ at: c.at, kind: c.authorId != null && c.authorId === issue.reporterId ? 'comment_customer' : 'comment_agent' })
  }
  return events
}
