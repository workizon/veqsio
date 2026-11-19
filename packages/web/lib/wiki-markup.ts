/**
 * Pragmatic Jira wiki markup -> Markdown converter (pure, no dependencies).
 *
 * Covers: headings (h1.-h6.), *bold*, _italic_, -strike-, +underline+ (text kept), {{mono}},
 * {code}/{noformat}/{quote}/{panel}, bq., nested * / # / - lists, ||header|| and |cell| tables,
 * [text|url], [url], [~user], !image.png! and horizontal rules.
 * The output is Markdown that is then rendered by the (safe) Markdown renderer.
 */

export interface WikiOptions {
  /** Resolve a bare attachment file name (from `!file.png!`) to a URL. */
  resolveAttachment?: (filename: string) => string | null | undefined;
}

const WIKI_SIGNALS: RegExp[] = [
  /^h[1-6]\.\s+\S/m,
  /\{code(?::[^}]*)?\}/,
  /\{noformat\}/,
  /\{quote\}/,
  /\{panel(?::[^}]*)?\}/,
  /\{color:[^}]+\}/,
  /\{\{[^{}\n]+\}\}/,
  /^\|\|.+\|\|\s*$/m,
  /\[~[^\]\s]+\]/,
  /(^|\s)![^\s!]+?(\|[^!\n]*)?!(\s|$)/m,
  /^bq\.\s/m,
  /\[[^\]|\n]+\|(https?:\/\/|mailto:)[^\]\s]+\]/,
];
const MARKDOWN_SIGNALS: RegExp[] = [
  /^```/m,
  /^#{1,6} \S/m,
  /\*\*\S[^*\n]*\*\*/,
  /\]\((https?:|\/|#|mailto:)[^)\s]*\)/,
  /^\s*[-*] \[[ xX]\] /m,
  /^\s*\|?[ :]*-{3,}[ :]*\|/m,
  /^>\s/m,
];

/** Heuristic: does this text look like Jira wiki markup rather than Markdown? */
export function looksLikeWikiMarkup(src: string): boolean {
  if (!WIKI_SIGNALS.some((r) => r.test(src))) return false;
  return !MARKDOWN_SIGNALS.some((r) => r.test(src));
}

const PH = '\u0000';

function splitCells(row: string): string[] {
  // Split on `|` that are not inside [...] link brackets.
  const cells: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '[') depth++;
    else if (ch === ']' && depth > 0) depth--;
    if (ch === '|' && depth === 0) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function inline(text: string, opts: WikiOptions): string {
  const holds: string[] = [];
  const hold = (s: string) => {
    holds.push(s);
    return `${PH}${holds.length - 1}${PH}`;
  };
  let s = text;
  // Inline code first so its content is never touched.
  s = s.replace(/\{\{([^{}\n]+?)\}\}/g, (_m, c: string) => hold('`' + c.replace(/`/g, "'") + '`'));
  // Images: !file.png! or !file.png|width=100!
  s = s.replace(/!([^\s!|][^!|\n]*?)(?:\|[^!\n]*)?!/g, (_m, src: string) => {
    if (/^https?:\/\//i.test(src) || src.startsWith('/')) return hold(`![](${src})`);
    const url = opts.resolveAttachment?.(src);
    return url ? hold(`![${src.replace(/[\[\]]/g, '')}](${url})`) : hold(`*[image: ${src.replace(/[*_\[\]]/g, '')}]*`);
  });
  // Mentions [~user] / [~accountid:abc]
  s = s.replace(/\[~(?:accountid:)?([^\]\s]+)\]/g, (_m, u: string) => hold(`@${u}`));
  // Links [text|url] and [url]
  s = s.replace(/\[([^\]|\n]+)\|([^\]\s|]+)(?:\|[^\]]*)?\]/g, (_m, t: string, u: string) => hold(`[${t.replace(/[\[\]]/g, '')}](${u})`));
  s = s.replace(/\[((?:https?:\/\/|mailto:)[^\]\s]+)\]/g, (_m, u: string) => hold(`[${u}](${u})`));
  // Colors / anchors / misc macros: drop the macro, keep text.
  s = s.replace(/\{color(?::[^}]*)?\}/g, '').replace(/\{anchor:[^}]*\}|\{toc[^}]*\}/g, '');
  // Forced line break
  s = s.replace(/\\\\/g, '  \n');
  // Emphasis (boundary aware so snake_case and 2*3 survive)
  const B = '(^|[\\s(>"\'])';
  const A = '(?=$|[\\s).,;:!?"\'])';
  s = s.replace(new RegExp(`${B}\\*(\\S(?:[^*\\n]*?\\S)?)\\*${A}`, 'g'), '$1**$2**');
  s = s.replace(new RegExp(`${B}_(\\S(?:[^_\\n]*?\\S)?)_${A}`, 'g'), '$1*$2*');
  s = s.replace(new RegExp(`${B}-(\\S(?:[^-\\n]*?\\S)?)-${A}`, 'g'), '$1~~$2~~');
  s = s.replace(new RegExp(`${B}\\+(\\S(?:[^+\\n]*?\\S)?)\\+${A}`, 'g'), '$1$2');
  s = s.replace(new RegExp(`${B}\\?\\?(\\S(?:[^?\\n]*?\\S)?)\\?\\?${A}`, 'g'), '$1$2');
  return s.replace(new RegExp(`${PH}(\\d+)${PH}`, 'g'), (_m, i: string) => holds[Number(i)]);
}

