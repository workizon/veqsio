'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ANY_NODE_ID, NODE_H, boundsOf, center, edgeGeometry, edgeSlots, hitNode, nodeRect, nodeWidth,
  normalizeCategory, CATEGORY_LABEL, CATEGORY_VAR,
  type DStatus, type DTransition, type Pos, type Rect,
} from '@/lib/workflow-graph'

export type Selection = { kind: 'status'; id: number } | { kind: 'transition'; id: number }

interface Props {
  statuses: DStatus[]
  transitions: DTransition[]
  positions: Record<number, Pos>
  selected: Selection | null
  flaggedStatusIds: Set<number>
  onSelect: (sel: Selection | null) => void
  onMove: (id: number, pos: Pos) => void
  /** from === null means "any status" (global transition). */
  onConnect: (from: number | null, to: number) => void
}

type DragState =
  | { kind: 'move'; id: number; dx: number; dy: number; startX: number; startY: number; moved: boolean }
  | { kind: 'connect'; from: number }

const ANY_W = 120

/**
 * Plain SVG canvas: lozenges coloured by status category, arrows with labels.
 * Move a status by dragging its body, create a transition by dragging from its
 * right-hand handle onto another status. Keyboard: Tab to a status, Enter to
 * edit, arrow keys to nudge; the Table view offers the same actions without a pointer.
 */
