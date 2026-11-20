'use client'

import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { TemplateManager } from '@/components/templates/template-manager'
import { useTerm } from '@/hooks/use-term'
import { useI18n } from '@/hooks/use-i18n'

/** Global issue templates (available in every project). Only administrators can change them; project templates live in project settings. */
export default function GlobalTemplatesPage() {
  const { tr } = useI18n()
  const { Issue } = useTerm()
  return (
    <AppLayout>
      <div className="space-y-4">
        <Breadcrumb items={[{ label: tr('Administration'), href: '/admin' }, { label: tr('{issue} templates', { issue: Issue }) }]} />
        <TemplateManager />
      </div>
    </AppLayout>
  )
}
