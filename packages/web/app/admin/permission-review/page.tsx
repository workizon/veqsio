'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { Modal } from '@/components/modal'

type Severity = 'high' | 'medium' | 'low' | 'info'
interface Finding { severity: Severity; code: string; text: string }
interface Summary {
  key: string; name: string; lead: string | null; scheme: { id: number; name: string } | null
  counts: { people: number; active: number; browse: number; admins: number; directGrants: number; groups: number; roles: number }
  anyone: string[]; loggedIn: string[]; findings: Finding[]
}
interface Via { type: 'role' | 'group' | 'direct' | 'lead'; name: string; group?: string }
interface Person { id: number; username: string; displayName: string; email: string; active: boolean; permissions: Array<{ key: string; via: Via[] }> }
interface Detail { project: { key: string; name: string; lead: string | null }; scheme: { name: string } | null; anyone: string[]; loggedIn: string[]; people: Person[]; groups: Array<{ name: string; members: number; permissions: number }>; findings: Finding[]; permissionNames: Record<string, string> }

const TONE: Record<Severity, string> = {
  high: 'bg-red-100 text-red-900', medium: 'bg-amber-100 text-amber-900', low: 'bg-[var(--surface-2)] text-[var(--text-secondary)]', info: 'bg-[var(--brand-50)] text-[var(--brand-700)]',
}
const Badge = ({ s, children }: { s: Severity; children: React.ReactNode }) => <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[s]}`}>{children}</span>
const worst = (f: Finding[]): Severity | null => (['high', 'medium', 'low', 'info'] as Severity[]).find((s) => f.some((x) => x.severity === s)) ?? null
const MATRIX: Array<[string, string]> = [['BROWSE_PROJECTS', 'Browse'], ['CREATE_ISSUES', 'Create'], ['EDIT_ISSUES', 'Edit'], ['TRANSITION_ISSUES', 'Transition'], ['DELETE_ISSUES', 'Delete'], ['PROJECT_ADMIN', 'Admin']]
const viaText = (v: Via) => v.type === 'role' ? `role ${v.name}${v.group ? ` via group ${v.group}` : ''}` : v.type === 'group' ? `group ${v.name}` : v.type === 'lead' ? 'project lead' : 'granted directly'

/** Permission review for administrators: who has which permission in each project, through roles, groups or directly. */
export default function PermissionReviewPage() {
  const [filter, setFilter] = useState('')
  const [onlyFindings, setOnlyFindings] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const list = useQuery({
    queryKey: ['permission-review'],
    queryFn: async () => {
      const r = await fetch('/rest/api/2/admin/reports/permission-review', { credentials: 'include' })
      if (!r.ok) throw new Error('Only system administrators can open this report.')
      return (await r.json()) as { generatedAt: string; projects: Summary[] }
    },
  })
  const rows = (list.data?.projects ?? []).filter((p) => (!onlyFindings || p.findings.some((f) => f.severity !== 'info')) && `${p.key} ${p.name} ${p.scheme?.name ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()))

  return (
    <AppLayout>
      <div className="space-y-5">
        <PageHeader
          title="Permission review"
          description="Who has access to each project and how they got it: through a project role, a group, directly, as project lead, or because everyone has it. Use it for access reviews and security audits."
          actions={<a href="/rest/api/2/admin/reports/permission-review?format=csv" className="veqsio-btn-secondary inline-flex items-center gap-2"><Download className="w-4 h-4" aria-hidden="true" />Export all projects (CSV)</a>}
        />
        <div className="flex flex-wrap items-center gap-4">
          <input className="veqsio-input w-72" placeholder="Filter projects…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter projects" />
          <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyFindings} onChange={(e) => setOnlyFindings(e.target.checked)} /> Only projects with findings</label>
          {list.data && <span className="text-sm text-[var(--text-tertiary)] sm:ml-auto">Generated {new Date(list.data.generatedAt).toLocaleString()}</span>}
        </div>

        {list.isLoading ? <div className="flex justify-center py-12"><Spinner /></div> : list.error ? <p role="alert" className="text-[var(--error)]">{(list.error as Error).message}</p> : (
          <div className="rounded-lg border border-[var(--surface-3)] overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Permission review by project</caption>
              <thead><tr className="veqsio-table-header text-left">
                <th scope="col">Project</th><th scope="col">Scheme</th><th scope="col" className="text-right">People</th><th scope="col" className="text-right">Admins</th><th scope="col" className="text-right">Direct grants</th><th scope="col">Open to</th><th scope="col">Findings</th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--text-tertiary)]">No projects match.</td></tr>}
                {rows.map((p) => {
                  const w = worst(p.findings)
                  return (
                    <tr key={p.key} className="veqsio-table-row cursor-pointer" onClick={() => setOpen(p.key)}>
                      <td className="px-4 py-2"><button type="button" className="text-left font-medium text-[var(--brand-600)] hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(p.key) }}>{p.name}</button><div className="text-xs text-[var(--text-tertiary)]">{p.key}{p.lead ? ` · lead ${p.lead}` : ''}</div></td>
                      <td className="px-4 py-2">{p.scheme?.name ?? <span className="text-[var(--text-tertiary)]">none</span>}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.counts.people}<span className="text-xs text-[var(--text-tertiary)]"> ({p.counts.active} active)</span></td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.counts.admins}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.counts.directGrants}</td>
                      <td className="px-4 py-2">{p.anyone.length > 0 && <Badge s="high">Anyone</Badge>} {p.loggedIn.length > 0 && <Badge s="medium">All signed-in users</Badge>} {!p.anyone.length && !p.loggedIn.length && <span className="text-[var(--text-tertiary)]">Named people only</span>}</td>
                      <td className="px-4 py-2">{w ? <span className="inline-flex items-center gap-2"><Badge s={w}>{w}</Badge><span className="text-xs text-[var(--text-secondary)]">{p.findings.length} finding{p.findings.length === 1 ? '' : 's'}</span></span> : <span className="text-[var(--text-tertiary)]">None</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ProjectDetail projectKey={open} onClose={() => setOpen(null)} />
    </AppLayout>
  )
}

