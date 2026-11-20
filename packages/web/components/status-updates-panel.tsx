'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { StatusUpdateBadge } from '@/components/status-update-badge'
import { usePostStatusUpdate, useStatusUpdates } from '@/hooks/use-status-updates'
import { UPDATE_OPTIONS, validateDraft, whenLabel, type UpdateState } from '@/lib/status-updates'

/** History plus a form to post a new update on a project or an epic. Posting is only offered when `canPost`. */
export function StatusUpdatesPanel({ scope, epic = false, canPost = true, initiative = false }: { scope: string; epic?: boolean; canPost?: boolean; initiative?: boolean }) {
  const { tr } = useI18n();

  const { data, isLoading, error } = useStatusUpdates(scope, epic, true, initiative)
  const post = usePostStatusUpdate(scope, epic, initiative)
  const [state, setState] = useState<UpdateState | null>(null)
  const [body, setBody] = useState('')
  const problem = validateDraft(state, body)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (problem || !state) return
    try {
      await post.mutateAsync({ state, body })
      setBody('')
      setState(null)
      toast(tr('Status update posted'), 'success')
    } catch (err: any) {
      toast(err?.message || tr('Could not post the update'), 'error')
    }
  }

  return (
    <section aria-labelledby={`su-${scope}`} className="space-y-4">
      <h2 id={`su-${scope}`} className="text-heading-3 text-[var(--text-primary)]">{tr('Status updates')}</h2>

      {canPost && (
        <form onSubmit={submit} className="veqsio-card space-y-3">
          <fieldset>
            <legend className="text-caption text-[var(--text-secondary)] mb-1">{tr('How is it going?')}</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              {UPDATE_OPTIONS.map((o) => (
                <label key={o.value} className={`cursor-pointer rounded-full border px-3 py-1 text-sm focus-within:ring-2 focus-within:ring-[var(--brand-500)] ${state === o.value ? 'border-transparent text-white' : 'border-[var(--surface-3)] text-[var(--text-secondary)]'}`} style={state === o.value ? { background: o.color } : undefined}>
                  <input type="radio" name={`state-${scope}`} value={o.value} checked={state === o.value} onChange={() => setState(o.value)} className="sr-only" />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor={`su-body-${scope}`} className="text-caption text-[var(--text-secondary)] block mb-1">{tr('Update (optional)')}</label>
            <textarea id={`su-body-${scope}`} value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={10000} className="veqsio-input w-full text-sm" placeholder={tr('What changed, what is blocking, what is next?')} />
          </div>
          <button type="submit" disabled={!!problem || post.isPending} className="veqsio-btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
            {post.isPending && <Spinner size="sm" />} {tr('Post update')} </button>
        </form>
      )}

      {isLoading && <Spinner />}
      {error && <p role="alert" className="text-[var(--error)] text-sm">{(error as Error).message}</p>}
      {data && data.updates.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">{tr('No updates yet.')}{canPost ? ` ${tr('Post the first one above.')}` : ''}</p>}
      {data && data.updates.length > 0 && (
        <ol className="space-y-3">
          {data.updates.map((u) => (
            <li key={u.id} className="veqsio-card space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusUpdateBadge state={u.state} />
                <span className="text-[var(--text-primary)] font-medium">{u.author?.displayName ?? tr('Unknown user')}</span>
                <time dateTime={u.created} title={new Date(u.created).toLocaleString()} className="text-[var(--text-tertiary)]">{whenLabel(u.created)}</time>
              </div>
              {u.body && <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">{u.body}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
