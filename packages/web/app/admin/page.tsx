'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AdminSearch } from '@/components/admin/admin-search'

import { PluginPanels } from '@/components/plugin-panel'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { UserManager } from '@/components/user-manager'
import { GroupManager } from '@/components/group-manager'
import { PermissionSchemeEditor } from '@/components/permission-scheme-editor'
import { IssueTypeSchemeEditor } from '@/components/issue-type-scheme-editor'
import { ScreenSchemeEditor } from '@/components/screen-scheme-editor'
import { FieldConfigurationEditor } from '@/components/field-configuration-editor'
import { WorkflowSchemeEditor } from '@/components/workflow-scheme-editor'
import { ProjectRoleEditor } from '@/components/project-role-editor'
import { CustomFieldEditor } from '@/components/custom-field-editor'
import { AuditLog } from '@/components/audit-log'
import { ApplicationLinksEditor } from '@/components/application-links-editor'
import SSOAdminPage from './sso/page'
import OidcAdminPage from './oidc/page'
import ScimAdminPage from './scim/page'
import SamlAdminPage from './saml/page'
import LdapAdminPage from './ldap/page'
import CsvImportPage from './import/page'
import { useServerInfo } from '@/hooks/use-admin'
import { useActiveModules } from '@/hooks/use-modules'
import { useFeatures } from '@/hooks/use-features'
import { adminSections } from '@/lib/admin-nav'
import {
  Server,
  Clock,
  Database,
  Activity,
  Users,
  FolderKanban,
  Shield,
  Tag,
  Monitor,
  SlidersHorizontal,
  Workflow,
  Puzzle,
  ClipboardList,
  Link2,
  Upload,
} from 'lucide-react'

