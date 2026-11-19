/** Board card layout (board.config.cardFields / cardSize). Missing config = every optional part, comfortable. */
export const CARD_FIELDS = ['issuetype', 'labels', 'storyPoints', 'priority', 'assignee'] as const
export type CardField = (typeof CARD_FIELDS)[number]
export type CardSize = 'compact' | 'comfortable'

export const CARD_FIELD_LABELS: Record<CardField, string> = {
  issuetype: 'Issue type icon',
  labels: 'Labels',
  storyPoints: 'Story points',
  priority: 'Priority',
  assignee: 'Assignee',
}

export interface CardLayout { fields: Set<CardField>; size: CardSize }

export function normalizeCardLayout(config: unknown): CardLayout {
  const c = (config ?? {}) as { cardFields?: unknown; cardSize?: unknown }
  const fields = Array.isArray(c.cardFields)
    ? new Set((c.cardFields as unknown[]).filter((f): f is CardField => (CARD_FIELDS as readonly unknown[]).includes(f)))
    : new Set<CardField>(CARD_FIELDS)
  return { fields, size: c.cardSize === 'compact' ? 'compact' : 'comfortable' }
}
