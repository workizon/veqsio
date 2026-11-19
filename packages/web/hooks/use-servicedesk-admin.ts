import { useQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { FieldDef } from '@/lib/request-form'
import type { Desk } from './use-servicedesk'

/** Hooks for service desk project configuration (create wizard, settings, form builder). */

export class ApiError extends Error {
  constructor(message: string, public status: number, public body?: any) { super(message) }
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  })
  if (!res.ok) {
    let msg = res.statusText
    let body: any
    try { body = await res.json(); msg = body.errorMessages?.join(', ') || msg } catch {}
    throw new ApiError(msg, res.status, body)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

const SD = '/rest/servicedeskapi'
const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

function useDeskMutation<V, R = unknown>(deskId: number, fn: (v: V) => Promise<R>, keys: QueryKey[]) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => { for (const k of keys) qc.invalidateQueries({ queryKey: k }) },
  })
}

/* ---- desk ---- */

export interface DeskDetail extends Desk {
  projectId: number; projectKey: string | null; projectName: string | null
  welcomeMessage?: string | null; description?: string | null; enabled: boolean; publicSignup: boolean
}

export const TEMPLATES = ['it-support', 'customer-service', 'hr', 'facilities', 'none'] as const
export type DeskTemplateId = string

export interface CreateDeskInput {
  projectKey: string; createProject?: boolean; projectName?: string; name: string; slug: string
  description?: string; welcomeMessage?: string; publicSignup?: boolean; template: DeskTemplateId
}

export function useCreateDesk() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: CreateDeskInput) => api<{ id: number; slug: string; projectKey: string }>(`${SD}/servicedesk`, send('POST', b)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sd', 'desks'] }),
  })
}

/** Templates contributed by licensed modules (empty on the community edition). */
export const useExtraDeskTemplates = () =>
  useQuery({ queryKey: ['sd', 'desk-templates'], queryFn: async () => (await api<{ values: Array<{ id: string; title: string; description: string }> }>(`${SD}/desk-templates`)).values })

export const useProjects = () =>
  useQuery({ queryKey: ['projects', 'all'], queryFn: () => api<Array<{ id: number; key: string; name: string }>>('/rest/api/2/project') })

export const useDesk = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'desk'], queryFn: () => api<DeskDetail>(`${SD}/servicedesk/${id}`), enabled: Number.isInteger(id) })

export const useUpdateDesk = (id: number) =>
  useDeskMutation(id, (b: Partial<{ name: string; description: string | null; welcomeMessage: string | null; enabled: boolean; publicSignup: boolean }>) =>
    api(`${SD}/servicedesk/${id}`, send('PUT', b)), [['sd', id, 'desk'], ['sd', 'desks'], ['sd', id, 'portal-settings']])

/* ---- request types ---- */

export interface RequestTypeFull {
  id: number; serviceDeskId: number; name: string; description?: string | null; helpText?: string | null; icon?: string | null
  groupName?: string | null; issueTypeId: number; defaultPriorityId?: number | null; fields: FieldDef[]; sortOrder: number
  enabled: boolean; visibility: 'all' | 'organizations'; organizationIds: number[]; requestCount?: number
}
export type RequestTypeInput = Partial<Omit<RequestTypeFull, 'id' | 'serviceDeskId' | 'requestCount'>>

export const useAdminRequestTypes = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'rt-admin'], queryFn: () => api<{ values: RequestTypeFull[] }>(`${SD}/servicedesk/${id}/requesttype`) })

export const useAdminRequestType = (id: number, rtId: number) =>
  useQuery({ queryKey: ['sd', id, 'rt-admin', rtId], queryFn: () => api<RequestTypeFull>(`${SD}/servicedesk/${id}/requesttype/${rtId}`), enabled: Number.isInteger(rtId) })

const rtKeys = (id: number): QueryKey[] => [['sd', id, 'rt-admin'], ['sd', id, 'portal-settings'], ['portal']]

export const useCreateRequestType = (id: number) =>
  useDeskMutation(id, (b: RequestTypeInput & { name: string; issueTypeId: number }) => api<RequestTypeFull>(`${SD}/servicedesk/${id}/requesttype`, send('POST', b)), rtKeys(id))
