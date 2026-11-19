/** Extracts the JQL parse error (message and character position) from a failed queue save, if it is one. */
export interface JqlErrorInfo { message: string; position: number | null }

export function jqlErrorFrom(e: unknown): JqlErrorInfo | null {
  const body = (e as { body?: { jqlError?: { message?: unknown; position?: unknown }; errors?: { jql?: unknown } } } | null)?.body
  const j = body?.jqlError
  if (j && typeof j.message === 'string') return { message: j.message, position: typeof j.position === 'number' ? j.position : null }
  if (typeof body?.errors?.jql === 'string') return { message: body.errors.jql, position: null }
  return null
}
