'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import { stepIndex, swipeStep, type LightboxImage } from '@/lib/lightbox'

/**
 * A full-screen viewer for images: left and right arrows (buttons, keys, or a swipe on touch screens), a counter, zoom by
 * clicking the picture, download, and close (button, Esc, or a click on the dark background). Focus moves into the viewer and
 * returns to where it was.
 */
export function ImageLightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const [zoom, setZoom] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const count = images.length
  const image = images[index]

  const go = useCallback((d: number) => { setZoom(false); onIndex(stepIndex(index, d, count)) }, [index, count, onIndex])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = overflow; previous?.focus?.() }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === 'Tab') {
        // keep the focus inside the viewer
        const focusable = Array.from(document.querySelectorAll<HTMLElement>('[data-lightbox] button, [data-lightbox] a[href]'))
        if (focusable.length === 0) return
        const first = focusable[0], last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [go, onClose])

  if (!image || typeof document === 'undefined') return null
  const btn = 'flex h-11 w-11 items-center justify-center rounded-full bg-black/75 text-white ring-1 ring-white/50 shadow-lg hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white'

  return createPortal(
    <div
      data-lightbox
      role="dialog"
      aria-modal="true"
      aria-label={image.alt ? `Image: ${image.alt}` : 'Image viewer'}
      className={`fixed inset-0 z-[100] flex flex-col overscroll-contain bg-black/90 ${zoom ? '' : 'touch-pan-y'}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY } }}
      onTouchEnd={(e) => {
        const s = touch.current; touch.current = null
        if (!s || zoom) return
        const t = e.changedTouches[0]
        const d = swipeStep(t.clientX - s.x, t.clientY - s.y)
        if (d !== 0) go(-d)
      }}
    >
      <div className="flex items-center justify-between gap-3 p-3 text-white">
        <span className="min-w-0 truncate text-sm" aria-live="polite">
          {image.alt && <span className="mr-2">{image.alt}</span>}
          {count > 1 && <span className="text-white/70">{index + 1} / {count}</span>}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className={btn} onClick={() => setZoom(!zoom)} aria-label={zoom ? 'Fit to screen' : 'Zoom in'} aria-pressed={zoom}>
            {zoom ? <ZoomOut className="h-5 w-5" aria-hidden="true" /> : <ZoomIn className="h-5 w-5" aria-hidden="true" />}
          </button>
          <a className={btn} href={image.src} download={image.downloadName || image.alt || true} aria-label="Download"><Download className="h-5 w-5" aria-hidden="true" /></a>
          <button ref={closeRef} type="button" className={btn} onClick={onClose} aria-label="Close"><X className="h-5 w-5" aria-hidden="true" /></button>
        </div>
      </div>

      <div className={`relative flex min-h-0 flex-1 items-center justify-center sm:px-16 ${zoom ? 'overflow-auto' : 'overflow-hidden'}`} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        {count > 1 && (
          <button type="button" className={`${btn} absolute left-3 top-1/2 z-10 -translate-y-1/2`} onClick={() => go(-1)} aria-label="Previous image"><ChevronLeft className="h-6 w-6" aria-hidden="true" /></button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={image.src}
          src={image.src}
          alt={image.alt}
          draggable={false}
          onClick={() => setZoom(!zoom)}
          className={zoom ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'}
        />
        {count > 1 && (
          <button type="button" className={`${btn} absolute right-3 top-1/2 z-10 -translate-y-1/2`} onClick={() => go(1)} aria-label="Next image"><ChevronRight className="h-6 w-6" aria-hidden="true" /></button>
        )}
      </div>
    </div>,
    document.body,
  )
}
