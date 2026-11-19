import { Bookmark, Bug, Check, CornerDownRight, Flame, HelpCircle, LifeBuoy, Zap, type LucideIcon } from 'lucide-react'

/**
 * Issue type as a small solid square with a white glyph (the familiar Jira/Plane pattern): recognisable at 16px,
 * and the same everywhere (lists, boards, backlog, issue view). Colour is paired with a distinct glyph and a title,
 * so it is never the only signal.
 */
const TYPES: Record<string, { Icon: LucideIcon; bg: string; label: string; round?: boolean }> = {
  bug: { Icon: Bug, bg: '#E5484D', label: 'Bug' },
  // Round, so a Task never looks like a selection checkbox when it sits next to one in a list.
  task: { Icon: Check, bg: '#3D7BF0', label: 'Task', round: true },
  story: { Icon: Bookmark, bg: '#16A06A', label: 'Story' },
  epic: { Icon: Zap, bg: '#8B6CE0', label: 'Epic' },
  'sub-task': { Icon: CornerDownRight, bg: '#38A6D9', label: 'Sub-task' },
  subtask: { Icon: CornerDownRight, bg: '#38A6D9', label: 'Sub-task' },
  incident: { Icon: Flame, bg: '#EA7B2C', label: 'Incident' },
  'service request': { Icon: LifeBuoy, bg: '#14A38B', label: 'Service request' },
}

export function IssueTypeGlyph({ name, size = 16, className = '', color }: { name?: string | null; size?: number; className?: string; color?: string | null }) {
  const known = TYPES[(name || '').toLowerCase()]
  const inner = Math.round(size * 0.66)
  if (!known && name && name !== '?') {
    // a type an administrator created: first letter on its own colour
    return (
      <span role="img" aria-label={name} title={name} className={`inline-flex items-center justify-center shrink-0 rounded-[4px] text-white font-semibold ${className}`}
        style={{ width: size, height: size, background: color || '#667085', fontSize: Math.round(size * 0.6), lineHeight: 1 }}>
        {name.trim().charAt(0).toUpperCase()}
      </span>
    )
  }
  const t = known ?? { Icon: HelpCircle, bg: color || '#667085', label: name || 'Issue' }
  return (
    <span
      role="img"
      aria-label={name || t.label}
      title={name || t.label}
      className={`inline-flex items-center justify-center shrink-0 ${t.round ? 'rounded-full' : 'rounded-[4px]'} text-white ${className}`}
      style={{ width: size, height: size, background: t.bg }}
    >
      <t.Icon style={{ width: inner, height: inner }} strokeWidth={2.75} aria-hidden="true" />
    </span>
  )
}
