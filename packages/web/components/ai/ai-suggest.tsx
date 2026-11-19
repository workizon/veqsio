'use client'

import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { aiJson, useAiFeatures } from './use-ai'

interface Suggestion {
  issueType: { id: number; name: string } | null
  priority: { id: number; name: string } | null
  labels: string[]
}

export interface SuggestionApply {
  issueTypeId?: number
  priorityId?: number
  labels: string[]
}

/**
 * Create page: asks the server for a type/priority/label suggestion. Nothing is filled in until the user clicks Apply.
 * The server only returns values that exist, so applying can never create new types or labels.
 */
export function AiSuggest({ projectId, summary, description, onApply }: {
  projectId: string
  summary: string
  description: string
  onApply: (s: SuggestionApply) => void
}) {
  const { enabled, features } = useAiFeatures()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [s, setS] = useState<Suggestion | null>(null)
  if (!enabled || !features.classify) return null

  async function ask() {
    setLoading(true); setError(null); setS(null)
    try {
      setS(await aiJson<Suggestion>('POST', '/rest/api/2/issue/ai/suggest',
        { projectId: Number(projectId), summary: summary.trim(), description: description || null }))
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }

  const empty = s && !s.issueType && !s.priority && s.labels.length === 0

  return (
    <div className="space-y-2">
      <button type="button" className="veqsio-btn-secondary text-body-sm flex items-center gap-1.5"
        onClick={ask} disabled={loading || !projectId || summary.trim().length < 3}>
        <Sparkles className="w-4 h-4" aria-hidden /> {loading ? 'Thinking…' : 'Suggest type/priority/labels'}
      </button>
      {error && <p role="alert" className="text-caption text-[var(--error)]">{error}</p>}
      {s && (
        <div className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] p-3 text-body-sm space-y-2" aria-live="polite">
          {empty ? <p>No confident suggestion.</p> : (
            <ul className="space-y-0.5">
              {s.issueType && <li>Type: <strong>{s.issueType.name}</strong></li>}
              {s.priority && <li>Priority: <strong>{s.priority.name}</strong></li>}
              {s.labels.length > 0 && <li>Labels: <strong>{s.labels.join(', ')}</strong></li>}
            </ul>
          )}
          <p className="text-caption text-[var(--text-tertiary)]">AI-generated, check before use.</p>
          <div className="flex gap-2">
            {!empty && (
              <button type="button" className="veqsio-btn-primary text-body-sm" onClick={() => {
                onApply({ issueTypeId: s.issueType?.id, priorityId: s.priority?.id, labels: s.labels })
                setS(null)
              }}>Apply</button>
            )}
            <button type="button" className="veqsio-btn-secondary text-body-sm" onClick={() => setS(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  )
}
