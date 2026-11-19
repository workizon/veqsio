/**
 * Pure helpers for the workflow designer: the catalogue of condition /
 * validator / post-function types the executor really implements (with their
 * parameter schemas), validation of user supplied items, and graph analysis.
 * No DB access here so everything is unit-testable.
 *
 * Keep the catalogue in sync with conditions.ts, validators.ts and
 * post-functions.ts. Types the executor ignores (field_value, custom_script,
 * update_field, fire_event) are deliberately NOT offered: accepting them would
 * let an admin configure something that silently does nothing.
 */

export type ParamType = 'string' | 'text' | 'number' | 'enum' | 'role' | 'group' | 'resolution' | 'permission' | 'user'
export type ItemKind = 'condition' | 'validator' | 'postFunction'

export interface ParamDef {
  name: string
  label: string
  type: ParamType
  required: boolean
  help?: string
  options?: string[]
  maxLength?: number
  /** Fixed value (single-option enums are pre-filled by the UI). */
  default?: string | number | null
}

export interface TypeDef {
  type: string
  label: string
  description: string
  params: ParamDef[]
}

/** Mirrors PROJECT_PERMISSIONS in rbac/types.ts (kept literal so this module stays dependency free). */
export const PERMISSION_NAMES = [
  'PROJECT_ADMIN', 'ADMINISTER_PROJECTS', 'BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'DELETE_ISSUES',
  'TRANSITION_ISSUES', 'ASSIGN_ISSUES', 'ASSIGNABLE_USER', 'RESOLVE_ISSUES', 'CLOSE_ISSUES', 'MODIFY_REPORTER',
  'CREATE_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS', 'COMMENT_ISSUE', 'ADD_COMMENTS',
  'DELETE_ALL_COMMENTS', 'DELETE_OWN_COMMENTS', 'EDIT_ALL_COMMENTS', 'EDIT_OWN_COMMENTS', 'WORK_ON_ISSUES', 'EDIT_ALL_WORKLOGS', 'DELETE_ALL_WORKLOGS',
  'LINK_ISSUES', 'MANAGE_WATCHERS', 'VIEW_VOTERS_AND_WATCHERS', 'MANAGE_SPRINTS', 'SET_ISSUE_SECURITY',
] as const

export const CONDITION_TYPES: TypeDef[] = [
  { type: 'always_true', label: 'Always allowed', description: 'No restriction (placeholder).', params: [] },
  {
    type: 'user_in_project_role', label: 'User is in project role',
    description: 'Only members of the role (directly or via a group) in the issue’s project can run the transition.',
    params: [{ name: 'role_id', label: 'Project role', type: 'role', required: true }],
  },
  {
    type: 'user_in_group', label: 'User is in group',
    description: 'Only members of the group can run the transition.',
    params: [{ name: 'group_id', label: 'Group', type: 'group', required: true }],
  },
  {
    type: 'permission_check', label: 'User has project permission',
    description: 'The user needs this permission in the issue’s project.',
    params: [{ name: 'permission', label: 'Permission', type: 'permission', required: true, options: [...PERMISSION_NAMES] }],
  },
  {
    type: 'issue_field_value', label: 'Issue has an assignee',
    description: 'The transition is available only while the issue is assigned to somebody.',
    params: [
      { name: 'field', label: 'Field', type: 'enum', required: true, options: ['assignee'], default: 'assignee' },
      { name: 'operator', label: 'Operator', type: 'enum', required: true, options: ['is_not_empty'], default: 'is_not_empty' },
    ],
  },
]

export const VALIDATOR_TYPES: TypeDef[] = [
  {
    type: 'field_required', label: 'Field is required',
    description: 'The transition fails unless the transition screen supplies a value for this field.',
    params: [{ name: 'field', label: 'Field key', type: 'string', required: true, maxLength: 100, help: 'For example resolution, assignee or customfield_10010.' }],
  },
  {
    type: 'field_regex', label: 'Field matches pattern',
    description: 'If a value is supplied it must match the regular expression.',
    params: [
      { name: 'field', label: 'Field key', type: 'string', required: true, maxLength: 100 },
      { name: 'pattern', label: 'Regular expression', type: 'string', required: true, maxLength: 200, help: 'JavaScript syntax, e.g. ^[A-Z]{2,5}-\\d+$' },
    ],
  },
  {
    type: 'approval_required', label: 'Approval is required',
    description: 'Blocks the transition until the latest approval on the issue is approved (also while none was requested, pending, declined or expired). Optionally only approvals from one template count.',
    params: [{ name: 'template', label: 'Approval template name', type: 'string', required: false, maxLength: 120, help: 'Leave empty to accept any approval.' }],
  },
  {
    type: 'module_check', label: 'Module check',
    description: 'Runs a named check provided by an installed module (for example itsm.postmortem or itsm.pir). The transition fails with the check’s message. The check is skipped while its module is disabled or unlicensed.',
    params: [{ name: 'check', label: 'Check name', type: 'string', required: true, maxLength: 80, help: 'For example itsm.postmortem.' }],
  },
]

