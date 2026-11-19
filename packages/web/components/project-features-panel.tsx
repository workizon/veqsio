'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'

interface Row { id: string; name: string; description: string; instanceEnabled: boolean; enabled: boolean }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
  return res.json()
}

/** Turn optional features on or off for this project only. */
export function ProjectFeaturesPanel({ projectKey }: { projectKey: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['project-features', projectKey], queryFn: () => api<{ features: Row[] }>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/features`).then((r) => r.features) })
  const save = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api<unknown>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/features`, { method: 'PUT', body: JSON.stringify({ features: { [id]: enabled } }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-features', projectKey] }),
    onError: (e) => toast((e as Error).message, 'error'),
  })
  if (q.isLoading) return <Spinner />
  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-body-sm text-[var(--text-secondary)]">Switch optional features for this project. Turning one off hides it and closes its API for this project; nothing is deleted. Features an administrator switched off for the whole instance cannot be enabled here.</p>
      <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
        {(q.data ?? []).map((f) => (
          <li key={f.id} className="flex items-center gap-4 p-4">
            <label htmlFor={`pf-${f.id}`} className="flex-1 min-w-0">
              <span className="block text-body font-medium">{f.name}</span>
              <span className="block text-body-sm text-[var(--text-secondary)]">{f.description}{!f.instanceEnabled ? ' (switched off for the whole instance)' : ''}</span>
            </label>
            <input id={`pf-${f.id}`} type="checkbox" role="switch" checked={f.enabled} disabled={!f.instanceEnabled || save.isPending} onChange={(e) => save.mutate({ id: f.id, enabled: e.target.checked })} />
          </li>
        ))}
      </ul>
    </div>
  )
}