function SystemInfoTab() {
  const { tr } = useI18n();

  const { data, isLoading } = useServerInfo()

  if (isLoading || !data) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        {tr('Loading system information...')} </div>
    )
  }

  const uptimeSeconds = Math.floor(data.uptime)
  const days = Math.floor(uptimeSeconds / 86400)
  const hours = Math.floor((uptimeSeconds % 86400) / 3600)
  const minutes = Math.floor((uptimeSeconds % 3600) / 60)
  const uptimeText =
    days > 0
      ? `${days}d ${hours}h ${minutes}m`
      : hours > 0
        ? `${hours}h ${minutes}m`
        : `${minutes}m`

  const infoCards = [
    {
      icon: Server,
      label: tr('Version'),
      value: data.version,
      color: 'text-[var(--brand-500)]',
    },
    {
      icon: Clock,
      label: tr('Uptime'),
      value: uptimeText,
      color: 'text-[var(--success)]',
    },
    {
      icon: Database,
      label: tr('Database'),
      value: data.dbStatus === 'connected' ? tr('Connected') : tr('Disconnected'),
      color: data.dbStatus === 'connected' ? 'text-[var(--success)]' : 'text-[var(--error)]',
    },
    {
      icon: Activity,
      label: tr('Issues'),
      value: String(data.stats.issues),
      color: 'text-[var(--info)]',
    },
    {
      icon: FolderKanban,
      label: tr('Projects'),
      value: String(data.stats.projects),
      color: 'text-[var(--warning)]',
    },
    {
      icon: Users,
      label: tr('Users'),
      value: String(data.stats.users),
      color: 'text-[var(--brand-500)]',
    },
  ]

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {infoCards.map((card) => (
          <div key={card.label} className="veqsio-card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
                <card.icon className={`w-5 h-5 ${card.color}`} />
              </div>
              <div>
                <p className="text-caption text-[var(--text-tertiary)]">{card.label}</p>
                <p className="text-display text-[var(--text-primary)]">{card.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="veqsio-card space-y-3">
        <h3 className="text-heading-2 text-[var(--text-primary)]">{tr('Server Details')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="flex justify-between py-2 border-b border-[var(--surface-3)]">
            <span className="text-[var(--text-secondary)]">{tr('Base URL')}</span>
            <span className="text-[var(--text-primary)] font-mono">{data.baseUrl}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--surface-3)]">
            <span className="text-[var(--text-secondary)]">{tr('Server Title')}</span>
            <span className="text-[var(--text-primary)]">{data.serverTitle}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--surface-3)]">
            <span className="text-[var(--text-secondary)]">{tr('Build date')}</span>
            <span className="text-[var(--text-primary)]">{data.buildDate}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--surface-3)]">
            <span className="text-[var(--text-secondary)]">{tr('Server Time')}</span>
            <span className="text-[var(--text-primary)] font-mono">
              {new Date(data.serverTime).toLocaleString(getIntlLocale())}
            </span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--surface-3)]">
            <span className="text-[var(--text-secondary)]">{tr('Start time')}</span>
            <span className="text-[var(--text-primary)] font-mono">
              {new Date(data.startTime).toLocaleString(getIntlLocale())}
            </span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--surface-3)]">
            <span className="text-[var(--text-secondary)]">{tr('SCM Info')}</span>
            <span className="text-[var(--text-primary)]">{data.scmInfo}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function AdminHub() {
  const { tr } = useI18n();

  const { data: modules = [] } = useActiveModules()
  const { isEnabled } = useFeatures()
  const sections = adminSections(modules.flatMap((m) => m.web.adminPages.map((a) => ({ label: a.title, href: `/m/${m.id}/${a.path}`, hint: a.description }))))
  return (
    <div className="space-y-6">
      <PageHeader title={tr('Administration')} description={tr('Everything an administrator can configure, grouped by what it is about. Use the menu or search.')} />
      <AdminSearch />
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {sections.map((s) => (
          <section key={s.id} aria-labelledby={`adm-${s.id}`} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-4">
            <h2 id={`adm-${s.id}`} className="text-heading-3 text-[var(--text-primary)]">{tr(s.title)}</h2>
            <p className="text-body-sm text-[var(--text-secondary)] mb-2">{tr(s.description)}</p>
            <ul className="space-y-0.5">
              {s.items.filter((i) => isEnabled(i.feature)).map((i) => (
                <li key={i.href}><Link href={i.href} className="block rounded px-2 py-1 text-sm text-[var(--brand-600)] hover:bg-[var(--surface-2)]">{tr(i.label)}{i.hint && <span className="ml-2 text-caption text-[var(--text-tertiary)]">{tr(i.hint)}</span>}</Link></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <PluginPanels location="admin.page" context={{}} />
    </div>
  )
}

function AdminPageInner() {
  const { tr } = useI18n();

  const params = useSearchParams()
  const tab = params.get('tab')
  if (!tab) return <AppLayout><AdminHub /></AppLayout>
  const tabs = [
            { id: 'users', label: tr('Users'), content: <UserManager /> },
            { id: 'groups', label: tr('Groups'), content: <GroupManager /> },
            {
              id: 'permissions',
              label: tr('Permission Schemes'),
              content: <PermissionSchemeEditor />,
            },
            {
              id: 'issue-types',
              label: tr('Issue Type Schemes'),
              content: <IssueTypeSchemeEditor />,
              icon: <Tag className="w-4 h-4" />,
            },
            {
              id: 'screens',
              label: tr('Screens'),
              content: <ScreenSchemeEditor />,
              icon: <Monitor className="w-4 h-4" />,
            },
            {
              id: 'field-configs',
              label: tr('Field Configs'),
              content: <FieldConfigurationEditor />,
              icon: <SlidersHorizontal className="w-4 h-4" />,
            },
            {
              id: 'workflows',
              label: tr('Workflow Schemes'),
              content: <WorkflowSchemeEditor />,
              icon: <Workflow className="w-4 h-4" />,
            },
            {
              id: 'roles',
              label: tr('Project Roles'),
              content: <ProjectRoleEditor />,
              icon: <Users className="w-4 h-4" />,
            },
            {
              id: 'custom-fields',
              label: tr('Custom Fields'),
              content: <CustomFieldEditor />,
              icon: <Puzzle className="w-4 h-4" />,
            },
            {
              id: 'audit',
              label: tr('Audit Log'),
              content: <AuditLog />,
              icon: <ClipboardList className="w-4 h-4" />,
            },
            { id: 'sso', label: tr('SSO'), content: <SSOAdminPage />, icon: <Shield className="w-4 h-4" /> },
            { id: 'oidc', label: tr('OIDC'), content: <OidcAdminPage />, icon: <Shield className="w-4 h-4" /> },
            { id: 'saml', label: tr('SAML'), content: <SamlAdminPage />, icon: <Shield className="w-4 h-4" /> },
            { id: 'ldap', label: tr('LDAP'), content: <LdapAdminPage />, icon: <Users className="w-4 h-4" /> },
            { id: 'scim', label: tr('SCIM'), content: <ScimAdminPage />, icon: <Users className="w-4 h-4" /> },
            { id: 'apps', label: tr('Application Links'), content: <ApplicationLinksEditor />, icon: <Link2 className="w-4 h-4" /> },
            { id: 'import', label: tr('CSV Import'), content: <CsvImportPage />, icon: <Upload className="w-4 h-4" /> },
            { id: 'info', label: tr('System Info'), content: <SystemInfoTab /> },
  ]
  const current = tabs.find((t) => t.id === tab)
  return (
    <AppLayout>
      <div className="space-y-6">
        <h1 className="text-heading-1 text-[var(--text-primary)]">{current?.label ?? tr('Administration')}</h1>
        {current ? current.content : <p className="text-[var(--text-secondary)]">{tr('This page does not exist.')} <Link className="text-[var(--brand-600)] hover:underline" href="/admin">{tr('Back to administration')}</Link></p>}
      </div>
    </AppLayout>
  )
}

export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <AdminPageInner />
    </Suspense>
  )
}
