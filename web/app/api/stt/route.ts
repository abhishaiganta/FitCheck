import { NextResponse } from 'next/server';
import { speechToText } from '@/lib/elevenlabs';
import { err, route } from '@/lib/errors';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BYTES = 8 * 1024 * 1024;
const EXT: Record<string, string> = {
  'audio/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm',
};

/** Audio blob in (multipart field "audio" or a raw body), `{ text }` out. */
export const POST = route('api.stt', async (req: Request) => {
  checkIpLimit(req, 'stt', 30);
  const ct = req.headers.get('content-type') ?? '';
  let blob: Blob | null = null;
  if (ct.startsWith('multipart/form-data')) {
    const f = (await req.formData().catch(() => null))?.get('audio');
    if (f && typeof f !== 'string') blob = f as Blob;
  } else if (/^(audio|video)\//.test(ct)) {
    blob = new Blob([await req.arrayBuffer()], { type: ct });
  }
  if (!blob) throw err.badRequest('Send the recording as multipart field "audio".');
  if (blob.size < 800) throw err.badRequest("That recording was too short. Hold the button while you talk.");
  if (blob.size > MAX_BYTES) throw err.badRequest('That recording is too long. Keep it under a minute.');
  const mime = (blob.type || 'audio/mp4').split(';')[0].trim().toLowerCase();
  if (!EXT[mime]) throw err.badRequest(`Audio type "${mime}" is not supported.`);
  const text = await speechToText(blob, `speech.${EXT[mime]}`);
  if (!text) throw err.upstream('elevenlabs', "Didn't catch that. Try again or type it.", true);
  return NextResponse.json({ text }, { headers: { 'cache-control': 'no-store' } });
});
