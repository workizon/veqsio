'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'

export type ToolSource = 'linear' | 'asana' | 'clickup' | 'json'

interface Container { id: string; name: string; group?: string | null; issueCount: number | null; suggestedKey: string; existsInVeqsio: boolean }
interface ProjectStats { id: string; name: string; key: string; existed: boolean; issues: number; created: number; updated: number; skipped: number; failed: number; comments: number; links: number; sprints: number; columns: number }
interface Report {
  dryRun: boolean; cancelled: boolean; projects: ProjectStats[]
  totals: { projects: number; issues: number; created: number; updated: number; skipped: number; failed: number; comments: number; links: number; subtasks: number; sprints: number }
  users: { matched: number; created: number; unmatched: number; sample: Array<{ name: string | null; email: string | null; action: string }> }
  newValues: { statuses: string[]; issueTypes: string[]; priorities: string[]; labels: string[] }
  unsupported: Record<string, number>; warnings: string[]; errors: string[]
}
interface Session { id: number; status: string; dryRun: boolean; processed: number; total: number; errors: string[]; report: Report | null }

const COPY: Record<ToolSource, { title: string; blurb: string; tokenLabel?: string; help?: string; maps: string[]; unsupported: string[] }> = {
  linear: {
    title: 'Import from Linear',
    blurb: 'Teams, workflow states, cycles, issues, sub-issues, labels, comments and relations are imported through the Linear API with a personal API key.',
    tokenLabel: 'Linear personal API key',
    help: 'Create one in Linear under Settings > Account > Security & access > Personal API keys. A read-only key is enough.',
    maps: ['Teams become projects (the team key becomes the project key when it is free)', 'Workflow states become statuses and board columns', 'Cycles become sprints', 'Linear projects become components', 'Priority, estimate (story points), labels, due date, assignee and creator (matched by e-mail), comments, sub-issues, relations as links'],
    unsupported: ['Attachments and linked URLs', 'Reactions, subscribers, customer requests', 'Initiatives and project milestones', 'SLAs, templates, documents', 'Issue history'],
  },
  asana: {
    title: 'Import from Asana',
    blurb: 'Projects, sections, tasks, subtasks, comments and tags are imported through the Asana API with a personal access token.',
    tokenLabel: 'Asana personal access token',
    help: 'Create one in the Asana developer console (My apps > Personal access tokens).',
    maps: ['Projects become projects', 'Sections become statuses and board columns; completed tasks move to Done', 'Tasks and subtasks, assignee and creator matched by e-mail', 'Comments, tags as labels, due and start date, estimated and actual time', 'A "Priority" custom field becomes the priority, a numeric "Story points" field becomes story points'],
    unsupported: ['Other custom fields', 'Attachments', 'Followers', 'Task dependencies', 'Portfolios, goals, approvals', 'Activity history'],
  },
  clickup: {
    title: 'Import from ClickUp',
    blurb: 'Spaces, folders, lists, tasks, subtasks, comments and tags are imported through the ClickUp API with a personal API token.',
    tokenLabel: 'ClickUp personal API token',
    help: 'ClickUp > your avatar > Settings > Apps > API Token (it starts with pk_).',
    maps: ['Spaces become projects (or one project per list); folders and lists become components', 'Statuses become statuses and board columns', 'Tasks and subtasks, first assignee and creator matched by e-mail', 'Comments, tags, priority, dates, time estimate and time spent, points as story points', 'Dependencies and linked tasks become issue links'],
    unsupported: ['Additional assignees', 'Checklists', 'Custom fields', 'Attachments', 'Sprint folders', 'Docs, whiteboards, time entries'],
  },
  json: {
    title: 'Import from a JSON file',
    blurb: 'Upload a JSON file in the documented simple schema to import projects, issues, sprints and comments from any other tool or script.',
    maps: ['Projects with statuses (board columns) and sprints', 'Issues with type, status, priority, assignee, reporter, dates, labels, components, story points and time', 'Parent / sub-task relations, links and comments', 'Uploading the same file again updates the issues (matched by the ids in the file)'],
    unsupported: ['Attachments and history', 'Unknown properties are listed as warnings'],
  },
}

