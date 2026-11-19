import { transitionNeedsDialog, type TransitionLike } from './issue-view'

/**
 * What dropping a card on a board column has to do. A board move runs the workflow transition that leads to the column's status:
 *  - `direct`: a transition without any input exists, run it at once;
 *  - `input`: the only way there needs input (resolution, comment, a screen), so open the transition dialog instead of refusing;
 *  - `none`: the workflow has no transition to that status from here; `reachable` lists the statuses it does allow.
 */
export type BoardMovePlan<T extends TransitionLike = TransitionLike> =
  | { kind: 'direct'; transition: T }
  | { kind: 'input'; transition: T }
  | { kind: 'none'; reachable: string[] }

export function planBoardMove<T extends TransitionLike>(transitions: T[], toStatusId: number): BoardMovePlan<T> {
  const candidates = transitions.filter((t) => t.to.id === toStatusId)
  // Prefer a route that needs no input, so a plain drag never opens a dialog while a direct transition exists.
  const direct = candidates.find((t) => !transitionNeedsDialog(t))
  if (direct) return { kind: 'direct', transition: direct }
  if (candidates.length) return { kind: 'input', transition: candidates[0] }
  return { kind: 'none', reachable: [...new Set(transitions.map((t) => t.to.name))] }
}

/** Sentence for the toast when a move is impossible: says where the issue can go instead of just refusing. */
export function noRouteMessage(key: string, fromName: string, toName: string, reachable: string[]): string {
  const base = `${key} cannot move from ${fromName} to ${toName} in this workflow.`
  return reachable.length ? `${base} From ${fromName} it can go to: ${reachable.join(', ')}.` : `${base} No transitions are available from ${fromName}.`
}
