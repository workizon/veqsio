'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { UserPicker, type PickedUser } from '@/components/admin/user-picker'
import { ExplainResult, type ExplainReason } from '@/components/admin/explain-result'

interface Explanation {
  allowed: boolean
  permission: string
  user: { id: number; username: string; displayName: string; active: boolean }
  scope: { type: 'global' | 'project' | 'issue'; projectKey?: string; projectName?: string; issueKey?: string }
  reasons: ExplainReason[]
}
interface PermissionDef { key: string; name: string; type: 'GLOBAL' | 'PROJECT' }

type ScopeKind = 'project' | 'issue' | 'global'

const label = (p: string) => p.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

export default function PermissionHelperPage() {
  const { tr } = useI18n();

  const [user, setUser] = useState<PickedUser | null>(null)
  const [scope, setScope] = useState<ScopeKind>('project')
  const [target, setTarget] = useState('')
  const [permission, setPermission] = useState('BROWSE_PROJECTS')
  const [result, setResult] = useState<Explanation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const { data: perms } = useQuery({
    queryKey: ['permissions', 'list'],
    queryFn: async () => ((await (await fetch('/rest/api/2/permissions', { credentials: 'include' })).json()).permissions as PermissionDef[]),
  })
  const options = (perms ?? []).filter((p) => (scope === 'global' ? p.type === 'GLOBAL' : p.type === 'PROJECT'))

  const run = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setResult(null)
    if (!user) return setError(tr('Pick a user first.'))
    if (scope !== 'global' && !target.trim()) return setError(scope === 'issue' ? tr('Enter an issue key such as DEMO-1.') : tr('Enter a project key such as DEMO.'))
    const q = new URLSearchParams({ userId: String(user.id), permission })
    if (scope === 'project') q.set('projectKey', target.trim().toUpperCase())
    if (scope === 'issue') q.set('issueKey', target.trim().toUpperCase())
    setBusy(true)
    try {
      const res = await fetch(`/rest/api/2/admin/permission-helper?${q}`, { credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) setError(res.status === 403 ? tr('System administrator rights are required.') : body.errorMessages?.[0] || res.statusText)
      else setResult(body)
    } finally { setBusy(false) }
  }

  const where = result?.scope.type === 'issue' ? tr('in issue {key}', { key: result.scope.issueKey ?? '' }) : result?.scope.type === 'project' ? tr('in project {key}', { key: result.scope.projectKey ?? '' }) : tr('globally')

  return (
    <AppLayout>
      <div className="space-y-5">
        <PageHeader title={tr('Permission helper')} description={tr('Check whether a user has a permission and see which permission scheme entry decides it. Uses the same check as the application itself.')} />

        <form onSubmit={run} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 grid gap-4 md:grid-cols-2 max-w-4xl">
          <UserPicker label={tr('User')} value={user} onChange={setUser} />
          <div>
            <label htmlFor="ph-scope" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{tr('Check in')}</label>
            <select id="ph-scope" className="veqsio-input w-full" value={scope} onChange={(e) => { setScope(e.target.value as ScopeKind); setPermission(e.target.value === 'global' ? 'SYSTEM_ADMIN' : 'BROWSE_PROJECTS') }}>
              <option value="project">{tr('A project')}</option>
              <option value="issue">{tr('An issue (browse access first, then the permission)')}</option>
              <option value="global">{tr('Globally')}</option>
            </select>
          </div>
          {scope !== 'global' && (
            <div>
              <label htmlFor="ph-target" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{scope === 'issue' ? tr('Issue key') : tr('Project key')}</label>
              <input id="ph-target" className="veqsio-input w-full" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={scope === 'issue' ? 'DEMO-1' : 'DEMO'} autoComplete="off" />
            </div>
          )}
          <div>
            <label htmlFor="ph-perm" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{tr('Permission')}</label>
            <select id="ph-perm" className="veqsio-input w-full" value={permission} onChange={(e) => setPermission(e.target.value)}>
              {options.length === 0 && <option value={permission}>{label(permission)}</option>}
              {options.map((p) => <option key={p.key} value={p.key}>{label(p.key)}</option>)}
            </select>
          </div>
          <div className="md:col-span-2 flex items-center gap-3">
            <button type="submit" className="veqsio-btn-primary flex items-center gap-2" disabled={busy}><Search className="w-4 h-4" />{tr('Check permission')}</button>
            {busy && <Spinner />}
            <span className="text-caption text-[var(--text-tertiary)]">{tr('Looking up another user is recorded in the audit log.')}</span>
          </div>
        </form>

        {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
        {result && (
          <div className="">
            <ExplainResult
              verdict={result.allowed ? tr('Allowed') : tr('Denied')} positive={result.allowed}
              title={result.allowed ? tr('{name} has "{perm}" {where}', { name: result.user.displayName, perm: label(result.permission), where }) : tr('{name} does not have "{perm}" {where}', { name: result.user.displayName, perm: label(result.permission), where })}
              subtitle={result.scope.projectName ? tr('Project: {name}', { name: result.scope.projectName }) : undefined}
              reasons={result.reasons}
            />
          </div>
        )}
      </div>
    </AppLayout>
  )
}
