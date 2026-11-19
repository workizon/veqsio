'use client'

import { User } from 'lucide-react'

interface AvatarProps {
  name: string
  initials?: string
  src?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Avatar({ name, initials, src, size = 'md', className = '' }: AvatarProps) {
  const sizeClasses = {
    sm: 'w-5 h-5 text-[9px]',
    md: 'w-7 h-7 text-[10px]',
    lg: 'w-10 h-10 text-sm',
  }

  const fallbackInitials = initials || name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  const colors = [
    'bg-[#2F58D8]',
    'bg-[#0C7F6B]',
    'bg-[#C73237]',
    'bg-[#6F4FC9]',
    'bg-[#B85A12]',
    'bg-[#1A729F]',
    'bg-[#B52A82]',
    'bg-[#52607A]',
  ]
  const colorIndex = name.charCodeAt(0) % colors.length
  const bgColor = colors[colorIndex]

  return (
    <div
      className={`${sizeClasses[size]} rounded-full flex items-center justify-center overflow-hidden flex-shrink-0 ${bgColor} ${className}`}
      title={name}
    >
      {src ? (
        <img src={src} alt={name} className="w-full h-full object-cover" />
      ) : (
        <span className="text-white font-medium">{fallbackInitials}</span>
      )}
    </div>
  )
}

interface AvatarGroupProps {
  users: Array<{ name: string; initials?: string; src?: string }>
  max?: number
  size?: 'sm' | 'md' | 'lg'
}

export function AvatarGroup({ users, max = 3, size = 'md' }: AvatarGroupProps) {
  const displayUsers = users.slice(0, max)
  const remaining = users.length - max

  return (
    <div className="flex items-center -space-x-2">
      {displayUsers.map((user, i) => (
        <div key={i} className="ring-2 ring-[var(--surface-0)] rounded-full">
          <Avatar {...user} size={size} />
        </div>
      ))}
      {remaining > 0 && (
        <div className={`${size === 'sm' ? 'w-5 h-5 text-[9px]' : size === 'md' ? 'w-7 h-7 text-[10px]' : 'w-10 h-10 text-sm'} rounded-full bg-[var(--surface-3)] flex items-center justify-center ring-2 ring-[var(--surface-0)]`}>
          <span className="text-[var(--text-secondary)] font-medium">+{remaining}</span>
        </div>
      )}
    </div>
  )
}
