import { describe, test, expect } from 'bun:test'
import { checkContent, sanitizeFileName, safeExtension, sniffContent } from './upload-validation'

const b = (...n: number[]) => new Uint8Array(n)
const enc = (s: string) => new TextEncoder().encode(s)

describe('sanitizeFileName', () => {
  test('strips path separators and control characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(sanitizeFileName('a\u0000b\r\nc.txt')).toBe('abc.txt')
    expect(sanitizeFileName('C:\\x\\y.png')).toBe('C__x_y.png')
    expect(sanitizeFileName('\u202egnp.exe')).toBe('gnp.exe')
  })
  test('falls back and caps length at 255 keeping the extension', () => {
    expect(sanitizeFileName('...')).toBe('file')
    expect(sanitizeFileName('')).toBe('file')
    const long = sanitizeFileName('a'.repeat(400) + '.pdf')
    expect(long.length).toBe(255)
    expect(long.endsWith('.pdf')).toBe(true)
  })
  test('safeExtension only yields [a-z0-9]', () => {
    expect(safeExtension('x.PNG')).toBe('png')
    expect(safeExtension('noext')).toBe('bin')
    expect(safeExtension('x.p g')).toBe('bin')
  })
})

describe('sniffContent / checkContent', () => {
  const png = b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  test('detects known formats and executables', () => {
    expect(sniffContent(png)).toEqual({ kind: 'known', mime: 'image/png' })
    expect(sniffContent(b(0xff, 0xd8, 0xff, 0xe0))).toEqual({ kind: 'known', mime: 'image/jpeg' })
    expect(sniffContent(b(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toEqual({ kind: 'known', mime: 'image/gif' })
    expect(sniffContent(enc('%PDF-1.7'))).toEqual({ kind: 'known', mime: 'application/pdf' })
    expect(sniffContent(b(0x50, 0x4b, 3, 4))).toEqual({ kind: 'known', mime: 'application/zip' })
    expect(sniffContent(b(0x4d, 0x5a)).kind).toBe('executable')
    expect(sniffContent(b(0x7f, 0x45, 0x4c, 0x46)).kind).toBe('executable')
    expect(sniffContent(enc('#!/bin/sh')).kind).toBe('executable')
  })
  test('declared type must match', () => {
    expect(checkContent('image/png', png)).toEqual({ ok: true, mime: 'image/png' })
    expect(checkContent('image/png; charset=x', png).ok).toBe(true)
    expect(checkContent('application/octet-stream', png)).toEqual({ ok: true, mime: 'image/png' })
    expect(checkContent('application/pdf', png).ok).toBe(false)
    expect(checkContent('image/jpeg', enc('nope')).ok).toBe(false)
    expect(checkContent('text/plain', b(0x4d, 0x5a)).ok).toBe(false)
  })
  test('rejects active content and binary-as-text', () => {
    expect(checkContent('image/svg+xml', enc('<svg/>')).ok).toBe(false)
    expect(checkContent('text/html', enc('hi')).ok).toBe(false)
    expect(checkContent('text/plain', enc('<!DOCTYPE html><p>')).ok).toBe(false)
    expect(checkContent('text/plain', b(65, 0, 66)).ok).toBe(false)
    expect(checkContent('text/plain', enc('plain notes')).ok).toBe(true)
  })
})
