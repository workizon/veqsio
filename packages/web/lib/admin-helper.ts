/**
 * Admin helper: finds administration pages and settings by name or by what the person wants to do
 * ("add a custom field", "reset password", "why can't she see this issue"). Pure and DOM free; the pages
 * come from the shared route table (lib/routes.ts) and this file only adds synonyms and a scoring function.
 */
import { ADMIN_LINKS, ADMIN_SETTINGS, type NavLink } from './routes'
import type { StorageLike } from './issue-nav'

/** Extra words and phrases per admin page, keyed by href. Phrases are matched ignoring filler words and word order. */
export const ADMIN_KEYWORDS: Record<string, string[]> = {
  '/settings': ['my account', 'my preferences', 'change my password', 'language', 'time zone', 'theme'],
  '/admin/workflows': ['workflow', 'statuses', 'transitions', 'add a status', 'change status flow', 'workflow designer', 'approval step'],
  '/admin/notifications': ['notification scheme', 'email rules', 'who gets emails', 'webhooks', 'mail notifications', 'event notifications'],
  '/admin/issue-security': ['security level', 'confidential issues', 'restrict issue visibility', 'hide issues', 'issue security scheme', 'private issues', 'who can see issue', 'secret'],
  '/admin/permission-helper': [
    'why cant see issue', 'cannot see issue', 'cant see project', 'no access', 'access denied', 'forbidden', 'permission check', 'who can',
    'why cant edit', 'why cant comment', 'why cant transition', 'permission problem', 'user missing permission', 'debug permissions', 'explain permission',
  ],
  '/admin/notification-helper': [
    'why no email', 'did not get email', 'not notified', 'missing notification', 'why did get email', 'why did get this email', 'email not received',
    'debug notifications', 'explain notification', 'who gets notified',
  ],
  '/admin/audit': ['audit', 'history of changes', 'who changed', 'activity log', 'compliance', 'export log', 'admin actions'],
  '/admin/logs': ['logs', 'log viewer', 'log level', 'debug logging', 'errors', 'slow queries', 'slow query', 'performance', 'pg_stat_statements'],
  '/admin/storage': ['storage', 'disk', 'quota', 'attachments size', 'space', 'attachment limit'],
  '/admin/health': ['health check', 'misconfiguration', 'problems', 'diagnostics', 'what is wrong', 'sanity check'],
  '/admin/migration': ['migrate', 'import from jira', 'import from other tools', 'move from jira', 'trello', 'github import', 'switch from'],
  '/admin/sso': ['saml', 'single sign on', 'login with company account', 'identity provider', 'sso'],
  '/admin/features': ['modules', 'turn on', 'turn off', 'enable feature', 'disable feature', 'plugins', 'toggle module', 'licence', 'license'],
  '/admin/settings': ['instance settings', 'base url', 'site name', 'announcement', 'banner', 'global settings', 'configuration'],
  '/admin/system': ['mail server', 'smtp', 'email server', 'backup', 'restore', 'outgoing email', 'system settings', 'upgrade'],
  '/admin?tab=users': ['reset password', 'forgot password', 'add user', 'create user', 'new user', 'invite user', 'deactivate user', 'disable account', 'unlock account', 'change email', 'people', 'accounts'],
  '/admin?tab=groups': ['add user to group', 'create group', 'team', 'membership', 'veqsio-administrators', 'group'],
  '/admin?tab=permissions': ['permission scheme', 'grant permission', 'give access', 'who can edit', 'who can create issues', 'access control', 'security', 'revoke access', 'permissions'],
  '/admin?tab=issue-types': ['add issue type', 'new issue type', 'bug story epic', 'issue types', 'task types'],
  '/admin?tab=screens': ['create screen', 'edit screen', 'create issue form', 'which fields are shown', 'field layout', 'screen scheme'],
  '/admin?tab=field-configs': ['required field', 'make field mandatory', 'hide field', 'field required', 'field configuration'],
  '/admin?tab=workflows': ['workflow scheme', 'assign workflow', 'workflow per issue type'],
  '/admin?tab=roles': ['project role', 'developers role', 'administrators role', 'add role', 'role members', 'roles'],
  '/admin?tab=custom-fields': ['add custom field', 'create custom field', 'new field', 'extra field', 'dropdown field', 'text field', 'field', 'fields'],
  '/admin?tab=oidc': ['openid', 'oauth', 'login with google', 'login with microsoft', 'azure ad', 'okta', 'keycloak'],
  '/admin?tab=saml': ['saml', 'single sign on', 'sso', 'entra', 'azure ad', 'okta', 'adfs', 'identity provider', 'metadata', 'idp'],
  '/admin?tab=ldap': ['ldap', 'active directory', 'ad sync', 'directory', 'domain login', 'windows login', 'sync users', 'sync groups'],
  '/admin?tab=scim': ['user provisioning', 'sync users', 'directory sync', 'active directory', 'automatic accounts'],
  '/admin?tab=apps': ['connect application', 'integration', 'link to confluence', 'app link', 'other application'],
  '/admin?tab=import': ['import csv', 'upload csv', 'bulk import', 'spreadsheet', 'import issues'],
  '/admin?tab=info': ['version', 'uptime', 'database status', 'server info', 'about'],
}

