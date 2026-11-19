import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export type GadgetType =
  | 'queue-counts'
  | 'sla-compliance'
  | 'sla-breaches'
  | 'csat'
  | 'version-progress'
  | 'pie-chart'
  | 'filter-results'
  | 'assigned-to-me'
  | 'activity-stream'
  | 'created-vs-resolved'
  | 'sprint-health'
  | 'average-age'
  | 'resolution-time'
  | 'issue-statistics'
  | 'two-dimensional'
  | 'workload'
  | 'stat'
  | 'recently-created'
  | 'created-heatmap'
  | 'due-date-calendar'
  | 'notes'
  | 'velocity'
  | 'sprint-burndown'
  | 'cumulative-flow'

export interface GadgetConfig {
  [key: string]: unknown
}

export interface GadgetPosition {
  column: number
  row: number
}

export interface Gadget {
  id: string
  type: GadgetType
  title: string
  config: GadgetConfig
  position: GadgetPosition
}

export interface Dashboard {
  id: string
  name: string
  description: string
  owner?: { id: number }
  gadgets: Gadget[]
}

export interface DashboardSummary {
  id: string
  name: string
  owner: { id: number }
  isDefault?: boolean
}


async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json()
}

/* ------------------------------------------------------------------ */
/*  Dashboards                                                         */
/* ------------------------------------------------------------------ */

export function useDashboards() {
  return useQuery({
    queryKey: ['dashboards'],
    queryFn: async (): Promise<DashboardSummary[]> => {
      const response = await fetchJson<{ dashboards: DashboardSummary[] }>('/rest/api/2/dashboard')
      return response.dashboards
    },
  })
}

/** The dashboard that opens as the user's home (id null = the standard Home page). */
export function useDefaultDashboard() {
  return useQuery({
    queryKey: ['dashboard-default'],
    queryFn: () => fetchJson<{ id: string | null }>('/rest/api/2/dashboard/default'),
    staleTime: 60_000,
  })
}

export function useSetDefaultDashboard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string | null) => fetchJson<{ id: string | null }>('/rest/api/2/dashboard/default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['dashboards'] }); void qc.invalidateQueries({ queryKey: ['dashboard-default'] }) },
  })
}

export function useDashboard(id: string) {
  return useQuery({
    queryKey: ['dashboard', id],
    queryFn: async (): Promise<Dashboard> => {
      return await fetchJson<Dashboard>(`/rest/api/2/dashboard/${id}`)
    },
    enabled: !!id,
  })
}

export function useCreateDashboard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { name: string }) => {
      return await fetchJson<{ id: string; name: string }>('/rest/api/2/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] })
    },
  })
}

