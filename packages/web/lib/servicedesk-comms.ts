/** Pure helpers for the service desk e-mail settings, requests raised on behalf of customers, and merge/link. */

export const MIN_POLL_SECONDS = 60
export const MAX_POLL_SECONDS = 86_400

export interface ImapForm {
  enabled: boolean
  host: string
  port: string
  tls: boolean
  user: string
  password: string
  folder: string
  pollSeconds: string
}

export const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim())

/** Field errors for the IMAP form; empty when it can be saved. The password may stay empty when one is already stored. */
export function validateImapForm(f: ImapForm, passwordSet: boolean): Record<string, string> {
  const e: Record<string, string> = {}
  const port = Number(f.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) e.port = 'Enter a port between 1 and 65535'
  const secs = Number(f.pollSeconds)
  if (!Number.isInteger(secs) || secs < MIN_POLL_SECONDS) e.pollSeconds = `Poll at most once a minute: at least ${MIN_POLL_SECONDS} seconds`
  else if (secs > MAX_POLL_SECONDS) e.pollSeconds = 'At most once a day (86400 seconds)'
  if (!f.folder.trim()) e.folder = 'Enter a folder, usually INBOX'
  if (f.host.trim() && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(f.host.trim())) e.host = 'Enter a host name such as imap.example.com'
  if (f.enabled) {
    if (!f.host.trim()) e.host = 'Host is required to enable polling'
    if (!f.user.trim()) e.user = 'User is required to enable polling'
    if (!f.password && !passwordSet) e.password = 'Password is required to enable polling'
  }
  return e
}

export interface PollInfo { lastPollAt: string | null; lastStatus: string | null; lastError: string | null; lastCount: number | null }

/** One-line description of the last poll, with a tone for colouring (text is always present, colour is not the only signal). */
export function describePoll(p: PollInfo, now = Date.now()): { tone: 'none' | 'ok' | 'error'; text: string } {
  if (!p.lastPollAt) return { tone: 'none', text: 'Not polled yet' }
  const at = new Date(p.lastPollAt).getTime()
  const secs = Math.max(0, Math.round((now - at) / 1000))
  const ago = secs < 60 ? 'just now' : secs < 3600 ? `${Math.floor(secs / 60)} min ago` : secs < 86_400 ? `${Math.floor(secs / 3600)} h ago` : `${Math.floor(secs / 86_400)} d ago`
  if (p.lastStatus === 'error') return { tone: 'error', text: `Failed ${ago}: ${p.lastError || 'unknown error'}` }
  const n = p.lastCount ?? 0
  return { tone: 'ok', text: `OK ${ago}, ${n} message${n === 1 ? '' : 's'} processed` }
}

export interface CustomerChoice { id: number; displayName: string | null; email: string }

/** What to send as the customer of a request raised on behalf: a picked customer wins, else a typed address. */
export function customerPayload(
  picked: CustomerChoice | null, typed: string, name: string,
): { ok: true; body: { customerId: number } | { customerEmail: string; customerName?: string } } | { ok: false; error: string } {
  if (picked) return { ok: true, body: { customerId: picked.id } }
  const email = typed.trim()
  if (!email) return { ok: false, error: 'Pick a customer or enter an email address' }
  if (!looksLikeEmail(email)) return { ok: false, error: 'Enter a valid email address' }
  return { ok: true, body: { customerEmail: email, ...(name.trim() ? { customerName: name.trim() } : {}) } }
}

/** Typed text that is an email address of nobody on the list: the agent is about to create a customer. */
export function isNewCustomerEmail(typed: string, results: CustomerChoice[]): boolean {
  const t = typed.trim().toLowerCase()
  return looksLikeEmail(t) && !results.some((r) => r.email.toLowerCase() === t)
}

export interface MergeCandidate { key: string; summary: string; resolved?: string | null }

/** Open requests of the desk that can receive a merge, filtered by a search term, never the source itself. */
export function mergeCandidates(all: MergeCandidate[], sourceKey: string, term: string, limit = 8): MergeCandidate[] {
  const t = term.trim().toLowerCase()
  return all
    .filter((r) => r.key !== sourceKey && !r.resolved)
    .filter((r) => !t || r.key.toLowerCase().includes(t) || r.summary.toLowerCase().includes(t))
    .slice(0, limit)
}

/** Request key typed into a field, tolerant of case and surrounding space; null when it is not a key. */
export function parseRequestKey(s: string): string | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9_]*-\d{1,9})\s*$/.exec(s)
  return m ? m[1].toUpperCase() : null
}

export function describeMerge(r: { source: string; target: string; movedComments: number; movedAttachments: number; addedParticipants: number }): string {
  const parts = [`${r.movedComments} comment${r.movedComments === 1 ? '' : 's'}`, `${r.movedAttachments} attachment${r.movedAttachments === 1 ? '' : 's'}`]
  if (r.addedParticipants) parts.push(`${r.addedParticipants} participant${r.addedParticipants === 1 ? '' : 's'}`)
  return `${r.source} merged into ${r.target}: ${parts.join(', ')} moved`
}

export interface LinkTypeOption { id: string; name: string; inward: string; outward: string }

/** Both readings of every link type for a "this request ..." dropdown. */
export function linkOptions(types: LinkTypeOption[]): Array<{ value: string; label: string; linkTypeId: number; direction: 'outward' | 'inward' }> {
  return types.flatMap((t) => {
    const out = { value: `${t.id}:outward`, label: t.outward, linkTypeId: Number(t.id), direction: 'outward' as const }
    return t.inward === t.outward ? [out] : [out, { value: `${t.id}:inward`, label: t.inward, linkTypeId: Number(t.id), direction: 'inward' as const }]
  })
}
