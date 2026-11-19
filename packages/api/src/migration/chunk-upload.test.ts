import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, utimesSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChunkUploads, UploadError } from './chunk-upload'

const mk = (max = 1000) => { const dir = mkdtempSync(join(tmpdir(), 'chunk-')); return { dir, u: new ChunkUploads(dir, max) } }
const fails = async (p: Promise<unknown>, status: number) => { try { await p } catch (e) { expect(e).toBeInstanceOf(UploadError); expect((e as UploadError).status).toBe(status); return } throw new Error('expected failure') }

describe('chunked migration upload', () => {
  test('a file arrives in chunks and is assembled byte for byte', async () => {
    const { dir, u } = mk()
    const { uploadId } = await u.init('u1', '../../evil/backup.xml', 10)
    expect((await u.append(uploadId, 'u1', 0, Buffer.from('01234'))).received).toBe(5)
    expect((await u.status(uploadId, 'u1')).received).toBe(5)
    expect((await u.append(uploadId, 'u1', 5, Buffer.from('56789'))).received).toBe(10)
    const r = await u.complete(uploadId, 'u1', 'final.xml')
    expect(r.filename).toBe('backup.xml')                        // the client's path never survives
    expect(readFileSync(join(dir, 'final.xml'), 'utf8')).toBe('0123456789')
    expect(existsSync(join(dir, '.parts', `${uploadId}.part`))).toBe(false)
  })
  test('a retried or out-of-order chunk is refused with the real position, so a client can resume', async () => {
    const { u } = mk(); const { uploadId } = await u.init('u1', 'b.xml', 10)
    await u.append(uploadId, 'u1', 0, Buffer.from('01234'))
    try { await u.append(uploadId, 'u1', 0, Buffer.from('01234')) } catch (e) { expect((e as UploadError).status).toBe(409); expect((e as UploadError).received).toBe(5) }
    await fails(u.append(uploadId, 'u1', 9, Buffer.from('x')), 409)
  })
  test('limits: announced size, more data than announced, empty chunk, incomplete file', async () => {
    const { u } = mk(100)
    await fails(u.init('u1', 'b.xml', 101), 413); await fails(u.init('u1', 'b.xml', 0), 400); await fails(u.init('u1', 'b.xml', 1.5), 400)
    const { uploadId } = await u.init('u1', 'b.xml', 4)
    await fails(u.append(uploadId, 'u1', 0, Buffer.from('12345')), 413)
    await fails(u.append(uploadId, 'u1', 0, Buffer.alloc(0)), 400)
    await u.append(uploadId, 'u1', 0, Buffer.from('12'))
    await fails(u.complete(uploadId, 'u1', 'x.xml'), 409)
  })
  test('another user, a made-up id or a path in the id cannot touch an upload', async () => {
    const { u } = mk(); const { uploadId } = await u.init('u1', 'b.xml', 4)
    await fails(u.status(uploadId, 'u2'), 404); await fails(u.append(uploadId, 'u2', 0, Buffer.from('a')), 404)
    await fails(u.status('../../etc/passwd', 'u1'), 404); await fails(u.status('00000000-0000-0000-0000-000000000000', 'u1'), 404)
  })
  test('abandoned uploads are swept when a new one starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chunk-')); const u = new ChunkUploads(dir, 100, 1000)
    const old = await u.init('u1', 'b.xml', 4)
    const past = new Date(Date.now() - 5000)
    for (const f of readdirSync(join(dir, '.parts'))) utimesSync(join(dir, '.parts', f), past, past)
    await u.init('u1', 'c.xml', 4)
    await fails(u.status(old.uploadId, 'u1'), 404)
  })
})