export const POST_FUNCTION_TYPES: TypeDef[] = [
  {
    type: 'request_approval', label: 'Request approval',
    description: 'Starts an approval from the named approval template of the issue’s project (skipped if one from that template is already pending). The user running the transition cannot be an approver.',
    params: [{ name: 'template', label: 'Approval template name', type: 'string', required: true, maxLength: 120 }],
  },
  {
    type: 'assign_to_user', label: 'Assign issue',
    description: 'Assigns the issue to the chosen user, or to the person running the transition when empty.',
    params: [{ name: 'user_id', label: 'User', type: 'user', required: false, help: 'Leave empty to assign to the current user.' }],
  },
  {
    type: 'set_resolution', label: 'Set resolution',
    description: 'Sets the resolution and the resolved date.',
    params: [{ name: 'resolution_id', label: 'Resolution', type: 'resolution', required: true }],
  },
  {
    type: 'clear_field', label: 'Clear resolution',
    description: 'Clears the resolution and the resolved date (for example when reopening).',
    params: [{ name: 'field', label: 'Field', type: 'enum', required: true, options: ['resolution'], default: 'resolution' }],
  },
  {
    type: 'update_date', label: 'Stamp resolved date',
    description: 'Sets the resolved date to now.',
    params: [{ name: 'field', label: 'Field', type: 'enum', required: true, options: ['resolved_at'], default: 'resolved_at' }],
  },
  {
    type: 'add_comment', label: 'Add comment',
    description: 'Adds a comment, authored by the person running the transition.',
    params: [{ name: 'body', label: 'Comment', type: 'text', required: true, maxLength: 5000 }],
  },
]

export const TYPE_CATALOGUE: Record<ItemKind, TypeDef[]> = {
  condition: CONDITION_TYPES,
  validator: VALIDATOR_TYPES,
  postFunction: POST_FUNCTION_TYPES,
}

export const KIND_LABEL: Record<ItemKind, string> = { condition: 'Condition', validator: 'Validator', postFunction: 'Post-function' }

export const MAX_ITEMS_PER_LIST = 20

export interface ItemError { index: number; message: string }

/**
 * Validates a list of conditions, validators or post-functions.
 * Unknown types, unknown parameters and badly typed parameters are errors.
 */
export function validateItems(kind: ItemKind, items: unknown): ItemError[] {
  const errors: ItemError[] = []
  const label = KIND_LABEL[kind]
  if (!Array.isArray(items)) return [{ index: -1, message: `${label}s must be an array` }]
  if (items.length > MAX_ITEMS_PER_LIST) errors.push({ index: -1, message: `At most ${MAX_ITEMS_PER_LIST} ${label.toLowerCase()}s are allowed` })

  items.forEach((raw, index) => {
    const fail = (message: string) => { errors.push({ index, message: `${label} #${index + 1}: ${message}` }) }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('must be an object')
    const item = raw as Record<string, unknown>
    const def = TYPE_CATALOGUE[kind].find((t) => t.type === item.type)
    if (!def) return fail(`unsupported type '${String(item.type)}'`)

    const known = new Set(['type', ...def.params.map((p) => p.name)])
    for (const key of Object.keys(item)) if (!known.has(key)) fail(`unknown parameter '${key}' for ${def.type}`)

    for (const p of def.params) {
      const v = item[p.name]
      const empty = v === undefined || v === null || v === ''
      if (empty) {
        if (p.required) fail(`'${p.name}' is required for ${def.type}`)
        continue
      }
      switch (p.type) {
        case 'number': case 'role': case 'group': case 'resolution': case 'user':
          if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) fail(`'${p.name}' must be a positive integer`)
          break
        case 'enum': case 'permission':
          if (typeof v !== 'string' || !(p.options ?? []).includes(v)) fail(`'${p.name}' must be one of ${(p.options ?? []).join(', ')}`)
          break
        default:
          if (typeof v !== 'string') fail(`'${p.name}' must be text`)
          else if (v.length > (p.maxLength ?? 1000)) fail(`'${p.name}' is longer than ${p.maxLength ?? 1000} characters`)
          else if (def.type === 'field_regex' && p.name === 'pattern') {
            try { new RegExp(v) } catch { fail('pattern is not a valid regular expression') }
          } else if (p.name === 'field' && !/^[A-Za-z0-9_.-]+$/.test(v)) fail(`'field' may only contain letters, digits, _ . -`)
      }
    }
  })
  return errors
}

