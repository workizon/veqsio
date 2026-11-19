'use client'

import { useMemo, useState } from 'react'
import { MessageSquare, Pencil, Reply, Trash2 } from 'lucide-react'
import { RichText } from '@/components/rich-text'
import { RichTextEditor } from '@/components/rich-text-editor'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { usePageCommentActions, usePageComments, type PageComment } from '@/hooks/use-pages'
import { confirmDialog } from '@/components/dialogs'

/** Comments under a page. A comment can quote the text that was highlighted; replies go one level deep. */
export function PageComments({ pageId, canComment, quote, onClearQuote }: { pageId: number; canComment: boolean; quote: string | null; onClearQuote: () => void }) {
  const comments = usePageComments(pageId)
  const actions = usePageCommentActions(pageId)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [reply, setReply] = useState('')
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null)

  const { tops, replies } = useMemo(() => {
    const all = comments.data ?? []
    const byParent = new Map<number, PageComment[]>()
    for (const c of all) if (c.parentId) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c])
    return { tops: all.filter((c) => !c.parentId), replies: byParent }
  }, [comments.data])

  const fail = (e: Error) => toast(e.message, 'error')
  const add = () => actions.add.mutate({ body: draft, quote }, { onSuccess: () => { setDraft(''); onClearQuote() }, onError: fail })
  const sendReply = (parentId: number) => actions.add.mutate({ body: reply, parentId }, { onSuccess: () => { setReply(''); setReplyTo(null) }, onError: fail })

  const item = (c: PageComment, nested: boolean) => (
    <li key={c.id} className={nested ? 'ml-6 mt-3' : 'py-3 border-b border-[var(--surface-2)]'}>
      <div className="text-xs text-[var(--text-secondary)] mb-1">
        <strong className="text-[var(--text-primary)]">{c.author?.displayName ?? 'Unknown'}</strong> · {new Date(c.createdAt).toLocaleString()}
        {c.updatedAt !== c.createdAt && ' (edited)'}
      </div>
      {c.quote && <blockquote className="border-l-2 border-[var(--surface-4)] pl-3 text-sm text-[var(--text-secondary)] mb-1 line-clamp-3">{c.quote}</blockquote>}
      {editing?.id === c.id ? (
        <div className="space-y-2">
          <RichTextEditor value={editing.body} onChange={(body) => setEditing({ id: c.id, body })} label="Edit comment" rows={3} mentions={false} />
          <div className="flex gap-2">
            <button type="button" className="veqsio-btn-primary" disabled={!editing.body.trim() || actions.edit.isPending}
              onClick={() => actions.edit.mutate({ commentId: c.id, body: editing.body }, { onSuccess: () => setEditing(null), onError: fail })}>Save</button>
            <button type="button" className="veqsio-btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : <RichText value={c.body} className="text-sm" />}
      <div className="mt-1 flex gap-3 text-xs">
        {!nested && canComment && <button type="button" className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:underline" onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReply('') }}><Reply className="w-3 h-3" aria-hidden /> Reply</button>}
        {c.canEdit && <button type="button" className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:underline" onClick={() => setEditing({ id: c.id, body: c.body })}><Pencil className="w-3 h-3" aria-hidden /> Edit</button>}
        {c.canDelete && (
          <button type="button" className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:underline"
            onClick={async () => { if ((await confirmDialog(nested ? 'Delete this reply?' : 'Delete this comment and its replies?'))) actions.remove.mutate(c.id, { onError: fail }) }}>
            <Trash2 className="w-3 h-3" aria-hidden /> Delete
          </button>
        )}
      </div>
      {replyTo === c.id && (
        <div className="mt-2 ml-6 space-y-2">
          <RichTextEditor value={reply} onChange={setReply} label="Reply" rows={2} mentions={false} autoFocus />
          <button type="button" className="veqsio-btn-primary" disabled={!reply.trim() || actions.add.isPending} onClick={() => sendReply(c.id)}>Reply</button>
        </div>
      )}
      {!nested && (replies.get(c.id) ?? []).length > 0 && <ul>{(replies.get(c.id) ?? []).map((r) => item(r, true))}</ul>}
    </li>
  )

  return (
    <section aria-labelledby="page-comments-heading" className="mt-10">
      <h2 id="page-comments-heading" className="text-heading-3 flex items-center gap-2 mb-2"><MessageSquare className="w-5 h-5" aria-hidden /> Comments{comments.data ? ` (${comments.data.length})` : ''}</h2>
      {comments.isLoading && <Spinner />}
      {comments.isError && <p role="alert" className="text-sm text-red-600">Could not load the comments.</p>}
      {comments.data && tops.length === 0 && <p className="text-sm text-[var(--text-secondary)]">No comments yet.</p>}
      <ul>{tops.map((c) => item(c, false))}</ul>
      {canComment ? (
        <div className="mt-4 space-y-2">
          {quote && (
            <div className="flex items-start gap-2 text-sm border-l-2 border-[var(--brand-400,var(--brand-500))] pl-3 text-[var(--text-secondary)]">
              <span className="line-clamp-3 flex-1">Commenting on: {quote}</span>
              <button type="button" className="veqsio-btn-ghost text-xs" onClick={onClearQuote}>Remove quote</button>
            </div>
          )}
          <RichTextEditor value={draft} onChange={setDraft} label="Add a comment" placeholder="Add a comment" rows={3} mentions={false} onSubmit={() => draft.trim() && add()} />
          <button type="button" className="veqsio-btn-primary" disabled={!draft.trim() || actions.add.isPending} onClick={add}>Comment</button>
        </div>
      ) : <p className="mt-4 text-sm text-[var(--text-secondary)]">You do not have permission to comment on this page.</p>}
    </section>
  )
}