export const useUpdateRequestType = (id: number) =>
  useDeskMutation(id, (v: { rtId: number; body: RequestTypeInput }) => api<RequestTypeFull>(`${SD}/servicedesk/${id}/requesttype/${v.rtId}`, send('PUT', v.body)), rtKeys(id))
export const useDuplicateRequestType = (id: number) =>
  useDeskMutation(id, (rtId: number) => api<RequestTypeFull>(`${SD}/servicedesk/${id}/requesttype/${rtId}/duplicate`, send('POST')), rtKeys(id))
export const useDeleteRequestType = (id: number) =>
  useDeskMutation(id, (rtId: number) => api(`${SD}/servicedesk/${id}/requesttype/${rtId}`, send('DELETE')), rtKeys(id))
export const useReorderRequestTypes = (id: number) =>
  useDeskMutation(id, (ids: number[]) => api(`${SD}/servicedesk/${id}/requesttype/reorder`, send('POST', { ids })), rtKeys(id))

export interface FormContext {
  customFields: Array<{ id: number; name: string; fieldType: string }>
  priorities: Array<{ id: number; name: string }>
  issueTypes: Array<{ id: number; name: string }>
  components: Array<{ id: number; name: string }>
  organizations: Array<{ id: number; name: string }>
}
export const useFormContext = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'formcontext'], queryFn: () => api<FormContext>(`${SD}/servicedesk/${id}/formcontext`) })

/* ---- portal settings ---- */

export interface PortalSettings {
  portalTitle: string | null; introduction: string | null; logoUrl: string | null; accentColor: string | null
  groups: Array<{ name: string; requestTypeCount: number }>
  slug: string; enabled: boolean; publicSignup: boolean
}
export const usePortalSettings = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'portal-settings'], queryFn: () => api<PortalSettings>(`${SD}/servicedesk/${id}/portal-settings`) })
export const useSavePortalSettings = (id: number) =>
  useDeskMutation(id, (b: Partial<Pick<PortalSettings, 'portalTitle' | 'introduction' | 'logoUrl' | 'accentColor'>> & { groups?: Array<{ name: string; renamedFrom?: string }> }) =>
    api(`${SD}/servicedesk/${id}/portal-settings`, send('PUT', b)), [['sd', id, 'portal-settings'], ['sd', id, 'rt-admin'], ['portal']])

/* ---- people ---- */

export interface DeskAgent { userId: number; displayName: string; email: string; role: 'agent' | 'admin' }
export interface DeskCustomer { userId: number; displayName: string; email: string; organizationId: number | null; organization: string | null }
export interface DeskOrg { id: number; name: string; customerCount: number }

export const useDeskAgents = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'agents'], queryFn: () => api<{ values: DeskAgent[] }>(`${SD}/servicedesk/${id}/agent`) })
export const useAddAgent = (id: number) =>
  useDeskMutation(id, (b: { email: string; role: 'agent' | 'admin' }) => api(`${SD}/servicedesk/${id}/agent`, send('POST', b)), [['sd', id, 'agents']])
export const useRemoveAgent = (id: number) =>
  useDeskMutation(id, (userId: number) => api(`${SD}/servicedesk/${id}/agent/${userId}`, send('DELETE')), [['sd', id, 'agents']])

export const useDeskCustomers = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'customers'], queryFn: () => api<{ values: DeskCustomer[] }>(`${SD}/servicedesk/${id}/customer`) })
export const useAddCustomer = (id: number) =>
  useDeskMutation(id, (b: { email: string; organizationId?: number | null }) => api(`${SD}/servicedesk/${id}/customer`, send('POST', b)), [['sd', id, 'customers'], ['sd', id, 'orgs']])
export const useMoveCustomer = (id: number) =>
  useDeskMutation(id, (v: { userId: number; organizationId: number | null }) => api(`${SD}/servicedesk/${id}/customer/${v.userId}`, send('PUT', { organizationId: v.organizationId })), [['sd', id, 'customers'], ['sd', id, 'orgs']])
