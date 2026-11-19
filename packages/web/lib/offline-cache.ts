/**
 * Offline reading (opt-in, per device): the issues a person opens are kept as plain text in IndexedDB so that they can be read
 * without a connection (the offline page lists them). Never stored: attachments, comments of other people's private threads, anything
 * but the text of the issue itself. Capped at 50 issues, removed at sign-out, and off until the person switches it on in
 * Personal settings. Nothing is ever written back from here.
 */
export const DB_NAME = 'veqsio-offline'
export const STORE = 'issues'
export const MAX_ISSUES = 50
const FLAG = 'veqsio-offline-reading'

export interface OfflineIssue {
  key: string
  summary: string
  project: string
  type: string
  status: string
  priority: string
  assignee: string
  reporter: string
  updated: string
  description: string
  savedAt: number
}

export function offlineEnabled(): boolean {
  try { return localStorage.getItem(FLAG) === '1' } catch { return false }
}
export function setOfflineEnabled(on: boolean): void {
  try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG) } catch { /* storage unavailable */ }
}

/** The fields worth keeping, as plain text and bounded in size. */
export function toOfflineRecord(issue: { key: string; fields: Record<string, any> }, now = Date.now()): OfflineIssue {
  const f = issue.fields ?? {}
  const text = (v: unknown, max = 500) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max)
  return {
    key: text(issue.key, 100),
    summary: text(f.summary),
    project: text(f.project?.name ?? f.project?.key, 255),
    type: text(f.issuetype?.name, 100),
    status: text(f.status?.name, 100),
    priority: text(f.priority?.name, 100),
    assignee: text(f.assignee?.displayName, 255),
    reporter: text(f.reporter?.displayName, 255),
    updated: text(f.updated, 40),
    description: text(f.description, 20_000),
    savedAt: now,
  }
}

/** The keys to drop so that at most `max` records stay, oldest first. */
export function keysToEvict(records: Array<{ key: string; savedAt: number }>, max = MAX_ISSUES): string[] {
  if (records.length <= max) return []
  return [...records].sort((a, b) => a.savedAt - b.savedAt).slice(0, records.length - max).map((r) => r.key)
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'key' }) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
const all = (db: IDBDatabase) => new Promise<OfflineIssue[]>((resolve, reject) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => resolve(r.result as OfflineIssue[]); r.onerror = () => reject(r.error) })

export async function saveIssueOffline(issue: { key: string; fields: Record<string, any> }): Promise<void> {
  if (!offlineEnabled() || typeof indexedDB === 'undefined') return
  try {
    const db = await open()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(toOfflineRecord(issue))
    await done(tx)
    const records = await all(db)
    const evict = keysToEvict(records)
    if (evict.length) { const t2 = db.transaction(STORE, 'readwrite'); for (const k of evict) t2.objectStore(STORE).delete(k); await done(t2) }
    db.close()
  } catch { /* a cache that cannot be written is not worth a message */ }
}

export async function offlineCount(): Promise<number> {
  try { if (typeof indexedDB === 'undefined') return 0; const db = await open(); const n = (await all(db)).length; db.close(); return n } catch { return 0 }
}

export async function clearOfflineCache(): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return
    const db = await open()
    const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); await done(tx)
    db.close()
  } catch { /* nothing to clear */ }
}
