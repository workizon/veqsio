'use client'


import { useI18n } from '@/hooks/use-i18n'
import { PageHeader } from '@/components/page-header'
import { AppLayout } from '@/components/app-layout'
import { Tabs } from '@/components/tabs'
import { NotificationSchemeEditor } from '@/components/notification-scheme-editor'
import { WebhookManager } from '@/components/webhook-manager'
import { WebhookLogs } from '@/components/webhook-logs'

export default function AdminNotificationsPage() {
  const { tr } = useI18n();

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader title={tr('Notifications and webhooks')} description={tr('Manage notification schemes, webhooks and delivery settings.')} />

        <Tabs
          tabs={[
            {
              id: 'schemes',
              label: tr('Notification Schemes'),
              content: <NotificationSchemeEditor />,
            },
            {
              id: 'webhooks',
              label: tr('Webhooks'),
              content: (
                <div className="space-y-6">
                  <WebhookManager />
                  <div>
                    <h3 className="text-heading-3 text-[var(--text-primary)] mb-4">
                      {tr('Delivery Logs')} </h3>
                    <WebhookLogs />
                  </div>
                </div>
              ),
            },
          ]}
        />
      </div>
    </AppLayout>
  )
}
