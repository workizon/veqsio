/**
 * Pure helpers for the Pages (wiki) UI: the page tree, heading anchors with a table of contents, issue key links and
 * the search snippet. No DOM, no React. The HTML helpers work on the output of lib/rich-text (already escaped).
 */
import { renderRichText } from './rich-text'

/* ------------------------------ tree ------------------------------ */

export interface PageSummary {
  id: number
  title: string
  parentId: number | null
  position: number
  projectKey: string | null
  locked: boolean
  archived: boolean
  version: number
  author: { id: number; displayName: string | null } | null
  createdAt: string
  updatedAt: string
}

export interface PageNode extends PageSummary { children: PageNode[] }

const cmp = (a: PageSummary, b: PageSummary) =>
  a.position - b.position || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.id - b.id

/** Nested tree; siblings sorted by position, then title, then id. Pages whose parent is missing become roots. */
export function buildPageTree(pages: PageSummary[]): PageNode[] {
  const nodes = new Map<number, PageNode>(pages.map((p) => [p.id, { ...p, children: [] }]))
  const roots: PageNode[] = []
  for (const p of [...pages].sort(cmp)) {
    const node = nodes.get(p.id)!
    const parent = p.parentId !== null && p.parentId !== p.id ? nodes.get(p.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** Ids of the pages above `id`, nearest parent first (to expand the tree down to the open page). */
export function ancestorIds(pages: PageSummary[], id: number): number[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const out: number[] = []
  const seen = new Set([id])
  let cur = byId.get(id)?.parentId ?? null
  while (cur !== null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    cur = byId.get(cur)!.parentId
  }
  return out
}

/** Visible rows of a (partly collapsed) tree, depth first. */
export function visibleRows(roots: PageNode[], expanded: Set<number>): Array<{ node: PageNode; depth: number }> {
  const rows: Array<{ node: PageNode; depth: number }> = []
  const walk = (list: PageNode[], depth: number) => {
    for (const n of list) {
      rows.push({ node: n, depth })
      if (n.children.length && expanded.has(n.id)) walk(n.children, depth + 1)
    }
  }
  walk(roots, 0)
  return rows
}

/* ------------------------------ headings and table of contents ------------------------------ */

export interface TocEntry { id: string; text: string; level: number }

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")

export function slugify(text: string): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  return s || 'section'
}

/** Adds `id="pg-<slug>"` to every heading of rendered HTML and returns the table of contents (duplicate titles get -2, -3, ...). */
export function withHeadingIds(html: string): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = []
  const used = new Map<string, number>()
  const out = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim()
    const base = `pg-${slugify(text)}`
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    const id = n === 1 ? base : `${base}-${n}`
    toc.push({ id, text, level: Number(lvl) })
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`
  })
  return { html: out, toc }
}

/* ------------------------------ issue keys ------------------------------ */

const KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,9})\b/g

/**
 * Turns issue keys (PROJ-123) in the text of rendered HTML into links to the issue. Text inside links, code and
 * preformatted blocks is left alone. When `projectKeys` is given only those projects' keys become links (so "UTF-8"
 * or "ISO-8601" stay plain text).
 */
export function linkIssueKeys(html: string, projectKeys?: ReadonlySet<string>): string {
  let skip = 0
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        const m = /^<(\/?)(a|code|pre)\b/i.exec(part)
        if (m) skip = Math.max(0, skip + (m[1] ? -1 : 1))
        return part
      }
      if (skip > 0 || !part) return part
      return part.replace(KEY_RE, (whole, project: string, num: string) =>
        projectKeys && !projectKeys.has(project) ? whole : `<a href="/issues/${project}-${num}" class="rt-issue-key">${whole}</a>`)
    })
    .join('')
}

/** Markdown (or Jira wiki) to safe HTML with heading anchors and issue key links, plus the table of contents. */
export function renderPage(body: string, projectKeys?: ReadonlySet<string>): { html: string; toc: TocEntry[] } {
  const { html, toc } = withHeadingIds(renderRichText(body))
  return { html: linkIssueKeys(html, projectKeys), toc }
}

/* ------------------------------ search snippet ------------------------------ */

/** Splits a server snippet where matches are wrapped in [[ ]] into text and highlighted parts. */
export function snippetParts(snippet: string): Array<{ text: string; match: boolean }> {
  const out: Array<{ text: string; match: boolean }> = []
  const re = /\[\[(.*?)\]\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(snippet))) {
    if (m.index > last) out.push({ text: snippet.slice(last, m.index), match: false })
    out.push({ text: m[1], match: true })
    last = m.index + m[0].length
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), match: false })
  return out
}

/** Short summary of a version for the history list, e.g. "+3 -1 lines". */
export function versionSummary(added: number, removed: number): string {
  if (!added && !removed) return 'no text change'
  return [added ? `+${added}` : '', removed ? `-${removed}` : ''].filter(Boolean).join(' ') + ` line${added + removed === 1 ? '' : 's'}`
}
