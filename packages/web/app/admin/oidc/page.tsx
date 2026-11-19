'use client'

import { usePathname } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { useState } from 'react'
import {
  useOidcProviders,
  useSaveOidcProvider,
  useDeleteOidcProvider,
  useTestOidcProvider,
  type OidcProvider,
} from '@/hooks/use-oidc'
import { toast } from '@/components/toast'
import { KeyRound, Plus, Trash2, Pencil, TestTube } from 'lucide-react'
import { FeatureGate } from '@/components/feature-gate'
import { confirmDialog } from '@/components/dialogs'

interface FormState {
  id?: number
  name: string
  slug: string
  issuer: string
  clientId: string
  clientSecret: string
  hasSecret: boolean
  scopes: string
  emailClaim: string
  nameClaim: string
  groupsClaim: string
  allowedDomains: string
  autoProvision: boolean
  linkByEmail: boolean
  enforceSso: boolean
  enabled: boolean
}

const empty: FormState = {
  name: '', slug: '', issuer: '', clientId: '', clientSecret: '', hasSecret: false,
  scopes: 'openid profile email', emailClaim: 'email', nameClaim: 'name', groupsClaim: '',
  allowedDomains: '', autoProvision: false, linkByEmail: false, enforceSso: false, enabled: true,
}

function fromProvider(p: OidcProvider): FormState {
  return {
    id: p.id, name: p.name, slug: p.slug, issuer: p.issuer, clientId: p.clientId, clientSecret: '', hasSecret: p.hasSecret,
    scopes: p.scopes, emailClaim: p.emailClaim, nameClaim: p.nameClaim, groupsClaim: p.groupsClaim ?? '',
    allowedDomains: p.allowedDomains.join(', '), autoProvision: p.autoProvision, linkByEmail: p.linkByEmail,
    enforceSso: p.enforceSso, enabled: p.enabled,
  }
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium text-[var(--text-primary)]">{label}</span>
        <span className="block text-caption text-[var(--text-secondary)]">{hint}</span>
      </span>
    </label>
  )
}

