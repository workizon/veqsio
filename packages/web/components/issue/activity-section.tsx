'use client'

import { AgentBadge } from '@/components/agent-badge'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { ArrowDownUp, CornerDownRight, History, MessageSquare, X } from 'lucide-react'
import { Avatar } from '@/components/avatar'
import { CannedResponseSelect } from '@/components/canned-response-select'
import { EmptyState } from '@/components/empty-state'
import { RichText } from '@/components/rich-text'
import { RichTextEditor } from '@/components/rich-text-editor'
import { DraftNotice } from '@/components/draft-notice'
import { useDraft } from '@/hooks/use-draft'
import { commentDraftKey } from '@/lib/drafts'
import { SlaBadge } from '@/components/sla-badge'
import { Skeleton } from '@/components/skeleton'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { WorklogPanel } from '@/components/worklog-panel'
import {
  useAddComment, useDeleteComment, useIssueComments, useIssueHistory, useMyself, useToggleReaction, useUpdateComment,
} from '@/hooks/use-issues'
import { useFeatures } from '@/hooks/use-features'
import type { CommentItem, HistoryItem } from '@/hooks/use-issues'
import { useRequestMeta } from '@/hooks/use-servicedesk'
import { typingLabel, useTyping } from '@/hooks/use-realtime'
import { buildThreads, mergeActivity, type ActivityFilter } from '@/lib/issue-view'
import { RelativeTime } from './primitives'
import { TimeInStatusPanel } from './time-in-status-panel'

export interface ActivityHandle {
  focusComment: () => void
}

type TabId = ActivityFilter | 'worklog' | 'transitions'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'comments', label: 'Comments' },
  { id: 'history', label: 'History' },
  { id: 'worklog', label: 'Work log' },
  { id: 'transitions', label: 'Transitions' },
]

const QUICK_REPLIES = ['Thanks!', 'Looks good to me.', 'Could you share more details?']

type Replying = { id: string; rootId: string; author: string; internal: boolean }

