/**
 * Validation of `boards.config` (free-form JSON that already carries swimlane settings). Keys this module does not
 * know are kept as they are; the keys it owns are checked and normalised:
 *   swimlaneField, swimlaneJql, allowParallelSprints, cardColour { by, rules[] }, cardFields[], cardSize (compact|comfortable).
 * Pure (the JQL syntax check is injected) so it is unit tested without a database.
 */

/** Same 12 tokens as the label palette in the web app (`--label-<token>-bg|dot`), so colours follow light and dark themes. */
export const CARD_COLOUR_TOKENS = ['gray', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink'] as const
export type CardColourToken = (typeof CARD_COLOUR_TOKENS)[number]

export const CARD_COLOUR_MODES = ['none', 'priority', 'issuetype', 'assignee', 'label', 'rules'] as const
export type CardColourMode = (typeof CARD_COLOUR_MODES)[number]

/** Optional parts of a board card; the summary, key and flag are always shown. */
export const CARD_FIELDS = ['issuetype', 'labels', 'storyPoints', 'priority', 'assignee'] as const
export type CardField = (typeof CARD_FIELDS)[number]

export const MAX_CARD_COLOUR_RULES = 10
const MAX_CONFIG_BYTES = 20_000

export interface CardColourRule { name: string; jql: string; colour: CardColourToken }
export interface CardColourConfig { by: CardColourMode; rules: CardColourRule[] }

export type ConfigResult = { ok: true; config: Record<string, unknown> } | { ok: false; errors: string[] }

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validateBoardConfig(input: unknown, checkJql?: (jql: string) => string | null): ConfigResult {
  if (input === undefined || input === null) return { ok: true, config: {} }
  if (!isPlainObject(input)) return { ok: false, errors: ['config must be an object'] }
  let size = 0
  try { size = JSON.stringify(input).length } catch { return { ok: false, errors: ['config is not valid JSON'] } }
  if (size > MAX_CONFIG_BYTES) return { ok: false, errors: ['config is too large'] }

  const errors: string[] = []
  const out: Record<string, unknown> = { ...input }

  for (const key of ['swimlaneField', 'swimlaneJql'] as const) {
    const v = input[key]
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 1000)) errors.push(`${key} must be a string of at most 1000 characters`)
  }
  if (input.allowParallelSprints !== undefined && typeof input.allowParallelSprints !== 'boolean') errors.push('allowParallelSprints must be true or false')

  if (input.cardColour !== undefined) {
    const cc = validateCardColour(input.cardColour, checkJql, errors)
    if (cc) out.cardColour = cc
  }
  if (input.cardFields !== undefined) {
    const f = input.cardFields
    if (!Array.isArray(f) || f.some((x) => typeof x !== 'string' || !(CARD_FIELDS as readonly string[]).includes(x))) {
      errors.push(`cardFields must be a list of: ${CARD_FIELDS.join(', ')}`)
    } else {
      out.cardFields = CARD_FIELDS.filter((x) => f.includes(x))
    }
  }
  if (input.cardSize !== undefined && input.cardSize !== 'compact' && input.cardSize !== 'comfortable') errors.push('cardSize must be compact or comfortable')
  return errors.length ? { ok: false, errors } : { ok: true, config: out }
}

function validateCardColour(v: unknown, checkJql: ((jql: string) => string | null) | undefined, errors: string[]): CardColourConfig | null {
  if (!isPlainObject(v)) { errors.push('cardColour must be an object'); return null }
  const by = v.by === undefined ? 'none' : v.by
  if (typeof by !== 'string' || !(CARD_COLOUR_MODES as readonly string[]).includes(by)) {
    errors.push(`cardColour.by must be one of: ${CARD_COLOUR_MODES.join(', ')}`)
    return null
  }
  const rawRules = v.rules === undefined ? [] : v.rules
  if (!Array.isArray(rawRules)) { errors.push('cardColour.rules must be a list'); return null }
  if (rawRules.length > MAX_CARD_COLOUR_RULES) { errors.push(`cardColour.rules can have at most ${MAX_CARD_COLOUR_RULES} rules`); return null }
  const rules: CardColourRule[] = []
  rawRules.forEach((r, i) => {
    const n = i + 1
    if (!isPlainObject(r)) { errors.push(`Rule ${n} must be an object`); return }
    const jql = typeof r.jql === 'string' ? r.jql.trim() : ''
    if (!jql) { errors.push(`Rule ${n} needs a JQL query`); return }
    if (jql.length > 1000) { errors.push(`Rule ${n}: the JQL query is too long`); return }
    if (typeof r.colour !== 'string' || !(CARD_COLOUR_TOKENS as readonly string[]).includes(r.colour)) {
      errors.push(`Rule ${n}: colour must be one of: ${CARD_COLOUR_TOKENS.join(', ')}`)
      return
    }
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    if (name.length > 60) { errors.push(`Rule ${n}: the name is too long (60 characters at most)`); return }
    const bad = checkJql?.(jql)
    if (bad) { errors.push(`Rule ${n}: ${bad}`); return }
    rules.push({ name, jql, colour: r.colour as CardColourToken })
  })
  if (by === 'rules' && rules.length === 0 && !errors.length) errors.push('Colouring by rules needs at least one rule')
  return { by: by as CardColourMode, rules }
}
