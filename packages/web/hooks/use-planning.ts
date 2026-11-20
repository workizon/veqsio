import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { trNow } from '@/lib/tr'
import {
  applyCreate, applyMove, mapPlanning, mapRow, type MoveTarget, type PlanIssue, type PlanningData,
} from '@/lib/planning'

const BASE = '/rest/agile/1.0'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options?.headers,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || trNow('Request failed (HTTP {status})', { status: res.status }))
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const planningKey = (boardId: string | number | null) => ['planning', String(boardId)] as const

/** Sprints with their issues and totals plus the first backlog page: one request per board. */
export function usePlanning(boardId: string | number | null) {
  return useQuery<PlanningData, Error>({
    queryKey: planningKey(boardId),
    enabled: boardId !== null && boardId !== '',
    staleTime: 15_000,
    queryFn: async () => mapPlanning(await api(`${BASE}/board/${boardId}/planning?backlogMax=200`)),
  })
}

/** Loads the next page of the backlog into the cache. */
export function useLoadMoreBacklog(boardId: string | number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const cur = qc.getQueryData<PlanningData>(planningKey(boardId))
      const startAt = cur?.backlog.issues.length ?? 0
      const raw = await api<{ total: number; storyPoints: number; issues: any[] }>(`${BASE}/board/${boardId}/backlog?startAt=${startAt}&maxResults=200`)
      return { raw, startAt }
    },
    onSuccess: ({ raw, startAt }) => {
      qc.setQueryData<PlanningData>(planningKey(boardId), (cur) => {
        if (!cur || cur.backlog.issues.length !== startAt) return cur
        const seen = new Set(cur.backlog.issues.map((i) => i.key))
        const more = raw.issues.map(mapRow).filter((i) => !seen.has(i.key))
        return { ...cur, backlog: { ...cur.backlog, total: raw.total, storyPoints: raw.storyPoints, issues: [...cur.backlog.issues, ...more] } }
      })
    },
  })
}

interface MoveVars { keys: string[]; target: MoveTarget; beforeKey?: string | null }

/** Moves issues into a sprint or the backlog: optimistic, rolled back on error. */
export function useMoveIssues(boardId: string | number | null, onError?: (message: string) => void) {
  const qc = useQueryClient()
  const key = planningKey(boardId)
  return useMutation<unknown, Error, MoveVars, { previous?: PlanningData }>({
    mutationFn: ({ keys, target, beforeKey }) =>
      target.kind === 'backlog'
        ? api(`${BASE}/backlog/issue`, { method: 'POST', body: JSON.stringify({ issues: keys, ...(beforeKey ? { rankBeforeIssue: beforeKey } : {}) }) })
        : api(`${BASE}/sprint/${target.id}/issue`, {
            method: 'POST',
            body: JSON.stringify({ issues: keys, ...(beforeKey ? { rankBeforeIssue: beforeKey } : {}) }),
          }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<PlanningData>(key)
      if (previous) qc.setQueryData<PlanningData>(key, applyMove(previous, vars.keys, vars.target, vars.beforeKey))
      return { previous }
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
      onError?.(e.message)
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: key }) },
  })
}

export interface SprintInput { name: string; goal?: string | null; startDate?: string | null; endDate?: string | null }

function useInvalidatingMutation<TVars, TResult>(boardId: string | number | null, fn: (v: TVars) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation<TResult, Error, TVars>({
    mutationFn: fn,
    onSettled: () => { void qc.invalidateQueries({ queryKey: planningKey(boardId) }) },
  })
}

export function useCreateSprint(boardId: string | number | null) {
  return useInvalidatingMutation(boardId, (v: SprintInput) =>
    api<{ id: number }>(`${BASE}/board/${boardId}/sprint`, { method: 'POST', body: JSON.stringify(v) }))
}

export function useUpdateSprint(boardId: string | number | null) {
  return useInvalidatingMutation(boardId, ({ id, ...rest }: { id: number } & Partial<SprintInput>) =>
    api(`${BASE}/sprint/${id}`, { method: 'PUT', body: JSON.stringify(rest) }))
}

export function useDeleteSprint(boardId: string | number | null) {
  return useInvalidatingMutation(boardId, (id: number) => api(`${BASE}/sprint/${id}`, { method: 'DELETE' }))
}

export interface StartResult { warnings: string[]; parallelActiveSprints: boolean; issueCount: number; storyPoints: number }

export function useStartSprint(boardId: string | number | null) {
  return useInvalidatingMutation(boardId, ({ id, ...body }: { id: number } & Partial<SprintInput>) =>
    api<StartResult>(`${BASE}/sprint/${id}/start`, { method: 'POST', body: JSON.stringify(body) }))
}

export interface CompleteResult {
  summary: { completed: number; moved: number; completedPoints: number; movedPoints: number; movedTo: { type: 'backlog' } | { type: 'sprint'; id: number; name: string } }
}

export function useCompleteSprint(boardId: string | number | null) {
  return useInvalidatingMutation(boardId, ({ id, moveIncompleteTo }: { id: number; moveIncompleteTo: 'backlog' | number }) =>
    api<CompleteResult>(`${BASE}/sprint/${id}/complete`, { method: 'POST', body: JSON.stringify({ moveIncompleteTo }) }))
}

/** Creates an issue in the board's project and, for a sprint, plans it into that sprint. */
export function useCreatePlanIssue(boardId: string | number | null, projectId: number | undefined) {
  const qc = useQueryClient()
  return useMutation<PlanIssue, Error, { summary: string; issueTypeId: number; typeName: string; target: MoveTarget }>({
    mutationFn: async ({ summary, issueTypeId, typeName, target }) => {
      if (!projectId) throw new Error(trNow('This board has no project'))
      const created = await api<{ id: number | string; key: string }>('/rest/api/2/issue', {
        method: 'POST',
        body: JSON.stringify({ fields: { project: { id: projectId }, issuetype: { id: issueTypeId }, summary } }),
      })
      if (target.kind === 'sprint') {
        try {
          await api(`${BASE}/sprint/${target.id}/issue`, { method: 'POST', body: JSON.stringify({ issues: [created.key] }) })
        } catch (e) {
          throw new Error(trNow('{key} was created but could not be added to the sprint: {message}', { key: created.key, message: (e as Error).message }))
        }
      }
      return mapRow({
        id: String(created.id), key: created.key,
        fields: { summary, status: { name: 'To Do', statusCategory: { key: 'todo' } }, priority: null, issuetype: { name: typeName }, assignee: null, storyPoints: null },
      })
    },
    onSuccess: (issue, vars) => {
      qc.setQueryData<PlanningData>(planningKey(boardId), (cur) => (cur ? applyCreate(cur, issue, vars.target) : cur))
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: planningKey(boardId) }) },
  })
}
