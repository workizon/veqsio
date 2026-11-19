'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'

type AuthKind = 'cloud' | 'pat' | 'basic'
interface ProjectRow { key: string; name: string; lead: string | null; issueCount: number | null; existsInVeqsio: boolean }
interface Session {
  session: { status: string; startedAt?: string; totalEntities: number; processedEntities: number; errors: string[]; options?: { report?: Report } }
}
interface JsmReport { desks: Record<string, { created: boolean; requestTypes: number; groups: number; queues: number; organizations: number; customers: number }>; warnings: string[]; errors: string[]; usersCreated: number }
interface Report {
  projects: Record<string, { total: number | null; created: number; updated: number; skipped: number; failed: number; comments: number; worklogs: number; attachments: number; links: number; boards?: number; sprints?: number; sprintIssues?: number; workflows?: number; transitions?: number }>
  warnings: string[]; errors: string[]; usersCreated: number
  people?: { users: { created: number; matched: number; inactive: number; withoutEmail: number }; groups: { created: number; matched: number; memberships: number }; roleActors: number; adminGroups: string[]; globalPermissions?: { checked: number; entries: number } }
  screens?: { created: number; matched: number; fields: number; skippedFields: number }
  avatars?: { users: number; projects: number; failed: number }
  config?: Record<'issueTypes' | 'priorities' | 'statuses' | 'resolutions' | 'linkTypes', { created: number; matched: number }> & { issueTypeSchemes: { created: number; assigned: number } }
  fields?: { created: Array<{ jiraId: string; jiraName: string; name: string; type: string; note?: string }>; matched: Array<{ jiraId: string; jiraName: string; name: string; by: 'id' | 'name'; note?: string }>; skipped: Array<{ jiraId: string; jiraName: string; reason: string }>; contexts: number; options: number; requiredConfigs?: number }
  schemes?: { permissionSchemes: number; permissionEntries: number; notificationSchemes: number; assigned: number }
}
interface PeoplePreview { users: { total: number; willMatch: number; willCreate: number; inactive: number; withoutEmail: number }; groups: { total: number; willCreate: number; existing: number; administrators: string[] }; sample: Array<{ displayName: string; email: string; status: 'match' | 'create'; inactive: boolean; hiddenEmail: boolean; matchedTo?: string }>; warnings: string[] }
interface FieldRow { jiraId: string; jiraName: string; jiraType: string; ourType: string | null; action: 'match-id' | 'match-name' | 'create' | 'skip'; localId?: number; localName: string; reason?: string; overridden?: boolean }
type Override = { action: 'create' | 'map' | 'skip'; localId?: number }

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.errorMessages?.join(', ') || res.statusText)
  return data as T
}

