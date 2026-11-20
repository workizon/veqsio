'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { toast } from '@/components/toast'
import { useLinkRepo, useRotateSecret, useScmRepos, useUnlinkRepo, type ScmProvider, type ScmRepoCreated } from '@/hooks/use-scm'
import { confirmDialog } from '@/components/dialogs'

const LABEL: Record<ScmProvider, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', bitbucket: 'Bitbucket' }
const HINT: Record<ScmProvider, string> = {
  github: 'Webhook: content type application/json, secret below. Events: Pushes, Pull requests, Workflow runs.',
  gitlab: 'Webhook: paste the secret into "Secret token". Triggers: Push, Merge request, Pipeline events.',
  gitea: 'Webhook type Gitea (or GitHub): secret below. Events: Push, Pull request.',
  bitbucket: 'Bitbucket Cloud does not sign deliveries: the URL below carries the secret, keep it private. Triggers: Repository push, Pull request.',
}

export function RepositoriesPanel({ projectKey }: { projectKey: string }) {
  const { tr } = useI18n();

  const repos = useScmRepos(projectKey)
  const link = useLinkRepo(projectKey)
  const unlink = useUnlinkRepo(projectKey)
  const rotate = useRotateSecret(projectKey)
  const [provider, setProvider] = useState<ScmProvider>('github')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [token, setToken] = useState('')
  const [created, setCreated] = useState<ScmRepoCreated | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await link.mutateAsync({ provider, name: name.trim(), baseUrl: baseUrl.trim() || null, defaultBranch: branch.trim() || 'main', accessToken: token || null })
      setCreated(res); setName(''); setToken('')
    } catch (err: any) { toast(err?.message || tr('Failed to link the repository'), 'error') }
  }

  return (
    <div className="space-y-6">
      <p className="text-body-sm text-[var(--text-secondary)]">
        {tr('Link a repository to see its branches, commits, pull requests and builds on issues. Any branch name, commit message or pull request title containing an issue key (')}{projectKey}{tr('-123) is linked. Smart commits:')} <code>{projectKey}-123 #comment text #done</code> {tr('(the commit author\'s email must match a user with permission).')} </p>
      {created && (
        <div role="status" className="rounded-lg border border-[var(--brand-500)] p-4 space-y-2 text-body-sm">
          <p className="font-medium">{tr('Repository linked. Copy these now: the secret is not shown again.')}</p>
          <p>{tr('Payload URL:')} <code className="break-all">{created.webhookUrl}</code></p>
          {created.provider !== 'bitbucket' && <p>{tr('Secret:')} <code className="break-all">{created.webhookSecret}</code></p>}
          <p className="text-[var(--text-secondary)]">{tr(HINT[created.provider])}</p>
          <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => setCreated(null)}>{tr('Done')}</button>
        </div>
      )}
      <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)]">
        {(repos.data ?? []).map((r) => (
          <li key={r.id} className="flex items-center gap-3 p-3 text-body-sm">
            <span className="font-medium">{LABEL[r.provider]}</span>
            <span className="flex-1 truncate">{r.name}{r.baseUrl ? ` · ${r.baseUrl}` : ''}</span>
            <span className="text-caption text-[var(--text-tertiary)]">{r.hasToken ? tr('branch creation on') : tr('no access token')}</span>
            <button type="button" className="text-caption text-[var(--brand-500)] hover:underline" onClick={async () => { try { setCreated(await rotate.mutateAsync(r.id)) } catch (err: any) { toast(err?.message, 'error') } }}>{tr('New secret')}</button>
            <button type="button" className="text-caption text-[var(--error)] hover:underline" onClick={async () => { if ((await confirmDialog(tr('Unlink {name}? Its branch, commit and pull request links are removed.', { name: r.name })))) { try { await unlink.mutateAsync(r.id) } catch (err: any) { toast(err?.message, 'error') } } }}>{tr('Unlink')}</button>
          </li>
        ))}
        {repos.data?.length === 0 && <li className="p-3 text-body-sm text-[var(--text-tertiary)]">{tr('No repositories linked yet.')}</li>}
      </ul>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 rounded-lg border border-[var(--surface-3)] p-4">
        <label className="text-body-sm">{tr('Provider')} <select className="veqsio-input mt-1" value={provider} onChange={(e) => setProvider(e.target.value as ScmProvider)}>
            {(Object.keys(LABEL) as ScmProvider[]).map((p) => <option key={p} value={p}>{LABEL[p]}</option>)}
          </select>
        </label>
        <label className="text-body-sm">{tr('Repository (owner/name)')} <input className="veqsio-input mt-1" required value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('acme/app')} />
        </label>
        {provider !== 'bitbucket' && (
          <label className="text-body-sm">{tr('Server URL')} {provider === 'gitea' ? tr('(required)') : tr('(self-hosted only)')}
            <input className="veqsio-input mt-1" type="url" required={provider === 'gitea'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://git.example.com" />
          </label>
        )}
        <label className="text-body-sm">{tr('Default branch')} <input className="veqsio-input mt-1" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <label className="text-body-sm sm:col-span-2">{tr('Access token (optional, lets Veqsio create branches)')} <input className="veqsio-input mt-1" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <div className="sm:col-span-2"><button type="submit" className="veqsio-btn-primary text-sm" disabled={link.isPending}>{tr('Link repository')}</button></div>
      </form>
    </div>
  )
}