function ProjectDetail({ projectKey, onClose }: { projectKey: string | null; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const d = useQuery({
    queryKey: ['permission-review', projectKey], enabled: !!projectKey,
    queryFn: async () => { const r = await fetch(`/rest/api/2/admin/reports/permission-review/${projectKey}`, { credentials: 'include' }); if (!r.ok) throw new Error('Could not load the project'); return (await r.json()) as Detail },
  })
  const data = d.data
  const people = (data?.people ?? []).filter((p) => `${p.displayName} ${p.username} ${p.email}`.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <Modal isOpen={!!projectKey} onClose={onClose} title={data ? `${data.project.name} (${data.project.key})` : 'Project'} size="xl">
      {!data ? <div className="flex justify-center py-10"><Spinner /></div> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--text-secondary)]">
            <span>Scheme: <strong>{data.scheme?.name ?? 'none'}</strong>{data.project.lead ? ` · Lead: ${data.project.lead}` : ''}</span>
            <a href={`/rest/api/2/admin/reports/permission-review/${data.project.key}?format=csv`} className="veqsio-btn-secondary inline-flex items-center gap-2 text-sm"><Download className="w-4 h-4" aria-hidden="true" />Export this project (CSV)</a>
          </div>
          {data.findings.length > 0 && (
            <section aria-label="Findings"><h3 className="mb-2 text-sm font-semibold">Findings</h3>
              <ul className="space-y-1.5">{data.findings.map((f, i) => <li key={i} className="flex items-start gap-2 text-sm"><Badge s={f.severity}>{f.severity}</Badge><span>{f.text}</span></li>)}</ul>
            </section>
          )}
          {data.groups.length > 0 && (
            <section aria-label="Groups"><h3 className="mb-2 text-sm font-semibold">Groups with permissions</h3>
              <div className="flex flex-wrap gap-2">{data.groups.map((g) => <span key={g.name} className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs">{g.name} · {g.members} member{g.members === 1 ? '' : 's'} · {g.permissions} permission{g.permissions === 1 ? '' : 's'}</span>)}</div>
            </section>
          )}
          <section aria-label="People">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">People with access ({data.people.length})</h3><input className="veqsio-input w-64" placeholder="Filter people…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter people" /></div>
            <div className="rounded-lg border border-[var(--surface-3)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="veqsio-table-header text-left"><th scope="col">Person</th>{MATRIX.map(([, n]) => <th key={n} scope="col" className="text-center">{n}</th>)}<th scope="col">Through</th></tr></thead>
                <tbody>
                  {people.length === 0 && <tr><td colSpan={MATRIX.length + 2} className="px-4 py-6 text-center text-[var(--text-tertiary)]">Nobody matches.</td></tr>}
                  {people.map((p) => {
                    const kinds = [...new Set(p.permissions.flatMap((x) => x.via.map((v) => v.type)))]
                    return (
                      <>
                        <tr key={p.id} className="veqsio-table-row cursor-pointer" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                          <td className="px-4 py-2"><div className="font-medium">{p.displayName}{!p.active && <span className="ml-2 text-xs text-[var(--error)]">deactivated</span>}</div><div className="text-xs text-[var(--text-tertiary)]">{p.username} · {p.email}</div></td>
                          {MATRIX.map(([k, n]) => <td key={k} className="px-4 py-2 text-center">{p.permissions.some((x) => x.key === k) ? <span aria-label={`${n}: yes`}>✓</span> : <span className="text-[var(--text-tertiary)]" aria-label={`${n}: no`}>–</span>}</td>)}
                          <td className="px-4 py-2 text-xs">{kinds.map((k) => k === 'direct' ? <Badge key={k} s="low">direct</Badge> : <span key={k} className="mr-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5">{k}</span>)}</td>
                        </tr>
                        {expanded === p.id && (
                          <tr key={`${p.id}-all`}><td colSpan={MATRIX.length + 2} className="bg-[var(--surface-1)] px-4 py-3">
                            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-xs">{p.permissions.map((x) => <li key={x.key}><strong>{data.permissionNames[x.key] ?? x.key}</strong> <span className="text-[var(--text-tertiary)]">— {x.via.map(viaText).join('; ')}</span></li>)}</ul>
                          </td></tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </Modal>
  )
}
