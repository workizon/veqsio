/**
 * Pure helpers for JQL autocomplete: work out what the user is typing at the
 * cursor, and apply a chosen suggestion back into the text. No DOM / React.
 */

export type JqlContextKind =
  | 'field' // expecting a field name
  | 'operator' // expecting an operator (=, !=, in, is not, ...)
  | 'value' // expecting a value (or function)
  | 'keyword' // expecting AND / OR / ORDER BY (after a complete clause)
  | 'orderField' // after ORDER BY
  | 'orderDirection' // after ORDER BY <field>
  | 'none'

export interface JqlContext {
  kind: JqlContextKind
  /** Text typed so far for the token under the cursor (without opening quote). */
  prefix: string
  /** Range in the input text replaced by an accepted suggestion. */
  start: number
  end: number
  /** Field of the current clause (lower-cased), for value / operator contexts. */
  field?: string
  /** Last operator seen in the current clause (lower-cased, e.g. "not in"). */
  operator?: string
  /** True when the cursor is inside an unterminated string literal. */
  quoted: boolean
  /** True when inside the parentheses of an IN (...) list. */
  inList: boolean
  /** Extra keywords valid here (e.g. FROM/TO after CHANGED). */
  extraKeywords: string[]
}

type Tok =
  | { t: 'word' | 'string' | 'op' | 'lparen' | 'rparen' | 'comma'; v: string; start: number; end: number; open?: boolean }

const OPERATOR_CHARS = '=!~<>'
const SYMBOL_OPERATORS = new Set(['=', '!=', '~', '!~', '>', '<', '>=', '<='])

function scan(text: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '"' || ch === "'") {
      const start = i++
      let v = ''
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\' && i + 1 < text.length) i++
        v += text[i++]
      }
      const open = i >= text.length
      if (!open) i++
      toks.push({ t: 'string', v, start, end: i, open })
    } else if (ch === '(') toks.push({ t: 'lparen', v: ch, start: i, end: ++i })
    else if (ch === ')') toks.push({ t: 'rparen', v: ch, start: i, end: ++i })
    else if (ch === ',') toks.push({ t: 'comma', v: ch, start: i, end: ++i })
    else if (OPERATOR_CHARS.includes(ch)) {
      const start = i
      while (i < text.length && OPERATOR_CHARS.includes(text[i])) i++
      toks.push({ t: 'op', v: text.slice(start, i), start, end: i })
    } else {
      const start = i
      while (i < text.length && !/[\s"'(),=!~<>]/.test(text[i])) i++
      toks.push({ t: 'word', v: text.slice(start, i), start, end: i })
    }
  }
  return toks
}

/** Words that may follow a partially typed multi-word operator. Empty when none is pending. */
export function operatorContinuations(operator: string | undefined): string[] {
  switch (operator) {
    case 'is':
      return ['not', 'EMPTY', 'NULL']
    case 'is not':
      return ['EMPTY', 'NULL']
    case 'not':
      return ['in']
    case 'was':
      return ['in', 'not in']
    case 'was not':
      return ['in']
    default:
      return []
  }
}

type State =
  | 'start'
  | 'operator'
  | 'value'
  | 'afterValue'
  | 'afterChanged'
  | 'orderBy' // saw ORDER, expecting BY
  | 'orderField'
  | 'orderDir'
  | 'afterOrderDir'

/**
 * Determine the autocomplete context at `cursor` in `text`.
 */
