import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requireGlobalPermission } from '../rbac/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq } from 'drizzle-orm';
import { writeFile, mkdir } from 'fs/promises';
import { join, resolve, sep, basename } from 'path';
import { realpath } from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  analyzeBackup,
  dryRun,
  runMigration,
  resumeMigration,
  pauseMigration,
  getMigrationProgress,
  getMigrationLogs,
  type MigrationOptions,
} from '../migration/engine';
import type { AppContext } from '../auth/middleware';
import { ChunkUploads, CHUNK_MAX_BYTES, UploadError } from '../migration/chunk-upload';

const app = new Hono<AppContext>();
const UPLOAD_DIR = process.env.MIGRATION_UPLOAD_DIR || '/tmp/veqsio-migrations';
/** Only files this endpoint stored itself may be analysed or imported: no arbitrary server paths. */
async function uploadedPath(p: unknown): Promise<string | null> {
  if (typeof p !== 'string' || !p) return null;
  try {
    const root = await realpath(UPLOAD_DIR);
    const real = await realpath(resolve(p));
    return real.startsWith(root + sep) ? real : null;
  } catch { return null; }
}

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

app.use('/rest/api/2/migration/*', sessionMiddleware);

// POST /rest/api/2/migration/upload
app.post('/rest/api/2/migration/upload', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const contentType = c.req.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ errorMessages: ['Expected multipart/form-data'] }, 400);
    }

    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || typeof file === 'string') {
      return c.json({ errorMessages: ['No file uploaded'] }, 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return c.json({ errorMessages: [`File exceeds maximum size of 2GB`] }, 413);
    }

    const filename = basename(file.name || 'backup.xml').slice(0, 200);
    const buffer = Buffer.from(await file.arrayBuffer());
    await mkdir(UPLOAD_DIR, { recursive: true });
    // the client's file name never reaches the file system path (it may contain ../)
    const path = join(UPLOAD_DIR, `${randomUUID()}.xml`);
    await writeFile(path, buffer);

    return c.json({
      success: true,
      filename,
      size: file.size,
      path,
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Upload failed'] }, 500);
  }
});

// (the parameter is not called :id or :xxxId on purpose: numericIdGuard answers 404 to non-integer values of those)
// Large backups: resumable upload in chunks (init, PUT chunks at an offset, complete). The one-request endpoint above holds the whole file in memory and a single
// request is capped by the proxies in front of the server (100 MB through Cloudflare on the Free and Pro plans), so the web UI uses these.
const MAX_BACKUP_BYTES = Number(process.env.MIGRATION_MAX_BYTES) || 8 * 1024 * 1024 * 1024; // 8 GB
const chunked = new ChunkUploads(UPLOAD_DIR, MAX_BACKUP_BYTES);
const uploadFailure = (c: any, err: any) => {
  if (err instanceof UploadError) return c.json({ errorMessages: [err.message], ...(err.received !== undefined ? { received: err.received } : {}) }, err.status);
  return c.json({ errorMessages: [err?.message || 'Upload failed'] }, 500);
};
app.post('/rest/api/2/migration/upload/init', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const b = await c.req.json().catch(() => ({})) as { filename?: string; size?: number };
    return c.json(await chunked.init(String(c.get('user')!.id), String(b.filename || 'backup.xml'), Number(b.size)));
  } catch (err) { return uploadFailure(c, err); }
});
app.get('/rest/api/2/migration/upload/:upload', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try { return c.json(await chunked.status(c.req.param('upload'), String(c.get('user')!.id))); } catch (err) { return uploadFailure(c, err); }
});
app.put('/rest/api/2/migration/upload/:upload', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    if (Number(c.req.header('content-length') || 0) > CHUNK_MAX_BYTES) return c.json({ errorMessages: [`A chunk may be at most ${CHUNK_MAX_BYTES / 1024 / 1024} MB`] }, 413);
    const chunk = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await chunked.append(c.req.param('upload'), String(c.get('user')!.id), Number(c.req.query('offset')), chunk));
  } catch (err) { return uploadFailure(c, err); }
});
app.post('/rest/api/2/migration/upload/:upload/complete', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const r = await chunked.complete(c.req.param('upload'), String(c.get('user')!.id), `${randomUUID()}.xml`);
    return c.json({ success: true, filename: r.filename, size: r.size, path: r.path });
  } catch (err) { return uploadFailure(c, err); }
});

// POST /rest/api/2/migration/analyze
app.post('/rest/api/2/migration/analyze', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const body = await c.req.json();
    const { path } = body;
    if (!path || typeof path !== 'string') {
      return c.json({ errorMessages: ['Backup path is required'] }, 400);
    }

    const safe = await uploadedPath(path);
    if (!safe) return c.json({ errorMessages: ['Backup file not found: upload it first'] }, 400);
    const stats = await analyzeBackup(safe);
    return c.json({
      success: true,
      stats,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ errorMessages: [`Failed to analyze backup: ${message}`] }, 500);
  }
});

