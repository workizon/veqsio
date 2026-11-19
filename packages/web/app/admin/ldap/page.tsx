'use client'

import { usePathname } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { useState } from 'react'
import { Network, Plus, Trash2, Pencil, TestTube, RefreshCw, Eye } from 'lucide-react'
import { toast } from '@/components/toast'
import { FeatureGate } from '@/components/feature-gate'
import {
  useLdapDirectories, useSaveLdapDirectory, useDeleteLdapDirectory, useTestLdapDirectory, useSyncLdapDirectory, type LdapDirectory, type SyncResult,
} from '@/hooks/use-ldap'
import { activeDirectoryPreset, emptyLdapForm, ldapPayload, ldapProblem, skipReason, syncSummary, type LdapForm } from '@/lib/sso-forms'
import { confirmDialog } from '@/components/dialogs'

function fromDirectory(d: LdapDirectory): LdapForm {
  return {
    id: d.id, name: d.name, url: d.url, startTls: d.startTls, tlsRejectUnauthorized: d.tlsRejectUnauthorized, bindDn: d.bindDn, bindPassword: '',
    hasBindPassword: d.hasBindPassword, baseDn: d.baseDn, userFilter: d.userFilter, usernameAttribute: d.usernameAttribute, emailAttribute: d.emailAttribute,
    displayNameAttribute: d.displayNameAttribute, uniqueIdAttribute: d.uniqueIdAttribute, groupBaseDn: d.groupBaseDn ?? '', groupFilter: d.groupFilter,
    groupNameAttribute: d.groupNameAttribute, groupMemberAttribute: d.groupMemberAttribute, nestedGroups: d.nestedGroups, loginEnabled: d.loginEnabled,
    autoProvision: d.autoProvision, linkByEmail: d.linkByEmail, syncEnabled: d.syncEnabled, syncIntervalMinutes: d.syncIntervalMinutes,
    deactivateMissing: d.deactivateMissing, maxEntries: d.maxEntries, timeoutMs: d.timeoutMs, enabled: d.enabled,
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

function SyncPanel({ result, title }: { result: SyncResult; title: string }) {
  return (
    <div className="rounded-lg bg-[var(--surface-2)] p-3 space-y-2" role="status">
      <div className="text-body-sm font-medium text-[var(--text-primary)]">{title}</div>
      {!result.ok ? (
        <p className="text-caption text-red-600 dark:text-red-400">{result.error}</p>
      ) : (
        <>
          <p className="text-caption text-[var(--text-secondary)]">{result.counts?.directoryUsers ?? 0} users found in the directory.</p>
          <ul className="text-body-sm text-[var(--text-primary)] list-disc pl-5">
            {result.counts && syncSummary(result.counts, !result.dryRun).map((l) => <li key={l}>{l}</li>)}
          </ul>
          {result.groupsToCreate && result.groupsToCreate.length > 0 && (
            <p className="text-caption text-[var(--text-secondary)]">New groups: {result.groupsToCreate.slice(0, 12).join(', ')}{result.groupsToCreate.length > 12 ? ', ...' : ''}</p>
          )}
          {result.skipped && result.skipped.length > 0 && (
            <details className="text-caption text-[var(--text-secondary)]">
              <summary className="cursor-pointer">Why were {result.skipped.length} users skipped?</summary>
              <ul className="list-disc pl-5 mt-1">
                {result.skipped.slice(0, 20).map((s) => <li key={s.key}><code className="font-mono">{s.key}</code>: {skipReason(s.reason)}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}

function LdapAdminPageBody() {
  const { data: dirs, isLoading } = useLdapDirectories()
  const save = useSaveLdapDirectory()
  const remove = useDeleteLdapDirectory()
  const test = useTestLdapDirectory()
  const sync = useSyncLdapDirectory()
  const [form, setForm] = useState<LdapForm | null>(null)
  const [results, setResults] = useState<Record<number, SyncResult>>({})

  const set = <K extends keyof LdapForm>(k: K, v: LdapForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  const submit = async () => {
    if (!form) return
    const problem = ldapProblem(form)
    if (problem) return toast(problem, 'error')
    try {
      await save.mutateAsync({ id: form.id, data: ldapPayload(form) })
      toast('Directory saved', 'success')
      setForm(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to save directory', 'error')
    }
  }

  const onTest = async (d: LdapDirectory) => {
    try {
      const r = await test.mutateAsync(d.id)
      toast(r.ok ? `Connected: ${r.users}${r.truncated ? '+' : ''} users${r.groups != null ? `, ${r.groups} groups` : ''} found` : (r.error ?? 'Connection failed'), r.ok ? 'success' : 'error')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Test failed', 'error')
    }
  }

  const run = async (d: LdapDirectory, dryRun: boolean, force = false) => {
    if (!dryRun && !(await confirmDialog(`Run the sync of "${d.name}" now? Users that are no longer in the directory are deactivated (never deleted).`))) return
    try {
      const r = await sync.mutateAsync({ id: d.id, dryRun, force })
      setResults((m) => ({ ...m, [d.id]: r }))
      if (!r.ok && !dryRun) toast(r.error ?? 'Sync failed', 'error')
      else if (!dryRun) toast('Sync finished', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Sync failed', 'error')
    }
  }

  const onDelete = async (d: LdapDirectory) => {
    if (!(await confirmDialog(`Delete "${d.name}"? Linked users keep their accounts but can no longer sign in with their directory password.`))) return
    try {
      await remove.mutateAsync(d.id)
      toast('Directory deleted', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to delete', 'error')
    }
  }

  return (
    <FeatureGate feature="ldap" label="LDAP / Active Directory" mode="banner">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
              <Network className="w-5 h-5 text-[var(--brand-500)]" />
            </div>
            <div>
              <h2 className="text-heading-2 text-[var(--text-primary)]">LDAP / Active Directory</h2>
              <p className="text-body-sm text-[var(--text-secondary)]">Password sign-in against the directory, automatic accounts and scheduled user and group sync.</p>
            </div>
          </div>
          {!form && (
            <button className="veqsio-btn-primary flex items-center gap-1.5 shrink-0" onClick={() => setForm({ ...emptyLdapForm })}>
              <Plus className="w-4 h-4" /> Add directory
            </button>
          )}
        </div>

        {form && (
          <div className="veqsio-card space-y-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-heading-3 text-[var(--text-primary)]">{form.id ? `Edit ${form.name}` : 'New directory'}</h3>
              <button type="button" className="veqsio-btn-secondary text-body-sm" onClick={() => setForm((f) => (f ? activeDirectoryPreset(f) : f))}>Use Active Directory defaults</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Name"><input className="veqsio-input w-full" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Corporate directory" /></Field>
              <Field label="Server URL"><input className="veqsio-input w-full" value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="ldaps://ldap.example.com:636" /></Field>
              <Field label="Service account bind DN"><input className="veqsio-input w-full" value={form.bindDn} onChange={(e) => set('bindDn', e.target.value)} placeholder="cn=veqsio,ou=services,dc=example,dc=com" /></Field>
              <Field label={`Bind password ${form.hasBindPassword ? '(stored encrypted, leave empty to keep)' : ''}`}>
                <input className="veqsio-input w-full" type="password" autoComplete="new-password" value={form.bindPassword} onChange={(e) => set('bindPassword', e.target.value)} placeholder={form.hasBindPassword ? '••••••••' : ''} />
              </Field>
              <Field label="User base DN" wide><input className="veqsio-input w-full" value={form.baseDn} onChange={(e) => set('baseDn', e.target.value)} placeholder="ou=people,dc=example,dc=com" /></Field>
              <Field label="User filter" wide><input className="veqsio-input w-full font-mono text-caption" value={form.userFilter} onChange={(e) => set('userFilter', e.target.value)} /></Field>
              <Field label="Username attribute"><input className="veqsio-input w-full" value={form.usernameAttribute} onChange={(e) => set('usernameAttribute', e.target.value)} placeholder="uid or sAMAccountName" /></Field>
              <Field label="Email attribute"><input className="veqsio-input w-full" value={form.emailAttribute} onChange={(e) => set('emailAttribute', e.target.value)} /></Field>
              <Field label="Display name attribute"><input className="veqsio-input w-full" value={form.displayNameAttribute} onChange={(e) => set('displayNameAttribute', e.target.value)} /></Field>
              <Field label="Unique ID attribute (stable key)"><input className="veqsio-input w-full" value={form.uniqueIdAttribute} onChange={(e) => set('uniqueIdAttribute', e.target.value)} placeholder="entryUUID or objectGUID" /></Field>
            </div>

            <div className="space-y-2 border-t border-[var(--surface-3)] pt-4">
              <h4 className="text-body-sm font-medium text-[var(--text-primary)]">Groups (optional)</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Group base DN (empty = no group sync)" wide><input className="veqsio-input w-full" value={form.groupBaseDn} onChange={(e) => set('groupBaseDn', e.target.value)} placeholder="ou=groups,dc=example,dc=com" /></Field>
                <Field label="Group filter" wide><input className="veqsio-input w-full font-mono text-caption" value={form.groupFilter} onChange={(e) => set('groupFilter', e.target.value)} /></Field>
                <Field label="Group name attribute"><input className="veqsio-input w-full" value={form.groupNameAttribute} onChange={(e) => set('groupNameAttribute', e.target.value)} /></Field>
                <Field label="Membership attribute"><input className="veqsio-input w-full" value={form.groupMemberAttribute} onChange={(e) => set('groupMemberAttribute', e.target.value)} placeholder="member or memberUid" /></Field>
              </div>
              <Toggle label="Resolve nested groups" hint="Members of groups inside groups count too (applied by the scheduled sync, not at sign-in)." checked={form.nestedGroups} onChange={(v) => set('nestedGroups', v)} />
            </div>

            <div className="space-y-3 border-t border-[var(--surface-3)] pt-4">
              <Toggle label="Enabled" hint="Master switch for sign-in and sync." checked={form.enabled} onChange={(v) => set('enabled', v)} />
              <Toggle label="Allow password sign-in with directory credentials" hint="The password is checked by the directory (search, then bind as the user). Empty passwords are always refused." checked={form.loginEnabled} onChange={(v) => set('loginEnabled', v)} />
              <Toggle label="Create accounts for directory users" hint="On first sign-in and during sync. Subject to the licence seat limit." checked={form.autoProvision} onChange={(v) => set('autoProvision', v)} />
              <Toggle label="Link existing accounts by email" hint="Off by default. A local account with the same username is never taken over." checked={form.linkByEmail} onChange={(v) => set('linkByEmail', v)} />
              <Toggle label="Scheduled sync" hint="Creates and updates users and group memberships on a schedule." checked={form.syncEnabled} onChange={(v) => set('syncEnabled', v)} />
              <Toggle label="Deactivate users that disappeared from the directory" hint="They are deactivated, never deleted, and are reactivated when they come back." checked={form.deactivateMissing} onChange={(v) => set('deactivateMissing', v)} />
              <Toggle label="Use StartTLS" hint="Upgrade a plain ldap:// connection to TLS before binding. Not with ldaps://." checked={form.startTls} onChange={(v) => set('startTls', v)} />
              <Toggle label="Verify the server certificate" hint="Turn off only for testing with self-signed certificates." checked={form.tlsRejectUnauthorized} onChange={(v) => set('tlsRejectUnauthorized', v)} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Sync interval (minutes)"><input className="veqsio-input w-full" type="number" min={5} max={10080} value={form.syncIntervalMinutes} onChange={(e) => set('syncIntervalMinutes', Number(e.target.value))} /></Field>
              <Field label="Maximum entries per search"><input className="veqsio-input w-full" type="number" min={1} max={50000} value={form.maxEntries} onChange={(e) => set('maxEntries', Number(e.target.value))} /></Field>
              <Field label="Timeout (ms)"><input className="veqsio-input w-full" type="number" min={1000} max={60000} value={form.timeoutMs} onChange={(e) => set('timeoutMs', Number(e.target.value))} /></Field>
            </div>
            <div className="flex justify-end gap-2">
              <button className="veqsio-btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="veqsio-btn-primary" disabled={save.isPending} onClick={submit}>Save</button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="text-center py-8 text-[var(--text-secondary)]">Loading directories...</div>
        ) : !dirs?.length ? (
          <div className="text-center py-8 text-[var(--text-secondary)]">No directories configured.</div>
        ) : (
          <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
            {dirs.map((d) => {
              const shown = results[d.id] ?? d.lastSyncResult ?? null
              return (
                <div key={d.id} className="px-4 py-3 space-y-3">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-body-sm font-medium text-[var(--text-primary)]">
                        {d.name}
                        {!d.enabled && <span className="ml-2 text-caption text-[var(--text-tertiary)]">disabled</span>}
                        {d.syncEnabled && <span className="ml-2 text-caption text-[var(--brand-500)]">sync every {d.syncIntervalMinutes} min</span>}
                        {d.syncRunning && <span className="ml-2 text-caption text-amber-600 dark:text-amber-400">sync running</span>}
                      </div>
                      <div className="text-caption text-[var(--text-secondary)] truncate">{d.url} · {d.baseDn}</div>
                      <div className="text-caption text-[var(--text-tertiary)]">{d.lastSyncAt ? `Last sync ${new Date(d.lastSyncAt).toLocaleString()}` : 'Never synced'}</div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button className="veqsio-btn-secondary text-body-sm flex items-center gap-1.5" onClick={() => onTest(d)}><TestTube className="w-4 h-4" /> Test connection</button>
                      <button className="veqsio-btn-secondary text-body-sm flex items-center gap-1.5" onClick={() => run(d, true)}><Eye className="w-4 h-4" /> Preview sync</button>
                      <button className="veqsio-btn-secondary text-body-sm flex items-center gap-1.5" onClick={() => run(d, false)}><RefreshCw className="w-4 h-4" /> Sync now</button>
                      <button className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title="Edit" aria-label="Edit" onClick={() => setForm(fromDirectory(d))}><Pencil className="w-4 h-4" /></button>
                      <button className="p-1 text-[var(--text-tertiary)] hover:text-red-500" title="Delete" aria-label="Delete" onClick={() => onDelete(d)}><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                  {shown && <SyncPanel result={shown} title={shown.dryRun ? 'Preview (nothing was changed)' : `Last sync result, ${new Date(shown.at).toLocaleString()}`} />}
                  {shown && !shown.ok && !shown.dryRun && shown.error?.includes('force') && (
                    <button className="veqsio-btn-secondary text-body-sm" onClick={() => run(d, false, true)}>Run anyway (force)</button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </FeatureGate>
  )
}

/** Opened on its own (/admin/ldap) the page needs the application layout with the administration menu; inside the admin tabs it does not. */
export default function LdapAdminPage() {
  const standalone = usePathname() === '/admin/ldap'
  return standalone ? <AppLayout><LdapAdminPageBody /></AppLayout> : <LdapAdminPageBody />
}
