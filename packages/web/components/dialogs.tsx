'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, HelpCircle, Info } from 'lucide-react'

/**
 * Confirmation, prompt and notice dialogs that replace the browser's confirm(), prompt() and alert().
 *
 *   if (!(await confirmDialog('Delete "Sprint 12"?'))) return          // a string is enough: the verb becomes the button
 *   const name = await promptDialog('Filter name', { placeholder: 'My filter' })   // null when cancelled
 *   await alertDialog('The rule needs a name.')
 *
 * `<DialogHost />` is mounted once in the providers and also exposes `window.veqsioDialogs` for modules that ship their own UI.
 */

type Tone = 'danger' | 'primary' | 'info' | 'success'
export interface ConfirmOptions { title?: string; message?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: Tone }
export interface PromptOptions { title?: string; message?: React.ReactNode; defaultValue?: string; placeholder?: string; confirmLabel?: string; required?: boolean }
export interface AlertOptions { title?: string; tone?: Tone; okLabel?: string }

type Request =
  | { kind: 'confirm'; opts: ConfirmOptions & { message: React.ReactNode }; resolve: (v: boolean) => void }
  | { kind: 'prompt'; label: string; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: 'alert'; message: React.ReactNode; opts: AlertOptions; resolve: () => void }

let push: ((r: Request) => void) | null = null
const queue: Request[] = []
let seq = 0
const enqueue = (r: Request) => { (r as Request & { id?: number }).id = ++seq; if (push) push(r); else queue.push(r) }

const DANGER = /^(delete|remove|revoke|uninstall|unlink|discard|reset|archive|rotate|clear|drop|deactivate)\b/i

/** The first word of a question such as `Delete "x"?` names the action: use it as the button and decide the tone. */
function infer(message: string): { label: string; tone: Tone; title: string } {
  const first = message.trim().split(/\s+/)[0]?.replace(/[^A-Za-z]/g, '') ?? ''
  if (DANGER.test(first)) {
    const label = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
    return { label, tone: /^(archive|rotate|reset|discard|clear)$/i.test(first) ? 'primary' : 'danger', title: `${label}?` }
  }
  return { label: 'Confirm', tone: 'primary', title: 'Please confirm' }
}

export function confirmDialog(input: string | (ConfirmOptions & { message: React.ReactNode })): Promise<boolean> {
  const opts = typeof input === 'string' ? { message: input } : input
  return new Promise((resolve) => enqueue({ kind: 'confirm', opts, resolve }))
}
export function promptDialog(label: string, opts: PromptOptions = {}): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: 'prompt', label, opts, resolve }))
}
export function alertDialog(message: React.ReactNode, opts: AlertOptions = {}): Promise<void> {
  return new Promise((resolve) => enqueue({ kind: 'alert', message, opts, resolve }))
}

const ICON: Record<Tone, { Icon: typeof Info; ring: string }> = {
  danger: { Icon: AlertTriangle, ring: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error)]' },
  primary: { Icon: HelpCircle, ring: 'bg-[var(--brand-50)] text-[var(--brand-600)]' },
  info: { Icon: Info, ring: 'bg-[var(--brand-50)] text-[var(--brand-600)]' },
  success: { Icon: CheckCircle2, ring: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]' },
}

