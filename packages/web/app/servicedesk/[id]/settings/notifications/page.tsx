'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useDeskNotificationSettings, useUpdateDeskNotificationSettings, type DeskNotificationSettings } from '@/hooks/use-servicedesk-comms'
import { useDesk } from '@/hooks/use-servicedesk-admin'

/** Project settings > Notifications: what the customer is emailed, plus what the desk sends internally. */
export default function DeskNotificationsPage() {
  const id = Number(useParams<{ id: string }>().id)
  const settings = useDeskNotificationSettings(id)
  const update = useUpdateDeskNotificationSettings(id)
  const desk = useDesk(id)
  const isAdmin = desk.data?.role === 'admin'

  const toggle = async (patch: Partial<DeskNotificationSettings>) => {
    try { await update.mutateAsync(patch) } catch (e) { toast((e as Error).message, 'error') }
  }

  const row = (key: keyof DeskNotificationSettings, title: string, help: string) => (
    <li className="flex items-start justify-between gap-4 py-3">
      <div>
        <p id={`${key}-l`} className="font-medium">{title}</p>
        <p id={`${key}-d`} className="text-[var(--text-secondary)]">{help}</p>
      </div>
      <button
        type="button" role="switch" aria-checked={!!settings.data?.[key]} aria-labelledby={`${key}-l`} aria-describedby={`${key}-d`}
        disabled={!isAdmin || update.isPending || !settings.data} onClick={() => toggle({ [key]: !settings.data?.[key] })}
        className={`relative mt-1 h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-400)] disabled:opacity-50 ${settings.data?.[key] ? 'bg-[var(--brand-500)] border-[var(--brand-500)]' : 'bg-[var(--surface-3)] border-[var(--surface-4)]'}`}
      >
        <span aria-hidden className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.data?.[key] ? 'translate-x-5' : ''}`} />
        <span className="sr-only">{settings.data?.[key] ? 'On' : 'Off'}</span>
      </button>
    </li>
  )

  return (
    <div className="space-y-4 max-w-2xl">
      <section className="veqsio-card p-5 space-y-2" aria-labelledby="cust-h">
        <h2 id="cust-h" className="text-heading-2">Customer emails</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Emails go to the requester and the request participants, are threaded per request, and link to the portal. Internal comments are never sent.
          Nothing is sent while no mail server is configured under System settings.
          {!isAdmin && ' Only desk administrators can change these switches.'}
        </p>
        {settings.isLoading && <Spinner />}
        {settings.isError && <p role="alert" className="text-sm text-[var(--error)]">Could not load the settings.</p>}
        {settings.data && (
          <ul className="divide-y divide-[var(--surface-3)] text-sm">
            {row('notifyCustomerComments', 'Agent replies', 'Email the customer when an agent adds a public comment.')}
            {row('notifyCustomerStatus', 'Status changes', 'Email the customer when the request moves to another status (with the transition comment, if any).')}
          </ul>
        )}
      </section>

      <section className="veqsio-card p-5 space-y-3 text-sm" aria-labelledby="int-h">
        <h2 id="int-h" className="text-heading-2">Always on</h2>
        <ul className="space-y-3">
          <li><strong>SLA breach</strong><br /><span className="text-[var(--text-secondary)]">An email goes out once per request and SLA when a goal is breached, and the <code>sla.breached</code> webhook fires. Goals are set under <Link className="text-[var(--brand-500)] hover:underline" href={`/servicedesk/${id}/sla`}>SLAs</Link>.</span></li>
          <li><strong>Issue notifications</strong><br /><span className="text-[var(--text-secondary)]">Assignees and watchers are notified through the project&apos;s notification scheme, like any other project. Customers only get the emails above.</span></li>
          <li><strong>Inbound email</strong><br /><span className="text-[var(--text-secondary)]">Gateway endpoint and mailbox polling are configured under <Link className="text-[var(--brand-500)] hover:underline" href={`/servicedesk/${id}/email`}>Email channel</Link>.</span></li>
        </ul>
      </section>
    </div>
  )
}
