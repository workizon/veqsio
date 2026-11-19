'use client'

import { updateBadge } from '@/lib/status-updates'

/** Coloured pill with the current state of a project. The colour is never the only signal: the label is always shown. */
export function StatusUpdateBadge({ state, title }: { state: string; title?: string }) {
  const b = updateBadge(state)
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ background: `${b.color}1f`, color: b.color }}
    >
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: b.color }} aria-hidden />
      {b.label}
    </span>
  )
}
