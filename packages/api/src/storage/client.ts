import { S3Client } from '@aws-sdk/client-s3';
import { storageConfig } from './config';

export const s3Client = new S3Client({
  endpoint: storageConfig.endpoint,
  region: storageConfig.region,
  credentials: {
    accessKeyId: storageConfig.accessKeyId,
    secretAccessKey: storageConfig.secretAccessKey,
  },
  forcePathStyle: true,
});

export function getStorageKey(projectKey: string, issueKey: string, fileUuid: string, filename: string): string {
  // Only a short alphanumeric extension of the client-supplied name ever reaches the key (no separators, dots or
  // control characters), so a hostile filename cannot shape the storage path.
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) : '';
  return `attachments/${projectKey}/${issueKey}/${fileUuid}${ext ? '.' + ext : ''}`;
}

export function getThumbnailKey(storageKey: string): string {
  const lastDot = storageKey.lastIndexOf('.');
  const base = lastDot > 0 ? storageKey.slice(0, lastDot) : storageKey;
  return `${base}_thumb.png`;
}
