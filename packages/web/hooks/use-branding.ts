import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_BRANDING, type Branding } from '@/lib/branding'

export const BRANDING_KEY = ['branding'] as const

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body.errorMessages?.join('. ') || (res.status === 403 ? 'System administrator rights are required' : res.statusText)), { status: res.status, body })
  return body as T
}

/** Public branding (name, logos, accent colour, footer links). Never fails: falls back to the Veqsio defaults. */
export function useBranding(): Branding {
  const q = useQuery({
    queryKey: BRANDING_KEY,
    queryFn: () => request<Branding>('/rest/api/2/branding', { cache: 'no-cache' }).catch(() => DEFAULT_BRANDING),
    staleTime: 60_000,
  })
  return q.data ?? DEFAULT_BRANDING
}

export interface AdminBranding extends Branding {
  stored: { siteName: string | null; accentColor: string | null; supportUrl: string | null; docsUrl: string | null; hideCredit: boolean }
  hideCreditLicensed: boolean
  limits: { maxFileBytes: number; minAccentContrast: number }
}

const ADMIN_KEY = ['admin', 'branding'] as const

export function useAdminBranding() {
  return useQuery({ queryKey: ADMIN_KEY, queryFn: () => request<AdminBranding>('/rest/api/2/admin/branding') })
}

function useBrandingMutation<V>(fn: (v: V) => Promise<AdminBranding>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(ADMIN_KEY, data)
      qc.invalidateQueries({ queryKey: BRANDING_KEY })
    },
  })
}

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

export function useSaveBranding() {
  return useBrandingMutation((patch: Partial<AdminBranding['stored']>) => request<AdminBranding>('/rest/api/2/admin/branding', json('PUT', patch)))
}

export function useUploadBrandingFile() {
  return useBrandingMutation(({ slot, file }: { slot: 'light' | 'dark' | 'favicon'; file: File }) => {
    const form = new FormData()
    form.append('file', file)
    return request<AdminBranding>(`/rest/api/2/admin/branding/logo/${slot}`, { method: 'POST', body: form })
  })
}

export function useRemoveBrandingFile() {
  return useBrandingMutation((slot: 'light' | 'dark' | 'favicon') => request<AdminBranding>(`/rest/api/2/admin/branding/logo/${slot}`, json('DELETE')))
}

export function useResetBranding() {
  return useBrandingMutation(() => request<AdminBranding>('/rest/api/2/admin/branding', json('DELETE')))
}
