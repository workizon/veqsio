'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

export function Modal({ isOpen, onClose, title, children, size = 'md' }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      window.addEventListener('keydown', handleEscape)
      return () => window.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onClose])

  if (!isOpen || typeof document === 'undefined') return null

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }

  // Rendered in <body>: a modal declared inside a positioned parent (the fixed header, a card with a transform)
  // would otherwise be trapped in that parent's stacking context and appear under the page.
  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto overscroll-contain veqsio-modal-overlay"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`veqsio-modal-panel w-full my-auto sm:max-h-[calc(100dvh-2rem)] sm:overflow-y-auto ${sizeClasses[size]} transform transition-all duration-200 ease-out-expo`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-[var(--surface-3)]">
          <h2 className="min-w-0 flex-1 text-heading-2 text-[var(--text-primary)] break-words [overflow-wrap:anywhere]">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="veqsio-btn-ghost p-1 shrink-0"
          >
            <X className="w-5 h-5 text-[var(--text-tertiary)]" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
