'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'

type Mapping = Record<string, number[]>
interface Preview { headers: string[]; sample: string[][]; rowCount: number; suggestedMapping: Mapping; targetFields: string[] }
interface Msg { row: number; message: string }
interface Report {
  dryRun: boolean; total: number; created: number; updated: number; skipped: number; failed: number
  errors: Msg[]; warnings: Msg[]; keys: string[]
  newValues: { issueTypes: string[]; statuses: string[]; priorities: string[]; resolutions: string[]; users: string[] }
}

const LABELS: Record<string, string> = {
  summary: 'Summary *', issueKey: 'Issue key', issueId: 'Issue id (for parent links)', description: 'Description', issueType: 'Issue type',
  status: 'Status', priority: 'Priority', resolution: 'Resolution', assignee: 'Assignee', reporter: 'Reporter', created: 'Created',
  updated: 'Updated', resolved: 'Resolved', dueDate: 'Due date', labels: 'Labels', components: 'Components', fixVersions: 'Fix versions',
  affectsVersions: 'Affects versions', parent: 'Parent (id or key)', environment: 'Environment', originalEstimate: 'Original estimate', storyPoints: 'Story points', comment: 'Comments',
}
const MULTI = new Set(['labels', 'components', 'fixVersions', 'affectsVersions', 'comment'])

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.errorMessages?.join(', ') || res.statusText)
  return data as T
}

