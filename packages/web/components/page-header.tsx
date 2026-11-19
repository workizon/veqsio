import type { ReactNode } from 'react'
import { Breadcrumb } from '@/components/breadcrumb'

/**
 * The header every page starts with, so the title sits in the same place and has the same size, weight and spacing
 * on every screen: optional breadcrumb, one h1, an optional one-line description, and the page's actions on the right
 * (the single primary action goes last). Do not repeat the primary action in an empty state.
 */
export function PageHeader({ title, description, breadcrumb, actions, meta }: {
  title: ReactNode
  description?: ReactNode
  breadcrumb?: Array<{ label: string; href?: string }>
  actions?: ReactNode
  /** Small items next to the title (presence avatars, a status lozenge). */
  meta?: ReactNode
}) {
  return (
    <header className="mb-6">
      {breadcrumb && breadcrumb.length > 0 && <div className="mb-2"><Breadcrumb items={breadcrumb} /></div>}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-heading-1 text-[var(--text-primary)]">{title}</h1>
            {meta}
          </div>
          {description && <p className="mt-1 max-w-3xl text-body text-[var(--text-secondary)]">{description}</p>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
