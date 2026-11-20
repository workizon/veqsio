'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useIssueTypesMeta } from '@/hooks/use-issues'

interface InlineCreateProps {
  /** Name used in labels, e.g. "Sprint 3" or "Backlog". */
  where: string
  pending: boolean
  onCreate: (input: { summary: string; issueTypeId: number; typeName: string }) => Promise<unknown>
}

/** "+ Create issue" row at the bottom of a sprint or the backlog. Enter creates and keeps the row open. */
export function InlineCreate({ where, pending, onCreate }: InlineCreateProps) {
  const { tr } = useI18n();

  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [typeId, setTypeId] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const { data: types = [] } = useIssueTypesMeta()
  const choices = types.filter((t) => !t.subtask)

  useEffect(() => {
    if (!typeId && choices.length) {
      setTypeId((choices.find((t) => t.name.toLowerCase() === 'task') ?? choices[0]).id)
    }
  }, [choices, typeId])

  useEffect(() => { if (open) input.current?.focus() }, [open])

  const submit = async () => {
    const text = summary.trim()
    const type = choices.find((t) => t.id === typeId)
    if (!text || !type || pending) return
    try {
      await onCreate({ summary: text, issueTypeId: Number(type.id), typeName: type.name })
      setSummary('')
      input.current?.focus()
    } catch {
      // the page shows the error toast; keep the text so nothing is lost
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-caption text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-left"
      >
        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
        {tr('Create issue')} </button>
    )
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void submit() }}
      className="flex flex-wrap items-center gap-2 p-2 border-t border-[var(--surface-3)] bg-[var(--surface-1)]"
    >
      <select
        aria-label={tr('Issue type')}
        value={typeId}
        onChange={(e) => setTypeId(e.target.value)}
        className="veqsio-input !w-auto !min-h-0 py-1 text-body-sm"
      >
        {choices.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <input
        ref={input}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setSummary('') } }}
        maxLength={500}
        placeholder={tr('What needs to be done in {where}?', { where })}
        aria-label={tr('New issue summary for {where}', { where })}
        className="veqsio-input flex-1 min-w-[200px] !min-h-0 py-1 text-body-sm"
      />
      <button type="submit" disabled={pending || !summary.trim() || !typeId} className="veqsio-btn-primary text-xs">
        {pending ? tr('Creating…') : tr('Create')}
      </button>
      <button type="button" onClick={() => { setOpen(false); setSummary('') }} className="veqsio-btn-ghost text-xs">
        {tr('Cancel')} </button>
    </form>
  )
}
