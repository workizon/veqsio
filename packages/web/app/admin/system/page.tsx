'use client'

import { AppLayout } from '@/components/app-layout'
import { usePublicSettings } from '@/hooks/use-instance-settings'
import { PageHeader } from '@/components/page-header'
import { Tabs } from '@/components/tabs'
import { SystemGeneralConfig } from '@/components/system-general-config'
import { UserManager } from '@/components/user-manager'
import { GroupManager } from '@/components/group-manager'
import { SystemLicenseBilling } from '@/components/system-license-billing'
import { SystemBackupRestore } from '@/components/system-backup-restore'
import { AuditLog } from '@/components/audit-log'
import { SystemMailServer } from '@/components/system-mail-server'
import {
  Settings,
  Users,
  Group,
  CreditCard,
  Archive,
  ClipboardList,
  Mail,
} from 'lucide-react'

export default function AdminSystemPage() {
  const cloud = !!usePublicSettings().data?.cloud
  // managed tenant: licence, backup and mail server belong to the platform (the API refuses writes there too)
  const selfHostOnly = new Set(['license', 'backup', 'mail'])
  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader title="System administration" description={<>Configure global system settings, users, groups, and infrastructure.{' '} {!cloud && <><a href="/admin/health" className="text-[var(--brand-500)] hover:underline">Run a configuration health check</a>{' · '} </>}<a href="/admin/audit" className="text-[var(--brand-500)] hover:underline">Admin audit log</a>{' · '} <a href="/admin/ai" className="text-[var(--brand-500)] hover:underline">AI assist</a>{' · '} <a href="/admin/plugins" className="text-[var(--brand-500)] hover:underline">Manage plugins</a>{' · '} <a href="/admin/license" className="text-[var(--brand-500)] hover:underline">Licence</a></>} />

        <Tabs
          tabs={([
            {
              id: 'general',
              label: 'General',
              content: <SystemGeneralConfig />,
              icon: <Settings className="w-4 h-4" />,
            },
            {
              id: 'users',
              label: 'Users',
              content: <UserManager />,
              icon: <Users className="w-4 h-4" />,
            },
            {
              id: 'groups',
              label: 'Groups',
              content: <GroupManager />,
              icon: <Group className="w-4 h-4" />,
            },
            {
              id: 'license',
              label: 'License',
              content: <SystemLicenseBilling />,
              icon: <CreditCard className="w-4 h-4" />,
            },
            {
              id: 'backup',
              label: 'Backup',
              content: <SystemBackupRestore />,
              icon: <Archive className="w-4 h-4" />,
            },
            {
              id: 'audit',
              label: 'Audit Log',
              content: <AuditLog />,
              icon: <ClipboardList className="w-4 h-4" />,
            },
            {
              id: 'mail',
              label: 'Mail Server',
              content: <SystemMailServer />,
              icon: <Mail className="w-4 h-4" />,
            },
          ]).filter((t) => !(cloud && selfHostOnly.has(t.id)))}
          defaultTab="general"
        />
      </div>
    </AppLayout>
  )
}
