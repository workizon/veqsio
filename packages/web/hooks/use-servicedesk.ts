import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

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

export interface SlaResult {
  slaId: number; name: string; metric: string; targetMs: number; elapsedMs: number
  remainingMs: number; status: 'running' | 'paused' | 'warning' | 'met' | 'breached'; breached: boolean
  stoppedAt?: string | null; startedAt?: string | null
  /** Projected (running) or actual (overdue) due instant; null while paused or met. */
  dueAt?: string | null; warningAt?: string | null
  calendar?: string | null; paused?: boolean
}
export type { FieldDef } from '@/lib/request-form'
import type { FieldDef } from '@/lib/request-form'
export interface PortalInfo {
  name: string; slug: string; description?: string; welcomeMessage?: string
  portalTitle?: string | null; introduction?: string | null; logoUrl?: string | null; accentColor?: string | null
  groups?: string[]
  requestTypes: Array<{
    id: number; name: string; description?: string; helpText?: string; icon?: string; groupName?: string; fields: FieldDef[]
    /** a form field is mapped to the summary / description, so the generic inputs are hidden */
    summaryField?: boolean; descriptionField?: boolean
  }>
}
export interface DeskRequest {
  key: string; summary: string; statusId: number; priorityId?: number; assigneeId?: number
  created: string; resolved?: string; sla: SlaResult[]; csat?: { rating: number } | null
}
export interface Desk { id: number; name: string; slug: string; role: 'admin' | 'agent'; projectKey?: string | null; enabled?: boolean; publicSignup?: boolean; description?: string | null }

export const useDesks = () => useQuery({ queryKey: ['sd', 'desks'], queryFn: () => api<{ values: Desk[] }>(`${SD}/servicedesk`) })

export const useDeskRequests = (id: number, params: Record<string, string>) =>
  useQuery({
    queryKey: ['sd', id, 'requests', params],
    queryFn: () => api<{ values: DeskRequest[]; total?: number; start?: number; limit?: number }>(`${SD}/servicedesk/${id}/request?${new URLSearchParams(params)}`),
    refetchInterval: 30_000,
  })

export const useDeskQueues = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'queues'], queryFn: () => api<{ values: Array<{ id: number; name: string; count?: number | null }> }>(`${SD}/servicedesk/${id}/queue?counts=true`), refetchInterval: 60_000 })

export const useDeskReport = (id: number, days = 30) =>
  useQuery({
    queryKey: ['sd', id, 'report', days],
    queryFn: () => api<{
      days: number
      daily: Array<{ date: string; created: number; resolved: number }>
      workload: Array<{ userId: number | null; name: string; open: number; resolved: number }>
      csatDistribution: Array<{ rating: number; count: number }>
      total: number; open: number; resolved: number
      csat: { responses: number; average: number | null }
      sla: Array<{ slaId: number; name: string; met: number; breached: number; running: number; compliance: number | null }>
    }>(`${SD}/servicedesk/${id}/report?days=${days}`),
  })

export const usePortal = (slug: string) =>
  useQuery({ queryKey: ['portal', slug], queryFn: () => api<PortalInfo>(`${SD}/portal/${slug}`), retry: false })

