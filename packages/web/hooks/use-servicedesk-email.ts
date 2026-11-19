import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ImapUpdate, ImapView } from './use-servicedesk-comms'

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
  return res.json()
}

const SD = '/rest/servicedeskapi'

export interface EmailChannel {
  configured: boolean
  enabled: boolean
  defaultRequestTypeId: number | null
  allowedSenderDomains: string[]
  inboundPath: string
  replyAddress: string | null
  imap: ImapView
  /** Present only in the response that creates the channel; shown once. */
  secret?: string
}

export interface EmailChannelUpdate {
  enabled?: boolean
  defaultRequestTypeId?: number | null
  allowedSenderDomains?: string[]
  replyAddress?: string | null
  imap?: ImapUpdate
}

export const useEmailChannel = (deskId: number) =>
  useQuery({ queryKey: ['sd', deskId, 'email-channel'], queryFn: () => api<EmailChannel>(`${SD}/servicedesk/${deskId}/email-channel`) })

export const useDeskRequestTypes = (deskId: number) =>
  useQuery({
    queryKey: ['sd', deskId, 'request-types'],
    queryFn: () => api<{ values: Array<{ id: number; name: string; enabled: boolean }> }>(`${SD}/servicedesk/${deskId}/requesttype`),
  })

export function useUpdateEmailChannel(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: EmailChannelUpdate) =>
      api<EmailChannel>(`${SD}/servicedesk/${deskId}/email-channel`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      const { secret: _secret, ...rest } = data
      qc.setQueryData(['sd', deskId, 'email-channel'], rest)
    },
  })
}

export function useRotateEmailSecret(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ secret: string }>(`${SD}/servicedesk/${deskId}/email-channel/rotate-secret`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId, 'email-channel'] }),
  })
}
