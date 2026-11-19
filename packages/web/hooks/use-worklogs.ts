import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface Worklog {
  id: number
  issueId: number
  issueKey: string
  author: {
    id?: number
    displayName?: string
    emailAddress?: string
  }
  comment?: string
  timeSpent: string
  timeSpentSeconds: number
  started: string
  created: string
  updated: string
}

export interface WorklogListResponse {
  startAt: number
  maxResults: number
  total: number
  worklogs: Worklog[]
  totalTimeSpentSeconds: number
  totalTimeSpent: string
}

export function useIssueWorklogs(issueKey: string) {
  return useQuery({
    queryKey: ['worklogs', issueKey],
    queryFn: () =>
      fetchJson<WorklogListResponse>(`/rest/api/2/issue/${issueKey}/worklog`),
    enabled: !!issueKey,
  })
}

export function useCreateWorklog() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      issueKey,
      data,
    }: {
      issueKey: string
      data: {
        issueId: number
        issueKey: string
        description?: string
        timeSpentSeconds: number
        started?: string
      }
    }) =>
      fetchJson<Worklog>(`/rest/api/2/issue/${issueKey}/worklog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['worklogs', vars.issueKey] })
      qc.invalidateQueries({ queryKey: ['issue', vars.issueKey] })
    },
  })
}

export function useUpdateWorklog() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      issueKey,
      data,
    }: {
      id: number
      issueKey: string
      data: {
        description?: string
        timeSpentSeconds?: number
        started?: string
      }
    }) =>
      fetchJson<Worklog>(`/rest/api/2/worklog/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['worklogs', vars.issueKey] })
      qc.invalidateQueries({ queryKey: ['issue', vars.issueKey] })
    },
  })
}

export function useDeleteWorklog() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      issueKey,
    }: {
      id: number
      issueKey: string
    }) =>
      fetchJson<{ success: boolean }>(`/rest/api/2/worklog/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['worklogs', vars.issueKey] })
      qc.invalidateQueries({ queryKey: ['issue', vars.issueKey] })
    },
  })
}

// Parse Jira-style duration (e.g. "2h 30m", "1d", "3w 2d") to seconds
export function parseDuration(input: string): number | null {
  const regex =
    /^(?:(\d+)w)?\s*(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*$/i
  const match = input.match(regex)
  if (!match) return null
  const [, w, d, h, m] = match
  let seconds = 0
  if (w) seconds += parseInt(w) * 144000
  if (d) seconds += parseInt(d) * 28800
  if (h) seconds += parseInt(h) * 3600
  if (m) seconds += parseInt(m) * 60
  return seconds || null
}

// Format seconds to Jira-style duration
export function formatDuration(seconds: number): string {
  const weeks = Math.floor(seconds / 144000)
  const days = Math.floor((seconds % 144000) / 28800)
  const hours = Math.floor((seconds % 28800) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (weeks > 0) parts.push(`${weeks}w`)
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  return parts.join(' ') || '0m'
}