export const useRemoveCustomer = (id: number) =>
  useDeskMutation(id, (userId: number) => api(`${SD}/servicedesk/${id}/customer/${userId}`, send('DELETE')), [['sd', id, 'customers'], ['sd', id, 'orgs']])

export const useDeskOrgs = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'orgs'], queryFn: () => api<{ values: DeskOrg[] }>(`${SD}/servicedesk/${id}/organization`) })
export const useSaveOrg = (id: number) =>
  useDeskMutation(id, (v: { orgId?: number; name: string }) =>
    v.orgId ? api(`${SD}/servicedesk/${id}/organization/${v.orgId}`, send('PUT', { name: v.name })) : api(`${SD}/servicedesk/${id}/organization`, send('POST', { name: v.name })),
    [['sd', id, 'orgs'], ['sd', id, 'customers'], ['sd', id, 'formcontext']])
export const useDeleteOrg = (id: number) =>
  useDeskMutation(id, (orgId: number) => api(`${SD}/servicedesk/${id}/organization/${orgId}`, send('DELETE')), [['sd', id, 'orgs'], ['sd', id, 'customers'], ['sd', id, 'formcontext'], ['sd', id, 'rt-admin']])

/* ---- queues ---- */

export interface DeskQueue { id: number; name: string; jql: string | null; sortOrder: number }
export const useAdminQueues = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'queues-admin'], queryFn: () => api<{ values: DeskQueue[] }>(`${SD}/servicedesk/${id}/queue`) })
export const useSaveQueue = (id: number) =>
  useDeskMutation(id, (v: { qid?: number; name: string; jql: string | null; sortOrder?: number }) => {
    const { qid, ...body } = v
    return qid ? api(`${SD}/servicedesk/${id}/queue/${qid}`, send('PUT', body)) : api(`${SD}/servicedesk/${id}/queue`, send('POST', body))
  }, [['sd', id, 'queues-admin'], ['sd', id, 'queues']])
export const useDeleteQueue = (id: number) =>
  useDeskMutation(id, (qid: number) => api(`${SD}/servicedesk/${id}/queue/${qid}`, send('DELETE')), [['sd', id, 'queues-admin'], ['sd', id, 'queues']])

/* ---- knowledge base ---- */

export interface KbArticle { id: number; title: string; body: string; labels: string[]; published: boolean; views: number; helpful: number; updatedAt: string }
export const useKbArticles = (id: number) =>
  useQuery({ queryKey: ['sd', id, 'kb'], queryFn: () => api<{ values: KbArticle[] }>(`${SD}/servicedesk/${id}/kb`) })
export const useSaveKb = (id: number) =>
  useDeskMutation(id, (v: { aid?: number; title?: string; body?: string; labels?: string[]; published?: boolean }) => {
    const { aid, ...body } = v
    return aid ? api(`${SD}/servicedesk/${id}/kb/${aid}`, send('PUT', body)) : api(`${SD}/servicedesk/${id}/kb`, send('POST', body))
  }, [['sd', id, 'kb']])
export const useDeleteKb = (id: number) =>
  useDeskMutation(id, (aid: number) => api(`${SD}/servicedesk/${id}/kb/${aid}`, send('DELETE')), [['sd', id, 'kb']])

/** Desk configuration is for desk administrators; agents see the settings read-only. */
export function useDeskAdmin(id: number): { loading: boolean; isAdmin: boolean } {
  const d = useDesk(id)
  return { loading: d.isLoading, isAdmin: d.data?.role === 'admin' }
}

/* ---- portal attachments sent with the form ---- */

/** Upload one file to a just-created request (the attachment field of a request form). */
export async function uploadPortalFile(slug: string, key: string, file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${SD}/portal/${slug}/request/${key}/attachment`, { method: 'POST', credentials: 'include', body: form })
  if (!res.ok) {
    let msg = 'Upload failed'
    try { msg = (await res.json()).errorMessages?.join(', ') || msg } catch {}
    throw new Error(`${file.name}: ${msg}`)
  }
}
