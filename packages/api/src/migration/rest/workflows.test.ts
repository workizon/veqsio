import { describe, test, expect } from 'bun:test'
import { WorkflowObservations, inferWorkflow, parseRealWorkflow, pickRealWorkflow, uniqueTransitionName } from './workflows'

const at = (d: number) => new Date(Date.UTC(2020, 0, d))
const issue = (status: string, moves: Array<[string, string, number]>, type = 'Bug') => ({
  issueType: { name: type, subtask: false },
  status: { name: status, category: 'todo' as const },
  history: moves.map(([from, to, d]) => ({ at: at(d), author: null, field: 'status', from, to })),
})
const group = (issues: ReturnType<typeof issue>[]) => {
  const o = new WorkflowObservations()
  for (const i of issues) o.add('ABC', i)
  return o.groups.get('ABC')!.get('Bug')!
}

describe('workflow inference', () => {
  test('observes pairs, first and current statuses (history order independent of array order)', () => {
    const g = group([issue('Done', [['In Progress', 'Done', 3], ['Open', 'In Progress', 2]])])
    expect([...g.pairs.keys()].map((k) => k.replace('\0', '>'))).toEqual(['Open>In Progress', 'In Progress>Done'])
    expect([...g.first.keys()]).toEqual(['Open'])
    expect([...g.current.keys()]).toEqual(['Done'])
  })

  test('ignores non-status items and issues without history use the current status as first', () => {
    const i = issue('Open', [])
    i.history.push({ at: at(1), author: null, field: 'priority', from: 'Low', to: 'High' })
    const g = group([i])
    expect(g.pairs.size).toBe(0)
    expect([...g.first.keys()]).toEqual(['Open'])
  })

  test('initial status is the most common first status; initial transition has null from', () => {
    const g = group([
      issue('Done', [['Open', 'Done', 2]]), issue('Done', [['Open', 'Done', 2]]), issue('Done', [['Backlog', 'Done', 2]]),
    ])
    const plan = inferWorkflow(g, null)
    expect(plan.initial).toBe('Open')
    const init = plan.transitions.filter((t) => t.from === null)
    expect(init).toEqual([{ name: 'Create', from: null, to: 'Open' }])
  })

  test('terminal status gets reopen paths: every status connects to every other', () => {
    const g = group([issue('Done', [['Open', 'In Progress', 2], ['In Progress', 'Done', 3]])])
    const plan = inferWorkflow(g, null)
    const pairs = plan.transitions.filter((t) => t.from).map((t) => `${t.from}>${t.to}`).sort()
    expect(pairs).toHaveLength(6) // 3 statuses fully connected
    expect(pairs).toContain('Done>Open')
  })

  test('no terminal status: only observed pairs are used', () => {
    const g = group([issue('Open', [['Open', 'In Progress', 2], ['In Progress', 'Open', 3]])])
    const plan = inferWorkflow(g, null)
    expect(plan.transitions.filter((t) => t.from).map((t) => `${t.from}>${t.to}`).sort()).toEqual(['In Progress>Open', 'Open>In Progress'])
  })

  test('current status without any history is part of the workflow', () => {
    const g = group([issue('Blocked', [])])
    const plan = inferWorkflow(g, null)
    expect(plan.statuses).toEqual(['Blocked'])
    expect(plan.initial).toBe('Blocked')
  })

  test('transition names are unique per workflow', () => {
    const g = group([issue('Done', [['Open', 'In Progress', 2], ['Review', 'In Progress', 3], ['In Progress', 'Done', 4]])])
    const names = inferWorkflow(g, null).transitions.map((t) => t.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('to done')
  })

  test('uniqueTransitionName falls back to qualified names', () => {
    const taken = new Set<string>()
    expect(uniqueTransitionName('Done', 'Open', taken)).toBe('To Done')
    expect(uniqueTransitionName('Done', 'Review', taken)).toBe('To Done (from Review)')
    expect(uniqueTransitionName('Done', 'Review', taken)).toBe('To Done (from Review) 2')
  })
})

describe('real Jira workflows', () => {
  const cloud = {
    id: { name: 'Software workflow' },
    statuses: [{ id: '1', name: 'Open', statusCategory: 'TODO' }, { id: '2', name: 'Done', statusCategory: 'DONE' }, { id: '3', name: 'In Progress' }],
    transitions: [
      { name: 'Create', type: 'initial', from: [], to: '1' },
      { name: 'Start Progress', type: 'directed', from: ['1'], to: '3' },
      { name: 'Resolve', type: 'directed', from: ['3'], to: '2' },
      { name: 'Reopen', type: 'global', from: [], to: '1' },
    ],
  }

  test('parses ids to names and expands global transitions', () => {
    const w = parseRealWorkflow(cloud)!
    expect(w.name).toBe('Software workflow')
    expect(w.transitions).toContainEqual({ name: 'Create', from: null, to: 'Open' })
    expect(w.transitions).toContainEqual({ name: 'Start Progress', from: 'Open', to: 'In Progress' })
    expect(w.transitions.filter((t) => t.name === 'Reopen').map((t) => t.from).sort()).toEqual(['Done', 'In Progress'])
  })

  test('returns null for payloads without transitions', () => {
    expect(parseRealWorkflow({ name: 'x' })).toBeNull()
    expect(parseRealWorkflow({ name: 'x', statuses: [], transitions: [] })).toBeNull()
  })

  test('picks a workflow that covers observed statuses and keeps real names; no reopen completion', () => {
    const g = group([issue('Done', [['Open', 'In Progress', 2], ['In Progress', 'Done', 3]])])
    const real = parseRealWorkflow(cloud)!
    const other = parseRealWorkflow({ id: { name: 'Other' }, statuses: [{ id: '9', name: 'Foo' }], transitions: [{ name: 't', type: 'directed', from: ['9'], to: '9' }] })!
    const picked = pickRealWorkflow(g, [other, real])
    expect(picked?.name).toBe('Software workflow')
    const plan = inferWorkflow(g, picked)
    expect(plan.source).toBe('Software workflow')
    expect(plan.transitions.find((t) => t.from === 'Open' && t.to === 'In Progress')?.name).toBe('Start Progress')
    expect(plan.transitions.filter((t) => t.from === null)).toHaveLength(1)
  })

  test('no candidate covers an unknown status', () => {
    const g = group([issue('Weird', [])])
    expect(pickRealWorkflow(g, [parseRealWorkflow(cloud)!])).toBeNull()
  })
})