function Shell({ tone, title, children, onCancel, labelledBy }: { tone: Tone; title: string; children: React.ReactNode; onCancel: () => void; labelledBy: string }) {
  const { Icon, ring } = ICON[tone]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey, true); document.body.style.overflow = prev }
  }, [onCancel])
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 veqsio-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={labelledBy} className="veqsio-modal-panel w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-start gap-4">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${ring}`}><Icon className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <h2 id={labelledBy} className="text-heading-3 text-[var(--text-primary)]">{title}</h2>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const btnPrimary = 'veqsio-btn-primary'
const btnDanger = 'inline-flex items-center justify-center rounded-lg bg-[var(--error)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--error)] focus-visible:ring-offset-2'

function ConfirmView({ r, done }: { r: Extract<Request, { kind: 'confirm' }>; done: () => void }) {
  const { tr } = useI18n()
  const text = typeof r.opts.message === 'string' ? r.opts.message : ''
  const inferred = infer(text)
  const tone = r.opts.tone ?? inferred.tone
  const title = r.opts.title ?? (typeof r.opts.message === 'string' ? inferred.title : 'Please confirm')
  const shownTitle = tr(title)
  const label = r.opts.confirmLabel ?? inferred.label
  const answer = (v: boolean) => { r.resolve(v); done() }
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus() }, [])
  return (
    <Shell tone={tone} title={shownTitle} onCancel={() => answer(false)} labelledBy="dialog-title">
      <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{r.opts.message}</div>
      <div className="mt-6 flex justify-end gap-2">
        <button ref={cancel} type="button" className="veqsio-btn-secondary" onClick={() => answer(false)}>{r.opts.cancelLabel ?? tr('Cancel')}</button>
        <button type="button" className={tone === 'danger' ? btnDanger : btnPrimary} onClick={() => answer(true)} autoFocus={tone !== 'danger'}>{tr(label)}</button>
      </div>
    </Shell>
  )
}

function PromptView({ r, done }: { r: Extract<Request, { kind: 'prompt' }>; done: () => void }) {
  const { tr } = useI18n();

  const [value, setValue] = useState(r.opts.defaultValue ?? '')
  const answer = (v: string | null) => { r.resolve(v); done() }
  const ok = r.opts.required === false || value.trim().length > 0
  const submit = () => { if (ok) answer(value.trim()) }
  return (
    <Shell tone="primary" title={r.opts.title ?? r.label} onCancel={() => answer(null)} labelledBy="dialog-title">
      <form className="mt-2" onSubmit={(e) => { e.preventDefault(); submit() }}>
        {r.opts.message ? <p className="mb-3 text-sm text-[var(--text-secondary)]">{r.opts.message}</p> : r.opts.title ? <p className="mb-3 text-sm text-[var(--text-secondary)]">{r.label}</p> : null}
        <input autoFocus aria-label={r.label} className="veqsio-input w-full" value={value} placeholder={r.opts.placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="veqsio-btn-secondary" onClick={() => answer(null)}>{tr('Cancel')}</button>
          <button type="submit" className={`${btnPrimary} disabled:opacity-50`} disabled={!ok}>{r.opts.confirmLabel ?? 'OK'}</button>
        </div>
      </form>
    </Shell>
  )
}

function AlertView({ r, done }: { r: Extract<Request, { kind: 'alert' }>; done: () => void }) {
  const { tr } = useI18n()
  const tone = r.opts.tone ?? 'info'
  const close = () => { r.resolve(); done() }
  return (
    <Shell tone={tone} title={r.opts.title ?? (tone === 'danger' ? tr('Something went wrong') : tr('Notice'))} onCancel={close} labelledBy="dialog-title">
      <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{r.message}</div>
      <div className="mt-6 flex justify-end"><button type="button" className={btnPrimary} autoFocus onClick={close}>{r.opts.okLabel ?? tr('OK')}</button></div>
    </Shell>
  )
}

/** Renders the dialog that is asked for, one at a time. Mount once. */
export function DialogHost() {
  const [current, setCurrent] = useState<Request | null>(null)
  const pending = useRef<Request[]>([])
  useEffect(() => {
    const show = (r: Request) => setCurrent((cur) => { if (cur) { pending.current.push(r); return cur } return r })
    push = show
    for (const r of queue.splice(0)) show(r)
    ;(window as unknown as { veqsioDialogs?: unknown }).veqsioDialogs = { confirm: confirmDialog, prompt: promptDialog, alert: alertDialog }
    return () => { push = null }
  }, [])
  const next = () => setCurrent(pending.current.shift() ?? null)
  if (!current) return null
  if (current.kind === 'confirm') return <ConfirmView key={(current as Request & { id?: number }).id} r={current} done={next} />
  if (current.kind === 'prompt') return <PromptView key={(current as Request & { id?: number }).id} r={current} done={next} />
  return <AlertView key={(current as Request & { id?: number }).id} r={current} done={next} />
}
