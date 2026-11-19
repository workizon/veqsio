'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useDeleteKb, useKbArticles, useSaveKb, type KbArticle } from '@/hooks/use-servicedesk-admin'
import { confirmDialog } from '@/components/dialogs'

const onErr = (e: Error) => toast(e.message, 'error')

/** Project settings > Knowledge base. Agents manage articles; published ones are suggested to customers in the portal. */
export default function KnowledgeBasePage() {
  const id = Number(useParams<{ id: string }>().id)
  const articles = useKbArticles(id)
  const save = useSaveKb(id)
  const del = useDeleteKb(id)
  const [editing, setEditing] = useState<{ id?: number; title: string; body: string; labels: string; published: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = (a?: KbArticle) => { setError(null); setEditing(a ? { id: a.id, title: a.title, body: a.body, labels: a.labels.join(', '), published: a.published } : { title: '', body: '', labels: '', published: false }) }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!editing) return
    setError(null)
    save.mutate(
      { aid: editing.id, title: editing.title.trim(), body: editing.body, labels: editing.labels.split(',').map((l) => l.trim()).filter(Boolean).slice(0, 20), published: editing.published },
      { onSuccess: () => { toast('Article saved', 'success'); setEditing(null) }, onError: (er) => setError(er.message) },
    )
  }

  return (
    <section className="space-y-4" aria-labelledby="kb-h">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="kb-h" className="text-heading-2">Knowledge base</h2>
          <p className="text-sm text-[var(--text-secondary)]">Published articles are suggested to customers while they write a request.</p>
        </div>
        {!editing && <button className="veqsio-btn-primary" onClick={() => open()}>Create article</button>}
      </div>

      {editing && (
        <form onSubmit={submit} className="veqsio-card p-5 space-y-3" aria-label={editing.id ? 'Edit article' : 'New article'}>
          <label className="block space-y-1"><span className="text-sm font-medium">Title</span><input required autoFocus maxLength={500} className="veqsio-input w-full" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium">Article</span><textarea required rows={10} maxLength={100000} className="veqsio-input w-full" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium">Labels (comma separated)</span><input className="veqsio-input w-full" value={editing.labels} onChange={(e) => setEditing({ ...editing, labels: e.target.value })} /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} />Published (visible to customers)</label>
          {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="veqsio-btn-primary" disabled={save.isPending}>Save article</button>
            <button type="button" className="veqsio-btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      {articles.isLoading && <Spinner />}
      {articles.error && <div role="alert" className="text-[var(--error)]">{articles.error.message}</div>}
      {articles.data?.values.length === 0 && !editing && <p className="text-[var(--text-tertiary)]">No articles yet.</p>}
      <ul className="space-y-2">
        {articles.data?.values.map((a) => (
          <li key={a.id} className="veqsio-card p-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{a.title}</div>
              <div className="text-xs text-[var(--text-tertiary)]">{a.published ? 'Published' : 'Draft'} · {a.views} views · {a.helpful} found helpful{a.labels.length ? ` · ${a.labels.join(', ')}` : ''}</div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={a.published} onChange={(e) => save.mutate({ aid: a.id, published: e.target.checked }, { onError: onErr })} />Published<span className="sr-only"> {a.title}</span>
            </label>
            <button className="veqsio-btn-secondary text-sm" onClick={() => open(a)}>Edit<span className="sr-only"> {a.title}</span></button>
            <button className="veqsio-btn-ghost p-1.5 text-[var(--error)]" aria-label={`Delete ${a.title}`} onClick={async () => { if ((await confirmDialog(`Delete "${a.title}"?`))) del.mutate(a.id, { onError: onErr }) }}><Trash2 className="w-4 h-4" /></button>
          </li>
        ))}
      </ul>
    </section>
  )
}
