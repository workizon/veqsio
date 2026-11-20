'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
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
  const { tr } = useI18n();

  return (
    <div className="rounded-lg bg-[var(--surface-2)] p-3 space-y-2" role="status">
      <div className="text-body-sm font-medium text-[var(--text-primary)]">{title}</div>
      {!result.ok ? (
        <p className="text-caption text-red-600 dark:text-red-400">{result.error}</p>
      ) : (
        <>
          <p className="text-caption text-[var(--text-secondary)]">{result.counts?.directoryUsers ?? 0} {tr('users found in the directory.')}</p>
          <ul className="text-body-sm text-[var(--text-primary)] list-disc pl-5">
            {result.counts && syncSummary(result.counts, !result.dryRun).map((l) => <li key={l}>{l}</li>)}
          </ul>
          {result.groupsToCreate && result.groupsToCreate.length > 0 && (
            <p className="text-caption text-[var(--text-secondary)]">{tr('New groups:')} {result.groupsToCreate.slice(0, 12).join(', ')}{result.groupsToCreate.length > 12 ? ', ...' : ''}</p>
          )}
          {result.skipped && result.skipped.length > 0 && (
            <details className="text-caption text-[var(--text-secondary)]">
              <summary className="cursor-pointer">{tr('Why were')} {result.skipped.length} {tr('users skipped?')}</summary>
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
  const { tr } = useI18n();

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
      toast(tr('Directory saved'), 'success')
      setForm(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : tr('Failed to save directory'), 'error')
    }
  }

  const onTest = async (d: LdapDirectory) => {
    try {
      const r = await test.mutateAsync(d.id)
      toast(r.ok ? tr('Connected: {users} users{groups} found', { users: `${r.users}${r.truncated ? '+' : ''}`, groups: r.groups != null ? tr(', {n} groups', { n: r.groups }) : '' }) : (r.error ?? tr('Connection failed')), r.ok ? 'success' : 'error')
    } catch (e) {
      toast(e instanceof Error ? e.message : tr('Test failed'), 'error')
    }
  }

  const run = async (d: LdapDirectory, dryRun: boolean, force = false) => {
    if (!dryRun && !(await confirmDialog(tr('Run the sync of "{name}" now? Users that are no longer in the directory are deactivated (never deleted).', { name: d.name })))) return
    try {
      const r = await sync.mutateAsync({ id: d.id, dryRun, force })
      setResults((m) => ({ ...m, [d.id]: r }))
      if (!r.ok && !dryRun) toast(r.error ?? tr('Sync failed'), 'error')
      else if (!dryRun) toast(tr('Sync finished'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : tr('Sync failed'), 'error')
    }
  }

  const onDelete = async (d: LdapDirectory) => {
    if (!(await confirmDialog(tr('Delete "{name}"? Linked users keep their accounts but can no longer sign in with their directory password.', { name: d.name })))) return
    try {
      await remove.mutateAsync(d.id)
      toast(tr('Directory deleted'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : tr('Failed to delete'), 'error')
    }
  }

  return (
    <FeatureGate feature="ldap" label={tr('LDAP / Active Directory')} mode="banner">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
              <Network className="w-5 h-5 text-[var(--brand-500)]" />
            </div>
            <div>
              <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('LDAP / Active Directory')}</h2>
              <p className="text-body-sm text-[var(--text-secondary)]">{tr('Password sign-in against the directory, automatic accounts and scheduled user and group sync.')}</p>
            </div>
          </div>
          {!form && (
            <button className="veqsio-btn-primary flex items-center gap-1.5 shrink-0" onClick={() => setForm({ ...emptyLdapForm })}>
              <Plus className="w-4 h-4" /> {tr('Add directory')} </button>
          )}
        </div>

        {form && (
          <div className="veqsio-card space-y-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-heading-3 text-[var(--text-primary)]">{form.id ? tr('Edit {name}', { name: form.name }) : tr('New directory')}</h3>
              <button type="button" className="veqsio-btn-secondary text-body-sm" onClick={() => setForm((f) => (f ? activeDirectoryPreset(f) : f))}>{tr('Use Active Directory defaults')}</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label={tr('Name')}><input className="veqsio-input w-full" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={tr('Corporate directory')} /></Field>
              <Field label={tr('Server URL')}><input className="veqsio-input w-full" value={form.url} onChange={(e) => set('url', e.target.value)} placeholder={tr('ldaps://ldap.example.com:636')} /></Field>
              <Field label={tr('Service account bind DN')}><input className="veqsio-input w-full" value={form.bindDn} onChange={(e) => set('bindDn', e.target.value)} placeholder={tr('cn=veqsio,ou=services,dc=example,dc=com')} /></Field>
              <Field label={form.hasBindPassword ? tr('Bind password {note}', { note: tr('(stored encrypted, leave empty to keep)') }) : tr('Bind password {note}', { note: '' })}>
                <input className="veqsio-input w-full" type="password" autoComplete="new-password" value={form.bindPassword} onChange={(e) => set('bindPassword', e.target.value)} placeholder={form.hasBindPassword ? '••••••••' : ''} />
              </Field>
              <Field label={tr('User base DN')} wide><input className="veqsio-input w-full" value={form.baseDn} onChange={(e) => set('baseDn', e.target.value)} placeholder={tr('ou=people,dc=example,dc=com')} /></Field>
              <Field label={tr('User filter')} wide><input className="veqsio-input w-full font-mono text-caption" value={form.userFilter} onChange={(e) => set('userFilter', e.target.value)} /></Field>
              <Field label={tr('Username attribute')}><input className="veqsio-input w-full" value={form.usernameAttribute} onChange={(e) => set('usernameAttribute', e.target.value)} placeholder={tr('uid or sAMAccountName')} /></Field>
              <Field label={tr('Email attribute')}><input className="veqsio-input w-full" value={form.emailAttribute} onChange={(e) => set('emailAttribute', e.target.value)} /></Field>
              <Field label={tr('Display name attribute')}><input className="veqsio-input w-full" value={form.displayNameAttribute} onChange={(e) => set('displayNameAttribute', e.target.value)} /></Field>
              <Field label={tr('Unique ID attribute (stable key)')}><input className="veqsio-input w-full" value={form.uniqueIdAttribute} onChange={(e) => set('uniqueIdAttribute', e.target.value)} placeholder={tr('entryUUID or objectGUID')} /></Field>
            </div>

            <div className="space-y-2 border-t border-[var(--surface-3)] pt-4">
              <h4 className="text-body-sm font-medium text-[var(--text-primary)]">{tr('Groups (optional)')}</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label={tr('Group base DN (empty = no group sync)')} wide><input className="veqsio-input w-full" value={form.groupBaseDn} onChange={(e) => set('groupBaseDn', e.target.value)} placeholder={tr('ou=groups,dc=example,dc=com')} /></Field>
                <Field label={tr('Group filter')} wide><input className="veqsio-input w-full font-mono text-caption" value={form.groupFilter} onChange={(e) => set('groupFilter', e.target.value)} /></Field>
                <Field label={tr('Group name attribute')}><input className="veqsio-input w-full" value={form.groupNameAttribute} onChange={(e) => set('groupNameAttribute', e.target.value)} /></Field>
                <Field label={tr('Membership attribute')}><input className="veqsio-input w-full" value={form.groupMemberAttribute} onChange={(e) => set('groupMemberAttribute', e.target.value)} placeholder={tr('member or memberUid')} /></Field>
              </div>
              <Toggle label={tr('Resolve nested groups')} hint={tr('Members of groups inside groups count too (applied by the scheduled sync, not at sign-in).')} checked={form.nestedGroups} onChange={(v) => set('nestedGroups', v)} />
            </div>

            <div className="space-y-3 border-t border-[var(--surface-3)] pt-4">
              <Toggle label={tr('Enabled')} hint={tr('Master switch for sign-in and sync.')} checked={form.enabled} onChange={(v) => set('enabled', v)} />
              <Toggle label={tr('Allow password sign-in with directory credentials')} hint={tr('The password is checked by the directory (search, then bind as the user). Empty passwords are always refused.')} checked={form.loginEnabled} onChange={(v) => set('loginEnabled', v)} />
              <Toggle label={tr('Create accounts for directory users')} hint={tr('On first sign-in and during sync. Subject to the licence seat limit.')} checked={form.autoProvision} onChange={(v) => set('autoProvision', v)} />
              <Toggle label={tr('Link existing accounts by email')} hint={tr('Off by default. A local account with the same username is never taken over.')} checked={form.linkByEmail} onChange={(v) => set('linkByEmail', v)} />
              <Toggle label={tr('Scheduled sync')} hint={tr('Creates and updates users and group memberships on a schedule.')} checked={form.syncEnabled} onChange={(v) => set('syncEnabled', v)} />
              <Toggle label={tr('Deactivate users that disappeared from the directory')} hint={tr('They are deactivated, never deleted, and are reactivated when they come back.')} checked={form.deactivateMissing} onChange={(v) => set('deactivateMissing', v)} />
              <Toggle label={tr('Use StartTLS')} hint={tr('Upgrade a plain ldap:// connection to TLS before binding. Not with ldaps://.')} checked={form.startTls} onChange={(v) => set('startTls', v)} />
              <Toggle label={tr('Verify the server certificate')} hint={tr('Turn off only for testing with self-signed certificates.')} checked={form.tlsRejectUnauthorized} onChange={(v) => set('tlsRejectUnauthorized', v)} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label={tr('Sync interval (minutes)')}><input className="veqsio-input w-full" type="number" min={5} max={10080} value={form.syncIntervalMinutes} onChange={(e) => set('syncIntervalMinutes', Number(e.target.value))} /></Field>
              <Field label={tr('Maximum entries per search')}><input className="veqsio-input w-full" type="number" min={1} max={50000} value={form.maxEntries} onChange={(e) => set('maxEntries', Number(e.target.value))} /></Field>
              <Field label={tr('Timeout (ms)')}><input className="veqsio-input w-full" type="number" min={1000} max={60000} value={form.timeoutMs} onChange={(e) => set('timeoutMs', Number(e.target.value))} /></Field>
            </div>
            <div className="flex justify-end gap-2">
              <button className="veqsio-btn-secondary" onClick={() => setForm(null)}>{tr('Cancel')}</button>
              <button className="veqsio-btn-primary" disabled={save.isPending} onClick={submit}>{tr('Save')}</button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="text-center py-8 text-[var(--text-secondary)]">{tr('Loading directories...')}</div>
        ) : !dirs?.length ? (
          <div className="text-center py-8 text-[var(--text-secondary)]">{tr('No directories configured.')}</div>
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
                        {!d.enabled && <span className="ml-2 text-caption text-[var(--text-tertiary)]">{tr('disabled')}</span>}
                        {d.syncEnabled && <span className="ml-2 text-caption text-[var(--brand-500)]">{tr('sync every')} {d.syncIntervalMinutes} {tr('min')}</span>}
                        {d.syncRunning && <span className="ml-2 text-caption text-amber-600 dark:text-amber-400">{tr('sync running')}</span>}
                      </div>
                      <div className="text-caption text-[var(--text-secondary)] truncate">{d.url} · {d.baseDn}</div>
                      <div className="text-caption text-[var(--text-tertiary)]">{d.lastSyncAt ? tr('Last sync {date}', { date: new Date(d.lastSyncAt).toLocaleString(getIntlLocale()) }) : tr('Never synced')}</div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button className="veqsio-btn-secondary text-body-sm flex items-center gap-1.5" onClick={() => onTest(d)}><TestTube className="w-4 h-4" /> {tr('Test connection')}</button>
                      <button className="veqsio-btn-secondary text-body-sm flex items-center gap-1.5" onClick={() => run(d, true)}><Eye className="w-4 h-4" /> {tr('Preview sync')}</button>
                      <button className="veqsio-btn-secondary text-body-sm flex items-center gap-1.5" onClick={() => run(d, false)}><RefreshCw className="w-4 h-4" /> {tr('Sync now')}</button>
                      <button className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title={tr('Edit')} aria-label={tr('Edit')} onClick={() => setForm(fromDirectory(d))}><Pencil className="w-4 h-4" /></button>
                      <button className="p-1 text-[var(--text-tertiary)] hover:text-red-500" title={tr('Delete')} aria-label={tr('Delete')} onClick={() => onDelete(d)}><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                  {shown && <SyncPanel result={shown} title={shown.dryRun ? tr('Preview (nothing was changed)') : tr('Last sync result, {date}', { date: new Date(shown.at).toLocaleString(getIntlLocale()) })} />}
                  {shown && !shown.ok && !shown.dryRun && shown.error?.includes('force') && (
                    <button className="veqsio-btn-secondary text-body-sm" onClick={() => run(d, false, true)}>{tr('Run anyway (force)')}</button>
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
