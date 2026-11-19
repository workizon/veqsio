import { describe, it, expect } from 'bun:test'
import {
  validateItems, normalizeItems, analyzeGraph, workflowStatusIds, validateLayout,
  CONDITION_TYPES, VALIDATOR_TYPES, POST_FUNCTION_TYPES,
} from './definition'

describe('catalogue matches the executor', () => {
  it('only offers types the executor implements', () => {
    expect(CONDITION_TYPES.map((t) => t.type).sort()).toEqual(['always_true', 'issue_field_value', 'permission_check', 'user_in_group', 'user_in_project_role'])
    expect(VALIDATOR_TYPES.map((t) => t.type).sort()).toEqual(['approval_required', 'field_regex', 'field_required', 'module_check'])
    expect(POST_FUNCTION_TYPES.map((t) => t.type).sort()).toEqual(['add_comment', 'assign_to_user', 'clear_field', 'request_approval', 'set_resolution', 'update_date'])
  })
})

describe('validateItems', () => {
  it('accepts valid items', () => {
    expect(validateItems('condition', [{ type: 'user_in_group', group_id: 3 }, { type: 'always_true' }])).toEqual([])
    expect(validateItems('validator', [{ type: 'field_regex', field: 'summary', pattern: '^[A-Z]+$' }])).toEqual([])
    expect(validateItems('postFunction', [{ type: 'assign_to_user' }, { type: 'set_resolution', resolution_id: 1 }])).toEqual([])
  })

  it('rejects types the executor does not support', () => {
    expect(validateItems('validator', [{ type: 'custom_script', script: 'x' }])[0].message).toContain("unsupported type 'custom_script'")
    expect(validateItems('validator', [{ type: 'field_value' }])).toHaveLength(1)
    expect(validateItems('postFunction', [{ type: 'update_field', field: 'status' }])).toHaveLength(1)
    expect(validateItems('condition', [{ type: 'nope' }])).toHaveLength(1)
  })

  it('validates the approval items', () => {
    expect(validateItems('validator', [{ type: 'approval_required' }, { type: 'approval_required', template: 'Manager' }])).toEqual([])
    expect(validateItems('postFunction', [{ type: 'request_approval', template: 'Manager' }])).toEqual([])
    expect(validateItems('postFunction', [{ type: 'request_approval' }])[0].message).toContain("'template' is required")
  })

  it('checks required and typed params', () => {
    expect(validateItems('condition', [{ type: 'user_in_group' }])[0].message).toContain("'group_id' is required")
    expect(validateItems('condition', [{ type: 'user_in_group', group_id: '3' }])[0].message).toContain('positive integer')
    expect(validateItems('condition', [{ type: 'permission_check', permission: 'DROP_TABLES' }])).toHaveLength(1)
    expect(validateItems('condition', [{ type: 'permission_check', permission: 'EDIT_ISSUES' }])).toEqual([])
    expect(validateItems('postFunction', [{ type: 'clear_field', field: 'summary' }])).toHaveLength(1)
  })

  it('rejects unknown params, bad regex, bad field keys and non-arrays', () => {
    expect(validateItems('condition', [{ type: 'always_true', evil: 1 }])[0].message).toContain("unknown parameter 'evil'")
    expect(validateItems('validator', [{ type: 'field_regex', field: 'a', pattern: '(' }])[0].message).toContain('regular expression')
    expect(validateItems('validator', [{ type: 'field_required', field: 'a b;' }])).toHaveLength(1)
    expect(validateItems('validator', [{ type: 'field_regex', field: 'a', pattern: 'x'.repeat(201) }])).toHaveLength(1)
    expect(validateItems('condition', 'x' as any)).toHaveLength(1)
    expect(validateItems('condition', [null as any, 5 as any])).toHaveLength(2)
  })

  it('caps list length', () => {
    const many = Array.from({ length: 21 }, () => ({ type: 'always_true' }))
    expect(validateItems('condition', many).some((e) => e.index === -1)).toBe(true)
  })
})

