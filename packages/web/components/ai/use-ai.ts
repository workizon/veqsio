'use client'

import { useQuery } from '@tanstack/react-query'

export interface AiFeatures {
  enabled: boolean
  features: { classify: boolean; summarize: boolean; similar: boolean; release_notes: boolean; review: boolean; rule_draft: boolean }
}

const NONE: AiFeatures = { enabled: false, features: { classify: false, summarize: false, similar: false, release_notes: false, review: false, rule_draft: false } }

/** Which AI features the server offers to this user. While loading or on error nothing is shown. */
export function useAiFeatures(): AiFeatures {
  const { data } = useQuery({
    queryKey: ['ai', 'features'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<AiFeatures> => {
      const res = await fetch('/rest/api/2/ai/features', { credentials: 'include' })
      return res.ok ? ((await res.json()) as AiFeatures) : NONE
    },
  })
  return data ?? NONE
}

export async function aiJson<T>(method: 'GET' | 'POST', url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.errorMessages?.[0] ?? `Request failed (${res.status})`)
  return json as T
}

export interface SimilarIssue { key: string; summary: string; projectKey: string; status: string; score: number }
