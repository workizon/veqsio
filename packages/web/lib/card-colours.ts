/**
 * Kanban/Scrum card colours: a board setting ("Card colour by") stored in `boards.config.cardColour`.
 * Colours are palette tokens (the label palette, CSS variables `--label-<token>-bg|dot` that follow light and dark
 * themes), never hex. DOM-free so it is unit tested; the API validates the same shape (agile/board-config.ts).
 */

export const CARD_COLOUR_TOKENS = ['gray', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink'] as const
export type CardColourToken = (typeof CARD_COLOUR_TOKENS)[number]

export const CARD_COLOUR_MODES = ['none', 'priority', 'issuetype', 'assignee', 'label', 'rules'] as const
export type CardColourMode = (typeof CARD_COLOUR_MODES)[number]

export const CARD_COLOUR_MODE_LABELS: Record<CardColourMode, string> = {
  none: 'None', priority: 'Priority', issuetype: 'Issue type', assignee: 'Assignee', label: 'Label', rules: 'Custom JQL rules',
}

export interface CardColourRule { name: string; jql: string; colour: CardColourToken }
export interface CardColourConfig { by: CardColourMode; rules: CardColourRule[] }

export interface ColourableIssue {
  key: string
  fields: {
    priority?: { name: string } | null
    issuetype?: { name: string } | null
    assignee?: { displayName: string } | null
    labels?: string[]
  }
}

export const isToken = (v: unknown): v is CardColourToken => typeof v === 'string' && (CARD_COLOUR_TOKENS as readonly string[]).includes(v)

/** Tolerant reader for `board.config.cardColour` (missing or malformed = no colouring). */
export function normalizeCardColour(config: unknown): CardColourConfig {
  const raw = (config as { cardColour?: { by?: unknown; rules?: unknown } } | null | undefined)?.cardColour
  const by = (CARD_COLOUR_MODES as readonly string[]).includes(raw?.by as string) ? (raw!.by as CardColourMode) : 'none'
  const rules = Array.isArray(raw?.rules)
    ? (raw!.rules as any[]).filter((r) => r && typeof r.jql === 'string' && isToken(r.colour))
        .map((r): CardColourRule => ({ name: typeof r.name === 'string' ? r.name : '', jql: r.jql, colour: r.colour }))
    : []
  return { by, rules }
}

/** Stable token for any text (the same assignee or type gets the same colour on every board and day). */
export function hashToken(text: string): CardColourToken {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  // gray is kept for "no value", so named values use the other eleven
  return CARD_COLOUR_TOKENS[1 + (h % (CARD_COLOUR_TOKENS.length - 1))]
}

const PRIORITY_TOKENS: Record<string, CardColourToken> = {
  blocker: 'red', critical: 'red', highest: 'red', high: 'orange', major: 'orange', medium: 'amber', normal: 'amber',
  low: 'blue', minor: 'blue', lowest: 'gray', trivial: 'gray',
}
const TYPE_TOKENS: Record<string, CardColourToken> = {
  bug: 'red', story: 'green', epic: 'violet', task: 'blue', 'sub-task': 'cyan', subtask: 'cyan', improvement: 'teal', incident: 'orange',
}

export interface Coloured { token: CardColourToken; reason: string }

/** The colour of one card (null = uncoloured). `ruleMatches` maps issue key to the index of the first matching rule. */
export function colourFor(cfg: CardColourConfig, issue: ColourableIssue, ruleMatches: Record<string, number> = {}): Coloured | null {
  switch (cfg.by) {
    case 'priority': {
      const name = issue.fields.priority?.name
      return name ? { token: PRIORITY_TOKENS[name.toLowerCase()] ?? hashToken(name), reason: name } : null
    }
    case 'issuetype': {
      const name = issue.fields.issuetype?.name
      return name ? { token: TYPE_TOKENS[name.toLowerCase()] ?? hashToken(name), reason: name } : null
    }
    case 'assignee': {
      const name = issue.fields.assignee?.displayName
      return name ? { token: hashToken(name), reason: name } : { token: 'gray', reason: 'Unassigned' }
    }
    case 'label': {
      const first = [...(issue.fields.labels ?? [])].sort()[0]
      return first ? { token: hashToken(first), reason: first } : null
    }
    case 'rules': {
      const idx = ruleMatches[issue.key]
      const rule = idx === undefined ? undefined : cfg.rules[idx]
      return rule ? { token: rule.colour, reason: rule.name || rule.jql } : null
    }
    default:
      return null
  }
}

export interface LegendEntry { token: CardColourToken; label: string; count: number }

/** Legend of the colours that are actually on the board, most used first (rules keep their configured order). */
export function buildLegend(cfg: CardColourConfig, issues: ColourableIssue[], ruleMatches: Record<string, number> = {}): LegendEntry[] {
  if (cfg.by === 'none') return []
  const map = new Map<string, LegendEntry>()
  for (const i of issues) {
    const c = colourFor(cfg, i, ruleMatches)
    if (!c) continue
    const k = `${c.token}|${c.reason}`
    const e = map.get(k)
    if (e) e.count++
    else map.set(k, { token: c.token, label: c.reason, count: 1 })
  }
  const entries = [...map.values()]
  if (cfg.by === 'rules') {
    const order = new Map(cfg.rules.map((r, i) => [r.name || r.jql, i]))
    return entries.sort((a, b) => (order.get(a.label) ?? 99) - (order.get(b.label) ?? 99))
  }
  return entries.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** Inline style for the left border/tint of a card (CSS variables, so light and dark themes both work). */
export function cardColourStyle(token: CardColourToken | null | undefined): Record<string, string> {
  if (!token) return {}
  return {
    borderLeftWidth: '4px',
    borderLeftColor: `var(--label-${token}-dot)`,
    backgroundImage: `linear-gradient(color-mix(in srgb, var(--label-${token}-bg) 40%, transparent), color-mix(in srgb, var(--label-${token}-bg) 40%, transparent))`,
  }
}

/** Whether any rule-based colouring needs a server round trip. */
export const needsRuleLookup = (cfg: CardColourConfig) => cfg.by === 'rules' && cfg.rules.length > 0

/** Editable copy of the config with at most `max` rules, for the settings form. */
export function emptyRule(): CardColourRule { return { name: '', jql: '', colour: 'red' } }

/** Client side check before saving; the server validates again. Returns messages, empty when fine. */
export function validateCardColour(cfg: CardColourConfig, max = 10): string[] {
  const errors: string[] = []
  if (cfg.by === 'rules' && cfg.rules.length === 0) errors.push('Add at least one rule, or choose another colouring.')
  if (cfg.rules.length > max) errors.push(`At most ${max} rules.`)
  cfg.rules.forEach((r, i) => {
    if (!r.jql.trim()) errors.push(`Rule ${i + 1} needs a JQL query.`)
    if (!isToken(r.colour)) errors.push(`Rule ${i + 1} needs a colour.`)
  })
  return errors
}
