'use client'

import { AppLayout } from '@/components/app-layout'
import { IssueSecurityEditor } from '@/components/admin/issue-security-editor'

export default function AdminIssueSecurityPage() {
  return (
    <AppLayout>
      <IssueSecurityEditor />
    </AppLayout>
  )
}
