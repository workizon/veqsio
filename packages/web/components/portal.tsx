'use client'

import { createPortal } from 'react-dom'

/** Renders children in <body>, so an overlay is not trapped in the stacking context of the page part that declares it. */
export function Portal({ children }: { children: React.ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}