const STOP = new Set([
  'a', 'an', 'the', 'to', 'i', 'we', 'how', 'do', 'does', 'did', 'can', 'could', 'cant', 'cannot', 'cannot', 'my', 'me', 'she', 'he', 'they', 'her', 'his', 'their', 'this', 'that', 'these',
  'is', 'are', 'was', 'it', 'in', 'of', 'for', 'and', 'or', 'on', 'at', 'with', 'what', 'where', 'want', 'need', 'please', 'get', 'got', 'not', 'no', 'some',
])

/** Words that carry meaning even though they look like filler in other sentences. */
const KEEP = new Set(['why', 'who'])

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && w.endsWith('es') && /(s|x|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Lower-case words without punctuation or filler words; "can't" becomes "cant" and is dropped as filler. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && (KEEP.has(w) || !STOP.has(w)))
    .map(stem)
}

export interface AdminEntry extends NavLink { keywords: string[] }
export interface AdminHit { entry: AdminEntry; score: number }

/** Every administration page and tab setting with its synonyms. */
export function adminEntries(): AdminEntry[] {
  const seen = new Set<string>()
  const out: AdminEntry[] = []
  for (const l of [...ADMIN_LINKS, ...ADMIN_SETTINGS]) {
    if (seen.has(l.href)) continue
    seen.add(l.href)
    out.push({ ...l, keywords: ADMIN_KEYWORDS[l.href] ?? [] })
  }
  return out
}

const W = { label: 10, labelPrefix: 6, phrase: 12, phraseWord: 2, keywordWord: 4, hintWord: 2 }

/** 0 means "no match". Higher is better. */
export function scoreEntry(query: string, entry: AdminEntry): number {
  const q = tokenize(query)
  if (q.length === 0) return 0
  const qSet = new Set(q)
  const label = tokenize(entry.label)
  const hint = tokenize(entry.hint ?? '')
  let score = 0
  let matched = 0

  for (const t of q) {
    let best = 0
    if (label.includes(t)) best = W.label
    else if (t.length >= 3 && label.some((l) => l.startsWith(t))) best = W.labelPrefix
    if (!best && entry.keywords.some((k) => tokenize(k).includes(t))) best = W.keywordWord
    if (!best && hint.includes(t)) best = W.hintWord
    if (best) { score += best; matched++ }
  }

  // A whole synonym phrase present in the query (any order, filler ignored) is the strongest signal.
  for (const k of entry.keywords) {
    const kt = tokenize(k)
    if (kt.length > 1 && kt.every((t) => qSet.has(t))) score += W.phrase + W.phraseWord * kt.length
  }
  // The full label typed (or the label words all present) beats a partial hit.
  if (label.length > 0 && label.every((l) => qSet.has(l))) score += W.label

  return matched > 0 || score > 0 ? score : 0
}

/** Best matches first; entries with the same score sort by label. */
export function searchAdmin(query: string, entries: AdminEntry[] = adminEntries(), limit = 8): AdminHit[] {
  if (!query.trim()) return []
  const hits = entries
    .map((entry) => ({ entry, score: scoreEntry(query, entry) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
  // Drop the long tail of weak single-word hits when there is a clearly better match.
  const cutoff = hits.length ? hits[0].score * 0.4 : 0
  return hits.filter((h) => h.score >= cutoff).slice(0, limit)
}

/* ------------------------------------------------------------------ */
/*  Recent and frequent pages (per browser)                            */
/* ------------------------------------------------------------------ */

export const ADMIN_USAGE_KEY = 'veqsio-admin-helper-usage'

export interface UsageRecord { href: string; count: number; last: number }

export function loadUsage(storage: StorageLike | null | undefined): UsageRecord[] {
  if (!storage) return []
  try {
    const data = JSON.parse(storage.getItem(ADMIN_USAGE_KEY) || '[]')
    return Array.isArray(data) ? data.filter((r) => r && typeof r.href === 'string' && Number.isFinite(r.count) && Number.isFinite(r.last)) : []
  } catch { return [] }
}

export function recordUsage(list: UsageRecord[], href: string, now = Date.now()): UsageRecord[] {
  const found = list.find((r) => r.href === href)
  const next = found ? list.map((r) => (r.href === href ? { ...r, count: r.count + 1, last: now } : r)) : [...list, { href, count: 1, last: now }]
  return next.sort((a, b) => b.last - a.last).slice(0, 30)
}

export function saveUsage(storage: StorageLike | null | undefined, list: UsageRecord[]): void {
  try { storage?.setItem(ADMIN_USAGE_KEY, JSON.stringify(list)) } catch { /* private mode: nothing to remember */ }
}

export function recentEntries(usage: UsageRecord[], entries: AdminEntry[] = adminEntries(), limit = 4): AdminEntry[] {
  return [...usage].sort((a, b) => b.last - a.last).map((u) => entries.find((e) => e.href === u.href)).filter((e): e is AdminEntry => !!e).slice(0, limit)
}

export function frequentEntries(usage: UsageRecord[], entries: AdminEntry[] = adminEntries(), limit = 4): AdminEntry[] {
  return [...usage].filter((u) => u.count > 1).sort((a, b) => b.count - a.count || b.last - a.last).map((u) => entries.find((e) => e.href === u.href)).filter((e): e is AdminEntry => !!e).slice(0, limit)
}
