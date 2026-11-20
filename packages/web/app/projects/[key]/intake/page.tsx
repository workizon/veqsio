'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { IntakeQueue } from '@/components/intake/intake-queue'
import { useFeatures } from '@/hooks/use-features'
import { useIntakeInfo } from '@/hooks/use-intake'
import { useProject } from '@/hooks/use-project-admin'

export default function ProjectIntakePage() {
  const { tr } = useI18n();

  const key = String(useParams().key)
  const features = useFeatures()
  const { data: project } = useProject(key)
  const info = useIntakeInfo(key)

  return (
    <AppLayout>
      <div className="space-y-4">
        <Breadcrumb items={[{ label: tr('Projects'), href: '/projects' }, { label: project?.name ?? key, href: `/projects/${key}/settings` }, { label: tr('Intake') }]} />
        <div>
          <h1 className="text-heading-1 text-[var(--text-primary)]">{tr('Intake')}</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">{tr('Requests and ideas waiting for triage. A submission becomes an issue only when you accept it.')}</p>
        </div>
        {features.loaded && !features.isEnabled('intake') && <p role="alert" className="veqsio-card p-6">{tr('Intake is switched off on this instance.')}</p>}
        {info.isLoading && <div className="flex justify-center py-12"><Spinner size="lg" /></div>}
        {info.error && <p role="alert" className="veqsio-card p-6 text-[var(--text-secondary)]">{tr('This project was not found, or you may not view it.')}</p>}
        {info.data && !info.data.enabled && (
          <div className="veqsio-card p-6 space-y-2">
            <p>{tr('Intake is not enabled for this project.')}</p>
            {info.data.canAdmin
              ? <p><Link className="text-[var(--brand-500)] hover:underline" href={`/projects/${key}/settings`}>{tr('Enable it in the project settings')}</Link> {tr('(tab Intake).')}</p>
              : <p className="text-sm text-[var(--text-secondary)]">{tr('Ask a project administrator to enable it.')}</p>}
          </div>
        )}
        {info.data?.enabled && features.isEnabled('intake') && <IntakeQueue project={key} info={info.data} />}
      </div>
    </AppLayout>
  )
}
