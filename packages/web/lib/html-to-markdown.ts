/**
 * Safe HTML -> Markdown conversion for paste handling (pure module).
 *
 * The pasted HTML is parsed in a detached document (DOMParser) and WALKED; it is never inserted into
 * the page. Only a fixed set of elements is understood, everything else keeps just its text.
 * script/style/iframe/etc. are dropped with their content, all event/style attributes are ignored
 * (style is only read for bold/italic/strike hints), and links/images are filtered by URL allowlist.
 */

// Minimal structural DOM typing so the module works with the browser DOM and with linkedom in tests.
interface N {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<N>;
  getAttribute?(name: string): string | null;
}

export type HtmlParser = (html: string) => { body: N | null };

const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'TITLE', 'SVG', 'CANVAS', 'AUDIO', 'VIDEO', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA']);
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DETAILS', 'SUMMARY', 'DL', 'DT', 'DD', 'CENTER']);
const RICH_TAGS = /<(table|ul|ol|h[1-6]|pre|blockquote|a\s|img|strong|b[\s>]|em|i[\s>]|code|del|s[\s>]|strike|hr)/i;

function attr(n: N, name: string): string {
  return (n.getAttribute?.(name) ?? '') || '';
}

function styleHas(n: N, re: RegExp): boolean {
  return re.test(attr(n, 'style'));
}

function isSafeHref(h: string): boolean {
  const u = h.trim();
  return !/[\u0000-\u001f\u007f\s]/.test(u) && /^(https?:\/\/|mailto:)\S/i.test(u);
}

