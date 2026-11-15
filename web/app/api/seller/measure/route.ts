import { NextResponse } from 'next/server';
import { err, route } from '@/lib/errors';
import { estimateItemSize } from '@/lib/gemini';
import { categoryFromText, isCategory } from '@/lib/logic/categories';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BYTES = 5 * 1024 * 1024;
const OK_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/**
 * Photo(s) in, estimated width x depth x height out, so sellers never have to know the dimensions.
 * Form fields: "photo" (required, front view) and optional "photo2" (side view, improves depth).
 */
export const POST = route('api.seller.measure', async (req: Request) => {
  checkIpLimit(req, 'measure', 12);
  const form = await req.formData().catch(() => null);
  const files = [form?.get('photo'), form?.get('photo2')].filter((f): f is File => !!f && typeof f !== 'string');
  if (!files.length) throw err.badRequest('Attach the photo as form field "photo".');
  const images = [];
  for (const f of files) {
    const mime = (f.type || 'image/jpeg').toLowerCase();
    if (!OK_TYPES.has(mime)) throw err.badRequest('That file is not a photo we can read. Use a JPEG or PNG.');
    if (f.size > MAX_BYTES) throw err.badRequest('That photo is too large. Try again; it should shrink automatically.');
    if (f.size < 2000) throw err.badRequest('That photo looks empty. Take it again.');
    images.push({ mime, b64: Buffer.from(await f.arrayBuffer()).toString('base64') });
  }
  const est = await estimateItemSize(images);
  return NextResponse.json(
    { ...est, category: est.category && isCategory(est.category) ? est.category : categoryFromText(est.item), views: images.length },
    { headers: { 'cache-control': 'no-store' } },
  );
});