export const usePortalKb = (slug: string, q: string) =>
  useQuery({
    queryKey: ['portal', slug, 'kb', q],
    queryFn: () => api<{ values: Array<{ id: number; title: string; excerpt: string }> }>(`${SD}/portal/${slug}/kb?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 3,
  })

export const useMyRequests = (slug: string) =>
  useQuery({
    queryKey: ['portal', slug, 'requests'],
    queryFn: () => api<{ values: Array<{ key: string; summary: string; status: string; created: string; resolved?: string; requestType?: string | null; assignee?: string | null; sla?: 'overdue' | 'paused' | 'on_track' | 'met' | null }> }>(`${SD}/portal/${slug}/request`),
  })

export const usePortalRequest = (slug: string, key: string) =>
  useQuery({
    queryKey: ['portal', slug, 'request', key],
    queryFn: () => api<{
      key: string; summary: string; description?: string; status: string; created: string; resolved?: string
      csat?: { rating: number; comment?: string } | null
      comments: Array<{ id: number; parentId?: number | null; body: string; created: string; author?: string; mine: boolean }>
    }>(`${SD}/portal/${slug}/request/${key}`),
    retry: false,
  })

export function useCreatePortalRequest(slug: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { requestTypeId: number; summary?: string; description?: string; fieldValues: Record<string, unknown> }) =>
      api<{ key: string }>(`${SD}/portal/${slug}/request`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal', slug, 'requests'] }),
  })
}

export function usePortalComment(slug: string, key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: string | { body: string; parentId?: number }) => {
      const payload = typeof v === 'string' ? { body: v } : v
      return api(`${SD}/portal/${slug}/request/${key}/comment`, { method: 'POST', body: JSON.stringify(payload) })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal', slug, 'request', key] }),
  })
}

export function usePortalCsat(slug: string, key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { rating: number; comment?: string }) =>
      api(`${SD}/portal/${slug}/request/${key}/csat`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal', slug, 'request', key] }),
  })
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  const m = Math.floor(abs / 60_000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  const text = d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`
  return ms < 0 ? `-${text}` : text
}

/* ---- canned responses (agent reply templates) ---- */

export interface CannedResponse { id: number; title: string; body: string; sortOrder: number; createdAt: string }

export const useCannedResponses = (deskId: number | undefined) =>
  useQuery({
    queryKey: ['sd', deskId, 'canned'],
    queryFn: () => api<{ values: CannedResponse[] }>(`${SD}/servicedesk/${deskId}/canned`),
    enabled: !!deskId,
  })

export function useSaveCanned(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id?: number; title: string; body: string; sortOrder?: number }) => {
      const { id, ...body } = v
      return id
        ? api(`${SD}/servicedesk/${deskId}/canned/${id}`, { method: 'PUT', body: JSON.stringify(body) })
        : api(`${SD}/servicedesk/${deskId}/canned`, { method: 'POST', body: JSON.stringify(body) })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId, 'canned'] }),
  })
}