describe('normalizeItems', () => {
  it('drops empty optional params', () => {
    expect(normalizeItems<Record<string, unknown>>([{ type: 'assign_to_user', user_id: null }, { type: 'add_comment', body: 'x', extra: '' }]))
      .toEqual([{ type: 'assign_to_user' }, { type: 'add_comment', body: 'x' }])
  })
})

describe('analyzeGraph', () => {
  const names = { 1: 'Open', 2: 'In Progress', 3: 'Done', 4: 'Orphan' }
  const codes = (w: ReturnType<typeof analyzeGraph>) => w.map((x) => x.code).sort()

  it('is clean for a healthy flow', () => {
    const t = [
      { name: 'Start', fromStatusId: 1, toStatusId: 2 },
      { name: 'Finish', fromStatusId: 2, toStatusId: 3 },
      { name: 'Reopen', fromStatusId: 3, toStatusId: 1 },
    ]
    expect(analyzeGraph([1, 2, 3], t, names)).toEqual([])
  })

  it('flags dead ends, orphans and duplicate names', () => {
    const t = [
      { name: 'Start', fromStatusId: 1, toStatusId: 2 },
      { name: 'start', fromStatusId: 1, toStatusId: 3 },
    ]
    expect(codes(analyzeGraph([1, 2, 3, 4], t, names))).toEqual(['dead_end', 'dead_end', 'duplicate_name', 'no_transitions'])
  })

  it('global transitions remove dead ends', () => {
    const t = [{ name: 'Close', fromStatusId: null, toStatusId: 3 }, { name: 'Start', fromStatusId: 1, toStatusId: 2 }]
    expect(analyzeGraph([1, 2, 3], t, names).some((x) => x.code === 'dead_end')).toBe(false)
  })

  it('flags unreachable islands and self loops', () => {
    const cycle = [
      { name: 'a', fromStatusId: 1, toStatusId: 2 },
      { name: 'b', fromStatusId: 2, toStatusId: 1 },
      { name: 'c', fromStatusId: 3, toStatusId: 4 },
      { name: 'd', fromStatusId: 4, toStatusId: 3 },
    ]
    expect(analyzeGraph([5], [{ name: 'e', fromStatusId: 5, toStatusId: 5 }], names).map((x) => x.code)).toEqual(['self_loop_only'])
    const w = analyzeGraph([1, 2, 3, 4], cycle, names)
    // only pure cycles and no entry point: nothing counts as unreachable
    expect(w.some((x) => x.code === 'unreachable')).toBe(false)
    const withEntry = analyzeGraph([1, 2, 3, 4, 6], [...cycle, { name: 'enter', fromStatusId: 6, toStatusId: 1 }], names)
    expect(withEntry.filter((x) => x.code === 'unreachable').map((x) => x.statusId).sort()).toEqual([3, 4])
  })
})

describe('workflowStatusIds / validateLayout', () => {
  it('unions canvas nodes and transition endpoints', () => {
    const ids = workflowStatusIds({ '7': { x: 0, y: 0 } }, [{ name: 'x', fromStatusId: 1, toStatusId: 2 }, { name: 'y', fromStatusId: null, toStatusId: 3 }])
    expect(ids.sort()).toEqual([1, 2, 3, 7])
    expect(workflowStatusIds(null, [])).toEqual([])
  })
  it('validates positions', () => {
    expect(validateLayout({ '1': { x: 10, y: 20 } })).toBeNull()
    expect(validateLayout({ a: { x: 1, y: 1 } })).toContain('invalid status id')
    expect(validateLayout({ '1': { x: NaN, y: 1 } })).toContain('invalid position')
    expect(validateLayout({ '1': { x: 1e9, y: 1 } })).toContain('invalid position')
    expect(validateLayout([])).not.toBeNull()
  })
})
