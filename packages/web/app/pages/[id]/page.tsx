'use client'

import { useParams } from 'next/navigation'
import { PagesWorkspace } from '@/components/pages/pages-workspace'

export default function PageRoute() {
  const id = Number(useParams().id)
  return <PagesWorkspace pageId={Number.isInteger(id) && id > 0 ? id : null} />
}
