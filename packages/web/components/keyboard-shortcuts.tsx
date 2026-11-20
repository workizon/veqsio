'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { useUIStore } from './ui-store'
import { CommandPalette } from './command-palette'
import { CommandBar } from './command-bar'
import { useCommandLineStore } from '@/hooks/use-command-line'
import { useShortcuts } from '@/hooks/use-shortcuts'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { dispatchKey, helpSections, type HelpSection } from '@/lib/shortcuts'
import { isChromeFreeRoute } from '@/lib/routes'

/* ------------------------------------------------------------------ */
/*  Help overlay (content generated from lib/shortcuts)                 */
/* ------------------------------------------------------------------ */

export function ShortcutHelp({ sections }: { sections: HelpSection[] }) {
  const { tr } = useI18n()
  return (
    <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2" data-testid="shortcut-help">
      {sections.map((s) => (
        <section key={s.context} aria-labelledby={`shortcut-section-${s.context}`}>
          <h3 id={`shortcut-section-${s.context}`} className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
            {tr(s.label)}
          </h3>
          <ul className="divide-y divide-[var(--surface-3)]">
            {s.rows.map((r) => (
              <li key={r.id} data-shortcut-id={r.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-sm text-[var(--text-secondary)]">{tr(r.description)}</span>
                <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                  {r.combos.map((combo, ci) => (
                    <span key={ci} className="flex items-center gap-1">
                      {ci > 0 && <span className="text-[10px] text-[var(--text-tertiary)]">{tr('or')}</span>}
                      {combo.map((k, i) => (k === 'then' ? <span key={i} className="text-[10px] text-[var(--text-tertiary)]">{tr('then')}</span> : <kbd key={i} className="veqsio-kbd">{k}</kbd>))}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function ShortcutOverlay() {
  const { tr } = useI18n();

  const { shortcutsOpen, setShortcutsOpen } = useUIStore()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [mac, setMac] = useState(false)
  useEffect(() => { setMac(/mac|iphone|ipad/i.test(navigator.platform || '')) }, [])
  useDialogFocus(shortcutsOpen, dialogRef, closeRef)
  if (!shortcutsOpen) return null
  const close = () => setShortcutsOpen(false)
  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[8vh] veqsio-modal-overlay veqsio-fade-in overflow-y-auto"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-overlay-title"
        tabIndex={-1}
        className="veqsio-modal-panel w-full max-w-3xl veqsio-pop-in"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close() } }}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--surface-3)]">
          <h2 id="shortcut-overlay-title" className="text-heading-2 text-[var(--text-primary)]">{tr('Keyboard shortcuts')}</h2>
          <button ref={closeRef} onClick={close} aria-label={tr('Close')} className="veqsio-btn-ghost p-1">
            <X className="w-5 h-5 text-[var(--text-tertiary)]" />
          </button>
        </div>
        <div className="px-6 py-5 max-h-[70vh] overflow-y-auto">
          <ShortcutHelp sections={helpSections(undefined, mac)} />
        </div>
        <div className="px-6 py-3 border-t border-[var(--surface-3)] bg-[var(--surface-1)] rounded-b-2xl text-xs text-[var(--text-tertiary)]">
          {tr('Shortcuts are ignored while you type in a field. Press')} <kbd className="veqsio-kbd">{mac ? '⌘' : 'Ctrl'}</kbd> <kbd className="veqsio-kbd">K</kbd> {tr('for the command palette.')} </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Global shortcuts, palette and overlay                               */
/* ------------------------------------------------------------------ */

/** Registers the global shortcuts from the table, owns the single keydown listener, and mounts the palette and help overlay. */
export function KeyboardShortcuts() {
  const router = useRouter()
  const pathname = usePathname() || ''
  const enabled = !isChromeFreeRoute(pathname)

  useShortcuts('global', {
    'global.palette': () => { const s = useUIStore.getState(); s.setSearchOpen(!s.searchOpen) },
    'global.help': () => { const s = useUIStore.getState(); s.setShortcutsOpen(!s.shortcutsOpen) },
    'global.commandLine': () => { const s = useCommandLineStore.getState(); if (s.open) s.closeBar(); else s.openBar() },
    'global.repeatCommand': () => { const s = useCommandLineStore.getState(); if (!s.open) s.openBar('!!', true) },
    'global.create': () => useUIStore.getState().setCreateOpen(true),
    'global.goIssues': () => router.push('/issues'),
    'global.goDashboards': () => router.push('/dashboards'),
    'global.goBoards': () => router.push('/boards'),
    'global.goProjects': () => router.push('/projects'),
    'global.createProject': () => router.push('/projects?create=1'),
    'global.goAdmin': () => router.push('/admin/notifications'),
  }, enabled)

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(e: KeyboardEvent) {
      const blocked = document.querySelector('[aria-modal="true"]') !== null
      if (dispatchKey(e, Date.now(), blocked)) { e.preventDefault(); return }
      // macOS: Option+J types a symbol, so the key is not "j"; match the physical key instead
      if (e.code === 'KeyJ' && e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() !== 'j') {
        e.preventDefault()
        const s = useCommandLineStore.getState()
        if (s.open) s.closeBar(); else s.openBar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])

  if (!enabled) return null
  return (
    <>
      <CommandPalette />
      <CommandBar />
      <ShortcutOverlay />
    </>
  )
}
