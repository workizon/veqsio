import { describe, test, expect } from 'bun:test'
import { UndoKeyStack, isUndoKey, shouldUndoOnKey } from '../lib/undo-stack'

describe('UndoKeyStack', () => {
  test('undoes the newest toast first, one per call', () => {
    const calls: number[] = []
    const s = new UndoKeyStack()
    s.push(1, () => calls.push(1))
    s.push(2, () => calls.push(2))
    expect(s.size).toBe(2)
    expect(s.undoLatest()).toBe(true)
    expect(calls).toEqual([2])
    expect(s.top()?.id).toBe(1)
    expect(s.undoLatest()).toBe(true)
    expect(s.undoLatest()).toBe(false)
    expect(calls).toEqual([2, 1])
  })
  test('settled toasts are removed and never undone by the key', () => {
    const calls: number[] = []
    const s = new UndoKeyStack()
    s.push(1, () => calls.push(1))
    s.push(2, () => calls.push(2))
    s.remove(2)
    s.undoLatest()
    expect(calls).toEqual([1])
  })
  test('pushing the same id twice keeps one entry', () => {
    const s = new UndoKeyStack()
    s.push(1, () => {})
    s.push(1, () => {})
    expect(s.size).toBe(1)
  })
})

describe('Ctrl/Cmd+Z detection', () => {
  test('matches ctrl and meta, any case, without shift or alt', () => {
    expect(isUndoKey({ key: 'z', ctrlKey: true })).toBe(true)
    expect(isUndoKey({ key: 'Z', metaKey: true })).toBe(true)
    expect(isUndoKey({ key: 'z' })).toBe(false)
    expect(isUndoKey({ key: 'z', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isUndoKey({ key: 'z', ctrlKey: true, altKey: true })).toBe(false)
    expect(isUndoKey({ key: 'y', ctrlKey: true })).toBe(false)
  })
  test('is ignored while typing, composing, handled already or with no open toast', () => {
    const e = { key: 'z', ctrlKey: true }
    expect(shouldUndoOnKey(e, false, 1)).toBe(true)
    expect(shouldUndoOnKey(e, true, 1)).toBe(false)
    expect(shouldUndoOnKey(e, false, 0)).toBe(false)
    expect(shouldUndoOnKey({ ...e, defaultPrevented: true }, false, 1)).toBe(false)
    expect(shouldUndoOnKey({ ...e, isComposing: true }, false, 1)).toBe(false)
  })
})
