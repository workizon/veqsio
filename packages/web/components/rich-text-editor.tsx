'use client'


import { useI18n } from '@/hooks/use-i18n'
import { AgentBadge } from '@/components/agent-badge'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AtSign, Bold, Code, FileCode, Heading2, Italic, Link2, List, ListChecks, ListOrdered, Quote, Strikethrough } from 'lucide-react'
import { RichText } from '@/components/rich-text'
import { htmlHasRichStructure, htmlToMarkdown, tsvToMarkdownTable } from '@/lib/html-to-markdown'
import {
  continueList, insertBlock, insertCodeBlock, insertLink, insertText, mentionAt, prefixLines, wrapSelection,
  type EditState,
} from '@/lib/markdown-edit'

export interface UploadedImage {
  url: string
  name: string
}

interface UserHit {
  id: number
  key: string
  name: string
  isAgent?: boolean
}

export interface RichTextEditorProps {
  value: string
  onChange: (value: string) => void
  /** Accessible name for the textarea (also used as placeholder fallback). */
  label: string
  id?: string
  placeholder?: string
  rows?: number
  maxLength?: number
  disabled?: boolean
  autoFocus?: boolean
  /** Enable @mention autocomplete (staff-only user search endpoint). Default true. */
  mentions?: boolean
  /** When set, pasted images are uploaded as attachments of this issue. */
  issueKey?: string
  /** Custom image uploader (e.g. the service desk portal). Takes precedence over issueKey. */
  uploadImage?: (file: File) => Promise<UploadedImage>
  /** Ctrl/Cmd+Enter */
  onSubmit?: () => void
  /** Extra controls rendered at the end of the toolbar (e.g. canned responses). */
  toolbarExtra?: React.ReactNode
  className?: string
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

async function uploadIssueImage(issueKey: string, file: File): Promise<UploadedImage> {
  const form = new FormData()
  const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${Date.now()}.${(file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')}`
  form.append('file', new File([file], name, { type: file.type }))
  const res = await fetch(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`, { method: 'POST', credentials: 'include', body: form })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.errorMessages?.[0] || `Upload failed (HTTP ${res.status})`)
  }
  const uploaded = (await res.json()) as Array<{ id: string; filename: string }>
  if (!uploaded[0]) throw new Error('Upload failed')
  // Site-relative URL: the API redirects authenticated viewers to a signed download URL.
  return { url: `/rest/api/2/attachment/${encodeURIComponent(uploaded[0].id)}`, name: uploaded[0].filename }
}

export function RichTextEditor({
  value, onChange, label, id, placeholder, rows = 5, maxLength, disabled, autoFocus, mentions = true,
  issueKey, uploadImage, onSubmit, toolbarExtra, className = '',
}: RichTextEditorProps) {
  const { tr } = useI18n();

  const reactId = useId()
  const textareaId = id ?? `rte-${reactId}`
  const listId = `${textareaId}-mentions`
  const ref = useRef<HTMLTextAreaElement>(null)
  const pendingSel = useRef<{ start: number; end: number } | null>(null)
  const plainPaste = useRef(false)
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [hits, setHits] = useState<UserHit[]>([])
  const [mention, setMention] = useState<{ query: string; from: number } | null>(null)
  const [active, setActive] = useState(0)

  const canUpload = !!(uploadImage || issueKey)

  // Restore selection after a programmatic edit.
  useLayoutEffect(() => {
    if (pendingSel.current && ref.current) {
      const { start, end } = pendingSel.current
      ref.current.focus()
      ref.current.setSelectionRange(start, end)
      pendingSel.current = null
    }
  })

  const state = (): EditState => {
    const ta = ref.current
    return { value, start: ta?.selectionStart ?? value.length, end: ta?.selectionEnd ?? value.length }
  }

  const apply = useCallback((next: EditState) => {
    if (maxLength && next.value.length > maxLength) {
      setStatus({ kind: 'error', text: tr('Limit is {n} characters', { n: maxLength }) })
      return
    }
    pendingSel.current = { start: next.start, end: next.end }
    onChange(next.value)
  }, [onChange, maxLength])

  /* ---------------- @mention autocomplete ---------------- */
  const updateMention = (text: string, caret: number) => {
    setMention(mentions ? mentionAt(text, caret) : null)
    setActive(0)
  }

  useEffect(() => {
    if (!mention) { setHits([]); return }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/rest/api/2/user/search?query=${encodeURIComponent(mention.query)}`, { credentials: 'include', signal: ctrl.signal })
        if (!res.ok) { setHits([]); return }
        const users = (await res.json()) as Array<{ id: number; key: string; name: string; active?: boolean; isAgent?: boolean }>
        setHits(users.filter((u) => u.active !== false).slice(0, 6).map((u) => ({ id: u.id, key: u.key, name: u.name, isAgent: u.isAgent })))
      } catch { /* aborted or offline */ }
    }, 180)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [mention])

  const pickMention = (u: UserHit) => {
    if (!mention) return
    const caret = ref.current?.selectionStart ?? value.length
    const text = `@${u.key} `
    apply({ value: value.slice(0, mention.from) + text + value.slice(caret), start: mention.from + text.length, end: mention.from + text.length })
    setMention(null)
    setHits([])
  }

  /* ---------------- toolbar ---------------- */
  const tools: Array<{ label: string; icon: React.ReactNode; run: () => void; shortcut?: string }> = [
    { label: tr('Bold'), shortcut: 'Ctrl+B', icon: <Bold className="w-4 h-4" />, run: () => apply(wrapSelection(state(), '**')) },
    { label: tr('Italic'), shortcut: 'Ctrl+I', icon: <Italic className="w-4 h-4" />, run: () => apply(wrapSelection(state(), '*')) },
    { label: tr('Strikethrough'), icon: <Strikethrough className="w-4 h-4" />, run: () => apply(wrapSelection(state(), '~~')) },
    { label: tr('Heading'), icon: <Heading2 className="w-4 h-4" />, run: () => apply(prefixLines(state(), 'heading')) },
    { label: tr('Inline code'), icon: <Code className="w-4 h-4" />, run: () => apply(wrapSelection(state(), '`', '`', 'code')) },
    { label: tr('Code block'), icon: <FileCode className="w-4 h-4" />, run: () => apply(insertCodeBlock(state())) },
    { label: tr('Link'), shortcut: 'Ctrl+K', icon: <Link2 className="w-4 h-4" />, run: () => apply(insertLink(state())) },
    { label: tr('Bulleted list'), icon: <List className="w-4 h-4" />, run: () => apply(prefixLines(state(), 'bullet')) },
    { label: tr('Numbered list'), icon: <ListOrdered className="w-4 h-4" />, run: () => apply(prefixLines(state(), 'number')) },
    { label: tr('Task list'), icon: <ListChecks className="w-4 h-4" />, run: () => apply(prefixLines(state(), 'task')) },
    { label: tr('Quote'), icon: <Quote className="w-4 h-4" />, run: () => apply(prefixLines(state(), 'quote')) },
  ]
  if (mentions) {
    tools.push({
      label: tr('Mention a user'), icon: <AtSign className="w-4 h-4" />,
      run: () => {
        const s = state()
        const needsSpace = s.start > 0 && !/\s/.test(value[s.start - 1])
        apply(insertText(s, (needsSpace ? ' ' : '') + '@'))
        // The caret moved after '@': open the picker.
        setTimeout(() => ref.current && updateMention(ref.current.value, ref.current.selectionStart), 0)
      },
    })
  }

  /* ---------------- keyboard ---------------- */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey
    plainPaste.current = mod && e.shiftKey && e.key.toLowerCase() === 'v'

    if (mention && hits.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % hits.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(hits[active]); return }
    }
    if (mention && e.key === 'Escape') { e.preventDefault(); setMention(null); return }

    if (mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'b') { e.preventDefault(); apply(wrapSelection(state(), '**')); return }
      if (k === 'i') { e.preventDefault(); apply(wrapSelection(state(), '*')); return }
      if (k === 'k') { e.preventDefault(); apply(insertLink(state())); return }
      if (k === 'enter' && onSubmit) { e.preventDefault(); onSubmit(); return }
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      const next = continueList(state())
      if (next) { e.preventDefault(); apply(next) }
    }
  }

  /* ---------------- paste ---------------- */
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (plainPaste.current) { plainPaste.current = false; return } // Ctrl/Cmd+Shift+V: raw text
    const cd = e.clipboardData
    if (!cd) return

    // 1) Images from the clipboard (screenshots) -> attachment upload
    const image = Array.from(cd.files || []).find((f) => f.type.startsWith('image/'))
    const html = cd.getData('text/html')
    // Copying from Excel also puts a bitmap on the clipboard: prefer the table when HTML is present.
    if (image && !(html && /<table[\s>]/i.test(html))) {
      if (!canUpload) return
      e.preventDefault()
      if (image.size > MAX_IMAGE_BYTES) { setStatus({ kind: 'error', text: tr('Image is too large (max 10 MB)') }); return }
      const at = state()
      setStatus({ kind: 'info', text: tr('Uploading image...') })
      try {
        const up = uploadImage ? await uploadImage(image) : await uploadIssueImage(issueKey!, image)
        const alt = up.name.replace(/[\[\]\n]/g, ' ')
        apply(insertBlock({ ...at, value: ref.current?.value ?? at.value }, `![${alt}](${up.url})`))
        if (issueKey) queryClient.invalidateQueries({ queryKey: ['issue', issueKey, 'attachments'] })
        setStatus(null)
      } catch (err) {
        setStatus({ kind: 'error', text: err instanceof Error ? tr(err.message) : tr('Upload failed') })
      }
      return
    }

    // 2) Rich HTML (tables, lists, headings, links...) -> Markdown
    if (html && htmlHasRichStructure(html)) {
      let md = ''
      try { md = htmlToMarkdown(html) } catch { md = '' }
      if (md) {
        e.preventDefault()
        const s = state()
        apply(md.includes('\n') ? insertBlock(s, md) : insertText(s, md))
        return
      }
    }

    // 3) Tab separated text (spreadsheets) -> Markdown table
    const text = cd.getData('text/plain')
    const table = text ? tsvToMarkdownTable(text) : null
    if (table) {
      e.preventDefault()
      apply(insertBlock(state(), table))
    }
    // otherwise: default paste of plain text
  }

  const invisible = tab === 'preview'
  return (
    <div className={`rte border border-[var(--surface-3)] rounded-lg bg-[var(--surface-1)] focus-within:ring-2 focus-within:ring-[var(--brand-500)] ${className}`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--surface-3)] px-2 py-1">
        <div role="tablist" aria-label={tr('Editor mode')} className="flex gap-1 mr-2">
          {(['write', 'preview'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`${textareaId}-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`${textareaId}-panel-${t}`}
              onClick={() => setTab(t)}
              className={`px-2 py-1 text-sm rounded ${tab === t ? 'bg-[var(--surface-2)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]'}`}
            >
              {t === 'write' ? tr('Write') : tr('Preview')}
            </button>
          ))}
        </div>
        <div role="toolbar" aria-label={tr('Formatting')} aria-controls={textareaId} className={`flex flex-wrap items-center gap-0.5 ${invisible ? 'opacity-40 pointer-events-none' : ''}`}>
          {tools.map((t) => (
            <button
              key={t.label}
              type="button"
              tabIndex={invisible ? -1 : 0}
              disabled={disabled || invisible}
              onMouseDown={(e) => e.preventDefault() /* keep textarea selection */}
              onClick={t.run}
              aria-label={tr(t.label)}
              title={t.shortcut ? `${tr(t.label)} (${t.shortcut})` : tr(t.label)}
              className="p-1.5 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              {t.icon}
            </button>
          ))}
        </div>
        {toolbarExtra && <div className="ml-auto">{toolbarExtra}</div>}
      </div>

      <div id={`${textareaId}-panel-write`} role="tabpanel" aria-labelledby={`${textareaId}-tab-write`} hidden={tab !== 'write'} className="relative">
        <textarea
          ref={ref}
          id={textareaId}
          aria-label={label}
          placeholder={placeholder ?? `${label}...`}
          rows={rows}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          maxLength={maxLength}
          role={mentions ? 'combobox' : undefined}
          aria-expanded={mentions ? !!(mention && hits.length) : undefined}
          aria-controls={mentions ? listId : undefined}
          aria-autocomplete={mentions ? 'list' : undefined}
          aria-activedescendant={mention && hits.length ? `${listId}-${active}` : undefined}
          onChange={(e) => { onChange(e.target.value); setStatus(null); updateMention(e.target.value, e.target.selectionStart) }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (e.key.startsWith('Arrow') && !hits.length) updateMention(e.currentTarget.value, e.currentTarget.selectionStart) }}
          onClick={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onPaste={onPaste}
          className="w-full resize-y bg-transparent px-3 py-2 text-body text-[var(--text-primary)] outline-none font-mono text-sm"
        />
        {mention && hits.length > 0 && (
          <ul id={listId} role="listbox" aria-label={tr('Mention suggestions')} className="absolute left-2 bottom-2 z-20 w-64 max-h-52 overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] shadow-lg">
            {hits.map((u, i) => (
              <li
                key={u.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); pickMention(u) }}
                onMouseEnter={() => setActive(i)}
                className={`px-3 py-1.5 text-sm cursor-pointer ${i === active ? 'bg-[var(--surface-2)]' : ''}`}
              >
                <span className="font-medium">{u.name}</span> {u.isAgent && <AgentBadge />} <span className="text-[var(--text-tertiary)]">@{u.key}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div id={`${textareaId}-panel-preview`} role="tabpanel" aria-labelledby={`${textareaId}-tab-preview`} hidden={tab !== 'preview'} className="px-3 py-2 min-h-[6rem]">
        {tab === 'preview' && (value.trim() ? <RichText value={value} /> : <p className="text-sm text-[var(--text-tertiary)] italic">{tr('Nothing to preview')}</p>)}
      </div>

      <div className="flex items-center justify-between px-3 py-1 text-xs text-[var(--text-tertiary)] border-t border-[var(--surface-3)]">
        <span>{tr('Markdown supported')}{canUpload ? ` ${tr('· paste images to attach')}` : ''} {tr('· paste tables from Excel or Jira')}</span>
        <span role="status" aria-live="polite" className={status?.kind === 'error' ? 'text-[var(--error)]' : ''}>{status?.text ?? ''}</span>
      </div>
    </div>
  )
}
