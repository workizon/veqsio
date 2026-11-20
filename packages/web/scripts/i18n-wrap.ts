/**
 * Wraps the visible English text of React components in tr('…') so it can be translated, and lists every string it found.
 *
 *   bun scripts/i18n-wrap.ts [--write] [--out lib/i18n/catalogue.json] <path>...      (paths: files or folders under app/ and components/)
 *
 * Without --write nothing is changed: it prints what it would do. What it wraps:
 *   - JSX text:            <b>Save</b>                      ->  <b>{tr('Save')}</b>
 *   - string attributes:   placeholder, title, aria-label, alt, label, hint, description, heading, emptyText, helperText
 *   - toast messages:      toast('Saved')  /  toast("Saved", 'success')
 * What it leaves alone: text with no letters, code-like text (identifiers, paths, URLs, keys), text inside <code>, <pre>, <kbd>,
 * strings in template literals with ${} (they need a manual {placeholder} rewrite) and files that are not client components.
 * In every component that gets a tr() it adds `const { tr } = useI18n()` and the import. Re-running is safe (wrapped text is skipped).
 */
import ts from 'typescript'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const write = args.includes('--write')
const outIdx = args.indexOf('--out'); const out = outIdx >= 0 ? args[outIdx + 1] : null
const targets = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out')
const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'hint', 'description', 'heading', 'emptyText', 'helperText', 'tooltip', 'caption', 'submitLabel', 'pendingLabel', 'submit', 'ariaLabel', 'confirmLabel', 'cancelLabel'])
/** Object-literal properties inside a component whose string value is shown on screen (menu/option/breadcrumb/confirm-dialog definitions). */
const PROPS = new Set(['label', 'hint', 'placeholder', 'confirmLabel', 'emptyText', 'tooltip', 'caption', 'detail', 'title', 'description', 'message', 'helperText', 'submitLabel'])
const inRequestBody = (n: ts.Node) => { for (let p: ts.Node | undefined = n.parent; p; p = p.parent) { if (ts.isPropertyAssignment(p) && /^(body|headers|params|data|payload)$/.test(p.name.getText())) return true; if (ts.isCallExpression(p) && /^(JSON\.stringify|fetch|api|post|put|patch|request)$/.test(p.expression.getText())) return true } return false }
const SKIP_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'script', 'style'])

const files: string[] = []
const walk = (p: string) => { const st = statSync(p); if (st.isDirectory()) { for (const f of readdirSync(p)) if (f !== 'node_modules' && f !== '.next') walk(join(p, f)) } else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) files.push(p) }
for (const t of targets) walk(join(ROOT, t))

const isTranslatable = (s: string) => {
  const t = s.trim()
  if (/&[a-z]+;|&#\d+;/i.test(t)) return false // an entity we cannot decode: leave it as it is
  if (t.length < 2 || t.length > 200 || !/[A-Za-z]{2}/.test(t)) return false
  if (/^(https?:|\/|\.|#|@)/.test(t) || /[{}]|=>|&&|\|\|/.test(t)) return false
  if (/^[a-z0-9_.-]+$/.test(t) || /^[a-z]+([A-Z][A-Za-z0-9]*)+$/.test(t)) return false // identifiers, camelCase, kebab-case
  return true
}
/** JSX text is written with HTML entities (&apos; &nbsp; &ldquo; ...); a JS string is not, so decode them or they would show up literally on screen. */
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019', middot: '\u00b7', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', times: '\u00d7', rarr: '\u2192', larr: '\u2190', check: '\u2713' }
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m)))
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

