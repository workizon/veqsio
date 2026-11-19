export const storageConfig = {
  type: process.env.STORAGE_TYPE || 'r2',
  endpoint: process.env.STORAGE_ENDPOINT || '',
  bucket: process.env.STORAGE_BUCKET || 'veqsio-attachments',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || '',
  publicUrl: process.env.STORAGE_PUBLIC_URL || '',
  maxFileSize: Number(process.env.STORAGE_MAX_FILE_SIZE) || 104857600, // 100MB
  allowedMimeTypes: (process.env.STORAGE_ALLOWED_MIME_TYPES || 'image/*,application/pdf,text/*,application/json,application/zip,application/octet-stream').split(','),
  region: process.env.STORAGE_REGION || 'auto',
};
