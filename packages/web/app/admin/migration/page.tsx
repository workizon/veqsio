'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'

interface Source { id: string; name: string; href: string; kind: string; description: string }

const SOURCES: Source[] = [
  { id: 'jira', name: 'Jira (live, REST)', href: '/admin/migration/jira', kind: 'Live connection', description: 'Jira Cloud or Server/Data Center: projects, issues, comments, worklogs, attachments, history, boards and sprints.' },
  { id: 'jira-backup', name: 'Jira backup file', href: '/admin/migration/jira-backup', kind: 'File upload (XML)', description: 'Import a Jira Data Center XML backup, including users, schemes and workflows.' },
  { id: 'linear', name: 'Linear', href: '/admin/migration/linear', kind: 'Live connection (API key)', description: 'Teams, workflow states, cycles, issues, sub-issues, labels, comments and relations.' },
  { id: 'asana', name: 'Asana', href: '/admin/migration/asana', kind: 'Live connection (token)', description: 'Projects, sections, tasks, subtasks, comments, tags and due dates.' },
  { id: 'clickup', name: 'ClickUp', href: '/admin/migration/clickup', kind: 'Live connection (token)', description: 'Spaces, folders, lists, tasks, subtasks, comments, tags and time estimates.' },
  { id: 'csv', name: 'CSV file', href: '/admin/import/csv', kind: 'File upload (CSV)', description: 'Jira, Asana, ClickUp, Linear or spreadsheet exports with a column mapping step and a validation run.' },
  { id: 'json', name: 'JSON file', href: '/admin/migration/json', kind: 'File upload (JSON)', description: 'A documented simple schema for scripts and tools without their own importer.' },
]

interface HistoryRow { id: number; source: string; dryRun: boolean; status: string; startedAt: string | null; processed: number; total: number }

export default function MigrationHubPage() {
  const { tr } = useI18n();

  const [history, setHistory] = useState<HistoryRow[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    fetch('/rest/api/2/migration/tools/sessions', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then((d: { sessions: HistoryRow[] }) => setHistory(d.sessions.slice(0, 8)))
      .catch(() => setError(true))
  }, [])

  return (
    <AppLayout>
      <div className="space-y-5">
        <PageHeader title={tr('Import from other tools')} description={tr('Move projects, issues and comments to Veqsio. Every importer can run a preview first, matches people by e-mail and can be run again later to catch up without creating duplicates.')} />

        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={tr('Import sources')}>
          {SOURCES.map((s) => (
            <li key={s.id}>
              <Link href={s.href} className="veqsio-card p-4 block h-full hover:border-[var(--brand-500)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-500)]">
                <div className="font-medium text-[var(--text-primary)]">{s.name}</div>
                <div className="text-xs text-[var(--text-tertiary)] mb-2">{tr(s.kind)}</div>
                <p className="text-sm text-[var(--text-secondary)]">{tr(s.description)}</p>
              </Link>
            </li>
          ))}
        </ul>

        <section className="veqsio-card p-5 space-y-2">
          <h2 className="text-heading-3">{tr('Recent imports from Linear, Asana, ClickUp and JSON')}</h2>
          {error && <p className="text-sm text-red-700">{tr('The history could not be loaded.')}</p>}
          {!error && history === null && <p className="text-sm text-[var(--text-secondary)]">{tr('Loading…')}</p>}
          {history && history.length === 0 && <p className="text-sm text-[var(--text-secondary)]">{tr('Nothing imported yet.')}</p>}
          {history && history.length > 0 && (
            <table className="w-full text-sm">
              <thead><tr className="text-left"><th>#</th><th>{tr('Source')}</th><th>{tr('Kind')}</th><th>{tr('Status')}</th><th>{tr('Started')}</th><th>{tr('Issues')}</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.id}</td><td>{h.source}</td><td>{h.dryRun ? 'preview' : 'import'}</td><td>{h.status.replace(/_/g, ' ')}</td>
                    <td>{h.startedAt ? new Date(h.startedAt).toLocaleString(getIntlLocale()) : ''}</td><td>{h.processed}{h.total ? ` / ${h.total}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-[var(--text-tertiary)]">{tr('Documentation: docs/migration-other-tools.md')}</p>
        </section>
      </div>
    </AppLayout>
  )
}
