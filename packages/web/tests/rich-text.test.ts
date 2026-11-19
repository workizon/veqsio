import { describe, test, expect } from 'bun:test';
import { renderRichText, renderMarkdown, wikiToMarkdown, looksLikeWikiMarkup } from '../lib/rich-text';

describe('markdown rendering', () => {
  test('basic constructs', () => {
    const html = renderRichText('# Title\n\n**b** *i* ~~s~~ `c`\n\n- a\n- b\n\n1. x\n\n> quote\n\n```js\nlet a = 1 < 2;\n```');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('<s>s</s>');
    expect(html).toContain('<code>c</code>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('1 &lt; 2');
  });
  test('task lists', () => {
    const html = renderRichText('- [ ] todo\n- [x] done');
    expect(html).toContain('<input type="checkbox" disabled>');
    expect(html).toContain('<input type="checkbox" disabled checked>');
  });
  test('tables are wrapped for horizontal scroll', () => {
    const html = renderRichText('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('rt-table-wrap');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>2</td>');
  });
  test('links get target and rel; mentions are spans', () => {
    const html = renderRichText('see [x](https://example.com) and @alice');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('<span class="rt-mention">@alice</span>');
  });
  test('images: attachment/relative and https allowed', () => {
    expect(renderRichText('![a](/rest/api/2/attachment/1)')).toContain('<img src="/rest/api/2/attachment/1"');
    expect(renderRichText('![a](https://x.test/a.png)')).toContain('<img src="https://x.test/a.png"');
  });
});

describe('Jira wiki conversion', () => {
  test('detection', () => {
    expect(looksLikeWikiMarkup('h1. Title\n\n* a')).toBe(true);
    expect(looksLikeWikiMarkup('# Title\n\n**bold**')).toBe(false);
    expect(looksLikeWikiMarkup('just text')).toBe(false);
  });
  test('headings, emphasis, mono, lists', () => {
    const md = wikiToMarkdown('h2. Head\n*bold* and _it_ and -gone- {{mono}}\n* one\n** two\n# n1\n## n2');
    expect(md).toContain('## Head');
    expect(md).toContain('**bold** and *it* and ~~gone~~ `mono`');
    expect(md).toContain('- one\n  - two');
    expect(md).toContain('1. n1\n  1. n2');
  });
  test('code blocks keep content verbatim', () => {
    const md = wikiToMarkdown('{code:java}\nint *x* = 1;\n{code}\nafter');
    expect(md).toContain('```java\nint *x* = 1;\n```');
    const html = renderRichText('{code}\n<script>alert(1)</script>\n{code}');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  test('links, mentions, images', () => {
    const md = wikiToMarkdown('[text|https://a.test/x] [https://b.test] [~jdoe] !pic.png! !https://c.test/i.png!', {
      resolveAttachment: (n) => (n === 'pic.png' ? '/rest/api/2/attachment/7' : null),
    });
    expect(md).toContain('[text](https://a.test/x)');
    expect(md).toContain('[https://b.test](https://b.test)');
    expect(md).toContain('@jdoe');
    expect(md).toContain('![pic.png](/rest/api/2/attachment/7)');
    expect(md).toContain('![](https://c.test/i.png)');
  });
  test('unresolved attachment image does not become an img', () => {
    const html = renderRichText('h1. t\n!secret.png!');
    expect(html).not.toContain('<img');
  });
  test('tables render as HTML tables', () => {
    const html = renderRichText('||Name||Role||\n|Ann|*Dev*|\n|Bob|[x|https://e.test]|');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td><strong>Dev</strong></td>');
    expect(html).toContain('href="https://e.test"');
    expect(html.match(/<tr>/g)?.length).toBe(3);
  });
  test('quote, bq, rule, panel', () => {
    const html = renderRichText('{quote}\nhello\n{quote}\nbq. one\n----\n{panel:title=x}\np\n{panel}');
    expect(html.match(/<blockquote>/g)?.length).toBe(3);
    expect(html).toContain('<hr>');
  });
});

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](java\tscript:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](&#x6A;avascript&colon;alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x]( javascript:alert(1))',
  '[x](//evil.test/x)',
  '![x](javascript:alert(1))',
  '![x](data:image/svg+xml,<svg onload=alert(1)>)',
  '![x](//evil.test/a.png)',
  '![x"onerror="alert(1)](https://ok.test/a.png)',
  '![a](https://ok.test/a.png"onerror="alert(1))',
  '<<script>script>alert(1)<</script>/script>',
  '<details open ontoggle=alert(1)>',
  '<style>@import "javascript:alert(1)"</style>',
  '[a](https://ok.test/"onmouseover="alert(1))',
  '`<script>alert(1)</script>`',
  '[[x](javascript:alert(1))](https://ok.test)',
  '<https://ok.test"onclick="alert(1)>',
  '<javascript:alert(1)>',
  'javascript:alert(1)',
  '@"><img src=x onerror=alert(1)>',
  '- [ ] <img src=x onerror=alert(1)>',
  '| <script>alert(1)</script> | b |\n| --- | --- |\n| x | y |',
];
const WIKI_PAYLOADS = [
  'h1. <script>alert(1)</script>',
  '[click|javascript:alert(1)]',
  '[click|data:text/html,<script>alert(1)</script>]',
  '!javascript:alert(1)!',
  '!x.png|onerror=alert(1)!',
  '{code}</code><script>alert(1)</script>{code}',
  '||<img src=x onerror=alert(1)>||b||\n|c|d|',
  '{color:red}<script>alert(1)</script>{color}',
  '[~<img src=x onerror=alert(1)>]',
];

function assertSafe(html: string) {
  // Only our fixed tag allowlist, no event-handler attributes, only safe URL schemes in href/src.
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
  const allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'a', 'img', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'input']);
  for (const t of tags) expect(allowed.has(t)).toBe(true);
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
  for (const m of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    expect(m[2]).toMatch(/^(https?:\/\/|mailto:|\/(?!\/)|#)/i);
  }
}

describe('XSS', () => {
  for (const p of [...PAYLOADS, ...WIKI_PAYLOADS]) {
    test(`safe: ${JSON.stringify(p).slice(0, 60)}`, () => {
      assertSafe(renderRichText(p));
      assertSafe(renderRichText(p, { format: 'wiki' }));
      assertSafe(renderRichText(`h1. t\n${p}`));
      assertSafe(renderMarkdown(`# t\n\n${p}\n\n> ${p}\n\n- ${p}`));
    });
  }
  test('raw html is escaped, not passed through', () => {
    expect(renderRichText('<b onclick="x()">hi</b>')).toContain('&lt;b onclick');
  });
  test('external links carry rel/target; javascript links are plain text', () => {
    const html = renderRichText('[x](javascript:alert(1)) [y](https://a.test)');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
  test('huge input does not blow up', () => {
    expect(renderRichText('a'.repeat(500_000)).length).toBeLessThan(250_000);
  });
});
