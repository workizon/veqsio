import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, getThumbnailKey } from './client';
import { storageConfig } from './config';

const THUMB_MAX_WIDTH = 300;
const THUMB_MAX_HEIGHT = 300;
const MAX_INPUT_PIXELS = 40_000_000;
const MOCK_DIR = process.env.MOCK_STORAGE_DIR || '/tmp/veqsio-attachments';

export async function generateThumbnail(storageKey: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sharp: any = null;
  try {
    const mod: any = await import('sharp');
    sharp = mod.default ?? mod;
  } catch {
    console.warn('sharp not available, skipping thumbnail generation');
    return null;
  }

  try {
    let buffer: Buffer;

    if (storageConfig.type === 'mock') {
      const file = Bun.file(`${MOCK_DIR}/${storageKey}`);
      if (!(await file.exists())) return null;
      buffer = Buffer.from(await file.arrayBuffer());
    } else {
      const response = await s3Client.send(new GetObjectCommand({
        Bucket: storageConfig.bucket,
        Key: storageKey,
      }));

      if (!response.Body) return null;

      if (response.Body instanceof ReadableStream) {
        buffer = await streamToBuffer(response.Body);
      } else {
        const chunks: Uint8Array[] = [];
        for await (const chunk of response.Body as any) {
          chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
      }
    }

    // Only raster pictures are decoded: SVG and other text formats go through a much larger and riskier decoder, and a
    // picture claiming huge dimensions (a decompression bomb) must not eat the memory of the server.
    if (looksLikeText(buffer)) return null;
    const resized = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .resize(THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    const thumbnailKey = getThumbnailKey(storageKey);

    if (storageConfig.type === 'mock') {
      await Bun.write(`${MOCK_DIR}/${thumbnailKey}`, resized);
    } else {
      await s3Client.send(new PutObjectCommand({
        Bucket: storageConfig.bucket,
        Key: thumbnailKey,
        Body: resized,
        ContentType: 'image/png',
      }));
    }

    return thumbnailKey;
  } catch (err) {
    console.error('Thumbnail generation failed:', err);
    return null;
  }
}

async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** True for markup (SVG, HTML, XML): the first bytes are text with an angle bracket, which no raster format starts with. */
export function looksLikeText(b: Buffer): boolean {
  const head = b.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<') || head.includes('<svg') || head.includes('<!doctype');
}
