import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json()
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AutomationTrigger {
  id: number
  ruleId: number
  triggerType: string
  config: Record<string, any>
}

export interface AutomationCondition {
  id: number
  ruleId: number
  conditionType: string
  operator: string
  config: Record<string, any>
  position: number
}

export interface AutomationAction {
  id: number
  ruleId: number
  actionType: string
  config: Record<string, any>
  position: number
}

export interface AutomationRule {
  id: number
  name: string
  description?: string
  projectId?: number | null
  isEnabled: boolean
  createdBy: number
  createdAt: string
  updatedAt: string
  triggers: AutomationTrigger[]
  conditions: AutomationCondition[]
  actions: AutomationAction[]
}

export interface AutomationExecution {
  id: number
  ruleId: number
  triggeredBy: string
  triggerIssueKey?: string
  status: string
  startedAt: string
  completedAt?: string
  result: Record<string, any>
  errorMessage?: string
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

export function useAutomationRules(projectId?: number) {
  const url = projectId
    ? `/rest/api/2/automation/rule?projectId=${projectId}`
    : '/rest/api/2/automation/rule'
  return useQuery({
    queryKey: ['automation-rules', projectId],
    queryFn: () =>
      fetchJson<{ values: AutomationRule[] }>(url).then((d) => d.values),
  })
}

export function useAutomationRule(id: number | null) {
  return useQuery({
    queryKey: ['automation-rule', id],
    queryFn: () =>
      fetchJson<AutomationRule>(`/rest/api/2/automation/rule/${id}`),
    enabled: !!id,
  })
}

export function useCreateAutomationRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, any>) =>
      fetchJson<AutomationRule>('/rest/api/2/automation/rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-rules'] }),
  })
}

export function useUpdateAutomationRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number
      body: Record<string, any>
    }) =>
      fetchJson<AutomationRule>(`/rest/api/2/automation/rule/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['automation-rules'] })
      qc.invalidateQueries({ queryKey: ['automation-rule', vars.id] })
    },
  })
}

export function useDeleteAutomationRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/rest/api/2/automation/rule/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-rules'] }),
  })
}

export function useToggleAutomationRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, isEnabled }: { id: number; isEnabled: boolean }) =>
      fetchJson<{ id: number; isEnabled: boolean }>(
        `/rest/api/2/automation/rule/${id}/toggle`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isEnabled }),
        }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-rules'] }),
  })
}

export function useExecuteAutomationRule() {
  return useMutation({
    mutationFn: ({ id, issueKey }: { id: number; issueKey?: string }) =>
      fetchJson<{ success: boolean }>(`/rest/api/2/automation/rule/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueKey }),
      }),
  })
}

export function useAutomationExecutions(ruleId: number | null) {
  return useQuery({
    queryKey: ['automation-executions', ruleId],
    queryFn: () =>
      fetchJson<{ values: AutomationExecution[] }>(
        `/rest/api/2/automation/rule/${ruleId}/execution`
      ).then((d) => d.values),
    enabled: !!ruleId,
  })
}
