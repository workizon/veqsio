'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { ApprovalTemplateEditor } from '@/components/approvals/template-editor'

export default function ProjectApprovalsSettingsPage() {
  const key = String(useParams().key)
  return (
    <AppLayout>
      <div className="space-y-4">
        <Link href={`/projects/${key}/settings`} className="text-sm text-[var(--brand-500)] hover:underline">Back to project settings</Link>
        <ApprovalTemplateEditor projectKey={key} />
      </div>
    </AppLayout>
  )
}
