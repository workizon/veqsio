'use client'

import { useParams } from 'next/navigation'
import { ApprovalTemplateEditor } from '@/components/approvals/template-editor'
import { useDesk } from '@/hooks/use-servicedesk-admin'

/** Project settings > Approvals (service desk): templates of the desk's project. */
export default function DeskApprovalsPage() {
  const id = Number(useParams<{ id: string }>().id)
  const desk = useDesk(id)
  const key = desk.data?.projectKey
  if (!key) return null
  return <ApprovalTemplateEditor projectKey={key} />
}
