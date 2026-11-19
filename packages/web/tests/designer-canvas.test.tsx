import { describe, it, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DesignerCanvas } from '../components/workflow/designer-canvas'
import { ItemListEditor } from '../components/workflow/item-list-editor'
import { autoLayout } from '../lib/workflow-graph'

const statuses = [
  { id: 1, name: 'Open', category: 'to_do' },
  { id: 2, name: 'In Progress', category: 'in_progress' },
  { id: 3, name: 'Done', category: 'done' },
]
const transitions = [
  { id: 10, name: 'Start', fromStatusId: 1, toStatusId: 2 },
  { id: 11, name: 'Finish', fromStatusId: 2, toStatusId: 3 },
  { id: 12, name: 'Reopen', fromStatusId: 3, toStatusId: 1 },
  { id: 13, name: 'Close anything', fromStatusId: null, toStatusId: 3 },
]

const render = (selected: any = null) =>
  renderToStaticMarkup(
    <DesignerCanvas
      statuses={statuses}
      transitions={transitions}
      positions={autoLayout(statuses, transitions)}
      selected={selected}
      flaggedStatusIds={new Set([3])}
      onSelect={() => {}}
      onMove={() => {}}
      onConnect={() => {}}
    />,
  )

describe('DesignerCanvas (server render)', () => {
  it('draws a labelled, keyboard-focusable node per status plus the any-status node', () => {
    const html = render()
    for (const n of ['Open', 'In Progress', 'Done']) expect(html).toContain(n)
    expect(html).toContain('aria-label="Status Open, To do.')
    expect(html).toContain('aria-label="Status In Progress, In progress.')
    expect(html).toContain('Any status')
    expect((html.match(/role="button"/g) || []).length).toBe(3 + 1 + 4) // statuses + any + transitions
  })

  it('draws every transition with an arrow head and an accessible name', () => {
    const html = render()
    expect(html).toContain('Transition Start from Open to In Progress')
    expect(html).toContain('Transition Close anything from Any status to Done')
    expect((html.match(/<polygon/g) || []).length).toBe(4)
    expect(html).toContain('stroke-dasharray="6 4"') // global transitions are dashed
  })

  it('uses theme variables only, so the dark theme applies', () => {
    const html = render()
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/)
    expect(html).toContain('var(--surface-0)')
    expect(html).toContain('var(--status-done)')
  })

  it('highlights the selection and flags statuses with warnings', () => {
    const html = render({ kind: 'transition', id: 10 })
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('var(--brand-500)')
    expect(html).toContain('This status has warnings')
  })

  it('shows an empty-state hint without statuses', () => {
    const html = renderToStaticMarkup(
      <DesignerCanvas statuses={[]} transitions={[]} positions={{}} selected={null} flaggedStatusIds={new Set()} onSelect={() => {}} onMove={() => {}} onConnect={() => {}} />,
    )
    expect(html).toContain('no statuses yet')
  })
})

describe('ItemListEditor (server render)', () => {
  const defs = [
    { type: 'user_in_group', label: 'User is in group', description: 'Only group members.', params: [{ name: 'group_id', label: 'Group', type: 'group', required: true }] },
    { type: 'add_comment', label: 'Add comment', description: 'Adds a comment.', params: [{ name: 'body', label: 'Comment', type: 'text', required: true }] },
  ]
  it('renders typed inputs, required hints and flags unsupported legacy items', () => {
    const html = renderToStaticMarkup(
      <ItemListEditor
        label="Condition"
        defs={defs}
        lookups={{ group: [{ id: 1, name: 'devs' }] }}
        items={[{ type: 'user_in_group' }, { type: 'custom_script' }]}
        onChange={() => {}}
      />,
    )
    expect(html).toContain('devs')
    expect(html).toContain('Required: Group')
    expect(html).toContain('Unsupported type')
    expect(html).toContain('Remove condition 2')
    expect(html).toContain('Add condition')
  })
})
