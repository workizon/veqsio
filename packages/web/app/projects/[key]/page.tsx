'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { PluginPanels } from '@/components/plugin-panel'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { MilestonesSection } from '@/components/milestones-section'
import { StatusUpdateBadge } from '@/components/status-update-badge'
import { StatusUpdatesPanel } from '@/components/status-updates-panel'
import { useFeatures } from '@/hooks/use-features'
import { useStatusUpdates } from '@/hooks/use-status-updates'

interface ProjectFeature { id: string; enabled: boolean }

/** Project overview: current state (latest status update) with the update history, and links to the project areas. */
export default function ProjectOverviewPage() {
  const { tr } = useI18n();

  const key = String(useParams().key)
  const instance = useFeatures()
  const features = useQuery({
    queryKey: ['project-features', key],
    queryFn: async () => {
      const res = await fetch(`/rest/api/2/project/${encodeURIComponent(key)}/features`, { credentials: 'include' })
      if (!res.ok) return [] as ProjectFeature[]
      return ((await res.json()).features ?? []) as ProjectFeature[]
    },
  })
  const project = useQuery({
    queryKey: ['project', key],
    queryFn: async () => {
      const res = await fetch(`/rest/api/2/project/${encodeURIComponent(key)}`, { credentials: 'include' })
      if (!res.ok) throw new Error(res.status === 404 ? 'Project not found' : res.statusText)
      return (await res.json()) as { key: string; name: string; description?: string | null }
    },
  })
  const updatesOn = instance.isEnabled('updates') && (features.data ?? []).find((f) => f.id === 'updates')?.enabled !== false
  const milestonesOn = instance.isEnabled('milestones') && (features.data ?? []).find((f) => f.id === 'milestones')?.enabled !== false
  const latest = useStatusUpdates(key, false, updatesOn)

  return (
    <AppLayout>
      <div className="space-y-6">
        <Breadcrumb items={[{ label: tr('Projects'), href: '/projects' }, { label: key }]} />
        {project.isLoading && <Spinner />}
        {project.error && <p role="alert" className="text-[var(--error)]">{tr((project.error as Error).message)}</p>}
        {project.data && (
          <>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-heading-1 text-[var(--text-primary)]">{project.data.name}</h1>
                {updatesOn && latest.data?.latest && <StatusUpdateBadge state={latest.data.latest.state} title={tr('Latest status update')} />}
              </div>
              {project.data.description && <p className="text-body-sm text-[var(--text-secondary)] mt-1">{project.data.description}</p>}
              <nav aria-label={tr('Project areas')} className="flex flex-wrap gap-4 mt-3 text-sm">
                <Link className="text-[var(--brand-500)] hover:underline" href={`/issues?jql=${encodeURIComponent(`project = ${key}`)}`}>{tr('Issues')}</Link>
                {instance.isEnabled('roadmap') && <Link className="text-[var(--brand-500)] hover:underline" href="/roadmap">{tr('Roadmap')}</Link>}
                <Link className="text-[var(--brand-500)] hover:underline" href={`/projects/${key}/releases`}>{tr('Releases')}</Link>
                <Link className="text-[var(--brand-500)] hover:underline" href={`/projects/${key}/settings`}>{tr('Settings')}</Link>
              </nav>
            </div>
            {updatesOn ? <StatusUpdatesPanel scope={key} /> : <p className="text-sm text-[var(--text-tertiary)]">{tr('Status updates are switched off for this project.')}</p>}
            {milestonesOn && <MilestonesSection project={key} />}
            <PluginPanels location="project.page" context={{ project: key }} />
          </>
        )}
      </div>
    </AppLayout>
  )
}