function OidcAdminPageBody() {
  const { data: providers, isLoading } = useOidcProviders()
  const save = useSaveOidcProvider()
  const remove = useDeleteOidcProvider()
  const test = useTestOidcProvider()
  const [form, setForm] = useState<FormState | null>(null)

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const redirectUri = (slug: string) =>
    `${typeof window !== 'undefined' ? window.location.origin : ''}/rest/auth/1/oidc/${slug || '<slug>'}/callback`

  const submit = async () => {
    if (!form) return
    const data: Record<string, unknown> = {
      name: form.name.trim(),
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      scopes: form.scopes.trim(),
      emailClaim: form.emailClaim.trim(),
      nameClaim: form.nameClaim.trim(),
      groupsClaim: form.groupsClaim.trim() || null,
      allowedDomains: form.allowedDomains.split(/[,\s]+/).map((d) => d.trim().toLowerCase()).filter(Boolean),
      autoProvision: form.autoProvision,
      linkByEmail: form.linkByEmail,
      enforceSso: form.enforceSso,
      enabled: form.enabled,
    }
    if (form.clientSecret) data.clientSecret = form.clientSecret
    if (!form.id) {
      data.slug = form.slug.trim()
      if (!form.clientSecret) return toast('Client secret is required', 'error')
    }
    try {
      await save.mutateAsync({ id: form.id, data: data as any })
      toast('Provider saved', 'success')
      setForm(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to save provider', 'error')
    }
  }

  const onDelete = async (p: OidcProvider) => {
    if (!(await confirmDialog(`Delete "${p.name}"? Users who signed in through it keep their accounts but can no longer use this provider.`))) return
    try {
      await remove.mutateAsync(p.id)
      toast('Provider deleted', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to delete', 'error')
    }
  }

  const onTest = async (p: OidcProvider) => {
    try {
      const r = await test.mutateAsync(p.id)
      toast(r.ok ? 'Discovery succeeded' : `Discovery failed: ${r.error}`, r.ok ? 'success' : 'error')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Test failed', 'error')
    }
  }

  return (
    <FeatureGate feature="sso_oidc_generic" label="Generic OpenID Connect providers" mode="banner">
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-[var(--brand-500)]" />
          </div>
          <div>
            <h2 className="text-heading-2 text-[var(--text-primary)]">OpenID Connect providers</h2>
            <p className="text-body-sm text-[var(--text-secondary)]">
              Okta, Keycloak, Google Workspace, Auth0, Authentik or any other OIDC identity provider.
            </p>
          </div>
        </div>
        {!form && (
          <button className="veqsio-btn-primary flex items-center gap-1.5" onClick={() => setForm({ ...empty })}>
            <Plus className="w-4 h-4" /> Add provider
          </button>
        )}
      </div>

      {form && (
        <div className="veqsio-card space-y-5">
          <h3 className="text-heading-3 text-[var(--text-primary)]">{form.id ? `Edit ${form.name}` : 'New provider'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Display name</span>
              <input className="veqsio-input w-full" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Okta" />
            </label>
            <label className="space-y-1">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Slug (cannot be changed later)</span>
              <input className="veqsio-input w-full" value={form.slug} disabled={!!form.id} onChange={(e) => set('slug', e.target.value.toLowerCase())} placeholder="okta" />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Issuer URL (https, discovery at /.well-known/openid-configuration)</span>
              <input className="veqsio-input w-full" value={form.issuer} onChange={(e) => set('issuer', e.target.value)} placeholder="https://example.okta.com" />
            </label>
            <label className="space-y-1">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Client ID</span>
              <input className="veqsio-input w-full" value={form.clientId} onChange={(e) => set('clientId', e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-caption font-medium text-[var(--text-secondary)]">
                Client secret {form.hasSecret && <em>(stored encrypted, leave empty to keep)</em>}
              </span>
              <input className="veqsio-input w-full" type="password" autoComplete="new-password" value={form.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} placeholder={form.hasSecret ? '••••••••' : ''} />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Scopes (must include openid)</span>
              <input className="veqsio-input w-full" value={form.scopes} onChange={(e) => set('scopes', e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Email claim</span>
              <input className="veqsio-input w-full" value={form.emailClaim} onChange={(e) => set('emailClaim', e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Name claim</span>
              <input className="veqsio-input w-full" value={form.nameClaim} onChange={(e) => set('nameClaim', e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Groups claim (empty = no group sync)</span>
              <input className="veqsio-input w-full" value={form.groupsClaim} onChange={(e) => set('groupsClaim', e.target.value)} placeholder="groups" />
            </label>
            <label className="space-y-1">
              <span className="text-caption font-medium text-[var(--text-secondary)]">Allowed email domains (comma separated, empty = any)</span>
              <input className="veqsio-input w-full" value={form.allowedDomains} onChange={(e) => set('allowedDomains', e.target.value)} placeholder="example.com, example.org" />
            </label>
          </div>

          <div className="space-y-3 border-t border-[var(--surface-3)] pt-4">
            <Toggle label="Enabled" hint="Show the sign-in button and accept logins." checked={form.enabled} onChange={(v) => set('enabled', v)} />
            <Toggle label="Auto-provision users" hint="Create a Veqsio account on first sign-in (subject to the domain list)." checked={form.autoProvision} onChange={(v) => set('autoProvision', v)} />
            <Toggle label="Link existing accounts by email" hint="Only when the provider asserts email_verified=true. Off by default: a matching local account is otherwise refused." checked={form.linkByEmail} onChange={(v) => set('linkByEmail', v)} />
            <Toggle label="Enforce SSO" hint="Disable password login for everyone except system administrators (break-glass)." checked={form.enforceSso} onChange={(v) => set('enforceSso', v)} />
          </div>

          <p className="text-caption text-[var(--text-secondary)]">
            Redirect URI to register at the provider: <code className="font-mono">{redirectUri(form.slug)}</code>
          </p>

          <div className="flex justify-end gap-2">
            <button className="veqsio-btn-secondary" onClick={() => setForm(null)}>Cancel</button>
            <button className="veqsio-btn-primary" disabled={save.isPending} onClick={submit}>Save</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-8 text-[var(--text-secondary)]">Loading providers...</div>
      ) : !providers?.length ? (
        <div className="text-center py-8 text-[var(--text-secondary)]">No OIDC providers configured.</div>
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
          {providers.map((p) => (
            <div key={p.id} className="px-4 py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-body-sm font-medium text-[var(--text-primary)]">
                  {p.name} <span className="text-caption text-[var(--text-tertiary)]">({p.slug})</span>
                  {!p.enabled && <span className="ml-2 text-caption text-[var(--text-tertiary)]">disabled</span>}
                  {p.enforceSso && <span className="ml-2 text-caption text-[var(--brand-500)]">SSO enforced</span>}
                </div>
                <div className="text-caption text-[var(--text-secondary)] truncate">{p.issuer}</div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title="Test discovery" onClick={() => onTest(p)}><TestTube className="w-4 h-4" /></button>
                <button className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title="Edit" onClick={() => setForm(fromProvider(p))}><Pencil className="w-4 h-4" /></button>
                <button className="p-1 text-[var(--text-tertiary)] hover:text-red-500" title="Delete" onClick={() => onDelete(p)}><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    </FeatureGate>
  )
}

/** Opened on its own (/admin/oidc) the page needs the application layout with the administration menu; inside the admin tabs it does not. */
export default function OidcAdminPage() {
  const standalone = usePathname() === '/admin/oidc'
  return standalone ? <AppLayout><OidcAdminPageBody /></AppLayout> : <OidcAdminPageBody />
}
