'use client'

import { usePathname } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { useState } from 'react'
import { useScimTokens, useCreateScimToken, useRevokeScimToken } from '@/hooks/use-oidc'
import { toast } from '@/components/toast'
import { Users, Plus, Trash2, Copy, Check } from 'lucide-react'
import { FeatureGate } from '@/components/feature-gate'
import { confirmDialog } from '@/components/dialogs'

function ScimAdminPageBody() {
  const { data: tokens, isLoading } = useScimTokens()
  const create = useCreateScimToken()
  const revoke = useRevokeScimToken()
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const baseUrl = typeof window !== 'undefined' ? `${window.location.origin}/scim/v2` : '/scim/v2'

  const onCreate = async () => {
    if (!name.trim()) return
    try {
      const r = await create.mutateAsync(name.trim())
      setFresh(r.token)
      setName('')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to create token', 'error')
    }
  }

  const onRevoke = async (id: number) => {
    if (!(await confirmDialog('Revoke this SCIM token? The identity provider will stop provisioning until given a new one.'))) return
    try {
      await revoke.mutateAsync(id)
      toast('Token revoked', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to revoke', 'error')
    }
  }

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <FeatureGate feature="scim" label="SCIM provisioning" mode="banner">
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
          <Users className="w-5 h-5 text-[var(--brand-500)]" />
        </div>
        <div>
          <h2 className="text-heading-2 text-[var(--text-primary)]">SCIM provisioning</h2>
          <p className="text-body-sm text-[var(--text-secondary)]">
            Let Okta, Microsoft Entra ID or OneLogin create, update and deactivate users and groups.
          </p>
        </div>
      </div>

      <div className="veqsio-card space-y-1 text-body-sm">
        <div>SCIM base URL: <code className="font-mono">{baseUrl}</code></div>
        <div className="text-caption text-[var(--text-secondary)]">
          Authentication: HTTP bearer token. A SCIM token can create users and change group membership, so treat it like an administrator credential.
          Deleting a user in the identity provider deactivates the account here; it is never removed.
        </div>
      </div>

      {fresh && (
        <div className="veqsio-card border-l-4 border-l-[var(--brand-500)]">
          <p className="text-body-sm font-medium text-[var(--text-primary)]">New SCIM token</p>
          <p className="text-caption text-[var(--text-secondary)] mt-1">Copy it now. It is shown only once; only a hash is stored.</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 block px-3 py-2 bg-[var(--surface-3)] rounded-md text-caption font-mono break-all">{fresh}</code>
            <button className="veqsio-btn-secondary flex items-center gap-1" onClick={() => copy(fresh)}>
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="veqsio-btn-secondary" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}

      <div className="veqsio-card flex items-end gap-3">
        <label className="flex-1 space-y-1">
          <span className="text-caption font-medium text-[var(--text-secondary)]">Token name</span>
          <input className="veqsio-input w-full" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onCreate()} placeholder="e.g. Okta production" />
        </label>
        <button className="veqsio-btn-primary flex items-center gap-1.5" disabled={create.isPending || !name.trim()} onClick={onCreate}>
          <Plus className="w-4 h-4" /> Create token
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-8 text-[var(--text-secondary)]">Loading tokens...</div>
      ) : !tokens?.length ? (
        <div className="text-center py-8 text-[var(--text-secondary)]">No SCIM tokens yet.</div>
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
          {tokens.map((t) => (
            <div key={t.id} className="px-4 py-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-body-sm font-medium text-[var(--text-primary)]">
                  {t.name} {t.revokedAt && <span className="ml-2 text-caption text-red-500">revoked</span>}
                </div>
                <div className="text-caption text-[var(--text-tertiary)]">
                  Created {new Date(t.createdAt).toLocaleDateString()}
                  {t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleString()}` : ' · never used'}
                </div>
              </div>
              {!t.revokedAt && (
                <button className="p-1 text-[var(--text-tertiary)] hover:text-red-500" title="Revoke" onClick={() => onRevoke(t.id)}>
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
    </FeatureGate>
  )
}

/** Opened on its own (/admin/scim) the page needs the application layout with the administration menu; inside the admin tabs it does not. */
export default function ScimAdminPage() {
  const standalone = usePathname() === '/admin/scim'
  return standalone ? <AppLayout><ScimAdminPageBody /></AppLayout> : <ScimAdminPageBody />
}