export default function CsvImportPage() {
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await fetch('/rest/api/2/project', { credentials: 'include' })).json() as Promise<Array<{ key: string; name: string }>>,
  })
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [projectKey, setProjectKey] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const [dateOrder, setDateOrder] = useState<'dmy' | 'mdy'>('dmy')
  const [onExisting, setOnExisting] = useState<'skip' | 'overwrite'>('skip')
  const [report, setReport] = useState<Report | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn() } catch (e: any) { setError(e.message) } finally { setBusy(false) } }

  const onFile = (f: File | undefined) => {
    if (!f) return
    setFileName(f.name); setReport(null); setPreview(null)
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      setCsv(text)
      run(async () => {
        const p = await post<Preview>('/rest/api/2/csv-import/preview', { csv: text })
        setPreview(p); setMapping(p.suggestedMapping)
      })
    }
    reader.readAsText(f)
  }

  const submit = (dryRun: boolean) => run(async () => {
    setReport(await post<Report>('/rest/api/2/csv-import/run', { csv, projectKey, mapping, dateOrder, onExisting, dryRun }))
  })

  const setSingle = (field: string, value: string) =>
    setMapping((m) => { const n = { ...m }; if (value === '') delete n[field]; else n[field] = [Number(value)]; return n })
  const setMulti = (field: string, el: HTMLSelectElement) =>
    setMapping((m) => { const n = { ...m }; const v = [...el.selectedOptions].map((o) => Number(o.value)); if (v.length) n[field] = v; else delete n[field]; return n })

  return (
    <AppLayout>
      <div className="space-y-5">
        <div>
          <Link href="/admin/migration" className="text-sm text-[var(--brand-500)]">← Import from other tools</Link>
          <h1 className="text-heading-1 text-[var(--text-primary)]">CSV import</h1>
          <p className="text-[var(--text-secondary)]">Works with Jira CSV exports and with CSV exports of Asana, ClickUp, Linear and spreadsheets: columns are matched by name and you can change every mapping. Check the column mapping, run a validation first, then import.</p>
        </div>
        {error && <div role="alert" className="rounded border border-red-300 bg-red-50 text-red-800 p-3 text-sm">{error}</div>}

        <section className="veqsio-card p-5 space-y-3">
          <h2 className="text-heading-3">1. File and project</h2>
          <label className="block text-sm space-y-1">CSV file
            <input type="file" accept=".csv,text/csv" className="block" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <label className="block text-sm space-y-1">Target project
            <select className="veqsio-input block" value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
              <option value="">Select a project…</option>
              {projects.data?.map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
            </select>
          </label>
          {preview && <p className="text-sm text-[var(--text-secondary)]">{fileName}: {preview.rowCount} rows, {preview.headers.length} columns</p>}
        </section>

        {preview && (
          <section className="veqsio-card p-5 space-y-3">
            <h2 className="text-heading-3">2. Map columns</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {preview.targetFields.map((f) => (
                <label key={f} className="text-sm space-y-1 block">{LABELS[f] ?? f}
                  {MULTI.has(f) ? (
                    <select multiple size={Math.min(4, preview.headers.length)} className="veqsio-input block w-full"
                      value={(mapping[f] ?? []).map(String)} onChange={(e) => setMulti(f, e.target)}>
                      {preview.headers.map((h, i) => <option key={i} value={i}>{h || `(column ${i + 1})`}</option>)}
                    </select>
                  ) : (
                    <select className="veqsio-input block w-full" value={mapping[f]?.[0] ?? ''} onChange={(e) => setSingle(f, e.target.value)}>
                      <option value="">— not imported —</option>
                      {preview.headers.map((h, i) => <option key={i} value={i}>{h || `(column ${i + 1})`}</option>)}
                    </select>
                  )}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label>Numeric dates are{' '}
                <select className="veqsio-input inline-block w-auto" value={dateOrder} onChange={(e) => setDateOrder(e.target.value as any)}>
                  <option value="dmy">day/month/year</option><option value="mdy">month/day/year</option>
                </select>
              </label>
              <label>Existing keys{' '}
                <select className="veqsio-input inline-block w-auto" value={onExisting} onChange={(e) => setOnExisting(e.target.value as any)}>
                  <option value="skip">skip</option><option value="overwrite">overwrite</option>
                </select>
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="text-xs w-full"><thead><tr>{preview.headers.map((h, i) => <th key={i} className="text-left px-2">{h}</th>)}</tr></thead>
                <tbody>{preview.sample.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-2 max-w-[160px] truncate">{c}</td>)}</tr>)}</tbody></table>
            </div>
            <div className="flex gap-2">
              <button className="veqsio-btn-secondary" disabled={busy || !projectKey || !mapping.summary} onClick={() => submit(true)}>Validate (dry run)</button>
              <button className="veqsio-btn-primary" disabled={busy || !projectKey || !mapping.summary || !report?.dryRun || report.failed === report.total}
                onClick={() => submit(false)}>Import {preview.rowCount} rows</button>
            </div>
            {busy && <Spinner />}
          </section>
        )}

        {report && (
          <section className="veqsio-card p-5 space-y-3" aria-live="polite">
            <h2 className="text-heading-3">{report.dryRun ? 'Validation result' : 'Import result'}</h2>
            <p className="text-sm">
              {report.dryRun ? `${report.created} rows ready` : `${report.created} created, ${report.updated} updated, ${report.skipped} skipped`}
              {' · '}<span className={report.failed ? 'text-red-700' : ''}>{report.failed} with errors</span>
            </p>
            {Object.entries(report.newValues).some(([, v]) => v.length) && (
              <div className="text-sm"><strong>Will be created:</strong>
                <ul className="list-disc ml-5">
                  {Object.entries(report.newValues).filter(([, v]) => v.length).map(([k, v]) => <li key={k}>{k}: {v.slice(0, 20).join(', ')}{v.length > 20 ? '…' : ''}</li>)}
                </ul>
              </div>
            )}
            {report.errors.length > 0 && <details open><summary className="cursor-pointer text-sm text-red-700">Errors ({report.errors.length})</summary>
              <ul className="list-disc ml-5 text-sm">{report.errors.slice(0, 100).map((m, i) => <li key={i}>Row {m.row}: {m.message}</li>)}</ul></details>}
            {report.warnings.length > 0 && <details><summary className="cursor-pointer text-sm">Warnings ({report.warnings.length})</summary>
              <ul className="list-disc ml-5 text-sm">{report.warnings.slice(0, 100).map((m, i) => <li key={i}>Row {m.row}: {m.message}</li>)}</ul></details>}
          </section>
        )}
      </div>
    </AppLayout>
  )
}
