'use client'

import { Fragment } from 'react'
import Link from 'next/link'
import { ChevronRight, Home } from 'lucide-react'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-1.5 text-sm">
      <Link
        href="/"
        aria-label="Home"
        className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] transition-colors"
      >
        <Home className="w-4 h-4" />
      </Link>

      {items.map((item, index) => (
        <Fragment key={`${index}-${item.label}`}>
          <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
          {item.href ? (
            <Link
              href={item.href}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              {item.label}
            </Link>
          ) : (
            <span className="text-[var(--text-primary)] font-medium">
              {item.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  )
}
