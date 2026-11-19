import { checkContent } from '../servicedesk/upload-validation';
import { signingKey, verifySignature, isPublicStorageKey } from '../storage/signing';
import { Hono } from 'hono';
import { invalidateStorageUsage } from '../cloud/limits';
import { resolve, sep } from 'node:path';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { requirePermission } from '../middleware/permissions';
import { checkProjectPermission } from '../middleware/permissions';
import * as schema from '@veqsio/db';
import { eq, and } from 'drizzle-orm';
import { checkAttachmentPolicy } from '../settings/instance';
import { uploadFile, getSignedDownloadUrl, deleteFile, isAllowedMimeType, validateFileSize, generateThumbnail } from '../storage/service';
import { getIssue } from '../issues/service';
import type { AppContext } from '../auth/middleware';
import { getThumbnailKey } from '../storage/client';

import { db } from '../db';

const app = new Hono<AppContext>();
app.use('/rest/api/2/issue/*/attachments*', sessionMiddleware);
app.use('/rest/api/2/attachment/*', sessionMiddleware);

// Upload attachment
app.post('/rest/api/2/issue/:idOrKey/attachments', requireAuth, requirePermission('CREATE_ATTACHMENTS'), async (c) => {
  try {
    const idOrKey = c.req.param('idOrKey');
    const user = c.get('user')!;
    const issue = await getIssue(idOrKey);
    if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

    const formData = await c.req.formData();
    const files = formData.getAll('file');
    if (files.length > 10) {
      return c.json({ errorMessages: ['Maximum 10 files per upload'] }, 400);
    }

    const uploaded = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;

      if (!isAllowedMimeType(file.type)) {
        return c.json({ errorMessages: [`File type ${file.type} not allowed`] }, 400);
      }
      if (!validateFileSize(file.size)) {
        return c.json({ errorMessages: [`File too large (max 100MB)`] }, 400);
      }
      const policy = await checkAttachmentPolicy(file.size, file.name, issue.fields.project.id);
      if (policy) return c.json({ errorMessages: [policy] }, 400);

      const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, issue.fields.project.id)).limit(1))[0];
      if (!project) {
        return c.json({ errorMessages: ['Project not found'] }, 404);
      }

      // what the file really is, from its first bytes: a page or an image of markup (HTML, SVG, XML) is refused, and a type that the
      // content does not match is refused, as on the customer portal (the declared type alone is whatever the sender wrote)
      const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
      const content = checkContent(file.type, head);
      if (!content.ok) return c.json({ errorMessages: [content.error] }, 400);

      const result = await uploadFile(project.projectKey, issue.key, file, file.name, content.mime);
      invalidateStorageUsage();

      // Generate thumbnail inline for images (best-effort)
      if (result.thumbnailKey && file.type.startsWith('image/')) {
        try {
          await generateThumbnail(result.storageKey);
        } catch {
          // ignore thumbnail failures
        }
      }

      // Save to DB
      const [attachment] = await db.insert(schema.attachments).values({
        issueId: issue.id,
        filename: file.name,
        filesize: file.size,
        mimetype: file.type,
        storageKey: result.storageKey,
        authorId: user.id,
      }).returning();

      uploaded.push({
        id: String(attachment.id),
        self: `/rest/api/2/attachment/${attachment.id}`,
        filename: file.name,
        author: { id: user.id, displayName: user.displayName },
        created: new Date().toISOString(),
        size: file.size,
        mimeType: file.type,
        content: await getSignedDownloadUrl(result.storageKey),
        thumbnail: result.thumbnailUrl,
      });
    }

    return c.json(uploaded, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to upload attachment'] }, 500);
  }
});

// Get attachment (redirect to signed URL)
app.get('/rest/api/2/attachment/:id', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const id = Number(c.req.param('id'));
  const attachments = await db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1);
  if (attachments.length === 0) return c.json({ errorMessages: ['Attachment not found'] }, 404);

  const attachment = attachments[0];
  const inlinePdf = c.req.query('inline') === '1' && attachment.mimetype.toLowerCase() === 'application/pdf';
  const url = await getSignedDownloadUrl(attachment.storageKey, 900, inlinePdf);
  return c.redirect(url);
});