export function useUpdateDashboard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      gadgets,
    }: {
      id: string
      gadgets: Gadget[]
    }) => {
      return await fetchJson<Dashboard>(`/rest/api/2/dashboard/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gadgets }),
      })
    },
    onSuccess: (_, variables) => {
      return queryClient.invalidateQueries({ queryKey: ['dashboard', variables.id] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Jira Search Helpers                                                */
/* ------------------------------------------------------------------ */

interface JiraIssue {
  id: string
  key: string
  fields: {
    summary: string
    status?: { name: string }
    priority?: { name: string }
    issuetype?: { name: string }
    assignee?: { displayName: string }
    updated?: string
    created?: string
    resolved?: string | null
    resolutiondate?: string | null
    duedate?: string
  }
}

interface JiraSearchResponse {
  total: number
  issues: JiraIssue[]
}

/* ------------------------------------------------------------------ */
/*  Filter Results Gadget                                              */
/* ------------------------------------------------------------------ */

export interface FilterResult {
  id: string
  key: string
  summary: string
  status: string
  priority: string
  assignee?: string
  updated: string
}

export function useFilterResults(filterId?: string, jql?: string) {
  return useQuery({
    queryKey: ['filter-results', filterId, jql],
    queryFn: async (): Promise<FilterResult[]> => {
      let searchJql = jql || ''
      if (filterId && !searchJql) {
        const filter = await fetchJson<{ id: string; name: string; jql: string }>(
          `/rest/api/2/filter/${filterId}`
        )
        searchJql = filter.jql
      }
      const data = await fetchJson<JiraSearchResponse>(
        `/rest/api/2/search?jql=${encodeURIComponent(searchJql)}&fields=summary,status,priority,assignee,updated&maxResults=50`
      )
      return data.issues.map((issue) => ({
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name || 'Unknown',
        priority: issue.fields.priority?.name || 'Medium',
        assignee: issue.fields.assignee?.displayName,
        updated: issue.fields.updated || new Date().toISOString(),
      }))
    },
    enabled: !!(filterId || jql),
  })
}

/* ------------------------------------------------------------------ */
/*  Activity Stream Gadget                                             */
/* ------------------------------------------------------------------ */

export interface ActivityItem {
  id: string
  user: string
  action: string
  issueKey: string
  issueSummary: string
  timestamp: string
}

export function useActivityStream(limit = 10) {
  return useQuery({
    queryKey: ['activity-stream', limit],
    queryFn: async (): Promise<ActivityItem[]> => {
      const data = await fetchJson<JiraSearchResponse>(
        `/rest/api/2/search?jql=${encodeURIComponent('ORDER BY updated DESC')}&maxResults=${limit}&fields=summary,updated,assignee,status`
      )
      return data.issues.map((issue) => ({
        id: `a-${issue.id}`,
        user: issue.fields.assignee?.displayName || 'Unknown',
        action: 'updated',
        issueKey: issue.key,
        issueSummary: issue.fields.summary,
        timestamp: issue.fields.updated || new Date().toISOString(),
      }))
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Assigned to Me Gadget                                              */
/* ------------------------------------------------------------------ */

export interface IssueSummary {
  id: string
  key: string
  summary: string
  status: string
  priority: string
  dueDate?: string
}

export function useMyIssues() {
  return useQuery({
    queryKey: ['my-issues'],
    queryFn: async (): Promise<IssueSummary[]> => {
      const data = await fetchJson<JiraSearchResponse>(
        `/rest/api/2/search?jql=${encodeURIComponent('assignee=currentUser() AND resolution IS EMPTY')}&maxResults=20&fields=summary,status,priority,duedate`
      )
      return data.issues.map((issue) => ({
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name || 'Unknown',
        priority: issue.fields.priority?.name || 'Medium',
        dueDate: issue.fields.duedate,
      }))
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Sprint Health Gadget                                               */
/* ------------------------------------------------------------------ */

export interface SprintHealthData {
  name: string
  total: number
  completed: number
  remaining: number
  ideal: number
}

export function useSprintHealth(sprintId: string) {
  return useQuery({
    queryKey: ['sprint-health', sprintId],
    queryFn: async (): Promise<SprintHealthData[]> => {
      const sprintInfo = await fetchJson<{
        id: number
        name: string
        state: string
        originBoardId: number
      }>(`/rest/api/2/sprint/${sprintId}`)

      const issuesData = await fetchJson<JiraSearchResponse>(
        `/rest/api/2/sprint/${sprintId}/issue?fields=status&maxResults=1000`
      )

      const total = issuesData.issues.length
      const completed = issuesData.issues.filter((i) =>
        ['Done', 'Closed', 'Resolved'].includes(i.fields.status?.name || '')
      ).length
      const remaining = total - completed

      // Synthetic burndown history since API doesn't expose day-by-day history
      const history: SprintHealthData[] = []
      for (let i = 0; i < 10; i++) {
        const progress = i / 9
        history.push({
          name: `Day ${i + 1}`,
          total,
          completed: Math.round(completed * progress),
          remaining: Math.round(remaining + completed * (1 - progress)),
          ideal: Math.round(total * (1 - progress)),
        })
      }
      if (history.length) {
        history[history.length - 1].completed = completed
        history[history.length - 1].remaining = remaining
      }
      return history
    },
    enabled: !!sprintId,
  })
}

/* ------------------------------------------------------------------ */
/*  Pie Chart Gadget (Issue Distribution)                              */
/* ------------------------------------------------------------------ */

export interface DistributionItem {
  name: string
  value: number
}

export function useIssueDistribution(field: string) {
  return useQuery({
    queryKey: ['issue-distribution', field],
    queryFn: async (): Promise<DistributionItem[]> => {
      const fieldsParam =
        field === 'assignee'
          ? 'status,priority,issuetype,assignee'
          : 'status,priority,issuetype'
      const data = await fetchJson<JiraSearchResponse>(
        `/rest/api/2/search?jql=&maxResults=1000&fields=${fieldsParam}`
      )

      const counts: Record<string, number> = {}
      for (const issue of data.issues) {
        let value: string | undefined
        switch (field) {
          case 'status':
            value = issue.fields.status?.name
            break
          case 'priority':
            value = issue.fields.priority?.name
            break
          case 'type':
            value = issue.fields.issuetype?.name
            break
          case 'assignee':
            value = issue.fields.assignee?.displayName || 'Unassigned'
            break
        }
        if (value) {
          counts[value] = (counts[value] || 0) + 1
        }
      }

      return Object.entries(counts).map(([name, value]) => ({ name, value }))
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Created vs Resolved Gadget                                         */
/* ------------------------------------------------------------------ */

export interface CreatedVsResolvedItem {
  date: string
  created: number
  resolved: number
}

function getDateString(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().split('T')[0]
}

export function useCreatedVsResolved(days = 30) {
  return useQuery({
    queryKey: ['created-vs-resolved', days],
    queryFn: async (): Promise<CreatedVsResolvedItem[]> => {
      const since = getDateString(days)

      const [createdData, resolvedData] = await Promise.all([
        fetchJson<JiraSearchResponse>(
          `/rest/api/2/search?jql=${encodeURIComponent(`created >= "${since}"`)}&fields=created&maxResults=1000`
        ),
        fetchJson<JiraSearchResponse>(
          `/rest/api/2/search?jql=${encodeURIComponent(`resolved >= "${since}"`)}&fields=resolved&maxResults=1000`
        ),
      ])

      const result: Record<string, { created: number; resolved: number }> = {}
      const today = new Date()

      for (let i = 0; i < days; i++) {
        const d = new Date(today)
        d.setDate(d.getDate() - (days - 1 - i))
        const key = d.toISOString().slice(5, 10)
        result[key] = { created: 0, resolved: 0 }
      }

      for (const issue of createdData.issues) {
        const created = issue.fields.created?.slice(5, 10)
        if (created && result[created]) {
          result[created].created++
        }
      }

      for (const issue of resolvedData.issues) {
        const resolved = issue.fields.resolved?.slice(5, 10)
        if (resolved && result[resolved]) {
          result[resolved].resolved++
        }
      }

      return Object.entries(result).map(([date, counts]) => ({
        date,
        created: counts.created,
        resolved: counts.resolved,
      }))
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Average Age / Resolution Time Gadgets                              */
/* ------------------------------------------------------------------ */

export type GadgetPeriod = 'daily' | 'weekly' | 'monthly'

export interface AverageAgePoint {
  date: string
  averageDays: number
  openCount: number
}

export interface ResolutionTimePoint {
  date: string
  averageDays: number
  resolvedCount: number
}

export function useAverageAge(period: GadgetPeriod = 'daily', count = 30) {
  return useQuery({
    queryKey: ['gadget-average-age', period, count],
    queryFn: async (): Promise<AverageAgePoint[]> => {
      const res = await fetchJson<{ data: AverageAgePoint[] }>(
        `/rest/api/2/dashboard/gadgets/average-age?period=${period}&count=${count}`
      )
      return res.data
    },
  })
}

export function useResolutionTime(period: GadgetPeriod = 'daily', count = 30) {
  return useQuery({
    queryKey: ['gadget-resolution-time', period, count],
    queryFn: async (): Promise<ResolutionTimePoint[]> => {
      const res = await fetchJson<{ data: ResolutionTimePoint[] }>(
        `/rest/api/2/dashboard/gadgets/resolution-time?period=${period}&count=${count}`
      )
      return res.data
    },
  })
}


/** Data of a JQL-based gadget (statistics, workload, table, number tile, recently created, heat map, due-date calendar). */
export function useGadgetData<T = any>(type: string, config: Record<string, unknown>) {
  const body = { type, config: Object.fromEntries(Object.entries(config).filter(([k]) => !['title', 'refresh', 'colorScheme', 'showTable'].includes(k))) }
  const refresh = Number(config.refresh) || 0
  return useQuery<T>({
    queryKey: ['gadget-data', type, JSON.stringify(body.config)],
    refetchInterval: refresh > 0 ? refresh * 60_000 : false,
    queryFn: async () => {
      const res = await fetch('/rest/api/2/dashboard/gadget-data', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? `HTTP ${res.status}`)
      return res.json()
    },
  })
}