const catalogue = new Map<string, number>()
let wrapped = 0, componentsPatched = 0, skippedFiles: string[] = [], manual: string[] = []

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  if (!/^\s*['"]use client['"]/.test(src)) { skippedFiles.push(relative(ROOT, file)); continue }
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  type Edit = { start: number; end: number; text: string; fn: ts.Node | null }
  const edits: Edit[] = []
  const componentOf = (n: ts.Node): ts.Node | null => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name && /^[A-Z]/.test(p.name.text)) return p
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name) && /^[A-Z]/.test(p.parent.name.text)) return p
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isCallExpression(p.parent) && /^(memo|forwardRef)$/.test(p.parent.expression.getText())) return p
      if (ts.isFunctionDeclaration(p) && p.parent && ts.isExportAssignment?.(p.parent)) return p
    }
    return null
  }
  const insideSkipTag = (n: ts.Node) => { for (let p: ts.Node | undefined = n.parent; p; p = p.parent) { if (ts.isJsxElement(p) && SKIP_TAGS.has(p.openingElement.tagName.getText())) return true } return false }
  const add = (n: ts.Node, start: number, end: number, text: string, key: string) => {
    const fn = componentOf(n)
    if (!fn) { manual.push(`${relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(start).line + 1} ${key}`); return }
    if (process.env.I18N_LIST) console.log(relative(ROOT, file) + ":" + (sf.getLineAndCharacterOfPosition(start).line + 1) + " " + key.slice(0, 70))
    edits.push({ start, end, text, fn }); catalogue.set(key, (catalogue.get(key) ?? 0) + 1)
  }
  const leaf = (e: ts.Expression) => {
    if (ts.isParenthesizedExpression(e)) return leaf(e.expression)
    if (ts.isConditionalExpression(e)) { leaf(e.whenTrue); leaf(e.whenFalse) }
    else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) leaf(e.right)
    else if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && !e.text.includes('\n') && isTranslatable(e.text)) add(e, e.getStart(), e.getEnd(), `tr('${esc(e.text)}')`, e.text)
  }
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n) && !insideSkipTag(n)) {
      const raw = n.getText(); const t = decode(raw.replace(/\s+/g, ' ').trim())
      if (isTranslatable(t)) { const lead = /^\s/.test(raw) ? ' ' : '', trail = /\s$/.test(raw) ? ' ' : ''; add(n, n.getStart(), n.getEnd(), `${lead}{tr('${esc(t)}')}${trail}`, t) }
    } else if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && ATTRS.has(n.name.getText()) && isTranslatable(n.initializer.text)) {
      const init = n.initializer; add(n, init.getStart(), init.getEnd(), `{tr('${esc(init.text)}')}`, init.text)
    } else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && PROPS.has(n.name.text) && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)) && /^[A-Z]/.test(n.initializer.text) && /[a-z]/.test(n.initializer.text) && !/^(Ctrl|Cmd|Alt|Shift)\+/.test(n.initializer.text) && !n.initializer.text.includes('\n') && isTranslatable(n.initializer.text) && !inRequestBody(n) && componentOf(n)) {
      const i = n.initializer; add(i, i.getStart(), i.getEnd(), `tr('${esc(i.text)}')`, i.text)
    } else if (ts.isJsxAttribute(n) && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression && ATTRS.has(n.name.getText())) {
      // attribute value is an expression: wrap the string literals that can be the result (cond ? 'a' : 'b', x || 'a', x ?? 'a', cond && 'a')
      leaf(n.initializer.expression)
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'toast' && n.arguments[0]) {
      const a = n.arguments[0]
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) { if (isTranslatable(a.text)) add(n, a.getStart(), a.getEnd(), `tr('${esc(a.text)}')`, a.text) }
      else if (ts.isConditionalExpression(a) || ts.isParenthesizedExpression(a) || (ts.isBinaryExpression(a) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(a.operatorToken.kind))) leaf(a)
      else if (ts.isTemplateExpression(a)) manual.push(`${relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(a.getStart()).line + 1} toast(template with \${})`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (!edits.length) continue

  // every component that got a tr() needs the hook (once), at the top of its body
  const fns = [...new Set(edits.map((e) => e.fn!))] as (ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression)[]
  if (fns.some((fn) => !fn.body || !ts.isBlock(fn.body))) { // `() => <div/>`: turning it into a block by script is error-prone, so the file is left for a human
    manual.push(`${relative(ROOT, file)} has an expression-bodied component: wrap by hand`); continue
  }
  const hookEdits: Edit[] = []
  for (const fn of fns) {
    const body = fn.body as ts.Block
    if (/\bconst\s*\{[^}]*\btr\b[^}]*\}\s*=\s*useI18n\(\)/.test(body.getText())) continue
    hookEdits.push({ start: body.getStart() + 1, end: body.getStart() + 1, text: '\n  const { tr } = useI18n();\n', fn })
  }
  let next = src
  for (const e of [...edits, ...hookEdits].sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end)
  if (!/from ['"]@\/hooks\/use-i18n['"]/.test(next)) next = next.replace(/^(\s*['"]use client['"]\s*\n)/, `$1\nimport { useI18n } from '@/hooks/use-i18n'\n`)
  wrapped += edits.length; componentsPatched += fns.length
  if (write) writeFileSync(file, next)
}
console.log(`${write ? 'WROTE' : 'DRY RUN'}: ${wrapped} strings wrapped in ${componentsPatched} components; ${catalogue.size} unique strings`)
console.log(`skipped (not client components): ${skippedFiles.length} files; needs manual work: ${manual.length} spots`)
if (manual.length) console.log(manual.slice(0, 25).map((m) => '  ' + m).join('\n') + (manual.length > 25 ? `\n  … and ${manual.length - 25} more` : ''))

/**
 * Strings that are not wrapped in a tsx component but are translated at render time (lib/*.ts constants, hooks, module-level tables):
 * property values named like PROPS (label, hint, title ...), values of tables called *_ERRORS / *_REASONS / *_LABELS / *_TEXT, literal arguments of tr() / trNow(),
 * plus scripts/i18n-extra-strings.json for the few that are passed around as plain arguments.
 */
const extra = new Set<string>()
const EXTRA_PROPS = new Set([...PROPS, 'defaultTitle', 'done', 'section', 'group'])
const TABLE_NAME = /(ERRORS|REASONS|LABELS|TEXT|MESSAGES)$/
const scan = (p: string) => {
  const st = statSync(p)
  if (st.isDirectory()) { for (const f of readdirSync(p)) if (f !== 'node_modules' && f !== '.next' && f !== 'i18n') scan(join(p, f)); return }
  if (!/\.tsx?$/.test(p) || /\.test\.tsx?$/.test(p) || p.endsWith('/tr.ts')) return
  const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true, p.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lit = (e: ts.Node | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null)
  const accept = (t: string | null, lower = false) => { if (t && !/var\(|^#|^rgb/.test(t) && !t.includes('\n') && isTranslatable(t) && (lower || (/^[A-Z]/.test(t) && /[a-z]/.test(t) && !/^(Ctrl|Cmd|Alt|Shift)\+/.test(t)))) extra.add(t.trim()) }
  const inTable = (n: ts.Node) => { for (let q: ts.Node | undefined = n.parent; q; q = q.parent) if (ts.isVariableDeclaration(q) && ts.isIdentifier(q.name) && TABLE_NAME.test(q.name.text)) return true; return false }
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
      const name = ts.isIdentifier(n.name) ? n.name.text : n.name.text
      if (EXTRA_PROPS.has(name) && !(inRequestBody(n))) accept(lit(n.initializer), name === 'done')
      else if (inTable(n)) accept(lit(n.initializer), true)
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'tr' || n.expression.text === 'trNow')) accept(lit(n.arguments[0]), true)
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
if (out) {
  for (const root of ['lib', 'hooks', ...targets]) if (existsSync(join(ROOT, root))) scan(join(ROOT, root))
  const extraFile = join(ROOT, 'scripts/i18n-extra-strings.json')
  if (existsSync(extraFile)) for (const t of JSON.parse(readFileSync(extraFile, 'utf8')) as string[]) extra.add(t)
  const prev = join(ROOT, out) // the catalogue only grows: keys of an earlier run stay (wrapped text is not found again by this script)
  if (existsSync(prev)) for (const t of Object.keys(JSON.parse(readFileSync(prev, 'utf8')))) extra.add(t)
  for (const t of extra) if (!catalogue.has(t)) catalogue.set(t, 0)
  writeFileSync(join(ROOT, out), JSON.stringify(Object.fromEntries([...catalogue.keys()].sort().map((k) => [k, ''])), null, 1))
  console.log(`catalogue: ${catalogue.size} strings (${extra.size} from lib/hooks/constants)`)
}
