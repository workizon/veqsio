'use client'

import { usePathname } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { useState } from 'react'
import { ShieldCheck, Plus, Trash2, Pencil, TestTube, Copy, ExternalLink } from 'lucide-react'
import { toast } from '@/components/toast'
import { FeatureGate } from '@/components/feature-gate'
import {
  useSamlProviders, useSaveSamlProvider, useDeleteSamlProvider, useTestSamlProvider, type SamlProvider,
} from '@/hooks/use-saml'
import { certificateStatus, emptySamlForm, NAMEID_FORMATS, samlPayload, samlProblem, type SamlForm } from '@/lib/sso-forms'
import { confirmDialog } from '@/components/dialogs'

function fromProvider(p: SamlProvider): SamlForm {
  return {
    id: p.id, name: p.name, slug: p.slug, idpEntityId: p.idpEntityId, idpSsoUrl: p.idpSsoUrl, idpCertificates: p.idpCertificates,
    signRequests: p.signRequests, spSigningKey: '', spSigningCertificate: p.spSigningCertificate ?? '', hasSigningKey: p.hasSigningKey,
    nameIdFormat: p.nameIdFormat, emailAttribute: p.emailAttribute ?? '', displayNameAttribute: p.displayNameAttribute ?? '',
    usernameAttribute: p.usernameAttribute ?? '', groupsAttribute: p.groupsAttribute ?? '', syncGroups: p.syncGroups,
    defaultGroups: p.defaultGroups.join(', '), allowedDomains: p.allowedDomains.join(', '), autoProvision: p.autoProvision,
    linkByEmail: p.linkByEmail, enforceSso: p.enforceSso, enabled: p.enabled,
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

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`space-y-1 ${wide ? 'md:col-span-2' : ''}`}>
      <span className="text-caption font-medium text-[var(--text-secondary)]">{label}</span>
      {children}
    </label>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-caption text-[var(--text-secondary)] w-32 shrink-0">{label}</span>
      <code className="font-mono text-caption text-[var(--text-primary)] truncate flex-1" title={value}>{value}</code>
      <button
        type="button"
        className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        title={`Copy ${label}`}
        aria-label={`Copy ${label}`}
        onClick={() => navigator.clipboard?.writeText(value).then(() => toast('Copied', 'success'), () => toast('Copy failed', 'error'))}
      >
        <Copy className="w-4 h-4" />
      </button>
    </div>
  )
}

const tone = { ok: 'text-[var(--text-secondary)]', warn: 'text-amber-600 dark:text-amber-400', bad: 'text-red-600 dark:text-red-400' }

