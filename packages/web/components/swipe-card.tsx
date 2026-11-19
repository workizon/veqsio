'use client'

import { useRef, useState, type ReactNode } from 'react'
import { classifyGesture, decideSwipe, followDistance } from '@/lib/swipe'

export interface SwipeAction { label: string; onTrigger: () => void }

const LIMIT_PX = 96

/**
 * Touch swipe actions on a card: swipe left or right to run the action behind that side. It is an extra on phones, never the
 * only way (the same actions are in the card's menu). Vertical movement scrolls the page as usual; a swipe is only taken once
 * the finger has clearly gone sideways. Mouse and keyboard are untouched.
 */
export function SwipeCard({ left, right, children, className = '' }: { left?: SwipeAction; right?: SwipeAction; children: ReactNode; className?: string }) {
  const start = useRef<{ x: number; y: number; t: number; id: number } | null>(null)
  const mode = useRef<'horizontal' | 'vertical' | null>(null)
  const suppressClick = useRef(false)
  const wrap = useRef<HTMLDivElement>(null)
  const [dx, setDx] = useState(0)
  const [active, setActive] = useState(false)

  if (!left && !right) return <div className={className}>{children}</div>

  const reset = () => { start.current = null; mode.current = null; setActive(false); setDx(0) }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return
    start.current = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }
    mode.current = null
    suppressClick.current = false
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current
    if (!s || e.pointerId !== s.id) return
    const mx = e.clientX - s.x, my = e.clientY - s.y
    if (mode.current === null) {
      const c = classifyGesture(mx, my)
      if (!c) return
      mode.current = c
      if (c === 'horizontal') { try { wrap.current?.setPointerCapture(e.pointerId) } catch { /* the pointer is gone */ } setActive(true) }
    }
    if (mode.current === 'horizontal') setDx(followDistance(mx, { hasLeft: !!left, hasRight: !!right, limit: LIMIT_PX }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current
    if (!s || e.pointerId !== s.id) return
    const horizontal = mode.current === 'horizontal'
    if (horizontal) {
      suppressClick.current = true   // the tap that ends a swipe must not open the issue
      const dir = decideSwipe({ dx: e.clientX - s.x, dy: e.clientY - s.y, width: wrap.current?.getBoundingClientRect().width ?? 300, elapsedMs: performance.now() - s.t })
      const action = dir === 'left' ? left : dir === 'right' ? right : undefined
      reset()
      if (action) action.onTrigger()
      return
    }
    reset()
  }
  const onPointerCancel = () => { reset() }

  const revealLeft = dx < 0 && left     // card moved left: the left action shows on the right edge
  const revealRight = dx > 0 && right
  return (
    <div
      ref={wrap}
      className={`relative overflow-hidden rounded-lg ${className}`}
      style={{ touchAction: 'pan-y' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={(e) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false } }}
    >
      {(revealLeft || revealRight) && (
        <div aria-hidden className={`absolute inset-0 flex items-center px-4 text-[13px] font-semibold text-white bg-[var(--brand-600)] ${revealLeft ? 'justify-end' : 'justify-start'}`} data-swipe-reveal={revealLeft ? 'left' : 'right'}>
          {revealLeft ? left!.label : right!.label}
        </div>
      )}
      <div style={{ transform: `translateX(${dx}px)`, transition: active ? 'none' : 'transform 180ms ease-out' }} className="relative motion-reduce:transition-none">
        {children}
      </div>
    </div>
  )
}
