/** Pure text-editing helpers for the Markdown editor (textarea value + selection in, new value + selection out). */

export interface EditState {
  value: string
  start: number
  end: number
}

/** Wrap the selection in prefix/suffix; if already wrapped, unwrap. Selects the wrapped text. */
export function wrapSelection(s: EditState, prefix: string, suffix = prefix, placeholder = 'text'): EditState {
  const { value, start, end } = s
  const sel = value.slice(start, end)
  if (sel && sel.startsWith(prefix) && sel.endsWith(suffix) && sel.length >= prefix.length + suffix.length) {
    const inner = sel.slice(prefix.length, sel.length - suffix.length)
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length }
  }
  const text = sel || placeholder
  const next = value.slice(0, start) + prefix + text + suffix + value.slice(end)
  return { value: next, start: start + prefix.length, end: start + prefix.length + text.length }
}

/** Prefix each selected line (bullet, quote, numbered, task, heading). Toggles off if all lines already have it. */
export function prefixLines(s: EditState, kind: 'bullet' | 'number' | 'task' | 'quote' | 'heading'): EditState {
  const { value, start, end } = s
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  let lineEnd = value.indexOf('\n', end)
  if (lineEnd === -1) lineEnd = value.length
  const lines = value.slice(lineStart, lineEnd).split('\n')
  const marker = (i: number) => (kind === 'bullet' ? '- ' : kind === 'number' ? `${i + 1}. ` : kind === 'task' ? '- [ ] ' : kind === 'quote' ? '> ' : '## ')
  const existing = kind === 'bullet' ? /^[-*] (?!\[)/ : kind === 'number' ? /^\d+\. / : kind === 'task' ? /^[-*] \[[ xX]\] / : kind === 'quote' ? /^> ?/ : /^#{1,6} /
  const allHave = lines.every((l) => existing.test(l))
  const out = lines.map((l, i) => (allHave ? l.replace(existing, '') : kind === 'heading' ? marker(i) + l.replace(existing, '') : marker(i) + l))
  const block = out.join('\n')
  return { value: value.slice(0, lineStart) + block + value.slice(lineEnd), start: lineStart, end: lineStart + block.length }
}

/** Insert [text](url) and select the url part so the user can type it. */
export function insertLink(s: EditState): EditState {
  const { value, start, end } = s
  const sel = value.slice(start, end)
  if (/^https?:\/\/\S+$/.test(sel)) {
    const md = `[link](${sel})`
    return { value: value.slice(0, start) + md + value.slice(end), start: start + 1, end: start + 5 }
  }
  const text = sel || 'link text'
  const md = `[${text}](url)`
  const urlStart = start + text.length + 3
  return { value: value.slice(0, start) + md + value.slice(end), start: urlStart, end: urlStart + 3 }
}

export function insertCodeBlock(s: EditState): EditState {
  const { value, start, end } = s
  const sel = value.slice(start, end)
  const lead = start > 0 && value[start - 1] !== '\n' ? '\n' : ''
  const trail = end < value.length && value[end] !== '\n' ? '\n' : ''
  const body = sel || 'code'
  const md = `${lead}\`\`\`\n${body}\n\`\`\`${trail}`
  const bodyStart = start + lead.length + 4
  return { value: value.slice(0, start) + md + value.slice(end), start: bodyStart, end: bodyStart + body.length }
}

/** Insert a block of Markdown (e.g. a converted table) at the caret with blank lines around it. */
export function insertBlock(s: EditState, md: string): EditState {
  const { value, start, end } = s
  const before = value.slice(0, start)
  const after = value.slice(end)
  const lead = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const trail = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  const inserted = lead + md + trail
  const caret = start + inserted.length
  return { value: before + inserted + after, start: caret, end: caret }
}

export function insertText(s: EditState, text: string): EditState {
  const caret = s.start + text.length
  return { value: s.value.slice(0, s.start) + text + s.value.slice(s.end), start: caret, end: caret }
}

/** Active @mention query before the caret, e.g. "hello @ali" -> { query: 'ali', from: 6 }. */
export function mentionAt(value: string, caret: number): { query: string; from: number } | null {
  const m = value.slice(0, caret).match(/(^|[\s(])@([\w.\-]{0,40})$/)
  if (!m) return null
  return { query: m[2], from: caret - m[2].length - 1 }
}

/** On Enter inside a list item continue the list (or end it on an empty item). Returns null if not in a list. */
export function continueList(s: EditState): EditState | null {
  const { value, start, end } = s
  if (start !== end) return null
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const line = value.slice(lineStart, start)
  const m = line.match(/^(\s*)([-*]|\d+\.)( \[[ xX]\])? (.*)$/)
  if (!m) return null
  if (m[4].trim() === '') {
    // empty item: remove the marker
    return { value: value.slice(0, lineStart) + value.slice(start), start: lineStart, end: lineStart }
  }
  const num = /^\d+\.$/.test(m[2]) ? `${parseInt(m[2], 10) + 1}.` : m[2]
  const next = `\n${m[1]}${num}${m[3] ? ' [ ]' : ''} `
  return { value: value.slice(0, start) + next + value.slice(end), start: start + next.length, end: start + next.length }
}
