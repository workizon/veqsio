import { describe, test, expect, beforeEach } from 'bun:test'
import {
  registerTransitionCheck, runTransitionCheck, hasTransitionCheck, unregisterHooks,
  registerRequestCreatedHook, runRequestCreatedHooks,
} from './hooks'
import { registerDeskTemplate, getRegisteredDeskTemplate, listAvailableDeskTemplates } from '../servicedesk/template-registry'
import { validateItems } from '../workflow/definition'

const input = { issueId: 1, issueKey: 'X-1', projectId: 1, transitionId: 1, fromStatusId: 1, toStatusId: 2, toStatusName: 'Done', tx: null }

describe('module extension points', () => {
  beforeEach(() => { unregisterHooks('t') })

  test('a transition check refuses with its message, passes on null and is skipped when unregistered', async () => {
    expect(await runTransitionCheck('t.none', input)).toBeNull()
    registerTransitionCheck('t', 't.no', () => 'not allowed')
    registerTransitionCheck('t', 't.yes', () => null)
    expect(await runTransitionCheck('t.no', input)).toBe('not allowed')
    expect(await runTransitionCheck('t.yes', input)).toBeNull()
    unregisterHooks('t')
    expect(hasTransitionCheck('t.no')).toBe(false)
    expect(await runTransitionCheck('t.no', input)).toBeNull()
  })

  test('a check that throws fails closed', async () => {
    registerTransitionCheck('t', 't.boom', () => { throw new Error('db down') })
    const msg = await runTransitionCheck('t.boom', input)
    expect(msg).toContain('could not be verified')
  })

  test('request created hooks never throw into the caller', async () => {
    let seen = 0
    registerRequestCreatedHook('t', () => { seen++; throw new Error('x') })
    await runRequestCreatedHooks({ issueId: 1, issueKey: 'X-1', deskId: 1, requestTypeId: null, fieldValues: {} })
    expect(seen).toBe(1)
  })

  test('desk templates are listed only while available and removed with their owner', async () => {
    let on = true
    registerDeskTemplate('t', { id: 'test-tpl', title: 'T', description: 'd', feature: 'f', isAvailable: () => on, apply: async () => {} })
    expect((await listAvailableDeskTemplates()).map((t) => t.id)).toContain('test-tpl')
    on = false
    expect((await listAvailableDeskTemplates()).map((t) => t.id)).not.toContain('test-tpl')
    unregisterHooks('t')
    expect(getRegisteredDeskTemplate('test-tpl')).toBeUndefined()
  })

  test('the module_check validator is part of the workflow catalogue and needs a check name', () => {
    expect(validateItems('validator', [{ type: 'module_check', check: 'itsm.postmortem' }])).toEqual([])
    expect(validateItems('validator', [{ type: 'module_check' }]).length).toBeGreaterThan(0)
  })
})
