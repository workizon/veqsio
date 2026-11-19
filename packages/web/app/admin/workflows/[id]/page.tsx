'use client'

import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { WorkflowDesigner } from '@/components/workflow/designer'

export default function WorkflowDesignerPage() {
  const params = useParams<{ id: string }>()
  const id = Number(params.id)
  return (
    <AppLayout>
      {Number.isInteger(id) && id > 0
        ? <WorkflowDesigner workflowId={id} />
        : <p role="alert" className="text-[var(--error)]">Invalid workflow id</p>}
    </AppLayout>
  )
}
