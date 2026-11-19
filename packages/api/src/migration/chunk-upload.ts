import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'

/**
 * Resumable upload of a large migration backup in chunks. A single request cannot carry a multi-gigabyte file in the cloud: the proxy in front of a workspace
 * (Cloudflare accepts 100 MB per request on the Free and Pro plans) and the reverse proxy on the server both cap the request body, and the one-request endpoint
 * holds the whole file in memory. Chunks of a few tens of MB go through every layer and the server only ever holds one chunk.
 *
 * Layout: <dir>/.parts/<id>.json (who, name, expected size) and <dir>/.parts/<id>.part (bytes received so far). `complete` moves the part file to its final place.
 */
export const CHUNK_MAX_BYTES = 64 * 1024 * 1024
export const CHUNK_DEFAULT_BYTES = 32 * 1024 * 1024
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export class UploadError extends Error { constructor(public status: number, message: string, public received?: number) { super(message) } }

export class ChunkUploads {
  constructor(private dir: string, private maxBytes: number, private staleMs = 24 * 3600_000) {}
  private parts() { return join(this.dir, '.parts') }
  private async meta(id: string, user: string) {
    if (!ID.test(id)) throw new UploadError(404, 'Unknown upload')
    let m: { user: string; filename: string; size: number }
    try { m = JSON.parse(await readFile(join(this.parts(), `${id}.json`), 'utf8')) } catch { throw new UploadError(404, 'Unknown upload') }
    if (m.user !== user) throw new UploadError(404, 'Unknown upload') // somebody else's upload does not exist for you
    return m
  }
  private async received(id: string) { return (await stat(join(this.parts(), `${id}.part`)).catch(() => null))?.size ?? 0 }

  async init(user: string, filename: string, size: number) {
    if (!Number.isInteger(size) || size <= 0) throw new UploadError(400, 'size must be a positive integer')
    if (size > this.maxBytes) throw new UploadError(413, `File exceeds the maximum size of ${Math.floor(this.maxBytes / 1024 ** 3)} GB`)
    await mkdir(this.parts(), { recursive: true })
    for (const f of await readdir(this.parts())) { // abandoned uploads must not fill the disk
      const s = await stat(join(this.parts(), f)).catch(() => null)
      if (s && Date.now() - s.mtimeMs > this.staleMs) await rm(join(this.parts(), f), { force: true })
    }
    const id = randomUUID()
    await writeFile(join(this.parts(), `${id}.json`), JSON.stringify({ user, filename: basename(filename || 'backup.xml').slice(0, 200), size }))
    await writeFile(join(this.parts(), `${id}.part`), '')
    return { uploadId: id, chunkSize: CHUNK_DEFAULT_BYTES, maxChunk: CHUNK_MAX_BYTES, received: 0 }
  }
  async status(id: string, user: string) { const m = await this.meta(id, user); return { received: await this.received(id), size: m.size } }

  /** Appends one chunk at `offset`. The offset must equal what the server already holds, so a retried chunk can never be written twice. */
  async append(id: string, user: string, offset: number, chunk: Uint8Array) {
    const m = await this.meta(id, user)
    const have = await this.received(id)
    if (!Number.isInteger(offset) || offset !== have) throw new UploadError(409, `Offset mismatch: the server has ${have} bytes`, have)
    if (chunk.length === 0 || chunk.length > CHUNK_MAX_BYTES) throw new UploadError(400, `A chunk must be between 1 byte and ${CHUNK_MAX_BYTES / 1024 / 1024} MB`)
    if (have + chunk.length > m.size) throw new UploadError(413, 'More data than announced', have)
    await appendFile(join(this.parts(), `${id}.part`), chunk)
    return { received: have + chunk.length, size: m.size }
  }

  /** Moves the finished file to `<dir>/<final>` and returns its path and the original file name. */
  async complete(id: string, user: string, finalName: string) {
    const m = await this.meta(id, user)
    const have = await this.received(id)
    if (have !== m.size) throw new UploadError(409, `Upload incomplete: ${have} of ${m.size} bytes`, have)
    const path = join(this.dir, finalName)
    await rename(join(this.parts(), `${id}.part`), path)
    await rm(join(this.parts(), `${id}.json`), { force: true })
    return { path, filename: m.filename, size: m.size }
  }
}
