'use client'


import { useI18n } from '@/hooks/use-i18n'
import { AppLayout } from '@/components/app-layout'
import { NotificationChannelsPanel } from '@/components/integrations/notification-channels-panel'

/** Instance default Slack / Teams channels. Inbound webhook sources and project channels live in each project's settings. */
export default function AdminIntegrationsPage() {
  const { tr } = useI18n();

  return (
    <AppLayout>
      <div className=" space-y-4">
        <h1 className="text-heading-1">{tr('Integrations')}</h1>
        <h2 className="text-heading-3">{tr('Default chat channels')}</h2>
        <NotificationChannelsPanel scope={{}} />
      </div>
    </AppLayout>
  )
}
