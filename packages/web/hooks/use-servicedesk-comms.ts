import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CustomerChoice } from '@/lib/servicedesk-comms'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw new Error(msg)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

const SD = '/rest/servicedeskapi'

/* ---- per-desk customer notification switches ---- */

export interface DeskNotificationSettings { notifyCustomerComments: boolean; notifyCustomerStatus: boolean }

export const useDeskNotificationSettings = (deskId: number) =>
  useQuery({ queryKey: ['sd', deskId, 'notification-settings'], queryFn: () => api<DeskNotificationSettings>(`${SD}/servicedesk/${deskId}/notification-settings`) })

export function useUpdateDeskNotificationSettings(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<DeskNotificationSettings>) =>
      api<DeskNotificationSettings>(`${SD}/servicedesk/${deskId}/notification-settings`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (data) => qc.setQueryData(['sd', deskId, 'notification-settings'], data),
  })
}

/* ---- IMAP polling (extends the e-mail channel) ---- */

export interface ImapView {
  enabled: boolean; host: string; port: number; tls: boolean; user: string; passwordSet: boolean; folder: string; pollSeconds: number
  lastPollAt: string | null; lastStatus: 'ok' | 'error' | null; lastError: string | null; lastCount: number | null
}

export interface ImapUpdate {
  enabled?: boolean; host?: string | null; port?: number; tls?: boolean; user?: string | null
  /** Write-only; omitted or empty keeps the stored password. */
  password?: string; folder?: string; pollSeconds?: number
}

export type TestImapResult = { ok: true; unseen: number } | { ok: false; error: string }

export const useTestImap = (deskId: number) =>
  useMutation({
    mutationFn: (body: { host?: string; port?: number; tls?: boolean; user?: string; password?: string; folder?: string }) =>
      api<TestImapResult>(`${SD}/servicedesk/${deskId}/email-channel/test-connection`, { method: 'POST', body: JSON.stringify(body) }),
  })

export function usePollNow(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ status: string; processed?: number }>(`${SD}/servicedesk/${deskId}/email-channel/poll`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId, 'email-channel'] }),
  })
}

export interface InboundMessage { id: number; from: string; subject: string | null; status: 'created' | 'commented' | 'rejected'; reason: string | null; created: string }

export const useInboundMessages = (deskId: number, enabled: boolean) =>
  useQuery({
    queryKey: ['sd', deskId, 'inbound-messages'],
    queryFn: () => api<{ values: InboundMessage[] }>(`${SD}/servicedesk/${deskId}/email-channel/messages`),
    enabled,
  })

/* ---- raise on behalf, customers, merge, link ---- */

export const useCustomerSearch = (deskId: number, q: string) =>
  useQuery({
    queryKey: ['sd', deskId, 'customer-search', q],
    queryFn: () => api<{ values: CustomerChoice[] }>(`${SD}/servicedesk/${deskId}/customer-search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 1,
    staleTime: 10_000,
  })

export interface OnBehalfBody {
  customerId?: number; customerEmail?: string; customerName?: string
  requestTypeId: number; summary?: string; description?: string; fieldValues: Record<string, unknown>
}

export function useCreateOnBehalf(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: OnBehalfBody) => api<{ key: string; summary: string; customerId: number }>(`${SD}/servicedesk/${deskId}/request`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId] }),
  })
}

export interface MergeResult { source: string; target: string; movedComments: number; movedAttachments: number; addedParticipants: number }

export function useMergeRequest(deskId: number, key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { targetKey: string; note?: string }) =>
      api<MergeResult>(`${SD}/servicedesk/${deskId}/request/${encodeURIComponent(key)}/merge`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (r) => {
      // the issue view reads several caches for both issues
      qc.invalidateQueries({ queryKey: ['issue'] })
      qc.invalidateQueries({ queryKey: ['issues'] })
      qc.invalidateQueries({ queryKey: ['sd'] })
      qc.invalidateQueries({ queryKey: ['comments'] })
      void r
    },
  })
}

export function useLinkRequest(deskId: number, key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { targetKey: string; linkTypeId: number; direction: 'outward' | 'inward' }) =>
      api<{ id: number }>(`${SD}/servicedesk/${deskId}/request/${encodeURIComponent(key)}/link`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issue'] })
      qc.invalidateQueries({ queryKey: ['issues'] })
    },
  })
}

/** Open and recent requests of a desk, for the merge / link target pickers. */
export const useDeskRequestSearch = (deskId: number, q: string, enabled: boolean) =>
  useQuery({
    queryKey: ['sd', deskId, 'request-search', q],
    queryFn: () => api<{ values: Array<{ key: string; summary: string; resolved?: string | null }> }>(
      `${SD}/servicedesk/${deskId}/request?${new URLSearchParams({ limit: '12', ...(q.trim() ? { q: q.trim() } : {}) })}`,
    ),
    enabled,
    staleTime: 5_000,
  })
