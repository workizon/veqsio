'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/page-header'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { useTokens, useCreateToken, useRevokeToken, useTokenPolicy } from '@/hooks/use-tokens'
import { toast } from '@/components/toast'
import { Copy, Key, Plus, Trash2, Check, Clock, Shield } from 'lucide-react'
import { confirmDialog } from '@/components/dialogs'

const SCOPE_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'read:*', label: 'Read everything', hint: 'GET requests only' },
  { value: 'read:issues', label: 'Read issues', hint: 'Issues, comments, worklogs, search' },
  { value: 'write:issues', label: 'Write issues', hint: 'Create and change issues, comments, worklogs, attachments' },
  { value: 'read:projects', label: 'Read projects', hint: 'Projects, versions, components, boards' },
  { value: 'write:projects', label: 'Write projects', hint: 'Change projects, boards and sprints' },
  { value: 'write:*', label: 'Write everything', hint: 'Every non-administrative endpoint' },
  { value: 'admin', label: 'Administration', hint: 'Admin APIs, SCIM, migration. Also grants everything else' },
  { value: '*', label: 'Full access', hint: 'Everything your account can do' },
]

export default function TokensPage() {
  const { data: policy } = useTokenPolicy()
  const { data: tokens, isLoading } = useTokens()
  const createToken = useCreateToken()
  const revokeToken = useRevokeToken()

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newToken, setNewToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [scopes, setScopes] = useState<string[]>(['read:*'])
  const [days, setDays] = useState<number | null>(null)

  const handleCreate = async () => {
    if (!newName.trim()) return
    try {
      const result = await createToken.mutateAsync({ name: newName.trim(), scopes, expiresInDays: days ?? policy?.defaultDays })
      setNewToken(result.token)
      setNewName('')
      setShowCreate(false)
      toast('Token created. Copy it now — you will not see it again.', 'success')
    } catch (e: any) {
      toast(e.message || 'Failed to create token', 'error')
    }
  }

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleRevoke = async (id: number) => {
    if (!(await confirmDialog('Revoke this token? Any integrations using it will stop working.'))) return
    try {
      await revokeToken.mutateAsync(id)
      toast('Token revoked', 'success')
    } catch (e: any) {
      toast(e.message || 'Failed to revoke token', 'error')
    }
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          breadcrumb={[{ label: 'Profile', href: '/profile' }, { label: 'Personal access tokens' }]}
          title="Personal access tokens"
          description="Tokens allow scripts and integrations to authenticate with the Veqsio API on your behalf."
          actions={<button onClick={() => setShowCreate(true)} className="veqsio-btn-primary flex items-center gap-1.5"><Plus className="w-4 h-4" />Create token</button>}
        />

        {newToken && (
          <div className="veqsio-card border-l-4 border-l-[var(--brand-500)] bg-[var(--surface-1)]">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-body-sm font-medium text-[var(--text-primary)]">Your new token</p>
                <p className="text-caption text-[var(--text-secondary)] mt-1">
                  Copy it now — it will not be shown again.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 block px-3 py-2 bg-[var(--surface-3)] rounded-md text-caption font-mono text-[var(--text-primary)] break-all">
                    {newToken}
                  </code>
                  <button
                    onClick={() => handleCopy(newToken)}
                    className="veqsio-btn-secondary flex items-center gap-1 flex-shrink-0"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <button onClick={() => setNewToken(null)} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                ×
              </button>
            </div>
          </div>
        )}

        {showCreate && !newToken && (
          <div className="veqsio-card space-y-4">
            <h2 className="text-heading-2 text-[var(--text-primary)]">Create token</h2>
            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">Name</label>
              <input
                type="text"
                className="veqsio-input w-full"
                placeholder="e.g. CI/CD Integration"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">Scopes</label>
              <div className="space-y-1.5">
                {SCOPE_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={scopes.includes(o.value)}
                      onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, o.value] : cur.filter((s) => s !== o.value)))}
                    />
                    <span className="text-body-sm text-[var(--text-primary)]">
                      {o.label} <span className="text-caption text-[var(--text-tertiary)]">({o.value}) {o.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">Expires after</label>
              <select
                className="veqsio-input"
                value={days ?? policy?.defaultDays ?? 90}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {[30, 90, 180, 365]
                  .filter((d) => d <= (policy?.maxDays ?? 365))
                  .concat(policy && ![30, 90, 180, 365].includes(policy.maxDays) ? [policy.maxDays] : [])
                  .map((d) => (
                    <option key={d} value={d}>{d} days{d === policy?.defaultDays ? ' (default)' : ''}</option>
                  ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="veqsio-btn-secondary">Cancel</button>
              <button
                onClick={handleCreate}
                disabled={createToken.isPending || !newName.trim() || scopes.length === 0}
                className="veqsio-btn-primary"
              >
                {createToken.isPending ? <Spinner size="sm" /> : 'Create'}
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : !tokens?.length ? (
          <div className="text-center py-12">
            <Key className="w-12 h-12 text-[var(--text-tertiary)] mx-auto mb-3" />
            <h3 className="text-body font-medium text-[var(--text-primary)]">No tokens yet</h3>
            <p className="text-body-sm text-[var(--text-secondary)] mt-1">
              Create a token to use the Veqsio API from scripts and integrations.
            </p>
          </div>
        ) : (
          <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
            {tokens.map((token: any) => (
              <div key={token.id} className="px-4 py-3 flex items-center justify-between gap-4 hover:bg-[var(--surface-1)] transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-[var(--text-tertiary)]" />
                    <span className="text-body-sm font-medium text-[var(--text-primary)]">{token.name}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-caption text-[var(--text-tertiary)]">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Created {new Date(token.createdAt).toLocaleDateString()}
                    </span>
                    {token.lastUsedAt && (
                      <span>Last used {new Date(token.lastUsedAt).toLocaleDateString()}</span>
                    )}
                    {token.expiresAt && (
                      <span>Expires {new Date(token.expiresAt).toLocaleDateString()}</span>
                    )}
                    <span className="text-[var(--brand-500)]">{token.scopes?.join(', ')}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(token.id)}
                  disabled={revokeToken.isPending}
                  className="text-[var(--text-tertiary)] hover:text-red-500 transition-colors p-1"
                  title="Revoke token"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  )
}