export default function JiraRestImportPage() {
  const [baseUrl, setBaseUrl] = useState('')
  const [kind, setKind] = useState<AuthKind>('cloud')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [attachments, setAttachments] = useState(true)
  const [history, setHistory] = useState(true)
  const [schemes, setSchemes] = useState(true)
  const [people, setPeople] = useState(true)
  const [config, setConfig] = useState(true)
  const [customFields, setCustomFields] = useState(true)
  const [screens, setScreens] = useState(true)
  const [avatars, setAvatars] = useState(true)
  const [peoplePreview, setPeoplePreview] = useState<PeoplePreview | null>(null)
  const [fieldRows, setFieldRows] = useState<FieldRow[] | null>(null)
  const [existingFields, setExistingFields] = useState<Array<{ id: number; name: string; fieldType: string }>>([])
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [overwrite, setOverwrite] = useState(false)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [status, setStatus] = useState<Session['session'] | null>(null)
  const [jsm, setJsm] = useState<JsmReport | null>(null)

  const auth = kind === 'pat' ? { type: 'bearer' as const, token: secret } : { type: 'basic' as const, username, secret }
  const conn = { baseUrl, auth }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const connect = () => run(async () => {
    const me = await post<{ user: { displayName: string } }>('/rest/api/2/migration/rest/test', conn)
    setConnected(me.user.displayName)
    const a = await post<{ projects: ProjectRow[] }>('/rest/api/2/migration/rest/analyze', conn)
    setProjects(a.projects)
    setSelected(new Set(a.projects.map((p) => p.key))) // "just go": everything is selected by default
  })

  const startImport = (extra: { updatedSince?: string; onExisting?: 'skip' | 'overwrite' } = {}) => run(async () => {
    setStatus(null)
    const r = await post<{ sessionId: number }>('/rest/api/2/migration/rest/run', {
      ...conn,
      options: {
        projectKeys: [...selected], includeAttachments: attachments, includeHistory: history, includeSchemes: schemes, includePeople: people, includeConfig: config, includeCustomFields: customFields, includeScreens: screens, includeAvatars: avatars,
        ...(Object.keys(overrides).length ? { fieldOverrides: overrides } : {}),
        onExisting: extra.onExisting ?? (overwrite ? 'overwrite' : 'skip'),
        ...(extra.updatedSince ? { updatedSince: extra.updatedSince } : {}),
      },
    })
    setSessionId(r.sessionId)
  })
  const start = () => startImport()

  // What would happen to each Jira custom field, before anything is written; the choices made here go into the import
  const previewFields = (next: Record<string, Override> = overrides) => run(async () => {
    const r = await post<{ fields: FieldRow[]; existing: Array<{ id: number; name: string; fieldType: string }> }>('/rest/api/2/migration/rest/fields/preview', { ...conn, ...(Object.keys(next).length ? { fieldOverrides: next } : {}) })
    setFieldRows(r.fields); setExistingFields(r.existing)
  })
  const previewPeopleNow = () => run(async () => { setPeoplePreview(await post<PeoplePreview>('/rest/api/2/migration/rest/people/preview', conn)) })
  const choose = (jiraId: string, value: string) => {
    const next = { ...overrides }
    if (value === 'auto') delete next[jiraId]
    else if (value === 'create' || value === 'skip') next[jiraId] = { action: value }
    else if (value.startsWith('map:')) next[jiraId] = { action: 'map', localId: Number(value.slice(4)) }
    setOverrides(next)
    void previewFields(next)
  }

  // Jira Service Management: desks, request types with forms, queues, organizations and customers. Issues come from the import above.
  const importDesks = () => run(async () => {
    setJsm(null)
    setJsm(await post<JsmReport>('/rest/api/2/migration/rest/jsm/run', { ...conn, options: selected.size ? { projectKeys: [...selected] } : {} }))
  })

  // Re-sync changes made in Jira since the previous run started (1 day safety margin for time zones).
  const syncChanges = () => {
    const since = new Date((status?.startedAt ? new Date(status.startedAt).getTime() : Date.now()) - 24 * 3600_000)
    const p = (n: number) => String(n).padStart(2, '0')
    const fmt = `${since.getUTCFullYear()}-${p(since.getUTCMonth() + 1)}-${p(since.getUTCDate())} ${p(since.getUTCHours())}:${p(since.getUTCMinutes())}`
    return startImport({ updatedSince: fmt, onExisting: 'overwrite' })
  }

  const totalIssues = projects.filter((p) => selected.has(p.key)).reduce((a, p) => a + (p.issueCount ?? 0), 0)

  useEffect(() => {
    if (!sessionId) return
    let stop = false
    const tick = async () => {
      const res = await fetch(`/rest/api/2/migration/${sessionId}/status`, { credentials: 'include' })
      if (res.ok && !stop) {
        const s: Session = await res.json()
        setStatus(s.session)
        if (['running', 'pending'].includes(s.session.status)) setTimeout(tick, 2000)
      }
    }
    tick()
    return () => { stop = true }
  }, [sessionId])

  const report = status?.options?.report
  const pct = status && status.totalEntities > 0 ? Math.min(100, Math.round((status.processedEntities / status.totalEntities) * 100)) : 0

  return (
    <AppLayout>
      <div className="space-y-5">
        <div>
          <Link href="/admin/migration" className="text-sm text-[var(--brand-500)]">← Import from other tools</Link>
          <h1 className="text-heading-1 text-[var(--text-primary)]">Import from Jira (REST)</h1>
          <p className="text-[var(--text-secondary)]">
            Connect to Jira Cloud or Server/Data Center and import projects, issues, comments, worklogs, links, attachments, history, boards and sprints.
            Credentials are used only for this import and are not stored.
          </p>
        </div>

        {error && <div role="alert" className="rounded border border-red-300 bg-red-50 text-red-800 p-3 text-sm">{error}</div>}

        {!sessionId && (
          <>
            <section className="veqsio-card p-5 space-y-3">
              <h2 className="text-heading-3">1. Connect</h2>
              <label className="block space-y-1"><span className="text-sm font-medium">Jira URL</span>
                <input className="veqsio-input w-full" placeholder="https://your-company.atlassian.net" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </label>
              <label className="block space-y-1"><span className="text-sm font-medium">Authentication</span>
                <select className="veqsio-input w-full" value={kind} onChange={(e) => setKind(e.target.value as AuthKind)}>
                  <option value="cloud">Jira Cloud — email + API token</option>
                  <option value="pat">Server / Data Center — personal access token</option>
                  <option value="basic">Server / Data Center — username + password</option>
                </select>
              </label>
              {kind !== 'pat' && (
                <label className="block space-y-1"><span className="text-sm font-medium">{kind === 'cloud' ? 'Email' : 'Username'}</span>
                  <input className="veqsio-input w-full" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
                </label>
              )}
              <label className="block space-y-1"><span className="text-sm font-medium">{kind === 'basic' ? 'Password' : kind === 'cloud' ? 'API token' : 'Personal access token'}</span>
                <input className="veqsio-input w-full" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </label>
              <button className="veqsio-btn-primary" disabled={busy || !baseUrl || !secret} onClick={connect}>
                {busy ? 'Connecting…' : 'Test connection & load projects'}
              </button>
              {connected && <p className="text-sm text-green-700">Connected as {connected}</p>}
            </section>

            {projects.length > 0 && (
              <section className="veqsio-card p-5 space-y-3">
                <div className="rounded border border-[var(--brand-500)] p-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">Ready to migrate everything</div>
                    <div className="text-sm text-[var(--text-secondary)]">{selected.size} of {projects.length} projects · about {totalIssues.toLocaleString()} issues</div>
                  </div>
                  <button className="veqsio-btn-primary" disabled={busy || selected.size === 0} onClick={start}>Import everything now</button>
                </div>
                <h2 className="text-heading-3">2. Or choose projects</h2>
                <div className="flex gap-3 text-sm">
                  <button type="button" className="text-[var(--brand-500)]" onClick={() => setSelected(new Set(projects.map((p) => p.key)))}>Select all</button>
                  <button type="button" className="text-[var(--brand-500)]" onClick={() => setSelected(new Set())}>Clear</button>
                </div>
                <div className="max-h-72 overflow-y-auto divide-y divide-[var(--surface-3)]">
                  {projects.map((p) => (
                    <label key={p.key} className="flex items-center gap-3 py-2">
                      <input type="checkbox" checked={selected.has(p.key)} onChange={(e) => {
                        const next = new Set(selected); e.target.checked ? next.add(p.key) : next.delete(p.key); setSelected(next)
                      }} />
                      <span className="font-mono text-sm w-20">{p.key}</span>
                      <span className="flex-1">{p.name}</span>
                      <span className="text-sm text-[var(--text-tertiary)]">{p.issueCount ?? '?'} issues</span>
                      {p.existsInVeqsio && <span className="text-xs rounded bg-amber-100 text-amber-800 px-2 py-0.5">exists — will merge</span>}
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={attachments} onChange={(e) => setAttachments(e.target.checked)} />Attachments</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />Change history</label>
                  <label className="flex items-center gap-2" title="Needs a token with Jira administrator rights; what cannot be mapped is listed in the report"><input type="checkbox" checked={schemes} onChange={(e) => setSchemes(e.target.checked)} />Permission and notification schemes</label>
                  <label className="flex items-center gap-2" title="Every Jira user with their groups, project roles and administrator groups. People are matched by e-mail; the others are created without a password."><input type="checkbox" checked={people} onChange={(e) => setPeople(e.target.checked)} />People, groups and project roles</label>
                  <label className="flex items-center gap-2" title="Issue types (with sub-task flags), priorities in their order, statuses with categories, resolutions, link types, and the issue types each project offers."><input type="checkbox" checked={config} onChange={(e) => setConfig(e.target.checked)} />Issue types, priorities, statuses and link types</label>
                  <label className="flex items-center gap-2" title="Jira Cloud only: the fields a workflow transition asks for, put on the transitions that use them. Also: the custom fields Jira requires on create become required here."><input type="checkbox" checked={screens} onChange={(e) => setScreens(e.target.checked)} />Screens and required fields</label>
                  <label className="flex items-center gap-2" title="The pictures of people and projects are copied, so they do not depend on Jira staying up."><input type="checkbox" checked={avatars} onChange={(e) => setAvatars(e.target.checked)} />Avatars</label>
                  <label className="flex items-center gap-2" title="Fields are matched by their Jira id (kept from an earlier import), else by name and type; list options and where each field applies are copied."><input type="checkbox" checked={customFields} onChange={(e) => setCustomFields(e.target.checked)} />Custom fields with options and contexts</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />Overwrite issues that already exist</label>
                </div>
                <button className="veqsio-btn-primary" disabled={busy || selected.size === 0} onClick={start}>
                  Start import ({selected.size} project{selected.size === 1 ? '' : 's'})
                </button>
              </section>
            )}
            {connected && people && (
              <section className="veqsio-card p-5 space-y-3" aria-labelledby="pp-h">
                <h2 id="pp-h" className="text-heading-3">People: preview</h2>
                <p className="text-sm text-[var(--text-secondary)]">See who would be matched to an account that already exists (by e-mail), who would be created, and which groups are involved, before anything is written.</p>
                <button className="veqsio-btn-secondary" disabled={busy} onClick={previewPeopleNow}>{peoplePreview ? 'Refresh preview' : 'Preview people'}</button>
                {peoplePreview && (
                  <div className="space-y-2 text-sm" aria-live="polite">
                    <p>
                      {peoplePreview.users.total} people in Jira: <strong>{peoplePreview.users.willMatch}</strong> match an existing account, <strong>{peoplePreview.users.willCreate}</strong> would be created
                      {peoplePreview.users.inactive ? ` (${peoplePreview.users.inactive} inactive)` : ''}{peoplePreview.users.withoutEmail ? `; ${peoplePreview.users.withoutEmail} have no visible e-mail and get a placeholder address` : ''}.
                      {' '}{peoplePreview.groups.total} groups ({peoplePreview.groups.willCreate} new){peoplePreview.groups.administrators.length ? `; administrators: ${peoplePreview.groups.administrators.join(', ')}` : ''}.
                    </p>
                    {peoplePreview.warnings.map((w, i) => <p key={i} role="alert" className="text-red-700">{w}</p>)}
                    <div className="max-h-72 overflow-auto">
                      <table className="w-full">
                        <caption className="sr-only">People in Jira and what happens to each</caption>
                        <thead><tr className="text-left"><th scope="col">Name</th><th scope="col">E-mail</th><th scope="col">What happens</th></tr></thead>
                        <tbody>
                          {peoplePreview.sample.map((u, i) => (
                            <tr key={i} className="border-t border-[var(--surface-3)]">
                              <td className="py-1 pr-3">{u.displayName}{u.inactive && <span className="ml-2 text-xs text-[var(--text-tertiary)]">inactive</span>}</td>
                              <td className="py-1 pr-3 text-[var(--text-secondary)]">{u.email || <span className="text-[var(--text-tertiary)]">hidden</span>}</td>
                              <td className="py-1">{u.status === 'match' ? <>Matches <strong>{u.matchedTo}</strong></> : 'Created (no password)'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {peoplePreview.users.total > peoplePreview.sample.length && <p className="pt-1 text-[var(--text-tertiary)]">Showing the first {peoplePreview.sample.length} of {peoplePreview.users.total}.</p>}
                    </div>
                  </div>
                )}
              </section>
            )}
            {connected && customFields && (
              <section className="veqsio-card p-5 space-y-3" aria-labelledby="cf-h">
                <h2 id="cf-h" className="text-heading-3">Custom fields: preview</h2>
                <p className="text-sm text-[var(--text-secondary)]">
                  See what would happen to each Jira custom field before importing: created here, matched to a field that already exists, or skipped. Change a row if the automatic choice is wrong; your choices are used by the import.
                </p>
                <button className="veqsio-btn-secondary" disabled={busy} onClick={() => previewFields()}>{fieldRows ? 'Refresh preview' : 'Preview custom fields'}</button>
                {fieldRows && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Jira custom fields and what happens to each</caption>
                      <thead><tr className="text-left"><th scope="col">Jira field</th><th scope="col">Type in Jira</th><th scope="col">What happens</th><th scope="col">Your choice</th></tr></thead>
                      <tbody>
                        {fieldRows.map((r) => {
                          const cur = overrides[r.jiraId]
                          const value = !cur ? 'auto' : cur.action === 'map' ? `map:${cur.localId}` : cur.action
                          return (
                            <tr key={r.jiraId} className="border-t border-[var(--surface-3)] align-top">
                              <td className="py-1.5 pr-3"><span className="font-medium">{r.jiraName}</span><br /><span className="font-mono text-xs text-[var(--text-tertiary)]">{r.jiraId}</span></td>
                              <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{r.jiraType}</td>
                              <td className="py-1.5 pr-3">
                                {r.action === 'create' && <span>Create <strong>{r.localName}</strong> ({r.ourType})</span>}
                                {r.action === 'match-id' && <span>Use <strong>{r.localName}</strong> (same Jira id as before)</span>}
                                {r.action === 'match-name' && <span>Use <strong>{r.localName}</strong> (same name)</span>}
                                {r.action === 'skip' && <span className="text-[var(--text-tertiary)]">Skip</span>}
                                {r.reason && <div className="text-xs text-[var(--text-tertiary)]">{r.reason}</div>}
                              </td>
                              <td className="py-1.5">
                                <select aria-label={`What to do with ${r.jiraName}`} className="veqsio-input !py-1 text-sm" value={value} disabled={busy || !r.ourType && value === 'auto'} onChange={(e) => choose(r.jiraId, e.target.value)}>
                                  <option value="auto">Automatic</option>
                                  {r.ourType && <option value="create">Create a new field</option>}
                                  <option value="skip">Skip this field</option>
                                  {r.ourType && existingFields.map((f) => <option key={f.id} value={`map:${f.id}`}>Use existing: {f.name} ({f.fieldType})</option>)}
                                </select>
                              </td>
                            </tr>
                          )
                        })}
                        {fieldRows.length === 0 && <tr><td colSpan={4} className="py-2 text-[var(--text-tertiary)]">This Jira has no custom fields.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
            {connected && (
              <section className="veqsio-card p-5 space-y-3" aria-labelledby="jsm-h">
                <h2 id="jsm-h" className="text-heading-3">Service desks (Jira Service Management)</h2>
                <p className="text-sm text-[var(--text-secondary)]">
                  After the projects are imported, bring over their service desk setup: request types with their forms, request type groups, queues, customer organizations and their customers. Uses the projects selected above (all desks if none is selected). Safe to run again. SLA definitions, automation rules and portal branding are not available over the Jira API and must be recreated here.
                </p>
                <button className="veqsio-btn-secondary" disabled={busy} onClick={importDesks}>Import service desks</button>
                {jsm && (
                  <div className="space-y-2" aria-live="polite">
                    {Object.keys(jsm.desks).length === 0 && <p className="text-sm">No service desk was imported.</p>}
                    {Object.keys(jsm.desks).length > 0 && (
                      <table className="w-full text-sm">
                        <thead><tr className="text-left"><th>Project</th><th>Desk</th><th>Request types</th><th>Groups</th><th>Queues</th><th>Organizations</th><th>Customers</th></tr></thead>
                        <tbody>{Object.entries(jsm.desks).map(([k, d]) => <tr key={k}><td className="font-mono">{k}</td><td>{d.created ? 'created' : 'updated'}</td><td>{d.requestTypes}</td><td>{d.groups}</td><td>{d.queues}</td><td>{d.organizations}</td><td>{d.customers}</td></tr>)}</tbody>
                      </table>
                    )}
                    {jsm.usersCreated > 0 && <p className="text-sm">{jsm.usersCreated} placeholder users created.</p>}
                    {jsm.warnings.length > 0 && <details><summary className="cursor-pointer text-sm">Warnings ({jsm.warnings.length})</summary><ul className="list-disc ml-5 text-sm">{jsm.warnings.slice(0, 100).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
                    {jsm.errors.length > 0 && <ul role="alert" className="list-disc ml-5 text-sm text-red-700">{jsm.errors.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {sessionId && (
          <section className="veqsio-card p-5 space-y-3" aria-live="polite">
            <h2 className="text-heading-3">Import {status?.status ?? 'starting'}</h2>
            {(!status || ['running', 'pending'].includes(status.status)) && <Spinner />}
            {status && (
              <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-2 rounded bg-[var(--surface-3)] overflow-hidden">
                <div className="h-full bg-[var(--brand-500)]" style={{ width: `${pct}%` }} />
              </div>
            )}
            {status && <p className="text-sm text-[var(--text-secondary)]">{status.processedEntities} of {status.totalEntities || '?'} issues processed</p>}
            {report && (
              <>
                <table className="w-full text-sm">
                  <thead><tr className="text-left"><th>Project</th><th>Created</th><th>Updated</th><th>Skipped</th><th>Failed</th><th>Comments</th><th>Worklogs</th><th>Attachments</th><th>Links</th><th>Boards</th><th>Sprints</th><th>Workflows</th><th>Transitions</th></tr></thead>
                  <tbody>
                    {Object.entries(report.projects).map(([k, s]) => (
                      <tr key={k}><td className="font-mono">{k}</td><td>{s.created}</td><td>{s.updated}</td><td>{s.skipped}</td><td>{s.failed}</td><td>{s.comments}</td><td>{s.worklogs}</td><td>{s.attachments}</td><td>{s.links}</td><td>{s.boards ?? 0}</td><td>{s.sprints ?? 0}</td><td>{s.workflows ?? 0}</td><td>{s.transitions ?? 0}</td></tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-sm">{report.usersCreated} placeholder users created (they can sign in through SSO or password reset).</p>
                {report.people && (
                  <div className="text-sm space-y-1" aria-label="People imported">
                    <h3 className="font-medium">People</h3>
                    <p>{report.people.users.created} users created, {report.people.users.matched} matched to existing accounts{report.people.users.inactive ? `, ${report.people.users.inactive} inactive` : ''}; {report.people.groups.created} groups created ({report.people.groups.memberships} memberships); {report.people.roleActors} project role members{report.people.globalPermissions ? `; ${report.people.globalPermissions.entries} global permissions of single people` : ''}{report.people.adminGroups.length ? `; administrators: ${report.people.adminGroups.join(', ')}` : ''}.</p>
                  </div>
                )}
                {report.config && (
                  <div className="text-sm space-y-1" aria-label="Configuration imported">
                    <h3 className="font-medium">Issue types, priorities and statuses</h3>
                    <p>Issue types +{report.config.issueTypes.created}, priorities +{report.config.priorities.created}, statuses +{report.config.statuses.created}, resolutions +{report.config.resolutions.created}, link types +{report.config.linkTypes.created}; {report.config.issueTypeSchemes.assigned} projects got their issue type scheme. Entries that already existed were kept.</p>
                  </div>
                )}
                {report.screens && (
                  <div className="text-sm space-y-1" aria-label="Screens imported">
                    <h3 className="font-medium">Screens</h3>
                    <p>{report.screens.created} screens created ({report.screens.fields} fields{report.screens.skippedFields ? `, ${report.screens.skippedFields} without a counterpart` : ''}), {report.screens.matched} matched to existing ones; transitions that show a screen in Jira show it here.</p>
                  </div>
                )}
                {report.avatars && (
                  <p className="text-sm">Avatars copied: {report.avatars.users} people, {report.avatars.projects} projects{report.avatars.failed ? ` (${report.avatars.failed} could not be copied)` : ''}.</p>
                )}
                {report.schemes && (
                  <div className="text-sm space-y-1" aria-label="Schemes imported">
                    <h3 className="font-medium">Permission and notification schemes</h3>
                    <p>{report.schemes.permissionSchemes} permission schemes ({report.schemes.permissionEntries} grants) and {report.schemes.notificationSchemes} notification schemes created; {report.schemes.assigned} projects assigned.</p>
                  </div>
                )}
                {report.fields && (
                  <div className="text-sm space-y-2" aria-label="Custom fields imported">
                    <h3 className="font-medium">Custom fields</h3>
                    <p>{report.fields.created.length} created, {report.fields.matched.length} matched to existing fields, {report.fields.skipped.length} skipped; {report.fields.contexts} contexts and {report.fields.options} list options written{report.fields.requiredConfigs ? `; required fields set for ${report.fields.requiredConfigs} project and issue type pairs` : ''}.</p>
                    {(report.fields.created.length + report.fields.matched.length + report.fields.skipped.length) > 0 && (
                      <details><summary className="cursor-pointer">Every field ({report.fields.created.length + report.fields.matched.length + report.fields.skipped.length})</summary>
                        <table className="w-full mt-1">
                          <thead><tr className="text-left"><th>Jira field</th><th>Result</th><th>Note</th></tr></thead>
                          <tbody>
                            {report.fields.created.map((f) => <tr key={f.jiraId} className="border-t border-[var(--surface-3)]"><td>{f.jiraName} <span className="font-mono text-xs text-[var(--text-tertiary)]">{f.jiraId}</span></td><td>created as {f.name} ({f.type})</td><td>{f.note ?? ''}</td></tr>)}
                            {report.fields.matched.map((f) => <tr key={f.jiraId} className="border-t border-[var(--surface-3)]"><td>{f.jiraName} <span className="font-mono text-xs text-[var(--text-tertiary)]">{f.jiraId}</span></td><td>matched to {f.name} (by {f.by === 'id' ? 'Jira id' : 'name'})</td><td>{f.note ?? ''}</td></tr>)}
                            {report.fields.skipped.map((f) => <tr key={f.jiraId} className="border-t border-[var(--surface-3)]"><td>{f.jiraName} <span className="font-mono text-xs text-[var(--text-tertiary)]">{f.jiraId}</span></td><td>skipped</td><td>{f.reason}</td></tr>)}
                          </tbody>
                        </table>
                      </details>
                    )}
                  </div>
                )}
                {report.warnings.length > 0 && <details><summary className="cursor-pointer text-sm">Warnings ({report.warnings.length})</summary><ul className="list-disc ml-5 text-sm">{report.warnings.slice(0, 100).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
              </>
            )}
            {status && !['running', 'pending'].includes(status.status) && (
              <div className="rounded border border-[var(--surface-3)] p-3 space-y-2">
                <p className="text-sm text-[var(--text-secondary)]">
                  Still working in Jira? Pull in what changed since this import started. Issues changed in Jira overwrite their copy here (local edits to those issues are lost), so use this until the cutover.
                </p>
                <div className="flex gap-2">
                  <button className="veqsio-btn-secondary" disabled={busy} onClick={syncChanges}>Sync changes from Jira</button>
                  <button className="veqsio-btn-secondary" onClick={() => { setSessionId(null); setStatus(null) }}>Back</button>
                </div>
              </div>
            )}
            {status && status.errors.length > 0 && <details open><summary className="cursor-pointer text-sm text-red-700">Errors ({status.errors.length})</summary><ul className="list-disc ml-5 text-sm">{status.errors.slice(0, 100).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
          </section>
        )}
      </div>
    </AppLayout>
  )
}
