'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, ArrowLeft, CornerDownRight, Download, Paperclip, Reply, Star } from 'lucide-react'
import { PortalShell, timeAgo } from '@/components/portal-shell'
import { Skeleton } from '@/components/skeleton'
import { Avatar } from '@/components/avatar'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { PortalApprovals } from '@/components/approvals/portal-approvals'
import { RichText } from '@/components/rich-text'
import { ImageLightbox } from '@/components/image-lightbox'
import { RichTextEditor } from '@/components/rich-text-editor'
import { usePortalAttachments, usePortalComment, usePortalCsat, usePortalRequest, useUploadPortalAttachment } from '@/hooks/use-servicedesk'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

function formatSize(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function Attachments({ slug, requestKey, canUpload }: { slug: string; requestKey: string; canUpload: boolean }) {
  const { tr } = useI18n();

  const list = usePortalAttachments(slug, requestKey)
  const upload = useUploadPortalAttachment(slug, requestKey)
  const [localError, setLocalError] = useState('')
  const [viewing, setViewing] = useState<number | null>(null)

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    setLocalError('')
    if (!file) return
    if (file.size > MAX_UPLOAD_BYTES) { setLocalError(tr('File is too large (max 10 MB).')); return }
    upload.mutate(file)
  }

  const items = list.data?.values ?? []
  const pictures = items.filter((a) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.mimeType))
  return (
    <section aria-labelledby="att-h" className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)] p-4 space-y-3">
      <h2 id="att-h" className="text-heading-3 text-[var(--text-primary)]">{tr('Attachments')}</h2>
      {items.length === 0 && <p className="text-body-sm text-[var(--text-tertiary)]">{tr('No attachments.')}</p>}
      <ul className="space-y-1.5">
        {items.map((a) => (
          <li key={a.id}>
            {/* Downloads are served as attachments; the server sets the safe headers. */}
            <a href={a.content} download onClick={(e) => { const at = pictures.findIndex((p) => p.id === a.id); if (at >= 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); setViewing(at) } }} className="group flex items-center gap-2.5 min-h-[44px] rounded-lg px-2.5 -mx-1 hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-400)]">
              <Paperclip aria-hidden className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm font-medium text-[var(--text-primary)]">{a.filename}</span>
                <span className="block text-caption text-[var(--text-tertiary)]">{formatSize(a.size)}{a.mine ? ' · you' : ''}</span>
              </span>
              <Download aria-hidden className="w-4 h-4 shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)]" />
            </a>
          </li>
        ))}
      </ul>
      {canUpload && (
        <div className="border-t border-[var(--surface-3)] pt-3">
          <label htmlFor="attach" className="block text-body-sm font-medium text-[var(--text-primary)] mb-1.5">{tr('Attach a file')} <span className="font-normal text-[var(--text-tertiary)]">{tr('(max 10 MB)')}</span></label>
          <input
            id="attach" type="file" onChange={onPick} disabled={upload.isPending}
            className="block w-full text-body-sm text-[var(--text-secondary)] file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-[var(--surface-4)] file:bg-[var(--surface-0)] file:px-3 file:py-2 file:text-body-sm file:font-medium file:text-[var(--text-primary)] hover:file:bg-[var(--surface-2)]"
          />
          {upload.isPending && <p role="status" className="mt-1.5 text-caption text-[var(--text-secondary)]">{tr('Uploading…')}</p>}
        </div>
      )}
      {viewing !== null && pictures[viewing] && (
        <ImageLightbox images={pictures.map((p) => ({ src: p.content, alt: p.filename, downloadName: p.filename }))} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
      {(localError || upload.error) && <p role="alert" className="flex items-center gap-1.5 text-caption text-[var(--error)]"><AlertCircle aria-hidden className="w-3.5 h-3.5" />{localError || upload.error?.message}</p>}
    </section>
  )
}

