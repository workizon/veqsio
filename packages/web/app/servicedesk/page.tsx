'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { LifeBuoy, Plus } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { useDesks } from '@/hooks/use-servicedesk'

const ROLE_LABEL = { admin: 'Administrator', agent: 'Agent' } as const

export default function ServiceDesksPage() {
  const { tr } = useI18n();

  const { data, isLoading, error } = useDesks()
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title={tr('Service desks')} actions={<><Link href="/servicedesk/new" className="veqsio-btn-primary inline-flex items-center gap-2">
            <Plus className="w-4 h-4" aria-hidden /> {tr('Create service desk')} </Link></>} />
        {isLoading && <div className="flex justify-center py-16"><Spinner size="lg" /></div>}
        {error && <div role="alert" className="text-[var(--error)] text-body">{error.message}</div>}
        {data && data.values.length === 0 && (
          <EmptyState
            icon="folder" title={tr('No service desks')}
            description={tr('You are not an agent on any service desk yet. Use Create service desk above to start receiving requests.')}
          />
        )}
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data?.values.map((d) => (
            <li key={d.id} className="veqsio-card p-4 space-y-3">
              <div className="flex items-start gap-2">
                <LifeBuoy className="w-5 h-5 mt-0.5 shrink-0 text-[var(--brand-500)]" aria-hidden />
                <div className="min-w-0 flex-1">
                  <h2 className="text-heading-3 text-[var(--text-primary)] truncate">{d.name}</h2>
                  {d.projectKey && <p className="text-xs text-[var(--text-tertiary)] font-mono">{d.projectKey}</p>}
                </div>
                <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium bg-[var(--surface-2)] text-[var(--text-secondary)]">{tr(ROLE_LABEL[d.role])}</span>
              </div>
              {d.description && <p className="text-sm text-[var(--text-secondary)] line-clamp-2">{d.description}</p>}
              {d.enabled === false && <p className="text-xs text-[var(--warning)]">{tr('Portal disabled')}</p>}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <Link className="text-[var(--brand-500)] hover:underline" href={`/servicedesk/${d.id}`}>{tr('Queues')}</Link>
                <Link className="text-[var(--brand-500)] hover:underline" href={`/servicedesk/${d.id}/settings`}>{tr('Project settings')}</Link>
                <Link className="text-[var(--brand-500)] hover:underline" href={`/portal/${d.slug}`}>{tr('Customer portal')}</Link>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </AppLayout>
  )
}
