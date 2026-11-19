import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface AgentRun {
  id: number; agentId: number; issueId: number; projectId: number; issueKey?: string
  trigger: string; status: 'queued' | 'delivered' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  chainDepth: number; attempts: number; error: string | null; summary: string | null; resultUrl: string | null
  createdAt: string; startedAt: string | null; finishedAt: string | null
  agent?: { id: number; displayName: string; username: string }
}

export interface AgentInfo {
  id: number; userId: number; username: string; displayName: string; avatarUrl: string | null; description: string | null
  enabled: boolean; owner: { id: number; displayName: string } | null; webhookUrl: string | null; hasSigningSecret: boolean
  triggers: string[]; limits: { maxConcurrentRuns: number; maxRunsPerIssue: number; maxRunsPerHour: number }; consecutiveFailures: number
  signingSecret?: string
}

export const ACTIVE_RUN = ['queued', 'delivered', 'running']
export const TRIGGER_LABELS: Record<string, string> = {
  assigned: 'Issue assigned to the agent', mentioned: 'Agent @mentioned', status_changed: 'Status of its issue changes', commented: 'New comment on its issue', claim: 'Claimed by the agent',
}

export async function agentApi<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    const err = new Error(d.errorMessages?.[0] || `HTTP ${res.status}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export function useIssueAgentRuns(key: string, enabled = true) {
  return useQuery<AgentRun[], Error & { status?: number }>({
    queryKey: ['issue', key, 'agent-runs'],
    queryFn: () => agentApi<AgentRun[]>(`/rest/api/2/issue/${encodeURIComponent(key)}/agent-runs`),
    enabled: !!key && enabled,
    retry: false,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => ACTIVE_RUN.includes(r.status)) ? 5000 : false),
  })
}

export function useStopRun(issueKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: number) => agentApi<AgentRun>(`/rest/api/2/agent-runs/${runId}/stop`, 'POST'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['issue', issueKey, 'agent-runs'] }),
  })
}
