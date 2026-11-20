'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'

interface Row { kind: string; currentId: number | null; current: string | null; options: { id: number; name: string }[]; editable: boolean; optional: boolean }

const META: Record<string, { label: string; help: string; admin: string }> = {
  issuetype: { label: 'Issue types', help: 'Which issue types can be created in this project.', admin: '/admin?tab=issue-types' },
  workflow: { label: 'Workflows', help: 'Statuses and transitions per issue type.', admin: '/admin/workflows' },
  permission: { label: 'Permissions', help: 'Who may browse, create, edit and administer.', admin: '/admin?tab=permissions' },
  priority: { label: 'Priorities', help: 'Which priorities can be chosen; none means all of them.', admin: '/admin/priority-schemes' },
  security: { label: 'Issue security', help: 'Security levels that hide issues from some people. Change it in Administration (existing issues need their levels mapped).', admin: '/admin/issue-security' },
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
  return res.json()
}

/** Which configuration schemes this project uses (Jira's project settings overview). Changing one needs an administrator. */
export function ProjectSchemesPanel({ projectKey }: { projectKey: string }) {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const url = `/rest/api/2/project/${encodeURIComponent(projectKey)}/schemes`
  const q = useQuery({ queryKey: ['project-schemes', projectKey], queryFn: () => api<{ schemes: Row[]; fieldConfigurationOverrides: number }>(url) })
  const save = useMutation({
    mutationFn: (v: { kind: string; schemeId: number | null }) => api<unknown>(url, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project-schemes', projectKey] }); toast(tr('Scheme changed'), 'success') },
    onError: (e) => { toast((e as Error).message, 'error'); qc.invalidateQueries({ queryKey: ['project-schemes', projectKey] }) },
  })
  if (q.isLoading) return <Spinner />
  if (q.error) return <p role="alert" className="text-body-sm text-[var(--error)]">{(q.error as Error).message}</p>
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-body-sm text-[var(--text-secondary)]">{tr('The schemes this project uses. Only system administrators can switch a scheme; schemes are shared by every project that uses them, so edit their contents in Administration.')}</p>
      <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
        {(q.data?.schemes ?? []).map((s) => {
          const m = META[s.kind]
          return (
            <li key={s.kind} className="flex flex-wrap items-center gap-4 p-4">
              <div className="flex-1 min-w-[12rem]">
                <label htmlFor={`scheme-${s.kind}`} className="block text-body font-medium">{tr(m.label)}</label>
                <span className="block text-body-sm text-[var(--text-secondary)]">{m.help}</span>
              </div>
              {s.editable ? (
                <select
                  id={`scheme-${s.kind}`}
                  className="veqsio-input w-64"
                  value={s.currentId ?? ''}
                  disabled={save.isPending}
                  onChange={(e) => save.mutate({ kind: s.kind, schemeId: e.target.value ? Number(e.target.value) : null })}
                >
                  {(s.optional || s.currentId === null) && <option value="">{s.optional ? 'No scheme (all)' : 'Default (none selected)'}</option>}
                  {s.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : (
                <span id={`scheme-${s.kind}`} className="w-64 text-body-sm">{s.current ?? tr('None')}</span>
              )}
              <Link href={m.admin} className="text-body-sm">{tr('Manage')}</Link>
            </li>
          )
        })}
      </ul>
      {!!q.data?.fieldConfigurationOverrides && (
        <p className="text-body-sm text-[var(--text-secondary)]">{q.data.fieldConfigurationOverrides} {tr('issue type(s) use a custom field configuration.')} <Link href="/admin?tab=field-configs">{tr('Manage')}</Link></p>
      )}
    </div>
  )
}