function SamlAdminPageBody() {
  const { data: providers, isLoading } = useSamlProviders()
  const save = useSaveSamlProvider()
  const remove = useDeleteSamlProvider()
  const test = useTestSamlProvider()
  const [form, setForm] = useState<SamlForm | null>(null)

  const set = <K extends keyof SamlForm>(k: K, v: SamlForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const draftSp = (slug: string) => ({
    entityId: `${origin}/rest/auth/1/saml/${slug || '<slug>'}/metadata`,
    acsUrl: `${origin}/rest/auth/1/saml/${slug || '<slug>'}/acs`,
    metadataUrl: `${origin}/rest/auth/1/saml/${slug || '<slug>'}/metadata`,
  })

  const submit = async () => {
    if (!form) return
    const problem = samlProblem(form)
    if (problem) return toast(problem, 'error')
    try {
      await save.mutateAsync({ id: form.id, data: samlPayload(form) })
      toast('Provider saved', 'success')
      setForm(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to save provider', 'error')
    }
  }

  const onDelete = async (p: SamlProvider) => {
    if (!(await confirmDialog(`Delete "${p.name}"? Users who signed in through it keep their accounts but can no longer use this provider.`))) return
    try {
      await remove.mutateAsync(p.id)
      toast('Provider deleted', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to delete', 'error')
    }
  }

  const onTest = async (p: SamlProvider) => {
    try {
      const r = await test.mutateAsync(p.id)
      toast(r.ok ? 'Configuration looks good' : r.problems.join('; '), r.ok ? 'success' : 'error')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Test failed', 'error')
    }
  }

  const sp = form ? draftSp(form.slug) : null

  return (
    <FeatureGate feature="sso_saml" label="SAML single sign-on" mode="banner">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-[var(--brand-500)]" />
            </div>
            <div>
              <h2 className="text-heading-2 text-[var(--text-primary)]">SAML 2.0 providers</h2>
              <p className="text-body-sm text-[var(--text-secondary)]">Entra ID, Okta, ADFS, Keycloak, Google Workspace or any SAML 2.0 identity provider (SP-initiated sign-in).</p>
            </div>
          </div>
          {!form && (
            <button className="veqsio-btn-primary flex items-center gap-1.5 shrink-0" onClick={() => setForm({ ...emptySamlForm })}>
              <Plus className="w-4 h-4" /> Add provider
            </button>
          )}
        </div>

        {form && sp && (
          <div className="veqsio-card space-y-5">
            <h3 className="text-heading-3 text-[var(--text-primary)]">{form.id ? `Edit ${form.name}` : 'New SAML provider'}</h3>

            <div className="rounded-lg bg-[var(--surface-2)] p-3 space-y-2">
              <p className="text-body-sm font-medium text-[var(--text-primary)]">Give these values to your identity provider</p>
              <CopyRow label="Entity ID (audience)" value={sp.entityId} />
              <CopyRow label="ACS URL (POST)" value={sp.acsUrl} />
              <div className="flex items-center gap-2">
                <span className="text-caption text-[var(--text-secondary)] w-32 shrink-0">SP metadata</span>
                <a className="text-caption text-[var(--brand-500)] hover:underline inline-flex items-center gap-1" href={sp.metadataUrl} target="_blank" rel="noreferrer">
                  Open metadata XML <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Display name"><input className="veqsio-input w-full" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Company SSO" /></Field>
              <Field label="Slug (cannot be changed later)"><input className="veqsio-input w-full" value={form.slug} disabled={!!form.id} onChange={(e) => set('slug', e.target.value.toLowerCase())} placeholder="company" /></Field>
              <Field label="IdP entity ID (issuer)" wide><input className="veqsio-input w-full" value={form.idpEntityId} onChange={(e) => set('idpEntityId', e.target.value)} placeholder="https://sts.windows.net/<tenant>/" /></Field>
              <Field label="IdP single sign-on URL (HTTP-Redirect)" wide><input className="veqsio-input w-full" value={form.idpSsoUrl} onChange={(e) => set('idpSsoUrl', e.target.value)} placeholder="https://login.example.com/saml2" /></Field>
              <Field label="IdP signing certificate(s), PEM. Add the next certificate too before a key rollover." wide>
                <textarea className="veqsio-input w-full font-mono text-caption h-32" spellCheck={false} value={form.idpCertificates} onChange={(e) => set('idpCertificates', e.target.value)} placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'} />
              </Field>
              <Field label="NameID format">
                <select className="veqsio-input w-full" value={form.nameIdFormat} onChange={(e) => set('nameIdFormat', e.target.value)}>
                  {NAMEID_FORMATS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
                </select>
              </Field>
              <Field label="Allowed email domains (comma separated, empty = any)"><input className="veqsio-input w-full" value={form.allowedDomains} onChange={(e) => set('allowedDomains', e.target.value)} placeholder="example.com, example.org" /></Field>
            </div>

            <div className="space-y-2 border-t border-[var(--surface-3)] pt-4">
              <h4 className="text-body-sm font-medium text-[var(--text-primary)]">Attribute mapping</h4>
              <p className="text-caption text-[var(--text-secondary)]">Leave a field empty to try the usual names (email, mail, displayName, givenName + surname, groups, memberOf and the Microsoft claim URIs).</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Email attribute"><input className="veqsio-input w-full" value={form.emailAttribute} onChange={(e) => set('emailAttribute', e.target.value)} placeholder="email" /></Field>
                <Field label="Display name attribute"><input className="veqsio-input w-full" value={form.displayNameAttribute} onChange={(e) => set('displayNameAttribute', e.target.value)} placeholder="displayName" /></Field>
                <Field label="Username attribute"><input className="veqsio-input w-full" value={form.usernameAttribute} onChange={(e) => set('usernameAttribute', e.target.value)} placeholder="uid (default: part of the email before @)" /></Field>
                <Field label="Groups attribute"><input className="veqsio-input w-full" value={form.groupsAttribute} onChange={(e) => set('groupsAttribute', e.target.value)} placeholder="groups" /></Field>
                <Field label="Default groups for new users (comma separated, existing groups only)" wide><input className="veqsio-input w-full" value={form.defaultGroups} onChange={(e) => set('defaultGroups', e.target.value)} placeholder="veqsio-users" /></Field>
              </div>
            </div>

            <div className="space-y-3 border-t border-[var(--surface-3)] pt-4">
              <Toggle label="Enabled" hint="Show the sign-in button and accept logins." checked={form.enabled} onChange={(v) => set('enabled', v)} />
              <Toggle label="Create accounts on first sign-in (JIT provisioning)" hint="Subject to the domain list and the licence seat limit." checked={form.autoProvision} onChange={(v) => set('autoProvision', v)} />
              <Toggle label="Link existing accounts by email" hint="Off by default: a matching local account is otherwise refused so nobody can take it over through the IdP." checked={form.linkByEmail} onChange={(v) => set('linkByEmail', v)} />
              <Toggle label="Synchronise groups" hint="Memberships come from the groups attribute at each sign-in. Only memberships added by this provider are ever removed." checked={form.syncGroups} onChange={(v) => set('syncGroups', v)} />
              <Toggle label="Enforce SSO for these domains" hint="Disable password login for users covered by the domain list (everyone if it is empty). System administrators stay exempt as break-glass." checked={form.enforceSso} onChange={(v) => set('enforceSso', v)} />
              <Toggle label="Sign authentication requests" hint="Only needed when the IdP requires signed AuthnRequests. The SP certificate is published in the metadata." checked={form.signRequests} onChange={(v) => set('signRequests', v)} />
            </div>

            {form.signRequests && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label={`SP private key (PEM) ${form.hasSigningKey ? '(stored encrypted, leave empty to keep)' : ''}`}>
                  <textarea className="veqsio-input w-full font-mono text-caption h-28" spellCheck={false} autoComplete="off" value={form.spSigningKey} onChange={(e) => set('spSigningKey', e.target.value)} placeholder={form.hasSigningKey ? '••••••••' : '-----BEGIN PRIVATE KEY-----'} />
                </Field>
                <Field label="SP certificate (PEM)">
                  <textarea className="veqsio-input w-full font-mono text-caption h-28" spellCheck={false} value={form.spSigningCertificate} onChange={(e) => set('spSigningCertificate', e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
                </Field>
              </div>
            )}

            <p className="text-caption text-[var(--text-secondary)]">
              To try it, save the provider and open <code className="font-mono">{origin}/rest/auth/1/saml/{form.slug || '<slug>'}/login</code> in a private window (or use the button on the sign-in page).
              A response is accepted only when it is signed by one of the certificates above, is addressed to the entity ID and ACS URL shown here, answers this request and has not been used before.
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
          <div className="text-center py-8 text-[var(--text-secondary)]">No SAML providers configured.</div>
        ) : (
          <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
            {providers.map((p) => (
              <div key={p.id} className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-body-sm font-medium text-[var(--text-primary)]">
                      {p.name} <span className="text-caption text-[var(--text-tertiary)]">({p.slug})</span>
                      {!p.enabled && <span className="ml-2 text-caption text-[var(--text-tertiary)]">disabled</span>}
                      {p.enforceSso && <span className="ml-2 text-caption text-[var(--brand-500)]">SSO enforced</span>}
                    </div>
                    <div className="text-caption text-[var(--text-secondary)] truncate">{p.idpEntityId}</div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title="Check configuration" aria-label="Check configuration" onClick={() => onTest(p)}><TestTube className="w-4 h-4" /></button>
                    <button className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title="Edit" aria-label="Edit" onClick={() => setForm(fromProvider(p))}><Pencil className="w-4 h-4" /></button>
                    <button className="p-1 text-[var(--text-tertiary)] hover:text-red-500" title="Delete" aria-label="Delete" onClick={() => onDelete(p)}><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-1">
                  <CopyRow label="Entity ID" value={p.sp.entityId} />
                  <CopyRow label="ACS URL" value={p.sp.acsUrl} />
                  {p.certificates.map((c, i) => {
                    const s = certificateStatus(c)
                    return <div key={i} className={`text-caption ${tone[s.tone]}`}>Certificate {i + 1}: {c?.subject ?? 'unreadable'} ({s.label})</div>
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </FeatureGate>
  )
}

/** Opened on its own (/admin/saml) the page needs the application layout with the administration menu; inside the admin tabs it does not. */
export default function SamlAdminPage() {
  const standalone = usePathname() === '/admin/saml'
  return standalone ? <AppLayout><SamlAdminPageBody /></AppLayout> : <SamlAdminPageBody />
}