export function useDeleteCanned(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api(`${SD}/servicedesk/${deskId}/canned/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId, 'canned'] }),
  })
}

/** Server-side placeholder rendering for a specific request. */
export const renderCannedResponse = (deskId: number, cannedId: number, issueKey: string) =>
  api<{ title: string; body: string }>(`${SD}/servicedesk/${deskId}/canned/${cannedId}/render?issue=${encodeURIComponent(issueKey)}`)

export const useRequestMeta = (key: string) =>
  useQuery({
    queryKey: ['sd', 'meta', key],
    queryFn: () => api<{ isRequest: boolean; staff: boolean; deskId?: number; sla?: SlaResult[]; channel?: string; customer?: { id: number; displayName: string | null; email: string } | null }>(`${SD}/request/${encodeURIComponent(key)}/meta`),
    staleTime: 30_000,
  })

/* ---- Portal attachments (appended block) ---- */

export interface PortalAttachment { id: number; filename: string; size: number; mimeType: string; created: string; mine: boolean; content: string }

export const usePortalAttachments = (slug: string, key: string) =>
  useQuery({
    queryKey: ['portal', slug, 'request', key, 'attachments'],
    queryFn: () => api<{ values: PortalAttachment[] }>(`${SD}/portal/${slug}/request/${key}/attachment`),
  })

export function useUploadPortalAttachment(slug: string, key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File): Promise<PortalAttachment> => {
      const form = new FormData()
      form.append('file', file)
      // No explicit Content-Type: the browser must set the multipart boundary.
      const res = await fetch(`${SD}/portal/${slug}/request/${key}/attachment`, { method: 'POST', credentials: 'include', body: form })
      if (!res.ok) {
        let msg = res.status === 429 ? 'Too many uploads. Please try again later.' : 'Upload failed'
        try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
        throw new Error(msg)
      }
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal', slug, 'request', key, 'attachments'] }),
  })
}

/* ---- SLA calendars and metrics (desk admin) ---- */

export type WorkingHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', Array<[string, string]>>>
export interface Holiday { id?: number; date: string; name: string; recurring: boolean }
export interface SlaCalendar {
  id: number; name: string; builtIn: boolean; timeZone: string; workingHours: WorkingHours; holidays: Holiday[]
}
export interface SlaCalendarInput { name: string; timeZone: string; workingHours: WorkingHours; holidays: Holiday[] }

export interface GoalCriteria { priorityIds?: number[]; issueTypeIds?: number[]; requestTypeIds?: number[] }
export interface SlaGoal {
  id?: number; priorityId?: number | null; criteria: GoalCriteria; jql?: string | null; targetMinutes: number; calendarId?: number | null
}
export interface SlaConditions {
  start: import('@/lib/sla').Condition[]; pause: import('@/lib/sla').Condition[]; stop: import('@/lib/sla').Condition[]
}
export interface SlaMetric {
  id: number; name: string; metric: string; calendar: string; calendarId: number | null; warningPercent: number | null
  pauseStatusIds: number[]; goals: SlaGoal[]; effectiveConditions: SlaConditions; usesLegacyConditions: boolean
}
export interface SlaMetricInput {
  name: string; metric: string; calendarId: number | null; warningPercent: number | null
  startConditions: import('@/lib/sla').Condition[]; pauseConditions: import('@/lib/sla').Condition[]; stopConditions: import('@/lib/sla').Condition[]
  goals: Array<{ criteria: GoalCriteria; jql: string | null; targetMinutes: number; calendarId: number | null }>
}

export const useSlaCalendars = (deskId: number) =>
  useQuery({ queryKey: ['sd', deskId, 'calendars'], queryFn: () => api<{ values: SlaCalendar[] }>(`${SD}/servicedesk/${deskId}/calendar`) })

export function useSaveCalendar(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: SlaCalendarInput & { id?: number }) =>
      id
        ? api<SlaCalendar>(`${SD}/servicedesk/${deskId}/calendar/${id}`, { method: 'PUT', body: JSON.stringify({ ...body, holidays: body.holidays.map(({ date, name, recurring }) => ({ date, name, recurring })) }) })
        : api<SlaCalendar>(`${SD}/servicedesk/${deskId}/calendar`, { method: 'POST', body: JSON.stringify({ ...body, holidays: body.holidays.map(({ date, name, recurring }) => ({ date, name, recurring })) }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId, 'calendars'] }),
  })
}

export function useDeleteCalendar(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api(`${SD}/servicedesk/${deskId}/calendar/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId, 'calendars'] }),
  })
}

export interface CalendarPreview { due: string | null; start: string; elapsedMinutes: number | null; workingMinutes: number | null; message: string | null }

export const usePreviewCalendar = (deskId: number) =>
  useMutation({
    mutationFn: (body: { calendarId?: number; calendar?: { timeZone: string; workingHours: WorkingHours; holidays: Holiday[] }; start: string; durationMinutes: number }) =>
      api<CalendarPreview>(`${SD}/servicedesk/${deskId}/calendar/preview`, { method: 'POST', body: JSON.stringify(body) }),
  })

export const useSlaMetrics = (deskId: number) =>
  useQuery({ queryKey: ['sd', deskId, 'sla-metrics'], queryFn: () => api<{ values: SlaMetric[] }>(`${SD}/servicedesk/${deskId}/sla`) })

export function useSaveSla(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: SlaMetricInput & { id?: number }) =>
      id
        ? api<SlaMetric>(`${SD}/servicedesk/${deskId}/sla/${id}`, { method: 'PUT', body: JSON.stringify(body) })
        : api<SlaMetric>(`${SD}/servicedesk/${deskId}/sla`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sd', deskId, 'sla-metrics'] }); qc.invalidateQueries({ queryKey: ['sd', deskId, 'calendars'] }) },
  })
}

export function useDeleteSla(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api(`${SD}/servicedesk/${deskId}/sla/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId, 'sla-metrics'] }),
  })
}

export function useReorderSla(deskId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: number[]) => api(`${SD}/servicedesk/${deskId}/sla-order`, { method: 'PUT', body: JSON.stringify({ ids }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', deskId, 'sla-metrics'] }),
  })
}
