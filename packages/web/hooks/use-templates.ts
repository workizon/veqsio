import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).errorMessages?.join('. ') || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })
const enc = encodeURIComponent

/* ---------------------------- issue templates ---------------------------- */

export interface IssueTemplate {
  id: number
  scope: 'project' | 'global'
  projectKey: string | null
  name: string
  description: string | null
  issueTypeId: number | null
  summaryPattern: string
  body: string
  priorityId: number | null
  labels: string[]
  components: string[]
  assigneeId: number | null
  customFields: Array<{ fieldId: number; value: unknown }>
}
export interface TemplateList { canManageProject: boolean; canManageGlobal: boolean; templates: IssueTemplate[] }

/** Templates usable in a project (its own plus global ones); without a key only the global ones. */
export function useIssueTemplates(projectKey?: string, enabled = true) {
  return useQuery({
    queryKey: ['issue-templates', projectKey ?? null],
    enabled,
    retry: false,
    queryFn: () => api<TemplateList>(`/rest/api/2/issue-template${projectKey ? `?projectKey=${enc(projectKey)}` : ''}`),
  })
}

export type TemplateInput = Omit<IssueTemplate, 'id' | 'scope' | 'projectKey' | 'customFields'> & { projectKey?: string | null; customFields?: IssueTemplate['customFields'] }

export function useSaveTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id?: number; data: Partial<TemplateInput> }) =>
      id ? api<IssueTemplate>(`/rest/api/2/issue-template/${id}`, json('PUT', data)) : api<IssueTemplate>('/rest/api/2/issue-template', json('POST', data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['issue-templates'] }),
  })
}

export function useDeleteTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api<unknown>(`/rest/api/2/issue-template/${id}`, json('DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['issue-templates'] }),
  })
}

export interface TemplatePrefill {
  projectId: number
  issueTypeId: number
  summary: string
  description?: string
  priorityId?: number
  assigneeId?: number
  labels?: string[]
  components?: number[]
  customFields?: Array<{ fieldId: number; value: unknown }>
}
export const fetchPrefill = (templateId: number, projectKey: string) => api<TemplatePrefill>(`/rest/api/2/issue-template/${templateId}/prefill?projectKey=${enc(projectKey)}`)

/* ---------------------------- recurring issues --------------------------- */

export interface RecurringRule {
  id: number
  name: string
  templateId: number
  templateName: string | null
  frequency: 'daily' | 'weekly' | 'monthly'
  daysOfWeek: number[]
  dayOfMonth: number | null
  timeOfDay: string
  timezone: string
  ownerId: number
  ownerName: string | null
  active: boolean
  lastRunAt: string | null
  nextRunAt: string | null
}
export interface RecurringRun { id: number; slotAt: string; status: 'pending' | 'created' | 'failed' | 'skipped'; issueKey: string | null; error: string | null }

export function useRecurring(projectKey: string) {
  return useQuery({ queryKey: ['recurring', projectKey], queryFn: () => api<{ archived: boolean; rules: RecurringRule[] }>(`/rest/api/2/project/${enc(projectKey)}/recurring-issue`) })
}
export function useRecurringRuns(projectKey: string, id: number | null) {
  return useQuery({ queryKey: ['recurring-runs', projectKey, id], enabled: id !== null, queryFn: () => api<{ runs: RecurringRun[] }>(`/rest/api/2/project/${enc(projectKey)}/recurring-issue/${id}/runs`) })
}
export function useSaveRecurring(projectKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id?: number; data: Record<string, unknown> }) =>
      api<RecurringRule>(`/rest/api/2/project/${enc(projectKey)}/recurring-issue${id ? `/${id}` : ''}`, json(id ? 'PUT' : 'POST', data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring', projectKey] }),
  })
}
export function useDeleteRecurring(projectKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api<unknown>(`/rest/api/2/project/${enc(projectKey)}/recurring-issue/${id}`, json('DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring', projectKey] }),
  })
}

/* ------------------------ project templates and copy ---------------------- */

export interface ProjectTemplateInfo {
  id: string
  name: string
  description: string
  board: { name: string; type: string }
  components: string[]
  versions: string[]
  issueTemplates: Array<{ name: string; issueType: string }>
}
export function useProjectTemplates() {
  return useQuery({ queryKey: ['project-templates'], staleTime: 300_000, queryFn: () => api<{ templates: ProjectTemplateInfo[] }>('/rest/api/2/project-template').then((r) => r.templates) })
}
export interface CopyPreview { key: string; name: string; components: string[]; versions: string[]; issueTemplates: string[]; roleActors: Array<{ role: string; actors: number }> }
export function useCopyPreview(sourceKey: string | null) {
  return useQuery({ queryKey: ['copy-preview', sourceKey], enabled: !!sourceKey, retry: false, queryFn: () => api<CopyPreview>(`/rest/api/2/project/${enc(sourceKey!)}/copy-preview`) })
}

/* ---------------------------- archive and delete --------------------------- */

export function useArchiveProject(projectKey: string) {
  const qc = useQueryClient()
  const done = () => { qc.invalidateQueries({ queryKey: ['projects'] }); qc.invalidateQueries({ queryKey: ['project', projectKey] }) }
  return {
    archive: useMutation({ mutationFn: () => api<unknown>(`/rest/api/2/project/${enc(projectKey)}/archive`, json('POST')), onSuccess: done }),
    restore: useMutation({ mutationFn: () => api<unknown>(`/rest/api/2/project/${enc(projectKey)}/restore`, json('POST')), onSuccess: done }),
    remove: useMutation({
      mutationFn: (confirm: { confirmKey: string; confirmPhrase: string }) => api<unknown>(`/rest/api/2/project/${enc(projectKey)}`, json('DELETE', confirm)),
      onSuccess: done,
    }),
  }
}
