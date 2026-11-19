'use client'

import { useEffect } from 'react'

const STORE = 'veqsio-table-widths'
const HANDLE = 'data-col-resize'

type Saved = Record<string, number[]>

function load(): Saved {
  try { return JSON.parse(window.localStorage.getItem(STORE) || '{}') } catch { return {} }
}
function save(all: Saved) {
  try { window.localStorage.setItem(STORE, JSON.stringify(all)) } catch { /* private mode */ }
}

/** A stable id for a table: page path plus its caption or header texts. */
function tableId(table: HTMLTableElement): string {
  const heads = Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim()).join('|')
  return `${window.location.pathname}::${table.caption?.textContent?.trim() || ''}::${heads}`.slice(0, 200)
}

function headCells(table: HTMLTableElement): HTMLTableCellElement[] {
  const row = table.tHead?.rows[0]
  return row ? (Array.from(row.cells) as HTMLTableCellElement[]) : []
}

/** Freeze the current pixel widths so that one column can be changed without the others jumping. */
function freeze(table: HTMLTableElement) {
  const cells = headCells(table)
  const widths = cells.map((c) => c.getBoundingClientRect().width)
  table.style.tableLayout = 'fixed'
  table.style.width = `${Math.round(widths.reduce((a, b) => a + b, 0))}px`
  cells.forEach((c, i) => { c.style.width = `${Math.round(widths[i])}px` })
}

function applySaved(table: HTMLTableElement) {
  const saved = load()[tableId(table)]
  const cells = headCells(table)
  if (!saved || saved.length !== cells.length) return
  table.style.tableLayout = 'fixed'
  table.style.width = `${saved.reduce((a, b) => a + b, 0)}px`
  cells.forEach((c, i) => { c.style.width = `${saved[i]}px` })
}

function persist(table: HTMLTableElement) {
  const all = load()
  all[tableId(table)] = headCells(table).map((c) => Math.round(c.getBoundingClientRect().width))
  save(all)
}

function reset(table: HTMLTableElement) {
  table.style.tableLayout = ''
  table.style.width = ''
  headCells(table).forEach((c) => { c.style.width = '' })
  const all = load(); delete all[tableId(table)]; save(all)
}

function enhance(table: HTMLTableElement) {
  if (table.dataset.noResize !== undefined) return
  const cells = headCells(table)
  if (cells.length < 2 || cells.some((c) => c.colSpan > 1)) return
  const thead = table.tHead
  if (thead && thead.className.includes('sr-only')) return
  if (!table.dataset.resizeReady) { table.dataset.resizeReady = '1'; applySaved(table) }

  cells.forEach((th, idx) => {
    if (idx === cells.length - 1 || th.querySelector(`[${HANDLE}]`)) return
    th.style.position = 'relative'
    const h = document.createElement('span')
    h.setAttribute(HANDLE, '')
    h.setAttribute('role', 'separator')
    h.setAttribute('aria-orientation', 'vertical')
    h.title = 'Drag to resize, double-click to reset'
    h.style.cssText = 'position:absolute;top:0;right:-4px;width:9px;height:100%;cursor:col-resize;touch-action:none;z-index:1;user-select:none'
    h.addEventListener('mouseenter', () => { h.style.boxShadow = 'inset -4px 0 0 -3px var(--brand-500)' })
    h.addEventListener('mouseleave', () => { h.style.boxShadow = '' })
    h.addEventListener('dblclick', (e) => { e.stopPropagation(); reset(table) })
    h.addEventListener('click', (e) => e.stopPropagation())
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation()
      if (table.style.tableLayout !== 'fixed') freeze(table)
      const startX = e.clientX
      const startW = th.getBoundingClientRect().width
      const startTable = table.getBoundingClientRect().width
      const move = (ev: PointerEvent) => {
        const w = Math.max(48, Math.round(startW + ev.clientX - startX))
        th.style.width = `${w}px`
        table.style.width = `${Math.round(startTable + (w - startW))}px`
      }
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); persist(table) }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })
    th.appendChild(h)
  })
}

/** Makes every column header of every table draggable (width remembered per table). Mounted once in the layout. */
export function TableResizer() {
  useEffect(() => {
    const scan = () => document.querySelectorAll('table').forEach((t) => enhance(t as HTMLTableElement))
    scan()
    let queued = false
    const mo = new MutationObserver(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => { queued = false; scan() })
    })
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])
  return null
}
