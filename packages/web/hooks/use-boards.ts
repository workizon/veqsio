import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `HTTP ${res.status}`)
  }
  return res.json()
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Board {
  id: string
  name: string
  type: string
  projectId: number
  filterId: number | null
  config: BoardConfig
  columns: BoardColumn[]
  quickFilters: QuickFilter[]
}

export interface BoardConfig {
  swimlaneField?: string | null
  swimlaneJql?: string | null
  /** Card colour by (see lib/card-colours.ts). */
  /** Card layout: optional parts shown on cards and card density (see lib/card-layout.ts). */
  cardFields?: string[]
  cardSize?: 'compact' | 'comfortable'
  cardColour?: { by: string; rules: Array<{ name: string; jql: string; colour: string }> }
}

export interface BoardColumn {
  id: string
  name: string
  statusId: number | null
  min: number | null
  max: number | null
  sortOrder: number
}

export interface QuickFilter {
  id: string
  name: string
  jql: string
  sortOrder: number
}

export interface BoardSummary {
  id: string
  name: string
  type: string
  projectId: number
  filterId: number | null
}

/* ------------------------------------------------------------------ */
/*  Boards                                                             */
/* ------------------------------------------------------------------ */

export function useBoards(projectId?: number) {
  const url = projectId
    ? `/rest/api/2/board?projectId=${projectId}`
    : '/rest/api/2/board'
  return useQuery<{ values: BoardSummary[] }, Error>({
    queryKey: ['boards', projectId],
    queryFn: () => fetchJson(url),
  })
}

export function useBoard(id: string) {
  return useQuery<Board, Error>({
    queryKey: ['board', id],
    queryFn: () => fetchJson(`/rest/api/2/board/${id}`),
    enabled: !!id,
  })
}

export function useFilter(id: number | null) {
  return useQuery<{ id: string; name: string; jql: string; favourite: boolean }, Error>({
    queryKey: ['filter', id],
    queryFn: () => fetchJson(`/rest/api/2/filter/${id}`),
    enabled: !!id,
  })
}

export function useUpdateBoard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Board> }) =>
      fetchJson(`/rest/api/2/board/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['board', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['boards'] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Columns                                                            */
/* ------------------------------------------------------------------ */

export function useUpdateBoardColumns() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, columns }: { id: string; columns: BoardColumn[] }) =>
      fetchJson(`/rest/api/2/board/${id}/columns`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns }),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['board', variables.id] })
    },
  })
}

/* ------------------------------------------------------------------ */
/*  Quick Filters                                                      */
/* ------------------------------------------------------------------ */

export function useCreateQuickFilter() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ boardId, data }: { boardId: string; data: { name: string; jql: string; sortOrder?: number } }) =>
      fetchJson(`/rest/api/2/board/${boardId}/quick-filters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['board', variables.boardId] })
    },
  })
}

export function useUpdateQuickFilter() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ boardId, filterId, data }: { boardId: string; filterId: string; data: { name: string; jql: string; sortOrder?: number } }) =>
      fetchJson(`/rest/api/2/board/${boardId}/quick-filters/${filterId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['board', variables.boardId] })
    },
  })
}

export function useDeleteQuickFilter() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ boardId, filterId }: { boardId: string; filterId: string }) =>
      fetchJson(`/rest/api/2/board/${boardId}/quick-filters/${filterId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['board', variables.boardId] })
    },
  })
}