// Delete attachment
app.delete('/rest/api/2/attachment/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user')!;

  const attachments = await db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1);
  if (attachments.length === 0) return c.json({ errorMessages: ['Attachment not found'] }, 404);

  const attachment = attachments[0];

  // Resolve project for permission check
  const issueRows = await db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.id, attachment.issueId)).limit(1);
  const projectId = issueRows[0]?.projectId;
  if (!projectId) return c.json({ errorMessages: ['Project not found'] }, 404);

  const canDeleteAll = await checkProjectPermission(user, projectId, 'DELETE_ALL_ATTACHMENTS');
  const canDeleteOwn = await checkProjectPermission(user, projectId, 'DELETE_OWN_ATTACHMENTS');
  const isAuthor = attachment.authorId === user.id;

  if (!canDeleteAll && !(canDeleteOwn && isAuthor)) {
    return c.json({ errorMessages: ['Forbidden'] }, 403);
  }

  await deleteFile(attachment.storageKey);
  await db.delete(schema.attachments).where(eq(schema.attachments.id, id));

  return c.json({});
});

// List attachments for issue
app.get('/rest/api/2/issue/:idOrKey/attachments', requireAuth, requirePermission('BROWSE_PROJECTS'), async (c) => {
  const idOrKey = c.req.param('idOrKey');
  const issue = await getIssue(idOrKey);
  if (!issue) return c.json({ errorMessages: ['Issue not found'] }, 404);

  const attachments = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.issueId, issue.id))
    .orderBy(schema.attachments.createdAt);

  const result = await Promise.all(attachments.map(async (a) => {
    // an hour: the page that shows the list may stay open, and the links in it must keep working until it is reloaded
    const url = await getSignedDownloadUrl(a.storageKey, 3600);
    let thumbnail = null;
    if (a.mimetype.startsWith('image/')) {
      // its own link: a signed link is for one file, so the thumbnail cannot be made by editing the name in the link of the original
      thumbnail = await getSignedDownloadUrl(getThumbnailKey(a.storageKey), 3600);
    }
    return {
      id: String(a.id),
      self: `/rest/api/2/attachment/${a.id}`,
      filename: a.filename,
      author: { id: a.authorId },
      created: a.createdAt!.toISOString(),
      size: Number(a.filesize),
      mimeType: a.mimetype,
      content: url,
      thumbnail,
    };
  }));

  return c.json(result);
});

// Mock storage file serving (for testing without S3)
const MOCK_DIR = process.env.MOCK_STORAGE_DIR || '/tmp/veqsio-attachments';
app.get('/mock-storage/:path{.*}', async (c) => {
  // Only exists for development/tests. With a real storage backend this must not be a file server.
  if ((process.env.STORAGE_TYPE || 'r2') !== 'mock') return c.json({ errorMessages: ['File not found'] }, 404);
  const rel = c.req.param('path');
  // A link is a signed permission that expires (storage/signing.ts); only avatars keep a plain link.
  if (!isPublicStorageKey(rel)) {
    const exp = Number(c.req.query('exp'));
    const sig = c.req.query('sig') ?? '';
    if (!verifySignature(await signingKey(), rel, exp, c.req.query('inline') === '1', sig)) return c.json({ errorMessages: ['This link has expired or is not valid'] }, 403);
  }
  const root = resolve(MOCK_DIR);
  const full = resolve(root, rel);
  // Resolved path must stay inside the storage directory (rejects ../, encoded variants, absolute paths, NUL)
  if (rel.includes('\0') || rel.includes('\\') || !full.startsWith(root + sep)) {
    return c.json({ errorMessages: ['File not found'] }, 404);
  }
  const file = Bun.file(full);
  if (!(await file.exists())) {
    return c.json({ errorMessages: ['File not found'] }, 404);
  }
  // Uploaded content is untrusted: never let a browser render it in our origin.
  const inlinePdf = c.req.query('inline') === '1';
  return new Response(file, {
    headers: {
      'Content-Disposition': inlinePdf ? 'inline' : 'attachment',
      ...(inlinePdf ? { 'Content-Type': 'application/pdf' } : {}),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});

export default app;