export function DesignerCanvas({ statuses, transitions, positions, selected, flaggedStatusIds, onSelect, onMove, onConnect }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<DragState | null>(null)
  const [conn, setConn] = useState<{ from: number; at: Pos } | null>(null)
  const [frozen, setFrozen] = useState<ReturnType<typeof boundsOf> | null>(null)
  const [anyPos, setAnyPos] = useState<Pos | null>(null)

  const placed = useMemo(() => statuses.filter((s) => positions[s.id]), [statuses, positions])
  const statusRects = useMemo(() => {
    const m = new Map<number, Rect>()
    for (const s of placed) m.set(s.id, nodeRect(s, positions[s.id]))
    return m
  }, [placed, positions])

  // "Any status" pseudo node: left of the flow until the admin moves it.
  const defaultAny = useMemo<Pos>(() => {
    const rs = [...statusRects.values()]
    if (rs.length === 0) return { x: 40, y: 60 }
    const minX = Math.min(...rs.map((r) => r.x))
    const midY = (Math.min(...rs.map((r) => r.y)) + Math.max(...rs.map((r) => r.y))) / 2
    return { x: minX - ANY_W - 70, y: midY }
  }, [statusRects])
  useEffect(() => { if (anyPos === null && statusRects.size > 0) setAnyPos(defaultAny) }, [anyPos, statusRects.size, defaultAny])
  const anyX = (anyPos ?? defaultAny).x
  const anyY = (anyPos ?? defaultAny).y
  const anyRect: Rect = useMemo(() => ({ x: anyX, y: anyY, w: ANY_W, h: NODE_H }), [anyX, anyY])
  const rectOf = useMemo(() => new Map<number, Rect>([...statusRects, [ANY_NODE_ID, anyRect]]), [statusRects, anyRect])

  const liveBounds = useMemo(() => boundsOf([...rectOf.values()]), [rectOf])
  const bounds = frozen ?? liveBounds

  const slots = useMemo(() => edgeSlots(transitions), [transitions])

  function toSvg(e: { clientX: number; clientY: number }): Pos {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const m = svg.getScreenCTM()
    if (!m) return { x: e.clientX, y: e.clientY }
    const p = pt.matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  }

  function startMove(e: React.PointerEvent, id: number) {
    if (e.button !== 0) return
    const p = toSvg(e)
    const r = rectOf.get(id)!
    drag.current = { kind: 'move', id, dx: p.x - r.x, dy: p.y - r.y, startX: e.clientX, startY: e.clientY, moved: false }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  function moveDrag(e: React.PointerEvent) {
    const d = drag.current
    if (!d) return
    if (d.kind === 'move') {
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return
      if (!d.moved) { d.moved = true; setFrozen(liveBounds) }
      const p = toSvg(e)
      const pos = { x: Math.round(p.x - d.dx), y: Math.round(p.y - d.dy) }
      if (d.id === ANY_NODE_ID) setAnyPos(pos)
      else onMove(d.id, pos)
    } else {
      setConn({ from: d.from, at: toSvg(e) })
    }
  }

  function endDrag(e: React.PointerEvent) {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'move') {
      setFrozen(null)
      if (!d.moved && d.id !== ANY_NODE_ID) onSelect({ kind: 'status', id: d.id })
      return
    }
    setConn(null)
    const target = hitNode([...rectOf.entries()].filter(([id]) => id !== ANY_NODE_ID).map(([id, rect]) => ({ id, rect })), toSvg(e))
    if (target !== null) onConnect(d.from === ANY_NODE_ID ? null : d.from, target)
  }

  function startConnect(e: React.PointerEvent, id: number) {
    if (e.button !== 0) return
    e.stopPropagation()
    drag.current = { kind: 'connect', from: id }
    setConn({ from: id, at: toSvg(e) })
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  function nudge(e: React.KeyboardEvent, id: number) {
    const step = e.shiftKey ? 40 : 10
    const delta: Record<string, Pos> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }
    const dlt = delta[e.key]
    if (dlt) {
      e.preventDefault()
      const r = rectOf.get(id)!
      const pos = { x: r.x + dlt.x, y: r.y + dlt.y }
      if (id === ANY_NODE_ID) setAnyPos(pos)
      else onMove(id, pos)
    } else if ((e.key === 'Enter' || e.key === ' ') && id !== ANY_NODE_ID) {
      e.preventDefault()
      onSelect({ kind: 'status', id })
    }
  }

  const statusName = (id: number | null) => (id === null ? 'Any status' : statuses.find((s) => s.id === id)?.name ?? `#${id}`)

  const renderNode = (id: number, name: string, rect: Rect, opts: { category?: string; any?: boolean }) => {
    const cat = normalizeCategory(opts.category)
    const color = opts.any ? 'var(--text-tertiary)' : CATEGORY_VAR[cat]
    const isSel = selected?.kind === 'status' && selected.id === id
    const flagged = flaggedStatusIds.has(id)
    const label = opts.any ? 'Any status' : name
    return (
      <g
        key={`n${id}`}
        className="group outline-none"
        tabIndex={0}
        role="button"
        aria-label={opts.any ? 'Any status: source of global transitions. Arrow keys move it.' : `Status ${name}, ${CATEGORY_LABEL[cat]}${flagged ? ', has warnings' : ''}. Enter to edit, arrow keys to move.`}
        aria-pressed={isSel}
        onPointerDown={(e) => startMove(e, id)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => nudge(e, id)}
        style={{ cursor: 'grab', touchAction: 'none' }}
      >
        <rect
          x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={rect.h / 2}
          fill={`color-mix(in srgb, ${color} 14%, var(--surface-0))`}
          stroke={isSel ? 'var(--brand-500)' : color}
          strokeWidth={isSel ? 2.5 : 1.5}
          strokeDasharray={opts.any ? '4 3' : undefined}
          className="group-focus-visible:stroke-[var(--brand-500)]"
        />
        {!opts.any && <circle cx={rect.x + 15} cy={rect.y + rect.h / 2} r={4.5} fill={color} />}
        <text
          x={rect.x + (opts.any ? rect.w / 2 : 28)} y={rect.y + rect.h / 2 + 4.5}
          textAnchor={opts.any ? 'middle' : 'start'}
          fontSize={13} fontWeight={500} fill="var(--text-primary)" style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {label.length > 26 ? label.slice(0, 25) + '…' : label}
        </text>
        {flagged && <circle cx={rect.x + rect.w - 6} cy={rect.y + 4} r={4} fill="var(--warning)"><title>This status has warnings</title></circle>}
        <circle
          cx={rect.x + rect.w} cy={rect.y + rect.h / 2} r={7}
          fill="var(--brand-500)" stroke="var(--surface-0)" strokeWidth={2}
          className={`${isSel ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity`}
          style={{ cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={(e) => startConnect(e, id)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <title>Drag onto another status to create a transition</title>
        </circle>
      </g>
    )
  }

  return (
    <div className="relative rounded-xl border border-[var(--surface-3)] bg-[var(--surface-1)] overflow-hidden min-h-[360px]" data-testid="workflow-canvas">
      <svg
        ref={svgRef}
        role="group"
        aria-label="Workflow diagram"
        viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height: 'auto', maxWidth: Math.round(bounds.w * 1.25), aspectRatio: `${bounds.w} / ${bounds.h}` }}
        className="block select-none mx-auto"
        onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as Element).getAttribute('data-bg') === '1') onSelect(null) }}
      >
        <defs>
          <pattern id="wf-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="var(--surface-3)" />
          </pattern>
        </defs>
        <rect data-bg="1" x={bounds.x} y={bounds.y} width={bounds.w} height={bounds.h} fill="url(#wf-grid)" />

        {/* edges under nodes */}
        {transitions.map((t) => {
          const from = rectOf.get(t.fromStatusId ?? ANY_NODE_ID)
          const to = rectOf.get(t.toStatusId)
          if (!from || !to) return null
          const slot = slots.get(t.id)
          const g = edgeGeometry(from, to, slot?.bend ?? 0)
          const isSel = selected?.kind === 'transition' && selected.id === t.id
          const stroke = isSel ? 'var(--brand-500)' : 'var(--text-tertiary)'
          const label = t.name.length > 28 ? t.name.slice(0, 27) + '…' : t.name
          const lw = label.length * 6.6 + 14
          return (
            <g
              key={`e${t.id}`}
              tabIndex={0}
              role="button"
              aria-pressed={isSel}
              aria-label={`Transition ${t.name} from ${statusName(t.fromStatusId)} to ${statusName(t.toStatusId)}. Enter to edit.`}
              className="outline-none group/edge cursor-pointer"
              onClick={() => onSelect({ kind: 'transition', id: t.id })}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ kind: 'transition', id: t.id }) } }}
            >
              <path d={g.d} fill="none" stroke="transparent" strokeWidth={16} />
              <path d={g.d} fill="none" stroke={stroke} strokeWidth={isSel ? 2.5 : 1.6} strokeDasharray={t.fromStatusId === null ? '6 4' : undefined} className="group-focus-visible/edge:stroke-[var(--brand-500)]" />
              <polygon points="0,0 -10,-5 -10,5" fill={stroke} transform={`translate(${g.tip.x} ${g.tip.y}) rotate(${g.angle})`} />
              <rect x={g.label.x - lw / 2} y={g.label.y - 10} width={lw} height={20} rx={10} fill="var(--surface-0)" stroke={isSel ? 'var(--brand-500)' : 'var(--surface-3)'} />
              <text x={g.label.x} y={g.label.y + 4} textAnchor="middle" fontSize={11.5} fill="var(--text-secondary)" style={{ pointerEvents: 'none' }}>{label}</text>
            </g>
          )
        })}

        {/* live connection preview */}
        {conn && rectOf.get(conn.from) && (() => {
          const r = rectOf.get(conn.from)!
          const c = center(r)
          return <line x1={c.x} y1={c.y} x2={conn.at.x} y2={conn.at.y} stroke="var(--brand-500)" strokeWidth={2} strokeDasharray="5 4" pointerEvents="none" />
        })()}

        {renderNode(ANY_NODE_ID, 'Any status', anyRect, { any: true })}
        {placed.map((s) => renderNode(s.id, s.name, rectOf.get(s.id)!, { category: s.category }))}
      </svg>

      {placed.length === 0 && (
        <p className="absolute inset-x-0 top-24 text-center text-sm text-[var(--text-tertiary)] pointer-events-none px-6">
          This workflow has no statuses yet. Use “Add status” to place one on the canvas.
        </p>
      )}
      <p className="sticky left-0 bottom-0 px-3 py-2 text-xs text-[var(--text-tertiary)] bg-[var(--surface-1)]/90 border-t border-[var(--surface-3)]">
        Drag a status to move it. Drag from the dot on its right edge onto another status to add a transition. Use the dashed “Any status” node for global transitions.
      </p>
    </div>
  )
}

export { nodeWidth }
