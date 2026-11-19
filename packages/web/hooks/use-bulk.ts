'use client'

import { useQuery } from '@tanstack/react-query'
import type { BulkOperation, BulkResult } from '@/lib/bulk'

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let data: any = null
  try { data = await res.json() } catch { /* empty */ }
  if (!res.ok) throw new Error(data?.errorMessages?.join(', ') || `Request failed (HTTP ${res.status})`)
  return data as T
}

/** One server-side bulk run (or its dry run with `preview`). Partial success is a normal 200 answer. */
export function runBulk(issueKeys: string[], operation: BulkOperation, params: Record<string, unknown>, preview = false): Promise<BulkResult> {
  return post<BulkResult>(`/rest/api/2/bulk/issues${preview ? '?preview=true' : ''}`, { issueKeys, operation, params })
}

export interface BulkTransitionOption {
  id: number; name: string; to: { id: number; name: string }; count: number; issueKeys: string[]
  requiresComment?: boolean; requiresResolution?: boolean
}
export interface BulkTransitions { total: number; transitions: BulkTransitionOption[]; commonIds: number[]; unavailable: Array<{ key: string; reason: string }> }

export function useBulkTransitions(keys: string[], enabled: boolean) {
  return useQuery<BulkTransitions, Error>({
    queryKey: ['bulk', 'transitions', keys.join(',')],
    queryFn: () => post<BulkTransitions>('/rest/api/2/bulk/issues/transitions', { issueKeys: keys }),
    enabled,
    staleTime: 0,
    gcTime: 0,
  })
}

export interface SprintOption { id: number; name: string; state: string | null }

/** Open sprints (future and active) of the boards of one project. */
export function useProjectSprints(projectId: number | null, enabled: boolean) {
  return useQuery<SprintOption[], Error>({
    queryKey: ['bulk', 'sprints', projectId],
    enabled: enabled && projectId !== null,
    queryFn: async () => {
      const boards = await (await fetch(`/rest/agile/1.0/board?projectId=${projectId}`, { credentials: 'include' })).json()
      const out: SprintOption[] = []
      for (const b of boards.values ?? []) {
        const r = await (await fetch(`/rest/agile/1.0/board/${b.id}/sprint?state=future,active`, { credentials: 'include' })).json()
        for (const s of r.values ?? []) out.push({ id: s.id, name: s.name, state: s.state })
      }
      return out
    },
  })
}
