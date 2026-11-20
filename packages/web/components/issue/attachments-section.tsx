'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { ImageLightbox } from '@/components/image-lightbox'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileText, LayoutGrid, List, Trash2, Upload } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Skeleton } from '@/components/skeleton'
import { toast } from '@/components/toast'
import { useAddAttachment, useDeleteAttachment, useIssueAttachments } from '@/hooks/use-issues'
import type { ApiAttachment } from '@/hooks/use-issues'
import { attachmentPreviewUrl, formatBytes, isImageAttachment, isPdfAttachment, relativeTime } from '@/lib/issue-view'

/** Shared uploader so the toolbar "Attach" button, the drop zone and the section button use one input. */
export function useAttachmentUpload(issueKey: string) {
  const inputRef = useRef<HTMLInputElement>(null)
  const add = useAddAttachment()
  const { tr } = useI18n()
  const upload = useCallback(
    async (files: FileList | File[] | null | undefined) => {
      const list = files ? Array.from(files) : []
      if (list.length === 0) return
      try {
        await add.mutateAsync({ key: issueKey, files: list })
        toast(list.length === 1 ? tr('Attachment uploaded') : tr('{n} attachments uploaded', { n: list.length }), 'success')
      } catch (err: any) {
        toast(err?.message || tr('Failed to upload attachment'), 'error')
      } finally {
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [add, issueKey, tr],
  )
  return { inputRef, open: () => inputRef.current?.click(), upload, isPending: add.isPending }
}

export type AttachmentUploader = ReturnType<typeof useAttachmentUpload>

type ViewMode = 'grid' | 'list'

export function AttachmentsSection({ issueKey, uploader }: { issueKey: string; uploader: AttachmentUploader }) {
  const { tr } = useI18n();

  const { data, isLoading } = useIssueAttachments(issueKey)
  const del = useDeleteAttachment()
  const [view, setView] = useState<ViewMode>('grid')
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<ApiAttachment | null>(null)
  const attachments = data || []

  useEffect(() => {
    try {
      const v = window.localStorage.getItem('veqsio:attachments-view')
      if (v === 'grid' || v === 'list') setView(v)
    } catch {
      /* storage unavailable */
    }
  }, [])
  const changeView = (v: ViewMode) => {
    setView(v)
    try {
      window.localStorage.setItem('veqsio:attachments-view', v)
    } catch {
      /* storage unavailable */
    }
  }

  const remove = async (a: ApiAttachment) => {
    try {
      await del.mutateAsync({ key: issueKey, id: a.id })
      toast(tr('Attachment deleted'), 'success')
      if (preview?.id === a.id) setPreview(null)
    } catch (err: any) {
      toast(err?.message || tr('Failed to delete attachment'), 'error')
    }
  }

  const thumb = (a: ApiAttachment) => a.thumbnail || a.content
  const images = attachments.filter(isImageAttachment)

  return (
    <section
      aria-labelledby="issue-attachments-heading"
      id="issue-attachments"
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void uploader.upload(e.dataTransfer?.files)
      }}
      className={`space-y-3 rounded-lg ${dragging ? 'outline outline-2 outline-dashed outline-[var(--brand-500)] bg-[var(--brand-50)]' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="issue-attachments-heading" className="text-heading-3 text-[var(--text-primary)]">
          {tr('Attachments')} {attachments.length > 0 && <span className="text-[var(--text-tertiary)] font-normal">({attachments.length})</span>}
        </h2>
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border border-[var(--surface-3)] overflow-hidden" role="group" aria-label={tr('Attachment layout')}>
            <button type="button" aria-pressed={view === 'grid'} aria-label={tr('Grid view')} onClick={() => changeView('grid')} className={`p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-500)] ${view === 'grid' ? 'bg-[var(--surface-3)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]'}`}>
              <LayoutGrid className="w-4 h-4" aria-hidden="true" />
            </button>
            <button type="button" aria-pressed={view === 'list'} aria-label={tr('List view')} onClick={() => changeView('list')} className={`p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-500)] ${view === 'list' ? 'bg-[var(--surface-3)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]'}`}>
              <List className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <button type="button" onClick={uploader.open} disabled={uploader.isPending} className="veqsio-btn-ghost flex items-center gap-1 text-sm">
            <Upload className="w-4 h-4" aria-hidden="true" /> {uploader.isPending ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" aria-busy="true">
          <Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" />
        </div>
      ) : attachments.length === 0 ? (
        <button
          type="button"
          onClick={uploader.open}
          className="w-full rounded-lg border border-dashed border-[var(--surface-4)] px-4 py-6 text-body-sm text-[var(--text-tertiary)] hover:border-[var(--brand-500)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] transition-colors"
        >
          {tr('Drop files to attach, or')} <span className="text-[var(--brand-500)]">browse</span>
        </button>
      ) : view === 'grid' ? (
        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {attachments.map((a) => (
            <li key={a.id} className="group relative border border-[var(--surface-3)] rounded-lg overflow-hidden bg-[var(--surface-0)] hover:border-[var(--brand-500)] transition-colors">
              {isImageAttachment(a) ? (
                <button type="button" onClick={() => setPreview(a)} aria-label={`Preview ${a.filename}`} className="block w-full aspect-[4/3] bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-500)]">
                  <img src={thumb(a)} alt="" loading="lazy" className="w-full h-full object-cover" onError={(e) => { if (a.content && e.currentTarget.src !== a.content) e.currentTarget.src = a.content }} />
                </button>
              ) : isPdfAttachment(a) ? (
                <button type="button" onClick={() => setPreview(a)} aria-label={`Preview ${a.filename}`} className="flex w-full flex-col items-center justify-center aspect-[4/3] bg-[var(--surface-2)] p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-500)]">
                  <FileText className="w-8 h-8 text-[var(--error)] mb-1" aria-hidden="true" />
                  <span className="text-xs font-medium text-[var(--text-secondary)]">{tr('Preview PDF')}</span>
                </button>
              ) : (
                <a href={a.content} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center justify-center aspect-[4/3] bg-[var(--surface-2)] p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-500)]">
                  <FileText className="w-8 h-8 text-[var(--text-tertiary)] mb-1" aria-hidden="true" />
                  <span className="sr-only">{tr('Open')} {a.filename}</span>
                </a>
              )}
              <div className="p-2 border-t border-[var(--surface-3)] flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-[var(--text-primary)] truncate" title={a.filename}>{a.filename}</p>
                  <p className="text-[11px] text-[var(--text-tertiary)]">{formatBytes(a.size)} &middot; {relativeTime(a.created)}</p>
                </div>
                <button type="button" onClick={() => void remove(a)} aria-label={`Delete ${a.filename}`} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-[var(--surface-3)] border border-[var(--surface-3)] rounded-lg">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] transition-colors">
              {isImageAttachment(a) ? (
                <button type="button" onClick={() => setPreview(a)} aria-label={`Preview ${a.filename}`} className="w-9 h-9 rounded overflow-hidden shrink-0 bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">
                  <img src={thumb(a)} alt="" loading="lazy" className="w-full h-full object-cover" onError={(e) => { if (a.content && e.currentTarget.src !== a.content) e.currentTarget.src = a.content }} />
                </button>
              ) : isPdfAttachment(a) ? (
                <button type="button" onClick={() => setPreview(a)} aria-label={`Preview ${a.filename}`} className="w-9 h-9 rounded shrink-0 bg-[var(--surface-2)] text-[var(--error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">
                  <FileText className="w-full h-full p-2" aria-hidden="true" />
                </button>
              ) : (
                <FileText className="w-9 h-9 p-2 text-[var(--text-tertiary)] shrink-0" aria-hidden="true" />
              )}
              {isImageAttachment(a)
                ? <button type="button" onClick={() => setPreview(a)} className="flex-1 min-w-0 truncate text-left text-body-sm text-[var(--brand-500)] hover:underline">{a.filename}</button>
                : <a href={a.content} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-0 truncate text-body-sm text-[var(--brand-500)] hover:underline">{a.filename}</a>}
              <span className="hidden sm:block text-caption text-[var(--text-tertiary)]">{a.author?.displayName}</span>
              <span className="text-caption text-[var(--text-tertiary)] tabular-nums" title={new Date(a.created).toLocaleString(getIntlLocale())}>{formatBytes(a.size)}</span>
              <button type="button" onClick={() => void remove(a)} aria-label={`Delete ${a.filename}`} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">
                <Trash2 className="w-4 h-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal isOpen={!!preview && !isImageAttachment(preview)} onClose={() => setPreview(null)} title={preview?.filename || tr('Preview')} size="lg">
        {preview && !isImageAttachment(preview) && (
          <div className="space-y-3">
            <div className="flex items-center justify-center bg-[var(--surface-2)] rounded-lg h-[70vh] overflow-hidden">
              {isPdfAttachment(preview) ? (
                <iframe src={attachmentPreviewUrl(preview) ?? undefined} title={`Preview of ${preview.filename}`} className="w-full h-full border-0 bg-white" sandbox="allow-same-origin" />
              ) : (
                <img src={preview.content} alt={preview.filename} className="max-w-full max-h-[70vh] object-contain" />
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption text-[var(--text-tertiary)]">
                {formatBytes(preview.size)}
                {images.length > 1 && ` · ${tr('{n} of {total}', { n: images.findIndex((i) => i.id === preview.id) + 1, total: images.length })}`}
              </span>
              <div className="flex items-center gap-2">
                {images.length > 1 && (
                  <>
                    <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => { const i = images.findIndex((x) => x.id === preview.id); setPreview(images[(i - 1 + images.length) % images.length]) }}>{tr('Previous')}</button>
                    <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => { const i = images.findIndex((x) => x.id === preview.id); setPreview(images[(i + 1) % images.length]) }}>{tr('Next')}</button>
                  </>
                )}
                <a href={preview.content} download={preview.filename} className="veqsio-btn-secondary text-sm flex items-center gap-1"><Download className="w-4 h-4" aria-hidden="true" /> {tr('Download')}</a>
              </div>
            </div>
          </div>
        )}
      </Modal>
      {preview && isImageAttachment(preview) && (
        <ImageLightbox
          images={images.map((i) => ({ src: i.content, alt: i.filename, downloadName: i.filename }))}
          index={Math.max(0, images.findIndex((i) => i.id === preview.id))}
          onIndex={(n) => setPreview(images[n])}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  )
}
