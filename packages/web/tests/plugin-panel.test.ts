import { describe, it, expect } from 'bun:test'
import { buildPanelSrc, parsePanelMessage, isSafeNavigatePath, PANEL_SANDBOX } from '../lib/plugin-panel'

describe('plugin panel helpers', () => {
  it('sandbox never includes allow-same-origin', () => {
    expect(PANEL_SANDBOX).toBe('allow-scripts allow-forms')
    expect(PANEL_SANDBOX).not.toContain('same-origin')
  })

  it('builds src with only issue and project parameters', () => {
    expect(buildPanelSrc('https://p.example/panel', { issue: 'ABC-1', project: 'ABC' })).toBe('https://p.example/panel?issue=ABC-1&project=ABC')
    expect(buildPanelSrc('https://p.example/panel?token=1#x', { issue: 'ABC-1' })).toBe('https://p.example/panel?issue=ABC-1')
    expect(buildPanelSrc('https://p.example/panel', { issue: 'A&b=c', project: '../x' })).toBe('https://p.example/panel')
    expect(buildPanelSrc('javascript:alert(1)', {})).toBeNull()
    expect(buildPanelSrc('https://u:p@p.example/', {})).toBeNull()
    expect(buildPanelSrc('nonsense', {})).toBeNull()
  })

  it('navigate accepts same-origin paths only', () => {
    for (const p of ['/issues/ABC-1', '/projects/ABC/board?x=1']) expect(isSafeNavigatePath(p)).toBe(true)
    for (const p of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', 'issues', '/a\nb', 42, null]) expect(isSafeNavigatePath(p)).toBe(false)
  })

  it('messages require the opaque origin and the documented shape', () => {
    const ok = { source: 'veqsio-plugin', type: 'resize', height: 300 }
    expect(parsePanelMessage('null', ok)).toEqual({ type: 'resize', height: 300 })
    expect(parsePanelMessage('https://p.example', ok)).toBeNull()
    expect(parsePanelMessage('null', { ...ok, height: 999999 })).toEqual({ type: 'resize', height: 2000 })
    expect(parsePanelMessage('null', { ...ok, height: 1 })).toEqual({ type: 'resize', height: 40 })
    expect(parsePanelMessage('null', { ...ok, height: 'abc' })).toBeNull()
    expect(parsePanelMessage('null', { type: 'resize', height: 100 })).toBeNull()
    expect(parsePanelMessage('null', { source: 'veqsio-plugin', type: 'navigate', path: '/issues/X-1' })).toEqual({ type: 'navigate', path: '/issues/X-1' })
    expect(parsePanelMessage('null', { source: 'veqsio-plugin', type: 'navigate', path: '//evil.example' })).toBeNull()
    expect(parsePanelMessage('null', { source: 'veqsio-plugin', type: 'cookie' })).toBeNull()
    expect(parsePanelMessage('null', 'string')).toBeNull()
  })
})