const JSON_EXAMPLE = `{
  "projects": [{
    "id": "web", "key": "WEB", "name": "Website",
    "statuses": ["To Do", "In Progress", "Done"],
    "issues": [{
      "id": "1", "title": "Set up hosting", "status": "In Progress", "priority": "High",
      "assignee": "dev@example.com", "labels": ["infra"], "storyPoints": 3,
      "comments": [{ "author": "lead@example.com", "body": "Use the EU region" }]
    }]
  }]
}`

const BASE = '/rest/api/2/migration/tools'

async function api<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.errorMessages?.join(', ') || res.statusText)
  return data as T
}

export function MigrationToolWizard({ source }: { source: ToolSource }) {
  const copy = COPY[source]
  const isFile = source === 'json'
  const [token, setToken] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [groupBy, setGroupBy] = useState<'space' | 'list'>('space')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState<string | null>(null)
  const [containers, setContainers] = useState<Container[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [createUsers, setCreateUsers] = useState(true)
  const [comments, setComments] = useState(true)
  const [onExisting, setOnExisting] = useState<'update' | 'skip'>('update')
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [session, setSession] = useState<Session | null>(null)

  const options = (extra: Record<string, unknown> = {}) => ({
    containerIds: [...selected], projectKeys: Object.fromEntries([...selected].map((id) => [id, keys[id]]).filter(([, k]) => k)),
    includeComments: comments, onExisting, createMissingUsers: createUsers,
    ...(source === 'clickup' ? { groupBy } : {}), ...extra,
  })

  /** JSON for live sources, multipart for the file (bodies above 2 MiB are not accepted as JSON). */
  const send = <T,>(path: string, payload: { dryRun?: boolean; options?: Record<string, unknown> }) => {
    if (isFile) {
      const f = new FormData()
      f.set('file', file!)
      if (payload.dryRun !== undefined) f.set('dryRun', String(payload.dryRun))
      f.set('options', JSON.stringify(payload.options ?? {}))
      return api<T>(`${BASE}/${source}/${path}`, { method: 'POST', body: f })
    }
    return api<T>(`${BASE}/${source}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...payload }),
    })
  }

  const guarded = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const load = (gb = groupBy) => guarded(async () => {
    const opts = source === 'clickup' ? { groupBy: gb } : {}
    if (!isFile) {
      const me = await send<{ user: { name: string } }>('test', { options: opts })
      setConnected(me.user.name)
    }
    const a = await send<{ containers: Container[] }>('analyze', { options: opts })
    setContainers(a.containers)
    setSelected(new Set(a.containers.map((c) => c.id))) // "just go": everything is selected by default
    setKeys(Object.fromEntries(a.containers.map((c) => [c.id, c.suggestedKey])))
    if (isFile) setConnected(file?.name ?? 'file')
  })

  const start = (dryRun: boolean, extra: Record<string, unknown> = {}) => guarded(async () => {
    setSession(null)
    const r = await send<{ sessionId: number }>('run', { dryRun, options: options(extra) })
    setSessionId(r.sessionId)
  })

  const cancel = () => guarded(async () => {
    if (sessionId) await api(`${BASE}/sessions/${sessionId}/cancel`, { method: 'POST' })
  })

  useEffect(() => {
    if (!sessionId) return
    let stop = false
    const tick = async () => {
      const res = await fetch(`${BASE}/sessions/${sessionId}`, { credentials: 'include' })
      if (res.ok && !stop) {
        const s: { session: Session } = await res.json()
        setSession(s.session)
        if (s.session.status === 'running' && !(s.session.report)) setTimeout(tick, 1500)
        else if (s.session.status === 'cancelled' && !s.session.report) setTimeout(tick, 1500)
      }
    }
    tick()
    return () => { stop = true }
  }, [sessionId])

  const running = !!session && !session.report && !['failed'].includes(session.status)
  const report = session?.report ?? null
  const pct = session && session.total > 0 ? Math.min(100, Math.round((session.processed / session.total) * 100)) : 0
  const total = containers.filter((c) => selected.has(c.id)).reduce((a, c) => a + (c.issueCount ?? 0), 0)
  const canStart = selected.size > 0 && !busy
  const reset = () => { setSessionId(null); setSession(null) }

  return (
    <AppLayout>
      <div className="space-y-5">
        <div>
          <Link href="/admin/migration" className="text-sm text-[var(--brand-500)]">← Import from other tools</Link>
          <h1 className="text-heading-1 text-[var(--text-primary)]">{copy.title}</h1>
          <p className="text-[var(--text-secondary)]">{copy.blurb} {!isFile && 'The token is used only for this import and is not stored.'}</p>
        </div>

        {error && <div role="alert" className="rounded border border-red-300 bg-red-50 text-red-800 p-3 text-sm">{error}</div>}

        {!sessionId && (
          <>
            <section className="veqsio-card p-5 space-y-3">
              <h2 className="text-heading-3">1. {isFile ? 'Choose the file' : 'Connect'}</h2>
              {isFile ? (
                <>
                  <label className="block space-y-1"><span className="text-sm font-medium">JSON file</span>
                    <input type="file" accept=".json,application/json" className="block text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setContainers([]); setConnected(null) }} />
                  </label>
                  <details className="text-sm">
                    <summary className="cursor-pointer">Expected format</summary>
                    <pre className="mt-2 rounded bg-[var(--surface-2)] p-3 overflow-x-auto text-xs">{JSON_EXAMPLE}</pre>
                    <p className="mt-1 text-[var(--text-secondary)]">Full schema and all fields: docs/migration-other-tools.md. Maximum 50 MB.</p>
                  </details>
                </>
              ) : (
                <>
                  <label className="block space-y-1"><span className="text-sm font-medium">{copy.tokenLabel}</span>
                    <input className="veqsio-input w-full" type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} />
                    <span className="text-xs text-[var(--text-tertiary)]">{copy.help}</span>
                  </label>
                  {source === 'clickup' && (
                    <label className="block space-y-1"><span className="text-sm font-medium">One Veqsio project per</span>
                      <select className="veqsio-input w-full" value={groupBy} onChange={(e) => { setGroupBy(e.target.value as 'space' | 'list'); setContainers([]) }}>
                        <option value="space">Space (lists and folders become components)</option>
                        <option value="list">List</option>
                      </select>
                    </label>
                  )}
                </>
              )}
              <button className="veqsio-btn-primary" disabled={busy || (isFile ? !file : token.length < 6)} onClick={() => load()}>
                {busy ? 'Loading…' : isFile ? 'Read file' : 'Test connection & load projects'}
              </button>
              {connected && <p className="text-sm text-green-700">{isFile ? `Read ${connected}` : `Connected as ${connected}`}</p>}
            </section>

            <details className="veqsio-card p-5 text-sm">
              <summary className="cursor-pointer font-medium">What is imported and what is not</summary>
              <div className="grid sm:grid-cols-2 gap-4 mt-3">
                <div><div className="font-medium">Imported</div><ul className="list-disc ml-5">{copy.maps.map((m) => <li key={m}>{m}</li>)}</ul></div>
                <div><div className="font-medium">Not imported (reported as warnings)</div><ul className="list-disc ml-5">{copy.unsupported.map((m) => <li key={m}>{m}</li>)}</ul></div>
              </div>
            </details>

            {containers.length > 0 && (
              <section className="veqsio-card p-5 space-y-3">
                <div className="rounded border border-[var(--brand-500)] p-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">Ready to import everything</div>
                    <div className="text-sm text-[var(--text-secondary)]">{selected.size} of {containers.length} projects{total > 0 ? ` · about ${total.toLocaleString()} issues` : ''}. Preview first to see counts and warnings without changing anything.</div>
                  </div>
                  <div className="flex gap-2">
                    <button className="veqsio-btn-secondary" disabled={!canStart} onClick={() => start(true)}>Preview (dry run)</button>
                    <button className="veqsio-btn-primary" disabled={!canStart} onClick={() => start(false)}>Import everything now</button>
                  </div>
                </div>

                <h2 className="text-heading-3">2. Or choose projects</h2>
                <div className="flex gap-3 text-sm">
                  <button type="button" className="text-[var(--brand-500)]" onClick={() => setSelected(new Set(containers.map((c) => c.id)))}>Select all</button>
                  <button type="button" className="text-[var(--brand-500)]" onClick={() => setSelected(new Set())}>Clear</button>
                </div>
                <div className="max-h-80 overflow-y-auto divide-y divide-[var(--surface-3)]">
                  {containers.map((c) => (
                    <div key={c.id} className="flex flex-wrap items-center gap-3 py-2">
                      <input type="checkbox" aria-label={`Import ${c.name}`} checked={selected.has(c.id)} onChange={(e) => {
                        const next = new Set(selected); e.target.checked ? next.add(c.id) : next.delete(c.id); setSelected(next)
                      }} />
                      <span className="flex-1 min-w-[10rem]">{c.name}{c.group && <span className="text-xs text-[var(--text-tertiary)]"> · {c.group}</span>}</span>
                      <label className="text-xs text-[var(--text-tertiary)] flex items-center gap-1">Key
                        <input className="veqsio-input w-24 font-mono text-sm" value={keys[c.id] ?? ''} disabled={c.existsInVeqsio}
                          onChange={(e) => setKeys({ ...keys, [c.id]: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 20) })} />
                      </label>
                      <span className="text-sm text-[var(--text-tertiary)] w-24 text-right">{c.issueCount ?? '?'} issues</span>
                      {c.existsInVeqsio && <span className="text-xs rounded bg-amber-100 text-amber-800 px-2 py-0.5">imported before, will update</span>}
                    </div>
                  ))}
                </div>

                <h2 className="text-heading-3">3. Options</h2>
                <div className="flex flex-col gap-2 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={createUsers} onChange={(e) => setCreateUsers(e.target.checked)} />
                    Create placeholder users for people without a Veqsio account (matched by e-mail first; they have no password and can sign in through SSO or a password reset). Otherwise their work stays unassigned.</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} />Import comments</label>
                  <label className="flex items-center gap-2">Issues imported before
                    <select className="veqsio-input w-auto" value={onExisting} onChange={(e) => setOnExisting(e.target.value as 'update' | 'skip')}>
                      <option value="update">are updated from the source (local edits to imported fields are replaced)</option>
                      <option value="skip">are left untouched</option>
                    </select>
                  </label>
                </div>
              </section>
            )}
          </>
        )}

        {sessionId && (
          <section className="veqsio-card p-5 space-y-3" aria-live="polite">
            <h2 className="text-heading-3">
              {session?.dryRun ? 'Preview' : 'Import'} {report?.cancelled ? 'cancelled' : running || !session ? 'running' : session.status === 'failed' ? 'failed' : 'finished'}
            </h2>
            {(running || !session) && <Spinner />}
            {session && !report && session.status !== 'failed' && (
              <>
                <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-2 rounded bg-[var(--surface-3)] overflow-hidden">
                  <div className="h-full bg-[var(--brand-500)]" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-sm text-[var(--text-secondary)]">{session.processed} of {session.total || '?'} issues processed</p>
                <button className="veqsio-btn-secondary" disabled={busy} onClick={cancel}>Cancel</button>
              </>
            )}
            {session?.status === 'failed' && session.errors.map((e, i) => <p key={i} role="alert" className="text-sm text-red-700">{e}</p>)}

            {report && <ReportView report={report} />}

            {session && (report || session.status === 'failed') && (
              <div className="flex flex-wrap gap-2 pt-2">
                {report?.dryRun && !report.cancelled && (
                  <button className="veqsio-btn-primary" disabled={busy} onClick={() => start(false)}>Looks good: import now</button>
                )}
                {report && !report.dryRun && <p className="text-sm text-[var(--text-secondary)] w-full">Running the import again later updates what was imported (no duplicates), for example to catch up on changes until the cutover.</p>}
                <button className="veqsio-btn-secondary" onClick={reset}>Back</button>
              </div>
            )}
          </section>
        )}
      </div>
    </AppLayout>
  )
}

function ReportView({ report }: { report: Report }) {
  const t = report.totals
  const unsupported = Object.entries(report.unsupported)
  return (
    <div className="space-y-3 text-sm">
      <p>
        {report.dryRun
          ? `${t.projects} project(s), ${t.issues} issue(s): ${t.created} would be created, ${t.updated} updated, ${t.skipped} skipped.`
          : `${t.created} created, ${t.updated} updated, ${t.skipped} skipped, ${t.failed} failed.`}
        {' '}{t.comments} comments, {t.links} links, {t.subtasks} sub-issues, {t.sprints} sprints.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="text-left"><th>Project</th><th>Key</th><th>Issues</th><th>Created</th><th>Updated</th><th>Skipped</th><th>Failed</th><th>Comments</th><th>Links</th><th>Sprints</th></tr></thead>
          <tbody>
            {report.projects.map((p) => (
              <tr key={p.id}><td>{p.name}{p.existed && <span className="text-xs text-[var(--text-tertiary)]"> (existing)</span>}</td><td className="font-mono">{p.key}</td><td>{p.issues}</td><td>{p.created}</td><td>{p.updated}</td><td>{p.skipped}</td><td>{p.failed}</td><td>{p.comments}</td><td>{p.links}</td><td>{p.sprints}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        People: {report.users.matched} matched by e-mail or name, {report.users.created} {report.dryRun ? 'would be created as placeholder users' : 'placeholder users created'}, {report.users.unmatched} left unassigned.
      </p>
      {report.users.sample.length > 0 && (
        <details><summary className="cursor-pointer">People without a matching account ({report.users.sample.length})</summary>
          <ul className="list-disc ml-5">{report.users.sample.map((u, i) => <li key={i}>{u.name ?? '?'} {u.email ? `<${u.email}>` : '(no e-mail exposed)'} — {u.action}</li>)}</ul>
        </details>
      )}
      {Object.values(report.newValues).some((v) => v.length) && (
        <div><strong>{report.dryRun ? 'Will be created' : 'Created'}:</strong>
          <ul className="list-disc ml-5">{Object.entries(report.newValues).filter(([, v]) => v.length).map(([k, v]) => <li key={k}>{k}: {v.slice(0, 20).join(', ')}{v.length > 20 ? '…' : ''}</li>)}</ul>
        </div>
      )}
      {unsupported.length > 0 && (
        <details open><summary className="cursor-pointer">Data that Veqsio cannot hold ({unsupported.length})</summary>
          <ul className="list-disc ml-5">{unsupported.map(([k, n]) => <li key={k}>{k}: {n}</li>)}</ul>
        </details>
      )}
      {report.warnings.length > 0 && (
        <details><summary className="cursor-pointer">Warnings ({report.warnings.length})</summary>
          <ul className="list-disc ml-5">{report.warnings.slice(0, 200).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      {report.errors.length > 0 && (
        <details open><summary className="cursor-pointer text-red-700">Error log ({report.errors.length})</summary>
          <ul className="list-disc ml-5">{report.errors.slice(0, 200).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
