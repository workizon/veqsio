'use client'

import Link from 'next/link'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { ProjectAvatar } from '@/components/project-avatar'
import { Spinner } from '@/components/spinner'
import { useFeatures } from '@/hooks/use-features'
import { useIntakeCounts, useIntakeInfo } from '@/hooks/use-intake'
import { useProjects } from '@/hooks/use-project-admin'

function Row({ projectKey, name, avatar }: { projectKey: string; name: string; avatar?: string }) {
  const info = useIntakeInfo(projectKey)
  const counts = useIntakeCounts(projectKey, !!info.data?.enabled && info.data.canTriage)
  if (!info.data?.enabled) return null
  return (
    <li>
      <Link href={`/projects/${projectKey}/intake`} className="veqsio-card flex items-center gap-3">
        <ProjectAvatar projectKey={projectKey} name={name} src={avatar} size={32} />
        <span className="flex-1 min-w-0"><span className="block font-medium truncate">{name}</span><span className="text-xs text-[var(--text-tertiary)]">{projectKey}</span></span>
        {counts.data && <span className="text-sm text-[var(--text-secondary)]">{counts.data.pending} pending{counts.data.snoozed ? ` · ${counts.data.snoozed} snoozed` : ''}</span>}
      </Link>
    </li>
  )
}

export default function TriageHubPage() {
  const features = useFeatures()
  const { data: projects, isLoading } = useProjects()
  return (
    <AppLayout>
      <div className="space-y-4">
        <Breadcrumb items={[{ label: 'Projects', href: '/projects' }, { label: 'Intake' }]} />
        <h1 className="text-heading-1">Intake</h1>
        <p className="text-sm text-[var(--text-secondary)]">Projects that collect submissions for triage. Project administrators enable intake in the project settings.</p>
        {features.loaded && !features.isEnabled('intake') && <p role="alert" className="veqsio-card p-6">Intake is switched off on this instance.</p>}
        {isLoading && <div className="flex justify-center py-12"><Spinner size="lg" /></div>}
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Projects with intake">
          {features.isEnabled('intake') && (projects ?? []).map((p) => <Row key={p.id} projectKey={p.key} name={p.name} avatar={p.avatarUrls?.['48x48']} />)}
        </ul>
      </div>
    </AppLayout>
  )
}
