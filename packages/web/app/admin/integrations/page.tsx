'use client'

import { AppLayout } from '@/components/app-layout'
import { NotificationChannelsPanel } from '@/components/integrations/notification-channels-panel'

/** Instance default Slack / Teams channels. Inbound webhook sources and project channels live in each project's settings. */
export default function AdminIntegrationsPage() {
  return (
    <AppLayout>
      <div className=" space-y-4">
        <h1 className="text-heading-1">Integrations</h1>
        <h2 className="text-heading-3">Default chat channels</h2>
        <NotificationChannelsPanel scope={{}} />
      </div>
    </AppLayout>
  )
}
