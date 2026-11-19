import { describe, test, expect } from 'bun:test';
import { parseHTML } from 'linkedom';
import { htmlToMarkdown, tsvToMarkdownTable, htmlHasTable, htmlHasRichStructure } from '../lib/html-to-markdown';
import { renderRichText } from '../lib/rich-text';

const parse = (html: string) => parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`).document as any;
const conv = (html: string) => htmlToMarkdown(html, parse);

describe('HTML table paste', () => {
  test('Excel-style table (styles, colgroup, fragment comments)', () => {
    const md = conv(`<meta charset="utf-8"><!--StartFragment--><table border=0 cellpadding=0 cellspacing=0 width=300 style='border-collapse:collapse'>
      <col width=100 span=3><tr height=20 style='height:15.0pt'><td class=xl65 style='height:15pt'>Name</td><td class=xl65>Qty</td><td>Price</td></tr>
      <tr><td>Apple</td><td align=right>3</td><td align=right>1.5</td></tr></table><!--EndFragment-->`);
    expect(md).toBe('| Name | Qty | Price |\n| --- | --- | --- |\n| Apple | 3 | 1.5 |');
  });
  test('Jira-rendered table (confluenceTable, th header, links, bold)', () => {
    const md = conv(`<div class="table-wrap"><table class="confluenceTable"><tbody>
      <tr><th class="confluenceTh">Key</th><th class="confluenceTh">Summary</th></tr>
      <tr><td class="confluenceTd"><a href="https://jira.example.com/browse/ABC-1">ABC-1</a></td><td class="confluenceTd"><b>Fix</b> the <i>thing</i> <code>x()</code></td></tr>
      </tbody></table></div>`);
    expect(md).toBe('| Key | Summary |\n| --- | --- |\n| [ABC-1](https://jira.example.com/browse/ABC-1) | **Fix** the *thing* `x()` |');
  });
  test('Google Sheets table', () => {
    const md = conv(`<google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style>
      <table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1"><colgroup><col width="100"><col width="100"></colgroup>
      <tbody><tr style="height:21px;"><td>A</td><td>B</td></tr>
      <tr><td>1</td><td><span style="font-weight:bold;">two</span></td></tr></tbody></table></google-sheets-html-origin>`);
    expect(md).toBe('| A | B |\n| --- | --- |\n| 1 | **two** |');
  });
  test('pipes, newlines and block content inside cells', () => {
    const md = conv('<table><tr><td>a|b</td><td>line1<br>line2</td></tr><tr><td><p>p1</p><p>p2</p></td><td>x</td></tr></table>');
    expect(md).toBe('| a\\|b | line1 line2 |\n| --- | --- |\n| p1 p2 | x |');
  });
  test('colspan pads columns and ragged rows are filled', () => {
    const md = conv('<table><tr><th colspan="2">Wide</th><th>C</th></tr><tr><td>1</td></tr></table>');
    expect(md).toBe('| Wide |   | C |\n| --- | --- | --- |\n| 1 |   |   |');
  });
  test('nested formatting survives a round trip through the renderer', () => {
    const md = conv('<table><tr><th>H</th></tr><tr><td><b><i>both</i></b> <del>old</del></td></tr></table>');
    const html = renderRichText(md);
    expect(html).toContain('<th>H</th>');
    expect(html).toMatch(/<em><strong>both<\/strong><\/em>|<strong><em>both<\/em><\/strong>/);
    expect(html).toContain('<s>old</s>');
  });
  test('pasted Jira HTML table and Jira wiki table render identically', () => {
    const fromWiki = renderRichText('||Key||Summary||\n|A-1|Fix|');
    const fromHtml = renderRichText(conv('<table><tr><th>Key</th><th>Summary</th></tr><tr><td>A-1</td><td>Fix</td></tr></table>'));
    expect(fromHtml).toBe(fromWiki);
  });
  test('blank lines around tables when mixed with text', () => {
    const md = conv('<p>before</p><table><tr><td>a</td><td>b</td></tr></table><p>after</p>');
    expect(md).toBe('before\n\n| a | b |\n| --- | --- |\n\nafter');
  });
});

describe('other rich HTML', () => {
  test('headings, lists, task lists, code, quotes, images, links', () => {
    const md = conv(`<h2>T</h2><p>Hello <strong>w</strong> <a href="https://a.test">l</a></p><ul><li>a<ul><li>b</li></ul></li><li><input type="checkbox" checked> done</li></ul>
      <ol><li>x</li><li>y</li></ol><pre>let a = 1;\n  b</pre><blockquote><p>q</p></blockquote><img src="https://i.test/a.png" alt="pic"><hr>`);
    expect(md).toContain('## T');
    expect(md).toContain('Hello **w** [l](https://a.test)');
    expect(md).toContain('- a\n  - b');
    expect(md).toContain('- [x] done');
    expect(md).toContain('1. x\n2. y');
    expect(md).toContain('```\nlet a = 1;\n  b\n```');
    expect(md).toContain('> q');
    expect(md).toContain('![pic](https://i.test/a.png)');
    expect(md).toContain('---');
  });
  test('unknown tags keep text, markdown specials are escaped', () => {
    expect(conv('<custom-tag>2 * 3 _x_ [y]</custom-tag>')).toBe('2 \\* 3 \\_x\\_ \\[y\\]');
  });
  test('detects structure', () => {
    expect(htmlHasTable('<TABLE class=a>')).toBe(true);
    expect(htmlHasRichStructure('<div><span style="color:red">x</span></div>')).toBe(false);
    expect(htmlHasRichStructure('<b>x</b>')).toBe(true);
  });
});

describe('TSV', () => {
  test('excel text/plain', () => {
    expect(tsvToMarkdownTable('Name\tQty\nApple\t3\nPear\t4\n')).toBe('| Name | Qty |\n| --- | --- |\n| Apple | 3 |\n| Pear | 4 |');
  });
  test('quoted multi-line and pipe cells', () => {
    expect(tsvToMarkdownTable('a\tb\n"x\ny"\t"p|q ""z"""')).toBe('| a | b |\n| --- | --- |\n| x y | p\\|q "z" |');
  });
  test('not a table', () => {
    expect(tsvToMarkdownTable('one line\twith tab')).toBeNull();
    expect(tsvToMarkdownTable('a\tb\nc')).toBeNull();
    expect(tsvToMarkdownTable('no tabs\nat all')).toBeNull();
  });
});

describe('malicious HTML yields safe Markdown', () => {
  const evil = `<script>alert(1)</script><style>body{}</style><iframe src="javascript:alert(1)"></iframe>
    <p onclick="x()">hi <a href="javascript:alert(1)">bad link</a> <a href=" data:text/html,x">d</a> <a href="https://ok.test/a">ok</a></p>
    <img src="javascript:alert(1)" alt="img" onerror="alert(1)"><img src="data:image/png;base64,AAA" alt="d">
    <table><tr><td><script>alert(2)</script>cell</td><td><img src=x onerror=alert(3)></td></tr></table>`;
  test('scripts, handlers, dangerous urls are dropped', () => {
    const md = conv(evil);
    expect(md).not.toContain('alert');
    expect(md).not.toContain('javascript');
    expect(md).not.toContain('data:');
    expect(md).toContain('hi bad link');
    expect(md).toContain('[ok](https://ok.test/a)');
    expect(md).toContain('| cell |');
  });
  test('rendered result is safe', () => {
    expect(renderRichText(conv(evil))).not.toMatch(/<script|onerror|javascript:/i);
  });
});
