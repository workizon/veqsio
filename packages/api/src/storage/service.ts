import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, getStorageKey, getThumbnailKey } from './client';
import { storageConfig } from './config';
import { randomUUID } from 'crypto';
import type { UploadResult } from './types';
import { signingKey, signatureFor, isPublicStorageKey } from './signing';

export * from './types';
export { generateThumbnail } from './thumbnail';

const MOCK_DIR = process.env.MOCK_STORAGE_DIR || '/tmp/veqsio-attachments';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

export async function uploadFile(
  projectKey: string,
  issueKey: string,
  file: File | Blob | Buffer,
  filename: string,
  mimetype: string
): Promise<UploadResult> {
  const uuid = randomUUID();
  const key = getStorageKey(projectKey, issueKey, uuid, filename);

  const buffer = file instanceof Buffer ? file : Buffer.from(await (file as Blob).arrayBuffer());

  if (storageConfig.type === 'mock') {
    const path = `${MOCK_DIR}/${key}`;
    await Bun.write(path, buffer);
    const publicUrl = `${BASE_URL}/mock-storage/${key}`;
    const thumbnailKey = mimetype.startsWith('image/') ? getThumbnailKey(key) : undefined;
    const thumbnailUrl = thumbnailKey ? `${BASE_URL}/mock-storage/${thumbnailKey}` : undefined;
    return { storageKey: key, publicUrl, thumbnailKey, thumbnailUrl };
  }

  await s3Client.send(new PutObjectCommand({
    Bucket: storageConfig.bucket,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
    ContentLength: buffer.length,
  }));

  const publicUrl = storageConfig.publicUrl
    ? `${storageConfig.publicUrl}/${key}`
    : `${storageConfig.endpoint}/${storageConfig.bucket}/${key}`;

  let thumbnailKey: string | undefined;
  let thumbnailUrl: string | undefined;
  if (mimetype.startsWith('image/')) {
    thumbnailKey = getThumbnailKey(key);
    thumbnailUrl = storageConfig.publicUrl
      ? `${storageConfig.publicUrl}/${thumbnailKey}`
      : `${storageConfig.endpoint}/${storageConfig.bucket}/${thumbnailKey}`;
  }

  return { storageKey: key, publicUrl, thumbnailKey, thumbnailUrl };
}

export async function getSignedDownloadUrl(storageKey: string, expirySeconds = 900, inlinePdf = false): Promise<string> {
  if (storageConfig.type === 'mock') {
    if (isPublicStorageKey(storageKey)) return `${BASE_URL}/mock-storage/${storageKey}`;
    const exp = Math.floor(Date.now() / 1000) + expirySeconds;
    const sig = signatureFor(await signingKey(), storageKey, exp, inlinePdf);
    return `${BASE_URL}/mock-storage/${storageKey}?${inlinePdf ? 'inline=1&' : ''}exp=${exp}&sig=${sig}`;
  }

  const command = new GetObjectCommand({
    Bucket: storageConfig.bucket,
    Key: storageKey,
    ...(inlinePdf ? { ResponseContentDisposition: 'inline', ResponseContentType: 'application/pdf' } : { ResponseContentDisposition: 'attachment' }),
  });
  return getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
}

export async function deleteFile(storageKey: string): Promise<void> {
  if (storageConfig.type === 'mock') {
    try { await Bun.file(`${MOCK_DIR}/${storageKey}`).delete(); } catch {}
    try { await Bun.file(`${MOCK_DIR}/${getThumbnailKey(storageKey)}`).delete(); } catch {}
    return;
  }

  await s3Client.send(new DeleteObjectCommand({
    Bucket: storageConfig.bucket,
    Key: storageKey,
  }));
  const thumbnailKey = getThumbnailKey(storageKey);
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: storageConfig.bucket,
      Key: thumbnailKey,
    }));
    await s3Client.send(new DeleteObjectCommand({
      Bucket: storageConfig.bucket,
      Key: thumbnailKey,
    }));
  } catch {
    // Thumbnail doesn't exist, ignore
  }
}

export function isAllowedMimeType(mimetype: string): boolean {
  return storageConfig.allowedMimeTypes.some((allowed) => {
    if (allowed.endsWith('/*')) {
      return mimetype.startsWith(allowed.slice(0, -1));
    }
    return allowed === mimetype;
  });
}

export function validateFileSize(size: number): boolean {
  return size <= storageConfig.maxFileSize;
}
