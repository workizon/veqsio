import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApprovalStatus } from '@/lib/approvals'

export class ApprovalApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw new ApprovalApiError(msg, res.status)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}
const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

export interface Approval {
  id: number; issueId: number; templateId: number | null; name: string; status: ApprovalStatus; rule: string; ruleThreshold: number | null
  completedBy: string | null; createdBy: number | null; created: string; decided: string | null; expires: string | null
  isApprover: boolean; canDecide: boolean
  myDecision: { decision: 'approved' | 'declined'; comment: string | null; decided: string } | null
  approvers?: Array<{ id: number; displayName: string; decided: boolean }>
  decisions?: Array<{ approverId: number; approver: string | null; decision: 'approved' | 'declined'; comment: string | null; decided: string }>
  approverCount?: number
}

export interface PendingApproval extends Approval {
  issue: { key: string; summary: string }
  project: { key: string; name: string }
  portalSlug: string | null
}

export interface ApprovalTemplate {
  id: number; name: string; description?: string | null; rule: string; ruleThreshold: number | null
  approverUserIds?: number[]; approverGroupIds?: number[]
  autoApproveWhen?: { field: string; op: string; value: string | string[] } | null
  autoDeclineWhen?: { field: string; op: string; value: string | string[] } | null
  reminderIntervalHours?: number | null; expiryHours?: number | null
  onApprovedTransitionId?: number | null; onDeclinedTransitionId?: number | null
}

export interface PortalApproval {
  id: number; name: string; status: ApprovalStatus; created: string; expires: string | null; canDecide: boolean
  myDecision: { decision: 'approved' | 'declined'; comment: string | null } | null
  request: { key: string; summary: string }
}

export const useIssueApprovals = (key: string) =>
  useQuery({
    queryKey: ['approvals', 'issue', key],
    queryFn: () => api<{ values: Approval[] }>(`/rest/api/2/issue/${encodeURIComponent(key)}/approval`),
    retry: false,
  })

export const useMyApprovals = () =>
  useQuery({
    queryKey: ['approvals', 'pending'],
    queryFn: () => api<{ total: number; values: PendingApproval[] }>('/rest/api/2/approval/pending?maxResults=100'),
  })

function useInvalidating<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }) })
}

export const useRequestApproval = (key: string) =>
  useInvalidating((body: Record<string, unknown>) => api<Approval>(`/rest/api/2/issue/${encodeURIComponent(key)}/approval`, send('POST', body)))

export const useDecide = () =>
  useInvalidating((v: { id: number; decision: 'approved' | 'declined'; comment?: string }) =>
    api<Approval>(`/rest/api/2/approval/${v.id}/decision`, send('POST', { decision: v.decision, comment: v.comment || undefined })))

export const useCancelApproval = () =>
  useInvalidating((id: number) => api<void>(`/rest/api/2/approval/${id}`, send('DELETE')))

export const useApprovalTemplates = (projectKey: string) =>
  useQuery({
    queryKey: ['approvals', 'templates', projectKey],
    queryFn: () => api<{ values: ApprovalTemplate[] }>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/approval-template`),
    retry: false,
    enabled: !!projectKey,
  })

export function useSaveTemplate(projectKey: string) {
  return useInvalidating((v: { id?: number; body: Record<string, unknown> }) =>
    api<ApprovalTemplate>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/approval-template${v.id ? `/${v.id}` : ''}`, send(v.id ? 'PUT' : 'POST', v.body)))
}
export const useDeleteTemplate = (projectKey: string) =>
  useInvalidating((id: number) => api<void>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/approval-template/${id}`, send('DELETE')))

const SD = '/rest/servicedeskapi/portal'
export const usePortalApprovals = (slug: string, requestKey?: string) =>
  useQuery({
    queryKey: ['approvals', 'portal', slug, requestKey ?? 'pending'],
    queryFn: () => api<{ values: PortalApproval[] }>(`${SD}/${slug}/approvals${requestKey ? `?key=${encodeURIComponent(requestKey)}` : ''}`),
    retry: false,
  })
export const usePortalDecide = (slug: string) =>
  useInvalidating((v: { id: number; decision: 'approved' | 'declined'; comment?: string }) =>
    api<void>(`${SD}/${slug}/approvals/${v.id}/decision`, send('POST', { decision: v.decision, comment: v.comment || undefined })))
