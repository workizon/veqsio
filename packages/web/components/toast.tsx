'use client'

import { create } from 'zustand'
import { useEffect, useRef, useState } from 'react'
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle, Undo2 } from 'lucide-react'
import { Countdown } from '@/lib/undoable'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'info' | 'warning'
  /** Milliseconds before the toast closes on its own; 0 keeps it until dismissed. Default 4000. */
  duration?: number
  action?: ToastAction
  /** Marks a timed undo toast: shows an undo icon on the action and never closes while hovered or focused. */
  undo?: boolean
  /** Runs when the countdown ends (not when the action was clicked or the toast was dismissed). */
  onExpire?: () => void
  /** Runs when the user closes the toast with the X button or Escape. */
  onDismiss?: () => void
}

interface ToastStore {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => string
  removeToast: (id: string) => void
}

export const DEFAULT_TOAST_MS = 4000
export const UNDO_TOAST_MS = 6000

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = Math.random().toString(36).slice(2)
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    return id
  },
  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
}

const colors = {
  success: 'bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/20',
  error: 'bg-[var(--error)]/10 text-[var(--error)] border-[var(--error)]/20',
  info: 'bg-[var(--info)]/10 text-[var(--info)] border-[var(--info)]/20',
  warning: 'bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/20',
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const duration = toast.duration ?? (toast.undo ? UNDO_TOAST_MS : DEFAULT_TOAST_MS)
  const [progress, setProgress] = useState(1)
  const countdownRef = useRef<Countdown | null>(null)
  const closedRef = useRef(false)
  // Hover and keyboard focus pause the clock independently, so leaving one while the other holds keeps it paused.
  const hoverRef = useRef(false)
  const focusRef = useRef(false)

  // Latest callbacks without restarting the timer when the parent re-renders.
  const cb = useRef({ toast, onRemove })
  cb.current = { toast, onRemove }

  const close = (kind: 'expire' | 'dismiss' | 'action') => {
    if (closedRef.current) return
    closedRef.current = true
    countdownRef.current?.cancel()
    cb.current.onRemove(cb.current.toast.id)
    if (kind === 'expire') cb.current.toast.onExpire?.()
    if (kind === 'dismiss') cb.current.toast.onDismiss?.()
  }

  useEffect(() => {
    if (duration <= 0) return
    const c = new Countdown(duration, () => close('expire'))
    countdownRef.current = c
    c.start()
    const timer = setInterval(() => setProgress(c.fraction()), 50)
    return () => {
      clearInterval(timer)
      c.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration])

  const sync = () => {
    const c = countdownRef.current
    if (!c || c.finished) return
    if (hoverRef.current || focusRef.current) c.pause()
    else c.resume()
  }

  const Icon = icons[toast.type]

  return (
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      data-toast={toast.undo ? 'undo' : toast.type}
      onMouseEnter={() => { hoverRef.current = true; sync() }}
      onMouseLeave={() => { hoverRef.current = false; sync() }}
      onFocus={() => { focusRef.current = true; sync() }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focusRef.current = false; sync() }
      }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close('dismiss') } }}
      className={`relative flex flex-col gap-2 px-4 py-3 rounded-lg border shadow-lg min-w-[300px] max-w-[400px] animate-in slide-in-from-right bg-[var(--surface-0)] ${colors[toast.type]}`}
    >
      <div className="flex items-center gap-3">
        <Icon className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
        <p className="text-sm font-medium flex-1 text-[var(--text-primary)]">{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick()
              close('action')
            }}
            aria-keyshortcuts={toast.undo ? 'Control+Z Meta+Z' : undefined}
            title={toast.undo ? `${toast.action.label} (Ctrl/Cmd+Z)` : undefined}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold underline underline-offset-2 hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
          >
            {toast.undo && <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />}
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={() => close('dismiss')}
          aria-label="Dismiss notification"
          className="p-1 hover:bg-black/5 dark:hover:bg-white/10 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      {duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-black/10 rounded-b-lg overflow-hidden" aria-hidden="true">
          <div className="h-full bg-current opacity-40" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((state) => state.toasts)
  const removeToast = useToastStore((state) => state.removeToast)

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none [&>*]:pointer-events-auto"
      aria-live="polite"
      aria-relevant="additions"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  )
}

export function toast(message: string, type: Toast['type'] = 'info', action?: ToastAction) {
  return useToastStore.getState().addToast({ message, type, action })
}

export function dismissToast(id: string) {
  useToastStore.getState().removeToast(id)
}

/**
 * Timed undo toast (about 6 seconds, paused while hovered or focused). `onUndo` runs when the user clicks Undo,
 * `onExpire` when the time runs out, `onDismiss` when the toast is closed by hand.
 */
export function undoToast(opts: {
  message: string
  onUndo: () => void
  onExpire?: () => void
  onDismiss?: () => void
  duration?: number
  actionLabel?: string
}) {
  return useToastStore.getState().addToast({
    message: opts.message,
    type: 'success',
    undo: true,
    duration: opts.duration ?? UNDO_TOAST_MS,
    action: { label: opts.actionLabel ?? 'Undo', onClick: opts.onUndo },
    onExpire: opts.onExpire,
    onDismiss: opts.onDismiss,
  })
}
