import { env } from './env';

/** Vercel Blob helpers. All calls are optional: without a token the callers skip caching. */
export const blobEnabled = () => !!env.BLOB_READ_WRITE_TOKEN;

export async function blobFind(pathname: string): Promise<string | null> {
  if (!blobEnabled()) return null;
  try {
    const { head } = await import('@vercel/blob');
    const h = await head(pathname, { token: env.BLOB_READ_WRITE_TOKEN });
    return h?.url ?? null;
  } catch {
    return null; // not found or blob unreachable
  }
}

export async function blobPut(pathname: string, data: ArrayBuffer | Buffer | Blob, contentType: string): Promise<string> {
  const { put } = await import('@vercel/blob');
  const r = await put(pathname, data as any, {
    access: 'public', contentType, token: env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: false, allowOverwrite: true,
  });
  return r.url;
}
