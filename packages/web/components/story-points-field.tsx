'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useRef, useState } from 'react'
import { Hash } from 'lucide-react'

/** Parses user input: '' -> null (clear); otherwise a number 0..1000 with at most 2 decimals; undefined = invalid. */
export function parseStoryPointsInput(raw: string): number | null | undefined {
  const s = raw.trim().replace(',', '.')
  if (s === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined
  const n = Number(s)
  return n >= 0 && n <= 1000 ? n : undefined
}

export function formatStoryPoints(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(Number(v))
}

interface Props {
  value: number | null | undefined
  /** Persist the new value; throw to signal failure (the field reverts and shows the error). */
  onSave: (value: number | null) => Promise<void>
}

/** Sidebar field with click-to-edit. Enter saves, Escape cancels, blur saves. */
export function StoryPointsField({ value, onSave }: Props) {
  const { tr } = useI18n();

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)

  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  const start = () => { cancelled.current = false; setDraft(formatStoryPoints(value)); setError(null); setEditing(true) }

  const commit = async () => {
    if (cancelled.current || saving) return
    const parsed = parseStoryPointsInput(draft)
    if (parsed === undefined) { setError(tr('Enter a number from 0 to 1000 (max 2 decimals)')); return }
    if (parsed === (value ?? null)) { setEditing(false); return }
    setSaving(true)
    try {
      await onSave(parsed)
      setEditing(false)
    } catch (e: any) {
      setError(e?.message || tr('Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center justify-between" data-testid="story-points-field">
      <div className="flex items-center gap-2 text-[var(--text-tertiary)]">
        <Hash className="w-4 h-4" />
        <label htmlFor="sidebar-story-points" className="text-caption">{tr('Story points')}</label>
      </div>
      {editing ? (
        <div className="flex flex-col items-end">
          <input
            id="sidebar-story-points"
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={draft}
            disabled={saving}
            aria-invalid={!!error}
            aria-describedby={error ? 'sidebar-story-points-error' : undefined}
            onChange={(e) => { setDraft(e.target.value); setError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commit() }
              if (e.key === 'Escape') { cancelled.current = true; setEditing(false); setError(null) }
            }}
            onBlur={() => void commit()}
            className="veqsio-input w-20 text-right text-sm py-0.5"
          />
          {error && <span id="sidebar-story-points-error" role="alert" className="text-[10px] text-[var(--error)] mt-0.5">{error}</span>}
        </div>
      ) : (
        <button
          id="sidebar-story-points"
          type="button"
          onClick={start}
          title={tr('Click to edit story points')}
          className="text-body-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] rounded px-2 py-0.5 min-w-[3rem] text-right"
        >
          {value === null || value === undefined ? <span className="text-[var(--text-tertiary)]">{tr('None')}</span> : formatStoryPoints(value)}
        </button>
      )}
    </div>
  )
}
