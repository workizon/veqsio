import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export function useTokens() {
  return useQuery({
    queryKey: ['personal-access-tokens'],
    queryFn: () => fetchJson<any[]>('/rest/api/2/mypersonalaccessTokens'),
  })
}

export function useTokenPolicy() {
  return useQuery({
    queryKey: ['personal-access-token-policy'],
    queryFn: () => fetchJson<{ defaultDays: number; maxDays: number; scopes: string[] }>('/rest/api/2/mypersonalaccessTokens/policy'),
    staleTime: 5 * 60_000,
  })
}

export function useCreateToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; scopes?: string[]; expiresInDays?: number }) =>
      fetchJson<{ id: number; token: string; expiresAt: string; scopes: string[] }>('/rest/api/2/mypersonalaccessTokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personal-access-tokens'] }),
  })
}

export function useRevokeToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson<any>(`/rest/api/2/mypersonalaccessTokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personal-access-tokens'] }),
  })
}
