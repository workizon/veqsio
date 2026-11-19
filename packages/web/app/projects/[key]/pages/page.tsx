'use client'

import { useParams } from 'next/navigation'
import { PagesWorkspace } from '@/components/pages/pages-workspace'

export default function ProjectPagesPage() {
  return <PagesWorkspace scopeKey={String(useParams().key)} pageId={null} />
}
