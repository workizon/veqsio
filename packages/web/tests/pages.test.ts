import { describe, test, expect } from 'bun:test'
import { ancestorIds, buildPageTree, linkIssueKeys, renderPage, slugify, snippetParts, versionSummary, visibleRows, withHeadingIds, type PageSummary } from '../lib/pages'

const p = (id: number, parentId: number | null, position: number, title = `P${id}`): PageSummary => ({
  id, parentId, position, title, projectKey: null, locked: false, archived: false, version: 1, author: null, createdAt: '', updatedAt: '',
})

describe('page tree', () => {
  test('nests, orders siblings and keeps orphans at the top', () => {
    const tree = buildPageTree([p(1, null, 1, 'B'), p(2, null, 0, 'A'), p(3, 2, 1, 'z'), p(4, 2, 0, 'y'), p(5, 77, 0, 'orphan')])
    expect(tree.map((n) => n.id)).toEqual([2, 5, 1])
    expect(tree[0].children.map((n) => n.id)).toEqual([4, 3])
  })

  test('ancestors and visible rows follow the expanded set', () => {
    const pages = [p(1, null, 0), p(2, 1, 0), p(3, 2, 0), p(4, null, 1)]
    expect(ancestorIds(pages, 3)).toEqual([2, 1])
    expect(ancestorIds(pages, 4)).toEqual([])
    const tree = buildPageTree(pages)
    expect(visibleRows(tree, new Set()).map((r) => r.node.id)).toEqual([1, 4])
    expect(visibleRows(tree, new Set([1, 2])).map((r) => [r.node.id, r.depth])).toEqual([[1, 0], [2, 1], [3, 2], [4, 0]])
  })

  test('a self-parent or cycle does not hang', () => {
    expect(buildPageTree([p(1, 1, 0)]).map((n) => n.id)).toEqual([1])
    expect(ancestorIds([p(1, 2, 0), p(2, 1, 0)], 1).length).toBeLessThanOrEqual(1)
  })
})

describe('headings and table of contents', () => {
  test('slugify', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('Über uns')).toBe('uber-uns')
    expect(slugify('!!!')).toBe('section')
  })

  test('adds anchors and builds the toc; duplicate titles get a suffix', () => {
    const { html, toc } = withHeadingIds('<h1>Intro</h1>\n<p>x</p>\n<h2>Setup <code>x</code></h2>\n<h2>Setup <code>x</code></h2>\n<h3>A &amp; B</h3>')
    expect(toc).toEqual([
      { id: 'pg-intro', text: 'Intro', level: 1 },
      { id: 'pg-setup-x', text: 'Setup x', level: 2 },
      { id: 'pg-setup-x-2', text: 'Setup x', level: 2 },
      { id: 'pg-a-b', text: 'A & B', level: 3 },
    ])
    expect(html).toContain('<h1 id="pg-intro">Intro</h1>')
    expect(html).toContain('<h2 id="pg-setup-x-2">')
  })

  test('renderPage works on Markdown and never lets raw HTML through', () => {
    const { html, toc } = renderPage('# Title\n\n## <script>alert(1)</script>\n\ntext')
    expect(toc.map((t) => t.level)).toEqual([1, 2])
    expect(html).not.toContain('<script>')
  })
})

describe('issue key links', () => {
  test('links keys in text but not inside links or code', () => {
    const html = '<p>See PROJ-123 and <a href="/x">PROJ-9</a> and <code>PROJ-5</code></p><pre><code>PROJ-6</code></pre><p>PROJ-7.</p>'
    const out = linkIssueKeys(html)
    expect(out).toContain('<a href="/issues/PROJ-123" class="rt-issue-key">PROJ-123</a>')
    expect(out).toContain('<a href="/x">PROJ-9</a>')
    expect(out).toContain('<code>PROJ-5</code>')
    expect(out).toContain('<pre><code>PROJ-6</code></pre>')
    expect(out).toContain('>PROJ-7</a>.')
  })

  test('restricting to known projects leaves UTF-8 and ISO-8601 alone', () => {
    const out = linkIssueKeys('<p>UTF-8 ISO-8601 TEST-4 lower-12</p>', new Set(['TEST']))
    expect(out).toBe('<p>UTF-8 ISO-8601 <a href="/issues/TEST-4" class="rt-issue-key">TEST-4</a> lower-12</p>')
  })

  test('renderPage links keys end to end', () => {
    expect(renderPage('Fix TEST-12 soon', new Set(['TEST'])).html).toContain('href="/issues/TEST-12"')
  })
})

describe('small formatters', () => {
  test('snippet parts', () => {
    expect(snippetParts('a [[b]] c [[d]]')).toEqual([
      { text: 'a ', match: false }, { text: 'b', match: true }, { text: ' c ', match: false }, { text: 'd', match: true },
    ])
    expect(snippetParts('plain')).toEqual([{ text: 'plain', match: false }])
  })
  test('version summary', () => {
    expect(versionSummary(0, 0)).toBe('no text change')
    expect(versionSummary(3, 1)).toBe('+3 -1 lines')
    expect(versionSummary(1, 0)).toBe('+1 line')
  })
})
