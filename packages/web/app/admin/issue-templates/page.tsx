'use client'

import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { TemplateManager } from '@/components/templates/template-manager'
import { useTerm } from '@/hooks/use-term'

/** Global issue templates (available in every project). Only administrators can change them; project templates live in project settings. */
export default function GlobalTemplatesPage() {
  const { Issue } = useTerm()
  return (
    <AppLayout>
      <div className="space-y-4">
        <Breadcrumb items={[{ label: 'Administration', href: '/admin' }, { label: `${Issue} templates` }]} />
        <TemplateManager />
      </div>
    </AppLayout>
  )
}
