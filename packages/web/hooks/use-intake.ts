import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw Object.assign(new Error(msg), { status: res.status })
  }
  return res.json()
}

export type IntakeStatus = 'pending' | 'snoozed' | 'accepted' | 'declined' | 'duplicate'
export type IntakeAction = 'accept' | 'decline' | 'snooze' | 'duplicate' | 'reopen'
export type FieldMode = 'off' | 'optional' | 'required'
export interface IntakeFields { name: FieldMode; email: FieldMode; description: FieldMode }

export interface IntakeInfo { enabled: boolean; canTriage: boolean; canAdmin: boolean; canSubmit: boolean }
export interface IntakeItem {
  id: number; title: string; description: string; source: 'form' | 'email' | 'api' | 'app'; status: IntakeStatus
  requester: { name: string | null; email: string | null; userId: number | null }
  decidedBy: number | null; decidedAt: string | null; decisionReason: string | null; snoozedUntil: string | null
  acceptedIssue: { id: number; key: string } | null; duplicateOf: { id: number; key: string } | null
  createdAt: string; updatedAt: string
}
export interface IntakeList { startAt: number; maxResults: number; total: number; counts: Record<IntakeStatus, number>; items: IntakeItem[] }
export interface IntakeSettings {
  enabled: boolean; slug: string | null; publicFormEnabled: boolean; publicFormPath: string | null
  formTitle: string; formIntro: string; fields: IntakeFields
  emailEnabled: boolean; notifyLead?: boolean; emailConfigured: boolean; emailWebhookPath: string | null
}
export interface AcceptParams { issueTypeId: number; priorityId?: number | null; assigneeId?: number | null; summary?: string; note?: string; reason?: string }
export interface ActionBody extends Partial<AcceptParams> { until?: string; issue?: string }
export interface BulkResult { results: Array<{ id: number; ok: boolean; status?: string; error?: string }>; succeeded: number; failed: number }

const base = (k: string) => `/rest/api/2/project/${encodeURIComponent(k)}/intake`

export function useIntakeInfo(project: string) {
  return useQuery({ queryKey: ['intake-info', project], queryFn: () => api<IntakeInfo>(`${base(project)}/info`), retry: false })
}

export function useIntakeItems(project: string, status: IntakeStatus, q: string, enabled = true) {
  return useQuery({
    queryKey: ['intake-items', project, status, q],
    queryFn: () => api<IntakeList>(`${base(project)}/items?status=${status}&maxResults=100${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    enabled, refetchInterval: 60_000,
  })
}

export function useIntakeCounts(project: string, enabled: boolean) {
  return useQuery({
    queryKey: ['intake-counts', project],
    queryFn: () => api<IntakeList>(`${base(project)}/items?status=pending&maxResults=1`).then((r) => r.counts),
    enabled, retry: false,
  })
}

function useInvalidate(project: string) {
  const qc = useQueryClient()
  return () => { qc.invalidateQueries({ queryKey: ['intake-items', project] }); qc.invalidateQueries({ queryKey: ['intake-counts', project] }) }
}

export function useIntakeAction(project: string) {
  const done = useInvalidate(project)
  return useMutation({
    mutationFn: ({ id, action, body }: { id: number; action: IntakeAction; body?: ActionBody }) =>
      api<IntakeItem>(`${base(project)}/items/${id}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    onSuccess: done,
  })
}

export function useIntakeBulk(project: string) {
  const done = useInvalidate(project)
  return useMutation({
    mutationFn: (body: ActionBody & { ids: number[]; action: IntakeAction }) => api<BulkResult>(`${base(project)}/bulk`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: done,
  })
}

export function useSubmitIntake(project: string) {
  const done = useInvalidate(project)
  return useMutation({
    mutationFn: (body: { title: string; description?: string }) => api<IntakeItem>(`${base(project)}/items`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: done,
  })
}

export function useIntakeSettings(project: string) {
  return useQuery({ queryKey: ['intake-settings', project], queryFn: () => api<IntakeSettings>(`${base(project)}/settings`) })
}

export function useUpdateIntakeSettings(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<Pick<IntakeSettings, 'enabled' | 'publicFormEnabled' | 'formTitle' | 'formIntro' | 'fields' | 'emailEnabled' | 'notifyLead'>>) =>
      api<IntakeSettings>(`${base(project)}/settings`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (s) => { qc.setQueryData(['intake-settings', project], s); qc.invalidateQueries({ queryKey: ['intake-info', project] }) },
  })
}

export function useRotateIntakeSlug(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<IntakeSettings>(`${base(project)}/settings/rotate-slug`, { method: 'POST' }),
    onSuccess: (s) => qc.setQueryData(['intake-settings', project], s),
  })
}

export function useRotateIntakeEmailSecret(project: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<IntakeSettings & { secret: string }>(`${base(project)}/settings/rotate-email-secret`, { method: 'POST' }),
    onSuccess: ({ secret: _secret, ...s }) => qc.setQueryData(['intake-settings', project], s),
  })
}

/** Lookups for the accept dialog. */
export function useIntakeTypes(project: string) {
  return useQuery({
    queryKey: ['intake-createmeta', project],
    queryFn: () => api<{ projects: Array<{ issuetypes: Array<{ id: string; name: string; subtask: boolean }> }> }>(`/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(project)}`)
      .then((r) => (r.projects[0]?.issuetypes ?? []).filter((t) => !t.subtask)),
    staleTime: 5 * 60_000,
  })
}
export function useIntakePriorities() {
  return useQuery({ queryKey: ['intake-priorities'], queryFn: () => api<Array<{ id: string; name: string }>>('/rest/api/2/priority'), staleTime: 5 * 60_000 })
}
export function useIntakeAssignable() {
  return useQuery({
    queryKey: ['intake-assignable'],
    queryFn: () => api<Array<{ id: number; name: string; active: boolean }>>('/rest/api/2/user/search?query=').then((r) => r.filter((u) => u.active !== false)),
    staleTime: 60_000, retry: false,
  })
}

/* ---------------- public form (no session) ---------------- */

export interface PublicIntakeForm { title: string; intro: string; fields: IntakeFields }
export async function fetchPublicForm(slug: string): Promise<PublicIntakeForm> {
  const res = await fetch(`/rest/public/intake/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw Object.assign(new Error('not available'), { status: res.status })
  return res.json()
}
export async function submitPublicForm(slug: string, body: { title: string; description?: string; name?: string; email?: string; website?: string }) {
  const res = await fetch(`/rest/public/intake/${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw Object.assign(new Error(msg), { status: res.status })
  }
}