export function getJqlContext(text: string, cursor: number = text.length): JqlContext {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)))
  const toks = scan(before)
  cursor = before.length

  let prefix = ''
  let start = cursor
  let quoted = false

  const last = toks[toks.length - 1]
  if (last && last.t === 'string' && last.open) {
    quoted = true
    prefix = last.v
    start = last.start
    toks.pop()
  } else if (last && last.t === 'word' && last.end === cursor) {
    prefix = last.v
    start = last.start
    toks.pop()
  }

  let state: State = 'start'
  let field: string | undefined
  let operator: string | undefined
  let listDepth = 0
  let lastKeyword = ''

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i]
    const up = tk.t === 'word' ? tk.v.toUpperCase() : ''
    switch (state) {
      case 'start':
        if (tk.t === 'word' && up === 'NOT') break
        if (tk.t === 'word' && up === 'ORDER') state = 'orderBy'
        else if (tk.t === 'word') {
          field = tk.v.toLowerCase()
          operator = undefined
          state = 'operator'
        } else if (tk.t === 'string') {
          field = tk.v.toLowerCase()
          state = 'operator'
        }
        break
      case 'operator':
        if (tk.t === 'op' && SYMBOL_OPERATORS.has(tk.v)) {
          operator = tk.v
          state = 'value'
        } else if (tk.t === 'word') {
          if (up === 'CHANGED') {
            operator = 'changed'
            state = 'afterChanged'
          } else {
            // IS / NOT / IN / WAS compose multi-word operators.
            operator = operator && ['is', 'not', 'was'].includes(operator.split(' ').pop()!)
              ? `${operator} ${tk.v.toLowerCase()}`
              : tk.v.toLowerCase()
            if (up === 'IN' || up === 'EMPTY' || up === 'NULL') {
              // IN needs a '(' (handled in 'value'); IS EMPTY completes the clause
              state = up === 'IN' ? 'value' : 'afterValue'
            }
          }
        }
        break
      case 'afterChanged':
        if (tk.t === 'word' && ['FROM', 'TO', 'BY', 'DURING', 'AFTER', 'BEFORE', 'ON'].includes(up)) {
          lastKeyword = up
          state = 'value'
        } else if (tk.t === 'word' && (up === 'AND' || up === 'OR')) {
          state = 'start'
          field = undefined
        } else if (tk.t === 'word' && up === 'ORDER') state = 'orderBy'
        break
      case 'value':
        if (tk.t === 'lparen') {
          listDepth++
        } else if (tk.t === 'comma') {
          // stay in value
        } else if (tk.t === 'rparen') {
          listDepth = Math.max(0, listDepth - 1)
          if (listDepth === 0) state = lastKeyword ? 'afterChanged' : 'afterValue'
        } else if (tk.t === 'word' || tk.t === 'string') {
          // function call: skip over its argument list
          const next = toks[i + 1]
          if (tk.t === 'word' && next && next.t === 'lparen') {
            let depth = 0
            let j = i + 1
            for (; j < toks.length; j++) {
              if (toks[j].t === 'lparen') depth++
              else if (toks[j].t === 'rparen' && --depth === 0) break
            }
            i = j
          }
          if (listDepth === 0) state = lastKeyword ? 'afterChanged' : 'afterValue'
        }
        break
      case 'afterValue':
        if (tk.t === 'word' && (up === 'AND' || up === 'OR')) {
          state = 'start'
          field = undefined
          operator = undefined
          lastKeyword = ''
        } else if (tk.t === 'word' && up === 'ORDER') state = 'orderBy'
        break
      case 'orderBy':
        if (tk.t === 'word' && up === 'BY') state = 'orderField'
        break
      case 'orderField':
        if (tk.t === 'word') state = 'orderDir'
        break
      case 'orderDir':
        if (tk.t === 'comma') state = 'orderField'
        else if (tk.t === 'word') state = 'afterOrderDir'
        break
      case 'afterOrderDir':
        if (tk.t === 'comma') state = 'orderField'
        break
    }
  }

  const base = { prefix, start, end: cursor, quoted, inList: listDepth > 0, field, operator, extraKeywords: [] as string[] }

  // Quoted strings only make sense as values (or quoted field names).
  if (quoted && state !== 'value' && state !== 'start') {
    return { ...base, kind: 'none' }
  }

  switch (state) {
    case 'start':
      return { ...base, kind: 'field', field: undefined }
    case 'operator':
      // Mid-way through a multi-word operator ("is", "not", "was ...")?
      return { ...base, kind: 'operator', extraKeywords: operatorContinuations(operator) }
    case 'value':
      return { ...base, kind: 'value' }
    case 'afterChanged':
      return { ...base, kind: 'keyword', extraKeywords: ['FROM', 'TO', 'BY', 'DURING'] }
    case 'afterValue':
      return { ...base, kind: 'keyword' }
    case 'orderBy':
      return { ...base, kind: 'keyword', extraKeywords: ['BY'] }
    case 'orderField':
      return { ...base, kind: 'orderField' }
    case 'orderDir':
      return { ...base, kind: 'orderDirection' }
    case 'afterOrderDir':
      return { ...base, kind: 'none' }
  }
}

/** Quote a value if it contains characters JQL would not accept bare. */
export function formatJqlValue(value: string): string {
  if (/^[A-Za-z0-9_.@-]+$/.test(value) || /\(.*\)$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface AppliedSuggestion {
  text: string
  cursor: number
}

/**
 * Replace the token under the cursor (per `ctx`) with `insert`, adding a
 * trailing space where the user will continue typing.
 * `kind: 'value'` suggestions are quoted when necessary.
 */
export function applySuggestion(
  text: string,
  ctx: JqlContext,
  insert: string,
  opts: { asValue?: boolean; trailingSpace?: boolean } = {},
): AppliedSuggestion {
  let replacement = opts.asValue ? formatJqlValue(insert) : insert
  // IN / NOT IN need a parenthesised list: open it for the first value.
  if (opts.asValue && ctx.kind === 'value' && !ctx.inList && /(^|\s)in$/.test(ctx.operator ?? '')) {
    replacement = `(${replacement}`
  }
  let cursorOffset = replacement.length
  const after = text.slice(ctx.end)
  const needsSpace = opts.trailingSpace !== false && !/^\s/.test(after) && !replacement.endsWith('()') && !replacement.endsWith(')')
  if (needsSpace) {
    replacement += ' '
    cursorOffset += 1
  }
  const next = text.slice(0, ctx.start) + replacement + after
  return { text: next, cursor: ctx.start + cursorOffset }
}
