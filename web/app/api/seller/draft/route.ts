import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { blobEnabled, blobPut } from '@/lib/blob';
import { query } from '@/lib/db';
import { env } from '@/lib/env';
import { err, route } from '@/lib/errors';
import { CATEGORIES } from '@/lib/logic/categories';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BYTES = 4 * 1024 * 1024; // the page shrinks photos to ~1600 px first; Vercel caps bodies at 4.5 MB
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Seller flow: photo + height (+ title, category, asking price) -> a seller_drafts row.
 * The worker's seller stage turns it into a hidden listing with a real, true-scale 3D model and a fair price.
 * Returns the draft id and an edit token; only the token holder can publish the draft.
 */
export const POST = route('api.seller.draft', async (req: Request) => {
  checkIpLimit(req, 'seller-draft', 5);
  if (!blobEnabled()) throw err.notConfigured('Vercel Blob (BLOB_READ_WRITE_TOKEN)');
  const form = await req.formData().catch(() => null);
  const photo = form?.get('photo');
  if (!photo || typeof photo === 'string') throw err.badRequest('Add a photo of the item.');
  const file = photo as File;
  const ext = TYPES[file.type];
  if (!ext) throw err.badRequest('The photo must be a JPEG, PNG or WebP image.');
  if (file.size > MAX_BYTES) throw err.badRequest('That photo is over 4 MB. Try a smaller one.');

  const height = Number(form?.get('height_in'));
  if (!Number.isFinite(height) || height <= 0 || height >= 120) throw err.badRequest('Enter the height in inches (1 to 119).');
  const title = String(form?.get('title') ?? '').trim().slice(0, 120) || null;
  const askRaw = String(form?.get('ask_usd') ?? '').trim();
  const ask = askRaw === '' ? null : Number(askRaw);
  if (ask != null && (!Number.isFinite(ask) || ask < 0 || ask > 100000)) throw err.badRequest('The asking price looks wrong.');
  const catRaw = String(form?.get('category') ?? '');
  const category = (CATEGORIES as readonly string[]).includes(catRaw) ? catRaw : null;
  // a neighbourhood-level location only (rounded), never an address
  const lat = Number(form?.get('lat')), lng = Number(form?.get('lng'));
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && lat !== 0;
  const city = String(form?.get('city') ?? '').trim().slice(0, 60) || null;

  const token = randomBytes(16).toString('hex');
  const url = await blobPut(`seller/${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`, file, file.type);
  const [row] = await query<{ id: number }>(
    `insert into seller_drafts (photo_url, height_in, title, ask_usd, category, city, lat, lng, edit_token)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::int as id`,
    [url, Math.round(height * 10) / 10, title, ask, category, city,
      hasCoords ? Math.round(lat * 100) / 100 : (city ? null : env.ORIGIN_LAT),
      hasCoords ? Math.round(lng * 100) / 100 : (city ? null : env.ORIGIN_LNG), token],
    { branch: 'main' },
  );
  return NextResponse.json({ id: row.id, token, photo_url: url, status: 'new' });
});