export const ActivitySection = forwardRef<ActivityHandle, {
  issueKey: string
  resolveAttachment: (name: string) => string | null
}>(function ActivitySection({ issueKey, resolveAttachment }, ref) {
  const [tab, setTab] = useState<TabId>('all')
  const [newestFirst, setNewestFirst] = useState(true)
  const [composerOpen, setComposerOpen] = useState(false)
  const [text, setText] = useState('')
  const [internalNote, setInternalNote] = useState(false)
  const [replyingTo, setReplyingTo] = useState<Replying | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')

  const { data: commentsData, isLoading: commentsLoading } = useIssueComments(issueKey)
  const { data: historyData, isLoading: historyLoading } = useIssueHistory(issueKey)
  const { data: myself } = useMyself()
  const requestMeta = useRequestMeta(issueKey)
  const { typers, notifyTyping } = useTyping(`issue:${issueKey}`)
  const addComment = useAddComment()
  const updateComment = useUpdateComment()
  const deleteComment = useDeleteComment()
  const toggleReaction = useToggleReaction()
  const { isEnabled } = useFeatures()

  // Autosaved draft of the comment box: one per issue and reply target, cleared after posting or cancelling.
  const draftValue = useMemo(() => ({ text }), [text])
  const draft = useDraft({
    key: myself ? commentDraftKey(myself.id, issueKey, replyingTo?.id ?? null) : null,
    value: draftValue,
    onRestore: (d) => { if (d.text) { setText(d.text); setComposerOpen(true) } },
    onDiscard: () => setText(''),
  })

  const comments = useMemo(() => commentsData?.comments || [], [commentsData])
  const histories = useMemo(() => historyData?.histories || [], [historyData])
  const { rootOf, repliesByRoot } = useMemo(() => buildThreads(comments), [comments])
  const feed = useMemo(
    () => mergeActivity(comments, histories, { filter: tab === 'worklog' || tab === 'transitions' ? 'all' : tab, newestFirst }),
    [comments, histories, tab, newestFirst],
  )
  const staff = !!requestMeta.data?.staff
  const isRequest = !!requestMeta.data?.isRequest

  useEffect(() => {
    try {
      if (window.localStorage.getItem('veqsio:activity-newest-first') === '0') setNewestFirst(false)
    } catch {
      /* storage unavailable */
    }
  }, [])
  const toggleOrder = () => {
    setNewestFirst((v) => {
      try {
        window.localStorage.setItem('veqsio:activity-newest-first', v ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !v
    })
  }

  const focusComposer = () => {
    setTab((t) => (t === 'history' || t === 'worklog' || t === 'transitions' ? 'all' : t))
    setComposerOpen(true)
    setTimeout(() => {
      const el = document.getElementById('comment-textarea')
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el?.focus()
    }, 30)
  }
  useImperativeHandle(ref, () => ({ focusComment: focusComposer }))

  const submit = async () => {
    if (!text.trim()) return
    try {
      await addComment.mutateAsync({
        key: issueKey,
        body: text,
        internal: (internalNote || !!replyingTo?.internal) && staff,
        parentId: replyingTo?.rootId,
      })
      toast('Comment added', 'success')
      draft.clear()
      setText('')
      setReplyingTo(null)
      setComposerOpen(false)
    } catch (err: any) {
      toast(err?.message || 'Failed to add comment', 'error')
    }
  }

  const cancelComposer = () => {
    draft.clear()
    setComposerOpen(false)
    setReplyingTo(null)
    setText('')
  }

  const saveEdit = async (commentId: string) => {
    try {
      await updateComment.mutateAsync({ key: issueKey, commentId, body: editBody })
      toast('Comment updated', 'success')
      setEditId(null)
      setEditBody('')
    } catch (err: any) {
      toast(err?.message || 'Failed to update comment', 'error')
    }
  }

  const remove = async (commentId: string) => {
    try {
      await deleteComment.mutateAsync({ key: issueKey, commentId })
      toast('Comment deleted', 'success')
    } catch (err: any) {
      toast(err?.message || 'Failed to delete comment', 'error')
    }
  }

  const renderComment = (c: CommentItem, isReply: boolean) => {
    const editing = editId === c.id
    const own = !!myself && myself.id === c.author?.id
    const authorName = c.author?.displayName || 'Unknown'
    return (
      <div
        key={`comment-${c.id}`}
        id={`comment-${c.id}`}
        className={`flex items-start gap-3 ${isReply ? 'border-l-2 border-[var(--brand-500)] pl-3' : ''}`}
      >
        <Avatar name={authorName} size="md" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-body-sm font-medium text-[var(--text-primary)]">{authorName}</span>
            {c.author?.isAgent && <AgentBadge />}
            <RelativeTime date={c.created} className="text-caption text-[var(--text-tertiary)]" />
            {c.internal && (
              <span className="text-xs rounded bg-[var(--surface-2)] text-[var(--warning)] px-2 py-0.5 font-medium">Internal</span>
            )}
            {c.updated !== c.created && <span className="text-caption text-[var(--text-tertiary)]">(edited)</span>}
          </div>
          {editing ? (
            <div className="mt-2 space-y-2">
              <RichTextEditor label="Edit comment" rows={4} value={editBody} onChange={setEditBody} issueKey={issueKey} maxLength={100000} onSubmit={() => void saveEdit(c.id)} />
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void saveEdit(c.id)} disabled={updateComment.isPending} className="veqsio-btn-primary text-sm">Save</button>
                <button type="button" onClick={() => { setEditId(null); setEditBody('') }} className="veqsio-btn-secondary text-sm">Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <RichText className="mt-1" value={c.body} resolveAttachment={resolveAttachment} />
              {isEnabled('reactions') && <div className="flex items-center gap-1.5 mt-1.5 flex-wrap" role="group" aria-label="Reactions">
                {(c.reactions ?? []).map((r) => (
                  <button
                    key={r.emoji}
                    type="button"
                    aria-pressed={r.me}
                    aria-label={`${r.emoji} ${r.count}${r.me ? ', you reacted' : ''}`}
                    onClick={() => toggleReaction.mutate({ key: issueKey, commentId: c.id, emoji: r.emoji })}
                    className={`text-xs rounded-full border px-2 py-0.5 ${r.me ? 'border-[var(--brand-500)] bg-[var(--surface-2)]' : 'border-[var(--surface-3)]'}`}
                  >
                    {r.emoji} {r.count}
                  </button>
                ))}
                <details className="relative">
                  <summary className="list-none cursor-pointer text-caption text-[var(--text-tertiary)] hover:text-[var(--brand-500)] rounded border border-transparent px-1" aria-label="Add reaction">☺ +</summary>
                  <div className="absolute z-10 mt-1 flex gap-1 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-1 shadow-md">
                    {['👍', '👎', '❤️', '🎉', '😄', '👀', '🚀'].map((e) => (
                      <button
                        key={e}
                        type="button"
                        aria-label={`React with ${e}`}
                        onClick={(ev) => { toggleReaction.mutate({ key: issueKey, commentId: c.id, emoji: e }); ev.currentTarget.closest('details')?.removeAttribute('open') }}
                        className="px-1 hover:bg-[var(--surface-2)] rounded"
                      >{e}</button>
                    ))}
                  </div>
                </details>
              </div>}
              <div className="flex items-center gap-3 mt-1">
                <button
                  type="button"
                  onClick={() => {
                    setReplyingTo({ id: c.id, rootId: rootOf(c), author: authorName, internal: !!c.internal })
                    if (isReply && !text) setText(`@${authorName.split(' ')[0]} `)
                    focusComposer()
                  }}
                  className="text-caption text-[var(--text-tertiary)] hover:text-[var(--brand-500)] flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
                >
                  <CornerDownRight className="w-3 h-3" aria-hidden="true" /> Reply
                </button>
                {own && (
                  <>
                    <button type="button" onClick={() => { setEditId(c.id); setEditBody(c.body) }} className="text-caption text-[var(--text-tertiary)] hover:text-[var(--brand-500)] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">Edit</button>
                    <button type="button" onClick={() => void remove(c.id)} className="text-caption text-[var(--text-tertiary)] hover:text-[var(--error)] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">Delete</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  const renderHistory = (h: HistoryItem, itemIndex: number) => {
    const change = h.items[itemIndex]
    const authorName = h.author?.displayName || 'Unknown'
    return (
      <div key={`history-${h.id}-${itemIndex}`} className="flex items-start gap-3">
        <div className="w-7 h-7 flex items-center justify-center shrink-0">
          <History className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-body-sm text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">{authorName}</span>{h.author?.isAgent && <> <AgentBadge /></>} changed{' '}
            <span className="font-medium text-[var(--text-primary)]">{change.field}</span>
            {change.fromString && <> from <span className="line-through text-[var(--text-tertiary)]">{change.fromString}</span></>}
            {change.toString && <> to <span className="text-[var(--brand-500)] font-medium">{change.toString}</span></>}
          </p>
          <RelativeTime date={h.created} className="text-caption text-[var(--text-tertiary)]" />
        </div>
      </div>
    )
  }

  const loading = commentsLoading || historyLoading
  const showComposer = tab !== 'history' && tab !== 'worklog' && tab !== 'transitions'

  return (
    <section aria-labelledby="issue-activity-heading" id="issue-activity" className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 id="issue-activity-heading" className="text-heading-3 text-[var(--text-primary)]">Activity</h2>
        {tab !== 'worklog' && tab !== 'transitions' && (
          <button
            type="button"
            onClick={toggleOrder}
            className="flex items-center gap-1 text-caption text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded px-2 py-1 hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
          >
            <ArrowDownUp className="w-3.5 h-3.5" aria-hidden="true" />
            {newestFirst ? 'Newest first' : 'Oldest first'}
          </button>
        )}
      </div>

      <div role="tablist" aria-label="Activity" className="flex items-center gap-1 border-b border-[var(--surface-3)] overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`activity-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="activity-panel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.id === tab)
              if (e.key === 'ArrowRight') { setTab(TABS[(i + 1) % TABS.length].id); e.preventDefault() }
              if (e.key === 'ArrowLeft') { setTab(TABS[(i - 1 + TABS.length) % TABS.length].id); e.preventDefault() }
            }}
            className={`px-3 py-2 text-sm font-medium relative whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-500)] ${tab === t.id ? 'text-[var(--brand-500)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
          >
            {t.label}
            {tab === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--brand-500)] rounded-t-full" />}
          </button>
        ))}
      </div>

      <div id="activity-panel" role="tabpanel" aria-labelledby={`activity-tab-${tab}`} className="space-y-4">
        {tab === 'worklog' ? (
          <WorklogPanel issueKey={issueKey} />
        ) : tab === 'transitions' ? (
          <TimeInStatusPanel issueKey={issueKey} />
        ) : (
          <>
            {showComposer && (
              <div className="flex items-start gap-3">
                <Avatar name={myself?.displayName || myself?.name || 'Me'} size="md" />
                <div className="flex-1 min-w-0 space-y-2">
                  {!composerOpen ? (
                    <>
                      <button
                        type="button"
                        onClick={focusComposer}
                        className="w-full text-left veqsio-input text-[var(--text-tertiary)] hover:border-[var(--brand-500)]"
                      >
                        Add a comment...
                      </button>
                      <p className="text-caption text-[var(--text-tertiary)]">
                        <strong>Pro tip:</strong> press <kbd className="px-1 rounded border border-[var(--surface-4)] bg-[var(--surface-2)] font-mono text-[11px]">M</kbd> to comment
                      </p>
                    </>
                  ) : (
                    <>
                      {replyingTo && (
                        <div className="flex items-center justify-between bg-[var(--surface-2)] px-3 py-2 rounded-lg text-sm">
                          <span className="text-[var(--text-secondary)]">Replying to <strong>{replyingTo.author}</strong></span>
                          <button type="button" onClick={() => setReplyingTo(null)} aria-label="Cancel reply" className="text-[var(--text-tertiary)] hover:text-[var(--error)]">
                            <X className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </div>
                      )}
                      <DraftNotice savedAt={draft.restored?.savedAt ?? null} onDiscard={draft.discard} />
                      <RichTextEditor
                        id="comment-textarea"
                        label="Add a comment"
                        placeholder="Add a comment... (Markdown supported, @ to mention)"
                        value={text}
                        onChange={(v) => { setText(v); if (v) notifyTyping() }}
                        issueKey={issueKey}
                        maxLength={100000}
                        autoFocus
                        onSubmit={() => void submit()}
                        toolbarExtra={isRequest && staff && requestMeta.data?.deskId ? (
                          <CannedResponseSelect
                            deskId={requestMeta.data.deskId}
                            issueKey={issueKey}
                            onInsert={(t) => setText((prev) => (prev.trim() ? `${prev}\n\n${t}` : t))}
                          />
                        ) : undefined}
                      />
                      <p className="text-caption text-[var(--text-tertiary)] min-h-[1.25rem]" aria-live="polite">{typingLabel(typers)}</p>
                      {!text.trim() && (
                        <div className="flex flex-wrap gap-1.5" aria-label="Quick replies">
                          {QUICK_REPLIES.map((q) => (
                            <button
                              key={q}
                              type="button"
                              onClick={() => setText(q)}
                              className="rounded-full border border-[var(--surface-4)] px-2.5 py-0.5 text-caption text-[var(--text-secondary)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      )}
                      {isRequest && staff && (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={internalNote} onChange={(e) => setInternalNote(e.target.checked)} />
                            Internal note <span className="text-[var(--text-tertiary)]">(hidden from the customer)</span>
                          </label>
                          <div className="flex flex-wrap gap-1">{requestMeta.data?.sla?.map((x) => <SlaBadge key={x.slaId} sla={x} />)}</div>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => void submit()} disabled={!text.trim() || addComment.isPending} className="veqsio-btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
                          {addComment.isPending && <Spinner size="sm" />}
                          {replyingTo ? 'Reply' : 'Save'}
                        </button>
                        <button type="button" onClick={cancelComposer} className="veqsio-btn-secondary text-sm">Cancel</button>
                        <span className="hidden sm:inline text-caption text-[var(--text-tertiary)]">Ctrl/Cmd+Enter to save</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {loading ? (
              <div className="space-y-4" aria-busy="true" aria-label="Loading activity">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="h-7 w-7 rounded-full" />
                    <div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-4 w-full" /></div>
                  </div>
                ))}
              </div>
            ) : feed.length === 0 ? (
              <EmptyState
                icon={tab === 'history' ? History : MessageSquare}
                title={tab === 'history' ? 'No history yet' : tab === 'comments' ? 'No comments yet' : 'No activity yet'}
                description={tab === 'history' ? 'Changes to this issue will be listed here.' : 'Be the first to comment, or press M.'}
              />
            ) : (
              <ul className="space-y-4">
                {feed.map((entry) => {
                  if (entry.type === 'history') {
                    return <li key={entry.key}>{renderHistory(entry.history, entry.itemIndex)}</li>
                  }
                  const c = entry.comment
                  const replies = repliesByRoot.get(c.id) || []
                  return (
                    <li key={entry.key} className="space-y-3">
                      {renderComment(c, false)}
                      {replies.length > 0 && (
                        <div className="ml-6 sm:ml-10 space-y-3" role="group" aria-label={`Replies to ${c.author?.displayName || 'comment'}`}>
                          {replies.map((r) => renderComment(r, true))}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  )
})
