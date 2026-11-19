'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { aiJson, useAiFeatures, type SimilarIssue } from './use-ai'

function List({ issues }: { issues: SimilarIssue[] }) {
  return (
    <ul className="space-y-1">
      {issues.map((i) => (
        <li key={i.key} className="text-body-sm">
          <Link href={`/issues/${i.key}`} className="text-[var(--brand-500)] hover:underline font-mono">{i.key}</Link>{' '}
          <span className="text-[var(--text-primary)]">{i.summary}</span>{' '}
          <span className="text-caption text-[var(--text-tertiary)]">({i.status})</span>
        </li>
      ))}
    </ul>
  )
}

/** Issue page: list of similar issues, loaded on demand. Works without any LLM. */
export function SimilarIssuesPanel({ issueKey }: { issueKey: string }) {
  const { features } = useAiFeatures()
  const [issues, setIssues] = useState<SimilarIssue[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { setIssues(null); setError(null) }, [issueKey])
  if (!features.similar) return null

  async function load() {
    setLoading(true); setError(null)
    try {
      const r = await aiJson<{ issues: SimilarIssue[] }>('GET', `/rest/api/2/issue/${encodeURIComponent(issueKey)}/similar`)
      setIssues(r.issues)
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }

  return (
    <div className="space-y-2">
      <div className="text-caption font-semibold text-[var(--text-tertiary)] uppercase">Similar issues</div>
      {issues === null && (
        <button type="button" className="veqsio-btn-secondary text-body-sm" onClick={load} disabled={loading}>
          {loading ? 'Searching…' : 'Find similar issues'}
        </button>
      )}
      {error && <p role="alert" className="text-caption text-[var(--error)]">{error}</p>}
      {issues && (issues.length === 0 ? <p className="text-body-sm text-[var(--text-secondary)]">No similar issues found.</p> : <List issues={issues} />)}
    </div>
  )
}

/** Create page: debounced hint while typing the summary. Uses the full-text path only (no LLM call). */
export function SimilarIssuesHint({ projectId, summary, description }: { projectId: string; summary: string; description: string }) {
  const { features } = useAiFeatures()
  const [issues, setIssues] = useState<SimilarIssue[]>([])

  useEffect(() => {
    if (!features.similar || !projectId || summary.trim().length < 8) { setIssues([]); return }
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      aiJson<{ issues: SimilarIssue[] }>('POST', '/rest/api/2/issue/similar',
        { projectId: Number(projectId), summary: summary.trim().slice(0, 500), description: description.slice(0, 2000) || null }, ctrl.signal)
        .then((r) => setIssues(r.issues))
        .catch(() => { /* hint only: stay silent */ })
    }, 700)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [features.similar, projectId, summary, description])

  if (issues.length === 0) return null
  return (
    <div className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] p-3 space-y-1" aria-live="polite">
      <div className="text-caption font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
        <Sparkles className="w-3.5 h-3.5" aria-hidden /> Possible duplicates: check before creating
      </div>
      <List issues={issues} />
    </div>
  )
}
