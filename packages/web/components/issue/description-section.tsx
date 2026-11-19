'use client'

import { forwardRef, useImperativeHandle, useMemo, useRef, useState, useEffect } from 'react'
import { Pencil } from 'lucide-react'
import { RichText } from '@/components/rich-text'
import { RichTextEditor } from '@/components/rich-text-editor'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { DescriptionHistoryButton } from './description-history'
import { useMyself, useUpdateIssue } from '@/hooks/use-issues'
import { DraftNotice } from '@/components/draft-notice'
import { useDraft } from '@/hooks/use-draft'
import { descriptionDraftKey } from '@/lib/drafts'
import { merge3, withMarkers } from '@/lib/merge3'

export interface DescriptionHandle {
  edit: () => void
}

export const DescriptionSection = forwardRef<DescriptionHandle, {
  issueKey: string
  description: string | null | undefined
  resolveAttachment: (name: string) => string | null
}>(function DescriptionSection({ issueKey, description, resolveAttachment }, ref) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const update = useUpdateIssue()
  const { data: myself } = useMyself()

  // Autosaved draft of an unsaved description edit (only while it differs from the saved text).
  const changed = editing && draft !== (description || '')
  const draftValue = useMemo(() => ({ text: changed ? draft : '' }), [changed, draft])
  const saved = useDraft({
    key: myself ? descriptionDraftKey(myself.id, issueKey) : null,
    value: draftValue,
    onRestore: (d) => { if (d.text && d.text !== (description || '')) { setDraft(d.text); setEditing(true) } },
    onDiscard: () => setDraft(description || ''),
  })

  const start = () => {
    setDraft(description || '')
    baseRef.current = description ?? null
    setConflict(null)
    setEditing(true)
  }
  useImperativeHandle(ref, () => ({ edit: start }))

  // Set when someone else changed the description while this one was being edited.
  const [conflict, setConflict] = useState<{ current: string | null } | null>(null)
  const baseRef = useRef<string | null>(null)

  // Someone saved a new description while this one is open: say so at once, not only when saving.
  useEffect(() => {
    if (editing && baseRef.current !== null && description !== undefined && (description ?? '') !== (baseRef.current ?? '')) {
      setConflict({ current: description ?? null })
    }
  }, [description, editing])

  // Combine their saved text with my edit line by line. Clean = just continue; conflicts are marked in the text.
  const mergeTheirs = (current: string | null) => {
    const r = merge3(baseRef.current ?? '', draft, current ?? '')
    baseRef.current = current
    setConflict(null)
    if (r.clean) { setDraft(r.merged ?? ''); toast('Their changes were merged into yours. Check the text and save.', 'success') }
    else { setDraft(withMarkers(r)); toast('Some lines were changed by both of you. They are marked with <<<<<<< and >>>>>>>; fix them before saving.', 'error') }
  }

  const save = async (overwrite = false) => {
    if (/^<<<<<<< mine$/m.test(draft)) { toast('Resolve the conflict markers (<<<<<<< ... >>>>>>>) before saving.', 'error'); return }
    try {
      await update.mutateAsync({ key: issueKey, fields: { description: draft }, ...(overwrite ? {} : { expect: { description: baseRef.current } }) })
      saved.clear()
      setConflict(null)
      setEditing(false)
    } catch (err: any) {
      if (err?.status === 409 && err?.conflict) { setConflict({ current: err.conflict.current ?? null }); return }
      toast(err?.message || 'Failed to update description', 'error')
    }
  }

  return (
    <section aria-labelledby="issue-description-heading" id="issue-description" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id="issue-description-heading" className="text-heading-3 text-[var(--text-primary)]">Description</h2>
        {!editing && (
          <div className="flex items-center gap-0.5">
          <DescriptionHistoryButton issueKey={issueKey} />
          <button
            type="button"
            onClick={start}
            aria-label="Edit description"
            title="Edit description (E)"
            className="p-1.5 rounded text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
          >
            <Pencil className="w-4 h-4" aria-hidden="true" />
          </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <DraftNotice savedAt={saved.restored?.savedAt ?? null} onDiscard={saved.discard} />
          <RichTextEditor
            label="Description"
            rows={10}
            value={draft}
            onChange={setDraft}
            issueKey={issueKey}
            maxLength={100000}
            autoFocus
            onSubmit={() => void save()}
          />
          {conflict && (
            <div role="alert" className="rounded-lg border border-[var(--warning)] bg-[var(--surface-1)] p-3 space-y-2 text-body-sm">
              <p className="font-medium">Someone else changed this description while you were editing.</p>
              <p className="text-caption text-[var(--text-secondary)]">Merge combines their changes with yours line by line; lines you both changed are marked for you to decide.</p>
              <details>
                <summary className="cursor-pointer">Show the current text</summary>
                <pre className="mt-2 whitespace-pre-wrap rounded bg-[var(--surface-2)] p-2 text-caption">{conflict.current || '(empty)'}</pre>
              </details>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="veqsio-btn-primary text-sm" onClick={() => mergeTheirs(conflict.current)}>Merge their changes into mine</button>
                <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => { baseRef.current = conflict.current; setConflict(null) }}>Keep editing (then save over theirs)</button>
                <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => void save(true)}>Overwrite with mine</button>
                <button type="button" className="veqsio-btn-ghost text-sm" onClick={() => { setDraft(conflict.current ?? ''); baseRef.current = conflict.current; setConflict(null) }}>Discard mine, use theirs</button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void save()} disabled={update.isPending} className="veqsio-btn-primary flex items-center gap-2 text-sm disabled:opacity-50">
              {update.isPending && <Spinner size="sm" />} Save
            </button>
            <button type="button" onClick={() => { saved.clear(); setEditing(false) }} className="veqsio-btn-secondary text-sm">Cancel</button>
            <span className="text-caption text-[var(--text-tertiary)] hidden sm:inline">Ctrl/Cmd+Enter to save</span>
          </div>
        </div>
      ) : description ? (
        <div
          onClick={(e) => {
            const el = e.target as HTMLElement
            if (el.closest('a, button, input, img')) return
            if (window.getSelection()?.toString()) return
            start()
          }}
          className="rounded-md p-2 -m-2 hover:bg-[var(--surface-2)] cursor-text transition-colors"
        >
          <RichText value={description} resolveAttachment={resolveAttachment} />
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          className="w-full text-left rounded-md p-2 -m-2 text-body text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
        >
          Add a description...
        </button>
      )}
    </section>
  )
})