function isSafeSrc(s: string): boolean {
  const u = s.trim();
  return !/[\u0000-\u001f\u007f\s]/.test(u) && (/^https?:\/\/\S/i.test(u) || /^\/(?!\/)/.test(u));
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_\[\]<>])/g, '\\$1').replace(/^(\s*)([#>+-])(\s)/, '$1\\$2$3').replace(/^(\s*\d+)\.(\s|$)/, '$1\\.$2');
}

function wrap(mark: string, inner: string): string {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function childrenOf(n: N): N[] {
  return Array.from(n.childNodes);
}

function inlineOf(n: N, ctx: { code: boolean }): string {
  if (n.nodeType === 3) {
    const t = (n.textContent || '').replace(/[\s\u00a0]+/g, ' ');
    return ctx.code ? t : escapeMarkdown(t);
  }
  if (n.nodeType !== 1) return '';
  const tag = n.nodeName.toUpperCase();
  if (SKIP.has(tag)) return '';
  const kids = () => childrenOf(n).map((c) => inlineOf(c, ctx)).join('');
  switch (tag) {
    case 'BR':
      return '\n';
    case 'B':
    case 'STRONG':
      return styleHas(n, /font-weight:\s*(normal|400)/i) ? kids() : wrap('**', kids());
    case 'I':
    case 'EM':
    case 'CITE':
      return wrap('*', kids());
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrap('~~', kids());
    case 'CODE':
    case 'KBD':
    case 'TT':
    case 'SAMP': {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      return t ? '`' + t.replace(/`/g, "'") + '`' : '';
    }
    case 'A': {
      const inner = kids();
      const href = attr(n, 'href');
      if (!isSafeHref(href) || !inner.trim()) return inner;
      return `[${inner.trim()}](${href.trim().replace(/[()]/g, encodeURIComponent)})`;
    }
    case 'IMG': {
      const src = attr(n, 'src');
      const alt = attr(n, 'alt').replace(/[\[\]\n]/g, ' ').trim();
      return isSafeSrc(src) ? `![${alt}](${src.trim().replace(/[()]/g, encodeURIComponent)})` : alt ? escapeMarkdown(alt) : '';
    }
    case 'INPUT':
      return '';
    case 'SPAN':
    case 'FONT':
    case 'U':
    case 'MARK':
    case 'SMALL':
    case 'SUB':
    case 'SUP':
    default: {
      let out = kids();
      if (tag === 'SPAN') {
        if (styleHas(n, /font-weight:\s*(bold|[6-9]00)/i)) out = wrap('**', out);
        if (styleHas(n, /font-style:\s*italic/i)) out = wrap('*', out);
        if (styleHas(n, /text-decoration[^;]*line-through/i)) out = wrap('~~', out);
      }
      return out;
    }
  }
}

function cleanInline(s: string): string {
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ');
}

function cellText(n: N): string {
  // Cell content on one line: block boundaries and <br> become spaces (the renderer escapes raw <br>).
  const walk = (x: N): string => {
    if (x.nodeType === 3) return escapeMarkdown((x.textContent || '').replace(/[\s\u00a0]+/g, ' '));
    if (x.nodeType !== 1) return '';
    const tag = x.nodeName.toUpperCase();
    if (SKIP.has(tag)) return '';
    if (tag === 'BR') return ' ';
    if (tag === 'TABLE') return ' ' + (x.textContent || '').replace(/\s+/g, ' ').trim() + ' ';
    if (BLOCK.has(tag) || tag === 'LI' || tag === 'UL' || tag === 'OL' || /^H[1-6]$/.test(tag) || tag === 'PRE' || tag === 'BLOCKQUOTE') {
      return ' ' + childrenOf(x).map(walk).join('') + ' ';
    }
    if (tag === 'B' || tag === 'STRONG' || tag === 'I' || tag === 'EM' || tag === 'A' || tag === 'CODE' || tag === 'DEL' || tag === 'S' || tag === 'STRIKE' || tag === 'IMG' || tag === 'SPAN') {
      // Reuse inline conversion but flatten any newline.
      return inlineOf(x, { code: false });
    }
    return childrenOf(x).map(walk).join('');
  };
  return childrenOf(n).map(walk).join('').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function rowsOf(table: N): N[] {
  const rows: N[] = [];
  const visit = (n: N) => {
    for (const c of childrenOf(n)) {
      if (c.nodeType !== 1) continue;
      const t = c.nodeName.toUpperCase();
      if (t === 'TR') rows.push(c);
      else if (t === 'THEAD' || t === 'TBODY' || t === 'TFOOT') visit(c);
    }
  };
  visit(table);
  return rows;
}

export function tableToMarkdown(table: N): string {
  const grid: string[][] = [];
  for (const tr of rowsOf(table)) {
    const row: string[] = [];
    for (const cell of childrenOf(tr)) {
      if (cell.nodeType !== 1) continue;
      const t = cell.nodeName.toUpperCase();
      if (t !== 'TD' && t !== 'TH') continue;
      const span = Math.min(Math.max(parseInt(attr(cell, 'colspan'), 10) || 1, 1), 50);
      row.push(cellText(cell));
      for (let i = 1; i < span; i++) row.push(''); // merged cells: content in the first column
    }
    if (row.some((c) => c !== '') || row.length) grid.push(row);
  }
  const live = grid.filter((r) => r.length > 0);
  if (!live.length) return '';
  const width = Math.min(Math.max(...live.map((r) => r.length)), 100);
  const fmt = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] || ' ').join(' | ')} |`;
  const lines = [fmt(live[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...live.slice(1).map(fmt)];
  return lines.join('\n');
}

function listToMarkdown(list: N, depth: number): string {
  const ordered = list.nodeName.toUpperCase() === 'OL';
  let idx = parseInt(attr(list, 'start'), 10) || 1;
  const lines: string[] = [];
  for (const li of childrenOf(list)) {
    if (li.nodeType !== 1 || li.nodeName.toUpperCase() !== 'LI') continue;
    let text = '';
    const nested: string[] = [];
    let task = '';
    for (const c of childrenOf(li)) {
      const t = c.nodeType === 1 ? c.nodeName.toUpperCase() : '';
      if (t === 'UL' || t === 'OL') nested.push(listToMarkdown(c, depth + 1));
      else if (t === 'INPUT' && attr(c, 'type').toLowerCase() === 'checkbox') task = c.getAttribute?.('checked') != null ? '[x] ' : '[ ] ';
      else if (t === 'P' || t === 'DIV') text += ' ' + cleanInline(childrenOf(c).map((x) => inlineOf(x, { code: false })).join('')).replace(/\n/g, ' ');
      else text += inlineOf(c, { code: false });
    }
    text = cleanInline(text).replace(/\n/g, ' ').trim();
    const marker = ordered ? `${idx++}.` : '-';
    lines.push(`${'  '.repeat(depth)}${marker} ${task}${text}`);
    for (const n of nested) lines.push(n);
  }
  return lines.join('\n');
}

const BLOCKISH = /^(TABLE|UL|OL|PRE|BLOCKQUOTE|H[1-6]|HR|P|DIV)$/;
function hasBlockDescendant(n: N): boolean {
  return childrenOf(n).some((x) => x.nodeType === 1 && !SKIP.has(x.nodeName.toUpperCase()) && (BLOCKISH.test(x.nodeName.toUpperCase()) || hasBlockDescendant(x)));
}

function blocksOf(n: N): string[] {
  const out: string[] = [];
  let inlineBuf = '';
  const flush = () => {
    const t = cleanInline(inlineBuf).trim();
    if (t) out.push(t);
    inlineBuf = '';
  };
  for (const c of childrenOf(n)) {
    if (c.nodeType === 3) {
      inlineBuf += inlineOf(c, { code: false });
      continue;
    }
    if (c.nodeType !== 1) continue;
    const tag = c.nodeName.toUpperCase();
    if (SKIP.has(tag)) continue;
    if (/^H[1-6]$/.test(tag)) {
      flush();
      const t = cleanInline(childrenOf(c).map((x) => inlineOf(x, { code: false })).join('')).replace(/\n/g, ' ').trim();
      if (t) out.push('#'.repeat(Number(tag[1])) + ' ' + t);
    } else if (tag === 'TABLE') {
      flush();
      const t = tableToMarkdown(c);
      if (t) out.push(t);
    } else if (tag === 'UL' || tag === 'OL') {
      flush();
      const t = listToMarkdown(c, 0);
      if (t) out.push(t);
    } else if (tag === 'PRE') {
      flush();
      const code = (c.textContent || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/```/g, "'''");
      if (code.trim()) out.push('```\n' + code + '\n```');
    } else if (tag === 'BLOCKQUOTE') {
      flush();
      const inner = blocksOf(c).join('\n\n');
      if (inner) out.push(inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'));
    } else if (tag === 'HR') {
      flush();
      out.push('---');
    } else if (tag === 'P' || BLOCK.has(tag) || tag === 'LI') {
      flush();
      // Blocks nested in blocks (div > table) are handled recursively.
      const hasBlockChild = childrenOf(c).some((x) => x.nodeType === 1 && (BLOCK.has(x.nodeName.toUpperCase()) || /^(TABLE|UL|OL|PRE|BLOCKQUOTE|H[1-6]|HR)$/.test(x.nodeName.toUpperCase())));
      if (hasBlockChild) out.push(...blocksOf(c));
      else {
        const t = cleanInline(childrenOf(c).map((x) => inlineOf(x, { code: false })).join('')).trim();
        if (t) out.push(t);
      }
    } else if (hasBlockDescendant(c)) {
      // Unknown wrapper element (e.g. <google-sheets-html-origin>, <b id="docs-internal-guid">): look inside.
      flush();
      out.push(...blocksOf(c));
    } else {
      inlineBuf += inlineOf(c, { code: false });
    }
  }
  flush();
  return out;
}

