'use client'

import { usePathname } from 'next/navigation'
import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useProjects } from '@/hooks/use-project-admin'
import { Upload, Download, AlertCircle, CheckCircle, FileText } from 'lucide-react'

interface ImportResult {
  row: number
  key?: string
  error?: string
}

function CsvImportPageBody() {
  const { data: projectsData } = useProjects()
  const [projectKey, setProjectKey] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<any[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [results, setResults] = useState<ImportResult[] | null>(null)
  const [stats, setStats] = useState<{ total: number; success: number; errors: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const projects = projectsData || []

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setResults(null)
    setStats(null)

    Papa.parse(f, {
      header: true,
      skipEmptyLines: true,
      preview: 5,
      complete: (res) => {
        setPreview(res.data as any[])
      },
      error: (err) => {
        toast(err.message, 'error')
      },
    })
  }

  const handleImport = async () => {
    if (!file || !projectKey) {
      toast('Please select a file and project', 'warning')
      return
    }

    setImporting(true)
    setResults(null)
    setStats(null)

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (res) => {
        try {
          const rows = res.data as any[]
          const response = await fetch('/rest/api/2/issue/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ projectKey, rows }),
          })
          const data = await response.json()
          if (!response.ok) {
            throw new Error(data.errorMessages?.[0] || 'Import failed')
          }
          setResults(data.results)
          setStats({ total: data.total, success: data.success, errors: data.errors })
          if (data.errors === 0) {
            toast(`Imported ${data.success} issues`, 'success')
          } else {
            toast(`Imported ${data.success}/${data.total} issues (${data.errors} errors)`, 'warning')
          }
        } catch (err: any) {
          toast(err.message, 'error')
        } finally {
          setImporting(false)
        }
      },
      error: (err) => {
        toast(err.message, 'error')
        setImporting(false)
      },
    })
  }

  const downloadTemplate = () => {
    const csv = 'summary,description,issuetype,priority,labels\n"Sample bug","Description here","Bug","High","bug,critical"\n"Another task","Task description","Task","Medium",""'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'veqsio-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
    toast('Template downloaded', 'success')
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <Breadcrumb items={[{ label: 'Admin', href: '/admin' }, { label: 'CSV Import' }]} />
          <h1 className="text-heading-1 text-[var(--text-primary)] mt-2">CSV Import</h1>
          <p className="text-body text-[var(--text-secondary)] mt-1">
            Bulk import issues from a CSV file.{' '}
            <a href="/admin/import/csv" className="text-[var(--brand-500)] hover:underline">
              Use the advanced wizard (Jira CSV exports, column mapping, validation)
            </a>
          </p>
        </div>

        <div className="veqsio-card space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-heading-2 text-[var(--text-primary)]">Upload file</h2>
            <button onClick={downloadTemplate} className="veqsio-btn-secondary flex items-center gap-2">
              <Download className="w-4 h-4" />
              Download Template
            </button>
          </div>

          <div>
            <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">Target project</label>
            <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)} className="veqsio-input w-full">
              <option value="">Select project...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </div>

          <div
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-[var(--surface-3)] rounded-lg p-8 text-center cursor-pointer hover:bg-[var(--surface-1)] transition-colors"
          >
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
            <FileText className="w-8 h-8 text-[var(--text-tertiary)] mx-auto mb-2" />
            {file ? (
              <p className="text-body text-[var(--text-primary)]">{file.name}</p>
            ) : (
              <>
                <p className="text-body text-[var(--text-primary)]">Click to upload CSV</p>
                <p className="text-caption text-[var(--text-tertiary)] mt-1">Supported columns: summary, description, issuetype, priority, labels</p>
              </>
            )}
          </div>

          {preview && preview.length > 0 && (
            <div>
              <h3 className="text-heading-3 text-[var(--text-primary)] mb-2">Preview (first 5 rows)</h3>
              <div className="overflow-x-auto border border-[var(--surface-3)] rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--surface-2)]">
                    <tr>
                      {Object.keys(preview[0]).map((col) => (
                        <th key={col} className="px-3 py-2 text-left text-[var(--text-secondary)] font-medium">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--surface-3)]">
                    {preview.map((row, i) => (
                      <tr key={i}>
                        {Object.keys(preview[0]).map((col) => (
                          <td key={col} className="px-3 py-2 text-[var(--text-primary)]">
                            {String(row[col] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={handleImport}
              disabled={importing || !file || !projectKey}
              className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {importing ? <Spinner size="sm" /> : <Upload className="w-4 h-4" />}
              Import Issues
            </button>
          </div>
        </div>

        {stats && (
          <div className="veqsio-card space-y-4">
            <h2 className="text-heading-2 text-[var(--text-primary)]">Results</h2>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-[var(--surface-2)] rounded-lg p-4 text-center">
                <p className="text-caption text-[var(--text-tertiary)]">Total</p>
                <p className="text-display text-[var(--text-primary)]">{stats.total}</p>
              </div>
              <div className="bg-green-500/10 rounded-lg p-4 text-center">
                <p className="text-caption text-green-600">Success</p>
                <p className="text-display text-green-600">{stats.success}</p>
              </div>
              <div className="bg-[var(--error)]/10 rounded-lg p-4 text-center">
                <p className="text-caption text-[var(--error)]">Errors</p>
                <p className="text-display text-[var(--error)]">{stats.errors}</p>
              </div>
            </div>

            {results && results.length > 0 && (
              <div className="overflow-x-auto border border-[var(--surface-3)] rounded-lg max-h-[400px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--surface-2)] sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-[var(--text-secondary)] font-medium">Row</th>
                      <th className="px-3 py-2 text-left text-[var(--text-secondary)] font-medium">Status</th>
                      <th className="px-3 py-2 text-left text-[var(--text-secondary)] font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--surface-3)]">
                    {results.map((r) => (
                      <tr key={r.row}>
                        <td className="px-3 py-2 text-[var(--text-primary)]">{r.row}</td>
                        <td className="px-3 py-2">
                          {r.key ? (
                            <span className="flex items-center gap-1 text-green-600">
                              <CheckCircle className="w-4 h-4" /> Created
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[var(--error)]">
                              <AlertCircle className="w-4 h-4" /> Error
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[var(--text-primary)]">
                          {r.key ? (
                            <a href={`/issues/${r.key}`} className="text-[var(--brand-500)] hover:underline">
                              {r.key}
                            </a>
                          ) : (
                            <span className="text-[var(--error)]">{r.error}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** Opened on its own (/admin/import) it needs the application layout; inside the admin tabs it is already inside one. */
export default function CsvImportPage() {
  const standalone = usePathname() === '/admin/import'
  return standalone ? <AppLayout><CsvImportPageBody /></AppLayout> : <CsvImportPageBody />
}
