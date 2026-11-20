'use client'


import { useI18n } from '@/hooks/use-i18n'
import { usePathname } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { useState, useEffect } from 'react'
import { useSSOSettings, useUpdateSSOSettings } from '@/hooks/use-sso'
import { toast } from '@/components/toast'
import {
  Shield,
  Save,
  TestTube,
  ToggleLeft,
  ToggleRight,
  Eye,
  EyeOff,
  KeyRound,
  Globe,
  Link,
  Building2,
} from 'lucide-react'

function SSOAdminPageBody() {
  const { tr } = useI18n();

  const { data: settings, isLoading } = useSSOSettings()
  const updateMutation = useUpdateSSOSettings()

  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [enforceSso, setEnforceSso] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (settings) {
      setClientId(settings.clientId || '')
      setClientSecret(settings.clientSecret || '')
      setTenantId(settings.tenantId || '')
      setRedirectUri(settings.redirectUri || '')
      setEnforceSso(settings.enforceSso || false)
    }
  }, [settings])

  const handleSave = async () => {
    if (!clientId || !clientSecret || !tenantId || !redirectUri) {
      toast(tr('All fields are required'), 'error')
      return
    }

    try {
      await updateMutation.mutateAsync({
        clientId,
        clientSecret,
        tenantId,
        redirectUri,
        enforceSso,
        active: true,
      })
      toast(tr('SSO settings saved successfully'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save settings', 'error')
    }
  }

  const handleTest = async () => {
    if (!clientId || !clientSecret || !tenantId || !redirectUri) {
      toast(tr('Fill in all fields before testing'), 'warning')
      return
    }

    setTesting(true)
    try {
      await updateMutation.mutateAsync({
        clientId,
        clientSecret,
        tenantId,
        redirectUri,
        enforceSso,
        active: true,
      })

      const popup = window.open(
        '/rest/auth/1/sso/microsoft',
        'ssoTest',
        'width=600,height=700,scrollbars=yes'
      )
      if (!popup) {
        toast(tr('Popup blocked. Please allow popups for this site.'), 'error')
      } else {
        toast(tr('Test login window opened. Complete the Microsoft flow to verify.'), 'info')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Test failed', 'error')
    } finally {
      setTesting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">{tr('Loading SSO settings...')}</div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
            <Shield className="w-5 h-5 text-[var(--brand-500)]" />
          </div>
          <div>
            <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Microsoft Entra ID SSO')}</h2>
            <p className="text-body-sm text-[var(--text-secondary)]">
              {tr('Configure single sign-on with Microsoft Azure Active Directory')} </p>
          </div>
        </div>
      </div>

      <div className="veqsio-card space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <KeyRound className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('Application (Client) ID')} </label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="veqsio-input w-full"
            />
            <p className="text-caption text-[var(--text-tertiary)]">
              {tr('The client ID from your Microsoft Entra app registration.')} </p>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Building2 className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('Directory (Tenant) ID')} </label>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="veqsio-input w-full"
            />
            <p className="text-caption text-[var(--text-tertiary)]">
              {tr('Your Microsoft Entra tenant ID, or "common" for multi-tenant.')} </p>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Eye className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('Client Secret')} </label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={tr('Enter client secret value')}
                className="veqsio-input w-full pr-10"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-caption text-[var(--text-tertiary)]">
              {tr('The client secret from your app registration Certificates & secrets.')} </p>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              <Link className="w-4 h-4 text-[var(--text-tertiary)]" />
              {tr('Redirect URI')} </label>
            <input
              type="text"
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="http://localhost:3000/rest/auth/1/sso/microsoft/callback"
              className="veqsio-input w-full"
            />
            <p className="text-caption text-[var(--text-tertiary)]">
              {tr('Must match the redirect URI configured in your Microsoft app registration.')} </p>
          </div>
        </div>

        <div className="border-t border-[var(--surface-3)] pt-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center flex-shrink-0">
                <Globe className="w-5 h-5 text-[var(--brand-500)]" />
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{tr('Enforce SSO-only login')}</p>
                <p className="text-caption text-[var(--text-secondary)]">
                  {tr('When enabled, users can only sign in via Microsoft SSO. Local password login will be disabled.')} </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEnforceSso(!enforceSso)}
              className="transition-colors flex-shrink-0"
            >
              {enforceSso ? (
                <ToggleRight className="w-8 h-8 text-[var(--success)]" />
              ) : (
                <ToggleLeft className="w-8 h-8 text-[var(--text-tertiary)]" />
              )}
            </button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 pt-4">
          <button
            type="button"
            onClick={handleSave}
            disabled={updateMutation.isPending}
            className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-60"
          >
            {updateMutation.isPending ? (
              <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {tr('Save Settings')} </button>

          <button
            type="button"
            onClick={handleTest}
            disabled={testing || updateMutation.isPending}
            className="veqsio-btn-secondary flex items-center gap-2 disabled:opacity-60"
          >
            {testing ? (
              <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <TestTube className="w-4 h-4" />
            )}
            {tr('Test Connection')} </button>
        </div>
      </div>
    </div>
  )
}

/** Opened on its own (/admin/sso) the page needs the application layout with the administration menu; inside the admin tabs it does not. */
export default function SSOAdminPage() {
  const standalone = usePathname() === '/admin/sso'
  return standalone ? <AppLayout><SSOAdminPageBody /></AppLayout> : <SSOAdminPageBody />
}