function tableToMarkdown(rows: string[], opts: WikiOptions): string[] {
  const parsed = rows.map((r) => {
    const header = r.startsWith('||');
    const trimmed = r.trim();
    const body = header ? trimmed.replace(/^\|\|/, '').replace(/\|\|?$/, '') : trimmed.replace(/^\|/, '').replace(/\|$/, '');
    const cells = header ? body.split('||') : splitCells(body);
    return { header, cells: cells.map((c) => inline(c.trim(), opts).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')) };
  });
  const width = Math.max(...parsed.map((p) => p.cells.length));
  const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill('')];
  const line = (cells: string[]) => `| ${pad(cells).map((c) => c || ' ').join(' | ')} |`;
  const out: string[] = [];
  let start = 0;
  if (parsed[0].header) {
    out.push(line(parsed[0].cells));
    start = 1;
  } else out.push(line(Array(width).fill('')));
  out.push(`| ${Array(width).fill('---').join(' | ')} |`);
  for (const p of parsed.slice(start)) out.push(line(p.cells));
  return out;
}

export function wikiToMarkdown(src: string, opts: WikiOptions = {}): string {
  const text = src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const blocks: string[] = [];
  const stash = (s: string) => {
    blocks.push(s);
    return `\n${PH}B${blocks.length - 1}${PH}\n`;
  };
  // Block macros that protect their content
  let s = text.replace(/\{code(?::([^}]*))?\}\n?([\s\S]*?)\{code\}/g, (_m, params: string | undefined, body: string) => {
    const lang = (params || '').split('|')[0].replace(/^language=/, '').replace(/[^\w+#.=-]/g, '');
    return stash('```' + (lang && !lang.includes('=') ? lang : '') + '\n' + body.replace(/\n$/, '').replace(/```/g, "'''") + '\n```');
  });
  s = s.replace(/\{noformat(?::[^}]*)?\}\n?([\s\S]*?)\{noformat\}/g, (_m, body: string) =>
    stash('```\n' + body.replace(/\n$/, '').replace(/```/g, "'''") + '\n```'));
  const wrapQuote = (body: string) => body.trim().split('\n').map((l) => '> ' + inline(l, opts)).join('\n');
  s = s.replace(/\{quote\}\n?([\s\S]*?)\{quote\}/g, (_m, body: string) => stash(wrapQuote(body)));
  s = s.replace(/\{panel(?::[^}]*)?\}\n?([\s\S]*?)\{panel\}/g, (_m, body: string) => stash(wrapQuote(body)));

  const lines = s.split('\n');
  const out: string[] = [];
  const isTableLine = (l: string) => /^\|.*\|\s*$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ph = line.match(new RegExp(`^${PH}B(\\d+)${PH}$`));
    if (ph) {
      out.push('', blocks[Number(ph[1])], '');
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^h([1-6])\.\s*(.*)$/))) {
      out.push('', '#'.repeat(Number(m[1])) + ' ' + inline(m[2], opts), '');
    } else if ((m = line.match(/^bq\.\s*(.*)$/))) {
      out.push('', '> ' + inline(m[1], opts), '');
    } else if (/^-{4,}\s*$/.test(line)) {
      out.push('', '---', '');
    } else if (isTableLine(line)) {
      const rows = [line];
      while (i + 1 < lines.length && isTableLine(lines[i + 1])) rows.push(lines[++i]);
      out.push('', ...tableToMarkdown(rows, opts), '');
    } else if ((m = line.match(/^(\*+|#+|-)\s+(.*)$/))) {
      const marks = m[1];
      const indent = '  '.repeat(marks.length - 1);
      out.push(`${indent}${marks[0] === '#' ? '1.' : '-'} ${inline(m[2], opts)}`);
    } else {
      out.push(inline(line, opts));
    }
  }
  return out.join('\n').replace(new RegExp(`${PH}B(\\d+)${PH}`, 'g'), (_m, i: string) => blocks[Number(i)]).replace(/\n{3,}/g, '\n\n').trim();
}