export default function PortalRequestPage() {
  const { tr } = useI18n();

  const { slug, key } = useParams<{ slug: string; key: string }>()
  const { data, isLoading, error } = usePortalRequest(slug, key)
  const comment = usePortalComment(slug, key)
  const csat = usePortalCsat(slug, key)
  const upload = useUploadPortalAttachment(slug, key)
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<{ id: number; author: string } | null>(null)
  const [rating, setRating] = useState(0)
  const [feedback, setFeedback] = useState('')

  const back = (
    <Link href={`/portal/${slug}/requests`} className="inline-flex items-center gap-1.5 min-h-[44px] -ml-2 px-2 rounded-md text-body font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-300)]">
      <ArrowLeft aria-hidden className="w-4 h-4" /> {tr('My requests')} </Link>
  )

  return (
    <PortalShell slug={slug}>
      {isLoading && (
        <div aria-busy="true" aria-label={tr('Loading request')} className="space-y-6">
          <Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-2/3" />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"><Skeleton className="h-64 rounded-xl" /><Skeleton className="h-48 rounded-xl" /></div>
        </div>
      )}
      {error && (
        <div className="space-y-2">{back}
          <div className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)]"><EmptyState icon="frown" title={tr('Request not found')} description={tr('It may have been removed, or it belongs to someone else.')} action={<Link href={`/portal/${slug}/requests`} className="veqsio-btn-secondary min-h-[44px] inline-flex items-center px-4">{tr('Back to my requests')}</Link>} /></div>
        </div>
      )}
      {data && (() => {
        const byId = new Map(data.comments.map((c) => [c.id, c]))
        const rootOf = (c: (typeof data.comments)[number]) => {
          let cur = c
          const seen = new Set<number>()
          while (cur.parentId != null && byId.has(cur.parentId) && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parentId)! }
          return cur.id
        }
        const bubble = (c: (typeof data.comments)[number], reply: boolean) => {
          const who = c.mine ? tr('You') : c.author ?? tr('Support')
          return (
            <li key={c.id} className={`flex gap-3 ${c.mine ? 'flex-row-reverse' : ''} ${reply ? 'ml-6 sm:ml-10' : ''}`}>
              <Avatar name={who} size="lg" className="mt-0.5" />
              <div className={`min-w-0 max-w-[calc(100%-3.5rem)] flex-1 sm:flex-none sm:max-w-[85%]`}>
                <div className={`flex items-baseline gap-2 text-caption text-[var(--text-tertiary)] ${c.mine ? 'justify-end' : ''}`}>
                  <span className="font-medium text-[var(--text-primary)]">{who}</span>
                  {!c.mine && <span className="rounded-full bg-[var(--surface-2)] px-1.5 text-caption-sm text-[var(--text-secondary)]">{tr('Support')}</span>}
                  <time dateTime={c.created} title={new Date(c.created).toLocaleString()}>{timeAgo(c.created)}</time>
                </div>
                <div className={`mt-1 rounded-2xl border px-4 py-3 text-body ${c.mine ? 'rounded-tr-sm border-[var(--brand-100)] bg-[var(--brand-50)]' : 'rounded-tl-sm border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)]'}`}>
                  <RichText value={c.body} />
                </div>
                {!data.resolved && (
                  <button type="button" className={`mt-0.5 inline-flex items-center gap-1 min-h-[36px] px-1 text-caption text-[var(--text-tertiary)] hover:text-[var(--brand-600)] ${c.mine ? 'float-right' : ''}`}
                    onClick={() => { setReplyTo({ id: rootOf(c), author: c.mine ? tr('yourself') : c.author ?? tr('Support') }); document.getElementById('reply')?.focus() }}>
                    <Reply aria-hidden className="w-3.5 h-3.5" /> {tr('Reply')} </button>
                )}
              </div>
            </li>
          )
        }
        const roots = data.comments.filter((c) => rootOf(c) === c.id)
        return (
          <div className="space-y-6">
            <div className="space-y-3">
              {back}
              <div className="flex flex-wrap items-center gap-2 text-body-sm text-[var(--text-tertiary)]">
                <span className="font-mono">{data.key}</span>
                <StatusBadge status={data.status} category={data.resolved ? 'done' : undefined} />
              </div>
              <h1 className="text-display text-[var(--text-primary)] break-words">{data.summary}</h1>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] items-start">
              <aside aria-label={tr('Request details')} className="lg:order-2 space-y-4 lg:sticky lg:top-24">
                <section aria-labelledby="det-h" className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)] p-4">
                  <h2 id="det-h" className="text-heading-3 text-[var(--text-primary)] mb-3">{tr('Details')}</h2>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-body-sm">
                    <dt className="text-[var(--text-tertiary)]">{tr('Status')}</dt><dd className="justify-self-end"><StatusBadge status={data.status} category={data.resolved ? 'done' : undefined} /></dd>
                    <dt className="text-[var(--text-tertiary)]">{tr('Reference')}</dt><dd className="justify-self-end font-mono text-[var(--text-primary)]">{data.key}</dd>
                    <dt className="text-[var(--text-tertiary)]">{tr('Created')}</dt><dd className="justify-self-end text-right text-[var(--text-primary)]" title={new Date(data.created).toLocaleString()}>{timeAgo(data.created)}</dd>
                    {data.resolved && <><dt className="text-[var(--text-tertiary)]">{tr('Resolved')}</dt><dd className="justify-self-end text-right text-[var(--text-primary)]" title={new Date(data.resolved).toLocaleString()}>{timeAgo(data.resolved)}</dd></>}
                    <dt className="text-[var(--text-tertiary)]">{tr('Replies')}</dt><dd className="justify-self-end text-[var(--text-primary)]">{data.comments.length}</dd>
                  </dl>
                </section>
                <Attachments slug={slug} requestKey={key} canUpload={!data.resolved} />
              </aside>

              <div className="lg:order-1 min-w-0 space-y-6">
                {data.description && (
                  <section aria-labelledby="desc-h" className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)] p-5">
                    <h2 id="desc-h" className="text-heading-3 text-[var(--text-primary)] mb-2">{tr('Description')}</h2>
                    <RichText value={data.description} />
                  </section>
                )}

                <PortalApprovals slug={slug} requestKey={key} />

                <section aria-labelledby="act-h" className="space-y-4">
                  <h2 id="act-h" className="text-heading-3 text-[var(--text-primary)]">{tr('Activity')}</h2>
                  {roots.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-[var(--surface-4)] px-4 py-6 text-center text-body-sm text-[var(--text-secondary)]">{tr('No replies yet. We will let you know here as soon as someone responds.')}</p>
                  ) : (
                    <ul className="space-y-5">
                      {roots.map((root) => (
                        <li key={root.id} className="list-none">
                          <ul className="space-y-3">
                            {bubble(root, false)}
                            {data.comments.filter((r) => r.id !== root.id && rootOf(r) === root.id).map((r) => bubble(r, true))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {!data.resolved && (
                  <form
                    onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; comment.mutate({ body: text, parentId: replyTo?.id }, { onSuccess: () => { setText(''); setReplyTo(null) } }) }}
                    className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)] p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="text-heading-3 text-[var(--text-primary)]" htmlFor="reply">{replyTo ? tr('Replying to {name}', { name: replyTo.author }) : tr('Add a comment')}</label>
                      {replyTo && <button type="button" className="inline-flex items-center gap-1 min-h-[36px] text-caption text-[var(--brand-600)] hover:underline" onClick={() => setReplyTo(null)}><CornerDownRight aria-hidden className="w-3.5 h-3.5" />{tr('Cancel reply')}</button>}
                    </div>
                    <RichTextEditor
                      id="reply" label={tr('Comment')} rows={4} maxLength={20000} mentions={false} value={text} onChange={setText}
                      uploadImage={async (file) => {
                        const a = await upload.mutateAsync(file)
                        return { url: a.content, name: a.filename }
                      }}
                    />
                    {comment.error && <p role="alert" className="flex items-center gap-1.5 text-body-sm text-[var(--error)]"><AlertCircle aria-hidden className="w-4 h-4" />{comment.error.message}</p>}
                    <div className="flex justify-end"><button className="veqsio-btn-primary min-h-[44px] px-5" disabled={comment.isPending || !text.trim()}>{comment.isPending ? tr('Sending…') : tr('Send')}</button></div>
                  </form>
                )}

                {data.resolved && !data.csat && (
                  <form onSubmit={(e) => { e.preventDefault(); if (rating) csat.mutate({ rating, comment: feedback || undefined }) }} className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)] p-5 space-y-4">
                    <div>
                      <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('How was your experience?')}</h2>
                      <p className="text-body-sm text-[var(--text-secondary)]">{tr('Your rating helps us improve. 1 is poor, 5 is excellent.')}</p>
                    </div>
                    <div role="radiogroup" aria-label={tr('Rating')} className="flex gap-2">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button type="button" key={n} role="radio" aria-checked={rating === n} aria-label={`${n} of 5`}
                          onClick={() => setRating(n)}
                          className={`w-11 h-11 rounded-full border text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-400)] ${rating === n ? 'border-[var(--brand-600)] bg-[var(--brand-600)] text-[var(--text-inverse)]' : 'border-[var(--surface-4)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'}`}>{n}</button>
                      ))}
                    </div>
                    <label className="block"><span className="sr-only">{tr('Feedback')}</span>
                      <textarea rows={2} maxLength={2000} placeholder={tr('Anything we could do better? (optional)')} className="veqsio-input w-full px-3" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
                    </label>
                    <button className="veqsio-btn-primary min-h-[44px] px-5" disabled={!rating || csat.isPending}>{tr('Submit feedback')}</button>
                  </form>
                )}
                {data.csat && (
                  <p className="flex items-center gap-2 rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] px-4 py-3 text-body-sm text-[var(--text-secondary)]">
                    <Star aria-hidden className="w-4 h-4 text-[var(--warning)]" />{tr('Thanks for your feedback — you rated this')} {data.csat.rating}/5.
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </PortalShell>
  )
}
