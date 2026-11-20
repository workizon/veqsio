'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { WorkflowDesigner } from '@/components/workflow/designer'

export default function WorkflowDesignerPage() {
  const { tr } = useI18n();

  const params = useParams<{ id: string }>()
  const id = Number(params.id)
  return (
    <AppLayout>
      {Number.isInteger(id) && id > 0
        ? <WorkflowDesigner workflowId={id} />
        : <p role="alert" className="text-[var(--error)]">{tr('Invalid workflow id')}</p>}
    </AppLayout>
  )
}