// POST /rest/api/2/migration/dry-run
app.post('/rest/api/2/migration/dry-run', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const body = await c.req.json();
    const { path } = body;
    if (!path || typeof path !== 'string') {
      return c.json({ errorMessages: ['Backup path is required'] }, 400);
    }

    const safe = await uploadedPath(path);
    if (!safe) return c.json({ errorMessages: ['Backup file not found: upload it first'] }, 400);
    const { stats, conflicts } = await dryRun(safe);
    return c.json({
      success: true,
      stats,
      conflicts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ errorMessages: [`Failed to run dry-run: ${message}`] }, 500);
  }
});

// POST /rest/api/2/migration/run
app.post('/rest/api/2/migration/run', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const user = c.get('user')!;
    const body = await c.req.json();
    const { path, options } = body as { path: string; options?: MigrationOptions };

    if (!path || typeof path !== 'string') {
      return c.json({ errorMessages: ['Backup path is required'] }, 400);
    }
    const safePath = await uploadedPath(path);
    if (!safePath) return c.json({ errorMessages: ['Backup file not found: upload it first'] }, 400);

    const [session] = await db
      .insert(schema.migrationSessions)
      .values({
        status: 'pending',
        backupPath: safePath,
        options: options || {},
        createdBy: user.id,
      })
      .returning();

    // Run migration in background so we can return the session ID immediately
    Promise.resolve().then(async () => {
      try {
        await runMigration(safePath, session.id, options || {});
      } catch (err) {
        console.error('Migration failed:', err);
        await db
          .update(schema.migrationSessions)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errors: [err instanceof Error ? err.message : String(err)],
          })
          .where(eq(schema.migrationSessions.id, session.id));
      }
    });

    return c.json({
      success: true,
      sessionId: session.id,
      status: session.status,
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to start migration'] }, 500);
  }
});

// GET /rest/api/2/migration/:id/status
app.get('/rest/api/2/migration/:id/status', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const id = parseInt(c.req.param('upload'), 10);
    if (Number.isNaN(id)) {
      return c.json({ errorMessages: ['Invalid session ID'] }, 400);
    }

    const session = await db
      .select()
      .from(schema.migrationSessions)
      .where(eq(schema.migrationSessions.id, id))
      .limit(1);

    if (session.length === 0) {
      return c.json({ errorMessages: ['Migration session not found'] }, 404);
    }

    const progress = await getMigrationProgress(id);

    return c.json({
      success: true,
      session: session[0],
      progress,
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch migration status'] }, 500);
  }
});

// POST /rest/api/2/migration/:id/pause
app.post('/rest/api/2/migration/:id/pause', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const id = parseInt(c.req.param('upload'), 10);
    if (Number.isNaN(id)) {
      return c.json({ errorMessages: ['Invalid session ID'] }, 400);
    }

    await pauseMigration(id);
    return c.json({ success: true, status: 'paused' });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to pause migration'] }, 500);
  }
});

// POST /rest/api/2/migration/:id/resume
app.post('/rest/api/2/migration/:id/resume', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const id = parseInt(c.req.param('upload'), 10);
    if (Number.isNaN(id)) {
      return c.json({ errorMessages: ['Invalid session ID'] }, 400);
    }

    const session = await db
      .select()
      .from(schema.migrationSessions)
      .where(eq(schema.migrationSessions.id, id))
      .limit(1);

    if (session.length === 0) {
      return c.json({ errorMessages: ['Migration session not found'] }, 404);
    }

    // Resume in background
    Promise.resolve().then(async () => {
      try {
        await resumeMigration(id);
      } catch (err) {
        console.error('Migration resume failed:', err);
        await db
          .update(schema.migrationSessions)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errors: [err instanceof Error ? err.message : String(err)],
          })
          .where(eq(schema.migrationSessions.id, id));
      }
    });

    return c.json({ success: true, status: 'running' });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to resume migration'] }, 500);
  }
});

// GET /rest/api/2/migration/:id/logs
app.get('/rest/api/2/migration/:id/logs', requireAuth, requireGlobalPermission('SYSTEM_ADMIN'), async (c) => {
  try {
    const id = parseInt(c.req.param('upload'), 10);
    if (Number.isNaN(id)) {
      return c.json({ errorMessages: ['Invalid session ID'] }, 400);
    }

    const logs = await getMigrationLogs(id);
    return c.json({ success: true, logs });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch migration logs'] }, 500);
  }
});

export default app;
