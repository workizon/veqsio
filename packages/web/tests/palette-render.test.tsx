import { describe, test, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PaletteView } from '../components/command-palette'
import { ShortcutHelp } from '../components/keyboard-shortcuts'
import { actionItems, buildGroups, issueItem, pageItems, projectItem } from '../lib/palette'
import { SHORTCUTS, helpSections } from '../lib/shortcuts'

const local = [...pageItems(), ...actionItems({ issueKey: 'DEMO-3' }), projectItem({ key: 'DEMO', name: 'Demo project' })]

const view = (over: Partial<Parameters<typeof PaletteView>[0]> = {}) => {
  const query = over.query ?? ''
  const groups = over.groups ?? buildGroups({ query, local, remote: [issueItem('DEMO-12', 'Login page crashes', 'Open')] })
  return renderToStaticMarkup(<PaletteView query={query} groups={groups} activeIndex={0} loading={false} error={false} {...over} />)
}

describe('command palette markup', () => {
  test('is a combobox controlling a listbox, with the active option referenced', () => {
    const html = view({ query: 'demo' })
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-controls="command-palette-listbox"')
    expect(html).toContain('aria-activedescendant="command-palette-option-0"')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('id="command-palette-option-0"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-selected="false"')
  })

  test('groups have labelled headers', () => {
    const html = view({ query: 'demo' })
    expect(html).toContain('role="group"')
    expect(html).toContain('Projects')
    expect(html).toContain('Issues')
  })

  test('highlights the matched characters', () => {
    const html = view({ query: 'login' })
    expect(html).toMatch(/<mark class="veqsio-hl">[Ll]ogin<\/mark>/)
  })

  test('empty query lists actions and pages with shortcut hints', () => {
    const html = view({ query: '' })
    expect(html).toContain('Create issue')
    expect(html).toContain('Assign DEMO-3 to me')
    expect(html).toContain('Toggle dark mode')
    expect(html).toContain('Sign out')
    expect(html).toContain('<kbd class="veqsio-kbd">C</kbd>')
  })

  test('shows an empty state when nothing matches', () => {
    const html = view({ query: 'qqqzzz', groups: [] })
    expect(html).toContain('data-testid="palette-empty"')
    expect(html).toContain('No results for')
    expect(html).not.toContain('aria-activedescendant')
  })

  test('shows skeleton rows while the server answers, below local results', () => {
    const withLocal = view({ query: 'create', loading: true })
    expect(withLocal).toContain('data-testid="palette-skeleton"')
    expect(withLocal).toContain('Create</mark> issue')
    expect(withLocal).not.toContain('data-testid="palette-empty"')
    const none = view({ query: 'qqqzzz', groups: [], loading: true })
    expect(none).toContain('data-testid="palette-skeleton"')
    expect(none).not.toContain('data-testid="palette-empty"')
  })

  test('shows an error with a retry button but keeps local results', () => {
    const html = view({ query: 'create', error: true, onRetry: () => {} })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Showing local results only')
    expect(html).toContain('Retry')
    expect(html).toContain('Create</mark> issue')
  })

  test('uses theme variables only, no hard-coded colours', () => {
    const html = view({ query: 'a' })
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/rgb\(/)
  })
})

describe('shortcut overlay markup', () => {
  const html = renderToStaticMarkup(<ShortcutHelp sections={helpSections()} />)

  test('lists every shortcut of the table, one row each', () => {
    for (const d of SHORTCUTS) expect(html).toContain(`data-shortcut-id="${d.id}"`)
    expect((html.match(/data-shortcut-id=/g) || []).length).toBe(SHORTCUTS.length)
  })

  test('has a section per context with its label', () => {
    for (const label of ['Everywhere', 'Issue list', 'Issue view', 'Board']) expect(html).toContain(label)
  })

  test('renders chords and alternatives', () => {
    expect(html).toContain('then')
    expect(html).toContain('>or<')
    expect(html).toContain('<kbd class="veqsio-kbd">Ctrl</kbd>')
  })
})
