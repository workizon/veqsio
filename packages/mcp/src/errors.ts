import { VeqsioError } from '@veqsio/client'

/** A mistake in the tool arguments that the model can fix (unknown issue type, ambiguous user, ...). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

const SCOPE_MESSAGE = /token scope/i

/** Turn any failure into one short, actionable sentence for the model. Never leaks the token or stack traces. */
export function describeError(e: unknown): string {
  if (e instanceof ToolError) return e.message
  if (e instanceof VeqsioError) {
    switch (e.kind) {
      case 'auth':
        return 'Authentication failed (401): VEQSIO_TOKEN is missing, wrong, expired or revoked. Create a new personal access token in Veqsio (Profile, Access tokens).'
      case 'forbidden':
        return SCOPE_MESSAGE.test(e.message)
          ? 'Refused (403): the token scope does not permit this request. The token is probably read-only; use a token with write:issues (or write:projects) to change data.'
          : `Refused (403): your Veqsio user lacks the permission for this action. ${e.message}`
      case 'not_found':
        return 'Not found (404): it does not exist, or this token/user is not allowed to see it.'
      case 'license':
        return `Needs an Enterprise licence (402): ${e.message}`
      case 'rate_limited':
        return 'Rate limited (429): wait a moment and retry with fewer requests.'
      case 'network':
        return e.message
      case 'server':
        return `Veqsio server error (${e.status}). Try again later.`
      default:
        return `Rejected by Veqsio (${e.status}): ${e.message}`
    }
  }
  return `Unexpected error: ${e instanceof Error ? e.message : String(e)}`
}