/** True if the HTML has structure worth converting (as opposed to plain styled text from an editor). */
export function htmlHasRichStructure(html: string): boolean {
  return RICH_TAGS.test(html);
}

export function htmlHasTable(html: string): boolean {
  return /<table[\s>]/i.test(html);
}

function defaultParser(html: string) {
  return new DOMParser().parseFromString(html, 'text/html') as unknown as { body: N | null };
}

/** Convert pasted HTML to Markdown. `parse` is injectable for tests (browser: DOMParser). */
export function htmlToMarkdown(html: string, parse: HtmlParser = defaultParser): string {
  if (!html || html.length > 2_000_000) return '';
  const doc = parse(html);
  if (!doc.body) return '';
  return blocksOf(doc.body).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Parse tab-separated text (Excel/Sheets "text/plain" clipboard), honoring double-quoted cells. */
export function parseTsv(text: string): string[][] | null {
  const src = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** If the text looks like spreadsheet data (>= 2 lines, same column count >= 2), return a Markdown table. */
export function tsvToMarkdownTable(text: string): string | null {
  if (!text.includes('\t')) return null;
  const rows = parseTsv(text);
  if (!rows || rows.length < 2) return null;
  const width = rows[0].length;
  if (width < 2 || rows.some((r) => r.length !== width)) return null;
  const esc = (c: string) => escapeMarkdown(c.replace(/\s*\n\s*/g, ' ').trim()).replace(/\|/g, '\\|') || ' ';
  const fmt = (r: string[]) => `| ${r.map(esc).join(' | ')} |`;
  return [fmt(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(fmt)].join('\n');
}
