'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CornerDownLeft, Terminal, X } from 'lucide-react'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { useCommandContext, useCommandLineStore, useRunCommand, lastStoredCommand } from '@/hooks/use-command-line'
import { toast } from '@/components/toast'
import {
  applySuggestion, completeCommand, isRepeatCommand, previewLine, resolveInput, type Resolution,
} from '@/lib/command-line'

const LISTBOX = 'command-bar-listbox'
const optionId = (i: number) => `command-bar-option-${i}`

/** Command line for the selected issues (Ctrl/Cmd+Alt+J, or ">" in the palette). Mounted once, renders only while open. */
export function CommandBar() {
  const open = useCommandLineStore((s) => s.open)
  return open ? <CommandBarDialog /> : null
}

function CommandBarDialog() {
  const { tr } = useI18n();

  const { targets, initialText, autoRun, closeBar, onDone } = useCommandLineStore()
  const autoRan = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useDialogFocus(true, dialogRef, inputRef)

  const [text, setText] = useState(initialText)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  const ctx = useCommandContext(targets, true)
  const run = useRunCommand()
  const repeat = isRepeatCommand(text)
  const stored = lastStoredCommand()
  const effective = repeat ? stored ?? '' : text

  const resolution: Resolution | null = useMemo(() => (effective.trim() ? resolveInput(effective, ctx) : null), [effective, ctx])
  const completion = useMemo(() => completeCommand(text, ctx), [text, ctx])
  const suggestions = dismissed || repeat ? [] : completion.suggestions
  const activeIdx = suggestions.length === 0 ? -1 : Math.min(active, suggestions.length - 1)

  useEffect(() => { setActive(0); setDismissed(false) }, [text])

  const count = targets.length
  const preview = resolution && resolution.ok ? previewLine(resolution, count) : ''
  const firstErrorObj = resolution?.errors[0]
  const firstError = firstErrorObj?.message ?? null
  // a half-typed command ("status" with no value yet) is guidance, not an error
  const guidance = firstErrorObj?.code === 'missing' && !error
  const status = repeat
    ? stored ? tr('Repeat: {cmd}', { cmd: stored }) : tr('There is no previous command to repeat.')
    : resolution?.pending ? tr('Checking available values...') : error ?? firstError ?? preview

  async function submit() {
    if (busy) return
    if (repeat && !stored) { setError(tr('There is no previous command to repeat.')); return }
    if (!resolution || !resolution.ok) return
    setBusy(true); setError(null)
    try {
      const outcome = await run(effective, resolution, targets)
      if (outcome.ok) { onDone?.(); closeBar() } else setError(outcome.message)
    } catch (e: any) {
      setError(e?.message || tr('The command failed'))
      toast(e?.message || tr('The command failed'), 'error')
    } finally { setBusy(false) }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); setText('!!'); autoRan.current = false; useCommandLineStore.setState({ autoRun: true }); return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (suggestions.length > 0) setDismissed(true); else closeBar(); return }
    if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); setActive((i) => (i + 1) % suggestions.length) }
    else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); setActive((i) => (i - 1 + suggestions.length) % suggestions.length) }
    else if (e.key === 'Tab' && suggestions.length && activeIdx >= 0) { e.preventDefault(); setText(applySuggestion(text, completion, suggestions[activeIdx])) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      // Enter on a half-typed word accepts the highlighted suggestion; on a complete command it runs
      if (suggestions.length && activeIdx >= 0 && completion.fragment !== '' && !(resolution?.ok)) setText(applySuggestion(text, completion, suggestions[activeIdx]))
      else void submit()
    }
  }

  // "Repeat last command" from the keyboard: run as soon as the data needed to resolve it has loaded.
  useEffect(() => {
    if (!autoRun || autoRan.current || busy) return
    if (!stored) { autoRan.current = true; setError(tr('There is no previous command to repeat.')); return }
    if (resolution?.ok) { autoRan.current = true; void submit() }
    else if (resolution && !resolution.pending) autoRan.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, resolution, stored])

  const canRun = !!resolution?.ok && !busy

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh] veqsio-modal-overlay veqsio-fade-in" onMouseDown={(e) => { if (e.target === e.currentTarget) closeBar() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={tr('Command line')} data-testid="command-bar" className="w-full max-w-xl" onKeyDown={onKeyDown} tabIndex={-1}>
        <div className="veqsio-modal-panel w-full overflow-hidden veqsio-pop-in">
          <div className="flex items-center justify-between gap-3 px-4 pt-3 text-caption text-[var(--text-secondary)]">
            <span className="flex items-center gap-2"><Terminal className="w-4 h-4" aria-hidden="true" />
              {count === 0 ? tr('No issues selected') : <>{tr('Applies to')} <strong className="text-[var(--text-primary)]">{count === 1 ? targets[0].key : tr('{n} selected issues', { n: count })}</strong></>}
            </span>
            <button type="button" onClick={closeBar} aria-label={tr('Close command line')} className="veqsio-btn-ghost p-1"><X className="w-4 h-4" aria-hidden="true" /></button>
          </div>
          <div className="flex items-center gap-3 px-4 border-b border-[var(--surface-3)]">
            <span className="text-[var(--brand-600)] font-mono text-sm" aria-hidden="true">&gt;</span>
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={tr('Command')}
              aria-expanded={suggestions.length > 0}
              aria-controls={LISTBOX}
              aria-autocomplete="list"
              aria-activedescendant={activeIdx >= 0 ? optionId(activeIdx) : undefined}
              aria-describedby="command-bar-status"
              autoComplete="off"
              spellCheck={false}
              placeholder={tr('assign me, status done, priority high, label add x, due friday ...')}
              className="flex-1 bg-transparent py-3 text-[15px] font-mono outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] placeholder:font-sans"
              value={text}
              onChange={(e) => { setText(e.target.value); setError(null) }}
            />
            <button type="button" className="veqsio-btn-primary text-xs disabled:opacity-50" disabled={!canRun && !(repeat && !!stored)} onClick={() => void submit()}>
              {busy ? tr('Running...') : tr('Run')} <CornerDownLeft className="w-3 h-3 inline ml-1" aria-hidden="true" />
            </button>
          </div>

          {suggestions.length > 0 && (
            <ul id={LISTBOX} role="listbox" aria-label={tr('Suggestions')} className="max-h-60 overflow-y-auto py-1.5">
              {completion.expecting && <li role="presentation" className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{tr(completion.expecting)}</li>}
              {suggestions.map((s, i) => (
                <li
                  key={`${s.kind}:${s.label}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeIdx}
                  className="veqsio-option flex items-center gap-3 mx-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer"
                  onMouseMove={() => { if (i !== activeIdx) setActive(i) }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setText(applySuggestion(text, completion, s)); inputRef.current?.focus() }}
                >
                  <span className="text-sm text-[var(--text-primary)] font-mono">{s.label}</span>
                  {s.detail && <span className="text-xs text-[var(--text-tertiary)] truncate">{s.detail}</span>}
                </li>
              ))}
            </ul>
          )}

          <div id="command-bar-status" role="status" aria-live="polite" data-testid="command-bar-status" className="px-4 py-2.5 min-h-[2.5rem] text-sm border-t border-[var(--surface-3)] bg-[var(--surface-1)]">
            {status && (
              <p className={(firstError || error) && !resolution?.pending && !guidance ? 'flex items-start gap-2 text-[var(--error)]' : 'text-[var(--text-secondary)]'}>
                {(firstError || error) && !resolution?.pending && !guidance && <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />}
                <span>{status}</span>
              </p>
            )}
            {!firstError && !error && resolution?.ok && !resolution.undoable && (
              <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{resolution.partlyUndoable ? tr('Some of these changes cannot be undone.') : tr('This cannot be undone.')}</p>
            )}
            {resolution?.warnings.map((w) => <p key={w} className="text-xs text-[var(--warning)] mt-0.5">{w}</p>)}
            {!status && <p className="text-xs text-[var(--text-tertiary)]">{tr('Type a command.')} <kbd className="veqsio-kbd">Tab</kbd> {tr('completes,')} <kbd className="veqsio-kbd">Enter</kbd> {tr('runs,')} <kbd className="veqsio-kbd">!!</kbd> {tr('repeats the last one,')} <kbd className="veqsio-kbd">:</kbd> {tr('adds a comment.')}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