/** Drops empty optional params so stored JSON stays minimal. */
export function normalizeItems<T extends Record<string, unknown>>(items: T[]): T[] {
  return items.map((it) => Object.fromEntries(Object.entries(it).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T)
}

/* ------------------------------------------------------------------ */
/*  Graph analysis                                                     */
/* ------------------------------------------------------------------ */

export interface GraphTransition { id?: number; name: string; fromStatusId: number | null; toStatusId: number }
export interface GraphWarning {
  code: 'duplicate_name' | 'unreachable' | 'dead_end' | 'no_transitions' | 'self_loop_only'
  message: string
  statusId?: number
  transitionName?: string
}

/**
 * Finds structural problems. `statusIds` are the statuses placed in the
 * workflow; `names` maps status id to display name for readable messages.
 * Everything is a warning: the engine itself accepts any graph.
 *
 * A "global" transition (from = null) is available from every status, so with
 * at least one global transition there are no dead ends.
 */
export function analyzeGraph(statusIds: number[], transitions: GraphTransition[], names: Record<number, string> = {}): GraphWarning[] {
  const warnings: GraphWarning[] = []
  const nm = (id: number) => names[id] ?? `#${id}`
  const ids = new Set(statusIds)

  // Two transitions with the same name leaving the same status are ambiguous for users.
  const seen = new Map<string, { n: number; from: number | null; name: string }>()
  for (const t of transitions) {
    const key = `${t.fromStatusId ?? 'any'}|${t.name.trim().toLowerCase()}`
    const cur = seen.get(key)
    if (cur) cur.n++
    else seen.set(key, { n: 1, from: t.fromStatusId, name: t.name.trim() })
  }
  for (const s of seen.values()) {
    if (s.n < 2) continue
    warnings.push({
      code: 'duplicate_name', transitionName: s.name,
      message: `${s.n} transitions named "${s.name}" leave ${s.from === null ? 'any status' : nm(s.from)}`,
    })
  }

  const globalTargets = new Set(transitions.filter((t) => t.fromStatusId === null).map((t) => t.toStatusId))
  const hasGlobal = globalTargets.size > 0
  const outgoing = new Map<number, number[]>()
  const hasIncoming = new Set<number>()
  for (const t of transitions) {
    if (t.fromStatusId !== null) {
      if (!outgoing.has(t.fromStatusId)) outgoing.set(t.fromStatusId, [])
      outgoing.get(t.fromStatusId)!.push(t.toStatusId)
    }
    if (t.fromStatusId !== t.toStatusId) hasIncoming.add(t.toStatusId)
  }

  for (const id of ids) {
    const outs = outgoing.get(id) ?? []
    if (!hasIncoming.has(id) && outs.length === 0 && !globalTargets.has(id)) {
      warnings.push({ code: 'no_transitions', statusId: id, message: `${nm(id)} has no transitions` })
    } else if (outs.length > 0 && outs.every((o) => o === id)) {
      warnings.push({ code: 'self_loop_only', statusId: id, message: `${nm(id)} can only transition to itself` })
    } else if (outs.length === 0 && !hasGlobal) {
      warnings.push({ code: 'dead_end', statusId: id, message: `${nm(id)} has no outgoing transition, issues get stuck there` })
    }
  }

  // Reachability from entry points (no incoming transition) and global targets.
  const entries = [...ids].filter((id) => !hasIncoming.has(id) && !globalTargets.has(id) && (outgoing.get(id)?.length ?? 0) > 0)
  const reachable = new Set<number>([...entries, ...globalTargets])
  const queue = [...reachable]
  while (queue.length) {
    const cur = queue.pop()!
    for (const nx of outgoing.get(cur) ?? []) if (!reachable.has(nx)) { reachable.add(nx); queue.push(nx) }
  }
  // A pure cycle has no entry point and is fine, so only check when one exists.
  if (entries.length > 0 || hasGlobal) {
    for (const id of ids) {
      const connected = hasIncoming.has(id) || (outgoing.get(id)?.length ?? 0) > 0
      if (connected && !reachable.has(id)) warnings.push({ code: 'unreachable', statusId: id, message: `${nm(id)} cannot be reached from any entry status` })
    }
  }
  return warnings
}

/** Statuses that belong to a workflow: placed on the canvas plus every transition endpoint. */
export function workflowStatusIds(layoutNodes: Record<string, unknown> | null | undefined, transitions: GraphTransition[]): number[] {
  const out = new Set<number>()
  for (const k of Object.keys(layoutNodes ?? {})) { const n = Number(k); if (Number.isInteger(n)) out.add(n) }
  for (const t of transitions) { if (t.fromStatusId !== null) out.add(t.fromStatusId); out.add(t.toStatusId) }
  return [...out]
}

export interface NodePosition { x: number; y: number }

/** Returns an error message for an invalid layout, else null. */
export function validateLayout(nodes: unknown): string | null {
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return 'nodes must be an object keyed by status id'
  const entries = Object.entries(nodes as Record<string, unknown>)
  if (entries.length > 500) return 'too many nodes'
  for (const [k, v] of entries) {
    if (!/^\d+$/.test(k)) return `invalid status id '${k}'`
    const p = v as Partial<NodePosition> | null
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 100000 || Math.abs(p.y) > 100000) {
      return `invalid position for status ${k}`
    }
  }
  return null
}
