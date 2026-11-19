/** Dashboard templates offered on the "create dashboard" screen. Pure data; validated by a unit test. */

export interface TemplateGadget {
  type: string
  title: string
  config: Record<string, unknown>
  rect: { x: number; y: number; w: number; h: number }
}

export interface DashboardTemplate {
  id: string
  name: string
  description: string
  icon: string
  layout: string
  gadgets: TemplateGadget[]
}

const g = (type: string, title: string, x: number, y: number, w: number, h: number, config: Record<string, unknown> = {}): TemplateGadget => ({
  type, title, config, rect: { x, y, w, h },
})

export const TEMPLATES: DashboardTemplate[] = [
  {
    id: 'blank', name: 'Blank', description: 'An empty dashboard. Add the gadgets you need.', icon: 'layout', layout: '2-column', gadgets: [],
  },
  {
    id: 'team-overview', name: 'Team overview', description: 'What is open, who is working on what, and what just happened.', icon: 'users', layout: '3-column',
    gadgets: [
      g('stat', 'Open issues', 0, 0, 3, 4, { jql: 'resolution = Unresolved', label: 'open' }),
      g('stat', 'Created this week', 3, 0, 3, 4, { jql: 'created >= -7d', compare: true }),
      g('stat', 'Resolved this week', 6, 0, 3, 4, { jql: 'resolved >= -7d', compare: true }),
      g('assigned-to-me', 'Assigned to me', 9, 0, 3, 12),
      g('pie-chart', 'Open issues by status', 0, 4, 4, 8, { jql: 'resolution = Unresolved', field: 'status' }),
      g('workload', 'Workload by assignee', 4, 4, 5, 8, { jql: 'resolution = Unresolved' }),
      g('created-vs-resolved', 'Created vs resolved', 0, 12, 6, 8, { days: 30 }),
      g('activity-stream', 'Activity stream', 6, 12, 6, 8, { limit: 15 }),
    ],
  },
  {
    id: 'sprint-health', name: 'Sprint health', description: 'Burndown, velocity and flow for the active sprint.', icon: 'zap', layout: 'wide-left',
    gadgets: [
      g('sprint-burndown', 'Sprint burndown', 0, 0, 8, 10),
      g('sprint-health', 'Sprint progress', 8, 0, 4, 10),
      g('velocity', 'Velocity', 0, 10, 6, 8),
      g('cumulative-flow', 'Cumulative flow', 6, 10, 6, 8),
      g('version-progress', 'Epic progress', 0, 18, 6, 8, { mode: 'epic' }),
      g('filter-results', 'Blocked or high priority', 6, 18, 6, 8, { jql: 'priority in (High, Highest) AND resolution = Unresolved ORDER BY priority DESC' }),
    ],
  },
  {
    id: 'service-desk', name: 'Service desk', description: 'Queues, SLA compliance, breaches and customer satisfaction.', icon: 'headphones', layout: '2-column',
    gadgets: [
      g('queue-counts', 'Queues', 0, 0, 4, 8),
      g('sla-compliance', 'SLA compliance', 4, 0, 4, 8, { days: 30 }),
      g('csat', 'Customer satisfaction', 8, 0, 4, 8, { days: 30 }),
      g('sla-breaches', 'Breached and at risk', 0, 8, 7, 9),
      g('workload', 'Workload by agent', 7, 8, 5, 9, { jql: 'resolution = Unresolved' }),
    ],
  },
  {
    id: 'executive-summary', name: 'Executive summary', description: 'Headline numbers, trends and release progress at a glance.', icon: 'briefcase', layout: '3-column',
    gadgets: [
      g('stat', 'Open issues', 0, 0, 3, 4, { jql: 'resolution = Unresolved' }),
      g('stat', 'Created last 30 days', 3, 0, 3, 4, { jql: 'created >= -30d', compare: true, days: 30 }),
      g('stat', 'Resolved last 30 days', 6, 0, 3, 4, { jql: 'resolved >= -30d', compare: true, days: 30 }),
      g('stat', 'Overdue', 9, 0, 3, 4, { jql: 'duedate < now() AND resolution = Unresolved' }),
      g('created-vs-resolved', 'Created vs resolved (90 days)', 0, 4, 8, 8, { days: 90 }),
      g('pie-chart', 'Issues by priority', 8, 4, 4, 8, { jql: 'resolution = Unresolved', field: 'priority' }),
      g('version-progress', 'Release progress', 0, 12, 6, 8),
      g('created-heatmap', 'Activity heat map', 6, 12, 6, 8, { days: 120 }),
    ],
  },
]

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id)
