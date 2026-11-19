import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(body?.errorMessages?.join(', ') || body?.error || res.statusText), { status: res.status, body })
  return body as T
}

/* --------------------------- inbound sources --------------------------- */

export interface InboundMapping {
  summary?: string
  description?: string
  comment?: string
  priority?: string
  priorityMap?: Record<string, string>
  labels?: string[]
  dedupKey?: string
  idempotencyKey?: string
  resolvedWhen?: { path: string; equals: string | string[] }
}

export interface InboundSource {
  id: number
  projectId: number
  name: string
  type: 'generic' | 'sentry'
  enabled: boolean
  authMode: 'hmac' | 'header'
  mapping: InboundMapping
  issueTypeId: number | null
  actorUserId: number | null
  actor: { id: number; displayName: string } | null
  url: string
  signatureHeader: string
  createdAt: string
  updatedAt: string
}
export interface InboundSourceWithSecret extends InboundSource { secret: string }

export interface InboundDelivery {
  id: number
  status: string
  reason: string | null
  idempotencyKey: string | null
  dedupKey: string | null
  issueKey: string | null
  payload: string | null
  isTest: boolean
  createdAt: string
}

export interface InboundPreview {
  dryRun: boolean
  normalized?: { summary: string; description: string; priority: string | null; labels: string[]; dedupKey: string | null; resolved: boolean; comment: string } | null
  plan?: { action: 'create' | 'comment' | 'transition' | 'ignore'; issue?: { key: string }; reason?: string } | null
  note?: string
  status?: string
  key?: string | null
  reason?: string | null
}

const enc = encodeURIComponent
const srcBase = (project: string) => `/rest/api/2/project/${enc(project)}/inbound-sources`

export function useInboundSources(project: string) {
  return useQuery({ queryKey: ['inbound-sources', project], queryFn: () => api<InboundSource[]>(srcBase(project)) })
}

export type InboundSourceInput = {
  name: string
  type?: 'generic' | 'sentry'
  authMode?: 'hmac' | 'header'
  enabled?: boolean
  mapping?: InboundMapping
}

export function useSaveInboundSource(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: InboundSourceInput & { id?: number }) =>
      id
        ? api<InboundSource>(`${srcBase(project)}/${id}`, { method: 'PUT', body: JSON.stringify(body) })
        : api<InboundSourceWithSecret>(srcBase(project), { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbound-sources', project] }),
  })
}

export function useRotateInboundSecret(project: string) {
  return useMutation({ mutationFn: (id: number) => api<InboundSourceWithSecret>(`${srcBase(project)}/${id}/rotate-secret`, { method: 'POST' }) })
}

export function useDeleteInboundSource(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api<unknown>(`${srcBase(project)}/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbound-sources', project] }),
  })
}

export function useInboundDeliveries(project: string, id: number | null) {
  return useQuery({
    queryKey: ['inbound-deliveries', project, id],
    queryFn: () => api<InboundDelivery[]>(`${srcBase(project)}/${id}/deliveries`),
    enabled: id !== null,
  })
}

export function useTestInboundSource(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload, dryRun }: { id: number; payload: unknown; dryRun: boolean }) =>
      api<InboundPreview>(`${srcBase(project)}/${id}/test`, { method: 'POST', body: JSON.stringify({ payload, dryRun }) }),
    onSuccess: (_r, v) => { if (!v.dryRun) qc.invalidateQueries({ queryKey: ['inbound-deliveries', project, v.id] }) },
  })
}

/* --------------------------- chat channels --------------------------- */

export type ChannelType = 'slack' | 'teams'
export interface NotificationChannel {
  id: number
  projectId: number | null
  type: ChannelType
  name: string
  url: string
  events: string[]
  settings: { teamsFormat?: 'adaptive' | 'messagecard' }
  enabled: boolean
  consecutiveFailures: number
  createdAt: string
}
export interface ChannelEvent { id: string; label: string }
export interface ChannelDelivery { id: number; event: string; status: string; responseStatus: number | null; error: string | null; attempts: number; latencyMs: number | null; createdAt: string }
export interface ChannelScope { project?: string }

const chanBase = (s: ChannelScope) => (s.project ? `/rest/api/2/project/${enc(s.project)}/notification-channels` : '/rest/api/2/admin/notification-channels')
const chanKey = (s: ChannelScope) => ['notification-channels', s.project ?? 'instance']

export function useNotificationChannels(s: ChannelScope) {
  return useQuery({ queryKey: chanKey(s), queryFn: () => api<{ channels: NotificationChannel[]; events: ChannelEvent[] }>(chanBase(s)) })
}

export type ChannelInput = { type?: ChannelType; name?: string; url?: string; events?: string[]; settings?: { teamsFormat?: 'adaptive' | 'messagecard' }; enabled?: boolean }

export function useSaveChannel(s: ChannelScope) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: ChannelInput & { id?: number }) =>
      api<NotificationChannel>(id ? `${chanBase(s)}/${id}` : chanBase(s), { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: chanKey(s) }),
  })
}

export function useDeleteChannel(s: ChannelScope) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api<unknown>(`${chanBase(s)}/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: chanKey(s) }),
  })
}

export function useTestChannel(s: ChannelScope) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api<{ ok: boolean; status: number | null; error: string | null; attempts: number }>(`${chanBase(s)}/${id}/test`, { method: 'POST' }).catch((e) => {
      if (e?.body && typeof e.body.ok === 'boolean') return e.body as { ok: boolean; status: number | null; error: string | null; attempts: number }
      throw e
    }),
    onSettled: (_r, _e, id) => { qc.invalidateQueries({ queryKey: [...chanKey(s), 'log', id] }); qc.invalidateQueries({ queryKey: chanKey(s) }) },
  })
}

export function useChannelDeliveries(s: ChannelScope, id: number | null) {
  return useQuery({
    queryKey: [...chanKey(s), 'log', id],
    queryFn: () => api<ChannelDelivery[]>(`${chanBase(s)}/${id}/deliveries`),
    enabled: id !== null,
  })
}
