/**
 * Terminology option: what the interface calls an "issue" (instance setting `issueTerm`).
 * Only visible words change. API field names, JQL, URLs and issue keys never go through here.
 *
 *   termWord('work item', { plural: true })        -> 'work items'
 *   termWord('ticket', { capitalize: true })       -> 'Ticket'
 *   termify('Create issue', 'task')                -> 'Create task'
 *   termify('Search Issues', 'work item')          -> 'Search Work items'
 *   termify('an issue', 'task')                    -> 'a task'
 *   termify('Create {issue}', 'ticket')            -> 'Create ticket'   ({issue} {Issue} {issues} {Issues} tokens)
 */

export const TERMS = ['issue', 'work item', 'ticket', 'task'] as const
export type Term = (typeof TERMS)[number]
export const DEFAULT_TERM: Term = 'issue'

export function isTerm(v: unknown): v is Term {
  return typeof v === 'string' && (TERMS as readonly string[]).includes(v)
}

/** English plural of the last word (issue -> issues, work item -> work items, entry -> entries, box -> boxes). */
export function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es'
  return word + 's'
}

export function capitalize(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word
}

export function termWord(term: Term, opts: { plural?: boolean; capitalize?: boolean } = {}): string {
  const w = opts.plural ? pluralize(term) : term
  return opts.capitalize ? capitalize(w) : w
}

const startsWithVowelSound = (w: string) => /^[aeiou]/i.test(w)

/**
 * Replaces the word issue/issues in a plain English string, keeping the casing style of the original
 * (issue -> ticket, Issue -> Ticket, ISSUE -> TICKET) and fixing a preceding article (an issue -> a task).
 * Also resolves the explicit tokens {issue}, {issues}, {Issue}, {Issues}.
 */
export function termify(text: string, term: Term): string {
  if (!text) return text
  const cased = (original: string, replacement: string) =>
    original.length > 1 && original === original.toUpperCase() ? replacement.toUpperCase() : original[0] === original[0].toUpperCase() ? capitalize(replacement) : replacement
  const withTokens = text.replace(/\{(issue|issues|Issue|Issues)\}/g, (_m, tok: string) => {
    const plural = tok.toLowerCase() === 'issues'
    return termWord(term, { plural, capitalize: tok[0] === 'I' })
  })
  if (term === 'issue') return withTokens
  return withTokens
    .replace(/\b(an?)\s+(issue)\b/gi, (_m, art: string, word: string) => {
      const rep = cased(word, term)
      const a = startsWithVowelSound(rep) ? 'an' : 'a'
      return `${cased(art, a)} ${rep}`
    })
    .replace(/\b(issue)(s?)\b/gi, (_m, word: string, s: string) => cased(word, s ? pluralize(term) : term))
}

/** "3 issues" / "1 ticket" for counts. */
export function countLabel(n: number, term: Term): string {
  return `${n} ${termWord(term, { plural: n !== 1 })}`
}
