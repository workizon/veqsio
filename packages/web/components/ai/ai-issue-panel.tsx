'use client'

import { useEffect, useState } from 'react'
import { Check, Copy, Sparkles } from 'lucide-react'
import { RichText } from '@/components/rich-text'
import { aiJson, useAiFeatures } from './use-ai'
import { SimilarIssuesPanel } from './similar-issues'

interface Summary { summary: string; containsInternal: boolean; truncated: boolean }
interface Review { review: string; containsInternal: boolean; truncated: boolean }

/**
 * "AI" section for the issue page sidebar. Rendered only when the server offers at least one feature.
 * Output is shown through the safe renderer and is always labelled as AI-generated.
 */
export function AiIssuePanel({ issueKey }: { issueKey: string }) {
  const { enabled, features } = useAiFeatures()
  const [result, setResult] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  useEffect(() => { setResult(null); setError(null); setReview(null); setReviewError(null) }, [issueKey])
  if (!features.similar && !(enabled && (features.summarize || features.review))) return null

  async function draftReview() {
    setReviewLoading(true); setReviewError(null)
    try { setReview(await aiJson<Review>('POST', `/rest/api/2/issue/${encodeURIComponent(issueKey)}/ai/post-incident-review`)) }
    catch (e) { setReviewError((e as Error).message) }
    finally { setReviewLoading(false) }
  }

  async function summarize() {
    setLoading(true); setError(null)
    try { setResult(await aiJson<Summary>('POST', `/rest/api/2/issue/${encodeURIComponent(issueKey)}/ai/summarize`)) }
    catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }

  async function copy() {
    if (!result) return
    await navigator.clipboard.writeText(result.summary)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="veqsio-card space-y-4" data-testid="ai-panel">
      <div className="flex items-center gap-2 text-caption font-semibold text-[var(--text-tertiary)] uppercase">
        <Sparkles className="w-4 h-4" aria-hidden /> AI
      </div>

      {enabled && features.summarize && (
        <div className="space-y-2">
          <button type="button" className="veqsio-btn-secondary text-body-sm" onClick={summarize} disabled={loading}>
            {loading ? 'Summarizing…' : 'Summarize'}
          </button>
          {error && <p role="alert" className="text-caption text-[var(--error)]">{error}</p>}
          {result && (
            <div className="space-y-2">
              <RichText value={result.summary} className="text-body-sm" />
              <p className="text-caption text-[var(--text-tertiary)]">
                AI-generated, check before use.
                {result.containsInternal && <strong className="text-[var(--warning,#b45309)]"> Includes internal notes: do not share with customers.</strong>}
                {result.truncated && ' Long threads were shortened; the oldest comments were left out.'}
              </p>
              <button type="button" className="veqsio-btn-secondary text-caption flex items-center gap-1.5" onClick={copy}>
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        </div>
      )}

      {enabled && features.review && (
        <div className="space-y-2">
          <button type="button" className="veqsio-btn-secondary text-body-sm" onClick={draftReview} disabled={reviewLoading}>
            {reviewLoading ? 'Drafting…' : 'Draft post-incident review'}
          </button>
          {reviewError && <p role="alert" className="text-caption text-[var(--error)]">{reviewError}</p>}
          {review && (
            <div className="space-y-2">
              <textarea aria-label="Post-incident review draft" className="veqsio-input w-full font-mono text-xs" rows={14} value={review.review} onChange={(e) => setReview({ ...review, review: e.target.value })} />
              <p className="text-caption text-[var(--text-tertiary)]">
                AI-generated draft from this issue and its comments. Check every fact before you share it.
                {review.containsInternal && <strong className="text-[var(--warning,#b45309)]"> Based on internal notes: do not share with customers.</strong>}
                {review.truncated && ' Long threads were shortened; the oldest comments were left out.'}
              </p>
              <button type="button" className="veqsio-btn-secondary text-caption flex items-center gap-1.5" onClick={async () => { await navigator.clipboard.writeText(review.review); setCopied(true); setTimeout(() => setCopied(false), 2000) }}>
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy Markdown'}
              </button>
            </div>
          )}
        </div>
      )}

      <SimilarIssuesPanel issueKey={issueKey} />
    </div>
  )
}
