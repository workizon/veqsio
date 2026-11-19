'use client'

import { Avatar } from './avatar'
import type { PresenceUser } from '@/lib/realtime'

/** Row of avatars for people currently viewing the same issue/board. */
export function PresenceAvatars({ users, max = 5 }: { users: PresenceUser[]; max?: number }) {
  if (users.length === 0) return null
  const shown = users.slice(0, max)
  const extra = users.length - shown.length
  return (
    <div className="flex items-center -space-x-1.5" aria-label={`${users.length} other ${users.length === 1 ? 'person' : 'people'} viewing`} data-testid="presence-avatars">
      {shown.map((u) => (
        <span
          key={u.id}
          title={`${u.displayName} is viewing`}
          className="rounded-full ring-2"
          style={{ ['--tw-ring-color' as string]: u.color }}
        >
          <Avatar name={u.displayName} src={u.avatarUrl ?? undefined} size="sm" />
        </span>
      ))}
      {extra > 0 && (
        <span className="ml-2 text-xs text-[var(--text-tertiary)]">+{extra}</span>
      )}
    </div>
  )
}
