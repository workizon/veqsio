'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'
import { useDesk } from '@/hooks/use-servicedesk-admin'

interface NavItem { label: string; href: string; match: 'exact' | 'prefix' }

/** Project settings sub-navigation, modelled on Jira Service Management. SLAs and Calendars are built on their own pages. */
function navItems(base: string): Array<{ heading: string; items: NavItem[] }> {
  const s = `${base}/settings`
  return [
    {
      heading: 'Project settings',
      items: [
        { label: 'Details', href: s, match: 'exact' },
        { label: 'Request types', href: `${s}/request-types`, match: 'prefix' },
        { label: 'Portal settings', href: `${s}/portal`, match: 'prefix' },
        { label: 'Customers and organizations', href: `${s}/customers`, match: 'prefix' },
        { label: 'Queues', href: `${s}/queues`, match: 'prefix' },
        { label: 'Approvals', href: `${s}/approvals`, match: 'prefix' },
      ],
    },
    {
      heading: 'Channels and content',
      items: [
        { label: 'Email channel', href: `${base}/email`, match: 'prefix' },
        { label: 'Knowledge base', href: `${s}/knowledge-base`, match: 'prefix' },
        { label: 'Canned responses', href: `${base}/canned`, match: 'prefix' },
        { label: 'Notifications', href: `${s}/notifications`, match: 'prefix' },
      ],
    },
    {
      heading: 'Service levels',
      items: [
        { label: 'SLAs', href: `${base}/sla`, match: 'prefix' },
        { label: 'Calendars', href: `${base}/calendars`, match: 'prefix' },
        { label: 'Automation', href: `${base}/automation`, match: 'prefix' },
        { label: 'Customer satisfaction', href: `${base}/csat`, match: 'prefix' },
        { label: 'Knowledge base and automation reports', href: `${base}/insights`, match: 'prefix' },
      ],
    },
  ]
}

export default function DeskSettingsLayout({ children }: { children: React.ReactNode }) {
  const { tr } = useI18n();

  const id = Number(useParams<{ id: string }>().id)
  const pathname = usePathname() ?? ''
  const desk = useDesk(id)
  const base = `/servicedesk/${id}`
  // The form builder needs the full width: the sub-navigation collapses to a back link there.
  const builder = /\/settings\/request-types\/\d+/.test(pathname)

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={base} className="veqsio-btn-ghost inline-flex items-center gap-1 text-sm">
            <ArrowLeft className="w-4 h-4" aria-hidden /> {tr('Back to queues')} </Link>
          <div className="min-w-0">
            <h1 className="text-heading-1 text-[var(--text-primary)] truncate">{desk.data?.name ?? tr('Service desk')}</h1>
            <p className="text-sm text-[var(--text-tertiary)]">
              {desk.data?.projectKey ? <>{tr('Project key')} <span className="font-mono">{desk.data.projectKey}</span> · </> : null}{tr('Project settings')} {desk.data && desk.data.role !== 'admin' && ' · read-only (desk administrators can edit)'}
            </p>
          </div>
        </div>

        {desk.isLoading && <div className="flex justify-center py-16"><Spinner size="lg" /></div>}
        {desk.error && <div role="alert" className="text-[var(--error)]">{desk.error.message}</div>}

        {desk.data && (
          <div className={builder ? 'space-y-4' : 'grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]'}>
            {builder ? (
              <Link href={`${base}/settings/request-types`} className="inline-flex items-center gap-1 text-sm text-[var(--brand-500)] hover:underline">
                <ArrowLeft className="w-4 h-4" aria-hidden /> {tr('All request types')} </Link>
            ) : (
              <nav aria-label={tr('Service desk settings')} className="veqsio-card p-2 h-fit space-y-3">
                {navItems(base).map((group) => (
                  <div key={group.heading}>
                    <div className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{tr(group.heading)}</div>
                    <ul className="space-y-0.5">
                      {group.items.map((it) => {
                        const active = it.match === 'exact' ? pathname === it.href : pathname.startsWith(it.href)
                        return (
                          <li key={it.href}>
                            <Link
                              href={it.href} aria-current={active ? 'page' : undefined}
                              className={`block px-3 py-2 rounded-md text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-500)] ${
                                active ? 'bg-[var(--surface-2)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                              }`}
                            >
                              {tr(it.label)}
                            </Link>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </nav>
            )}
            <div className="min-w-0">{children}</div>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
