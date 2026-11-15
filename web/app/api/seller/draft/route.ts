import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { blobEnabled, blobPut } from '@/lib/blob';
import { query } from '@/lib/db';
import { env } from '@/lib/env';
import { err, route } from '@/lib/errors';
import { categoryFromText, isCategory } from '@/lib/logic/categories';
import { checkIpLimit } from '@/lib/ratelimit';
import { sellerPrice, type Condition } from '@/lib/seller/price';

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
  // the declared type is only a claim: check the file really is a JPEG, PNG or WebP
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isWebp = String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WEBP';
  if (file.size < 1024 || !(isJpeg || isPng || isWebp)) throw err.badRequest("That file isn't a photo we can read. Try another one.");

  const height = Number(form?.get('height_in'));
  if (!Number.isFinite(height) || height <= 0 || height >= 120) throw err.badRequest('Enter the height in inches (1 to 119).');
  const title = String(form?.get('title') ?? '').trim().slice(0, 120) || null;
  const askRaw = String(form?.get('ask_usd') ?? '').trim();
  const ask = askRaw === '' ? null : Number(askRaw);
  if (ask != null && (!Number.isFinite(ask) || ask < 0 || ask > 100000)) throw err.badRequest('The asking price looks wrong.');
  // "What is it?" is free text: "water bottle" stays 'other' with its own size and price, "armchair" maps to a category
  const item = String(form?.get('item') ?? '').trim().toLowerCase().slice(0, 80) || null;
  const catRaw = String(form?.get('category') ?? '');
  const category = isCategory(catRaw) ? catRaw : categoryFromText(item ?? title);
  const dim = (k: string) => { const v = Number(form?.get(k)); return Number.isFinite(v) && v > 0 && v < 200 ? Math.round(v * 10) / 10 : null; };
  // the photo estimate's width and depth, kept in proportion if the seller changed the height
  const estH = dim('est_h_in'), sk = estH ? height / estH : 1;
  const w0 = dim('w_in'), d0 = dim('d_in');
  const w = w0 ? Math.round(w0 * sk * 10) / 10 : null, d = d0 ? Math.round(d0 * sk * 10) / 10 : null;
  const condRaw = String(form?.get('condition') ?? 'good');
  const condition: Condition = condRaw === 'like_new' || condRaw === 'fair' ? condRaw : 'good';
  // a neighbourhood-level location only (rounded), never an address
  const lat = Number(form?.get('lat')), lng = Number(form?.get('lng'));
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && lat !== 0;
  const city = String(form?.get('city') ?? '').trim().slice(0, 60) || null;

  const token = randomBytes(16).toString('hex');
  const url = await blobPut(`seller/${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`, file, file.type);
  const price = await sellerPrice({ item, category, condition, title, w_in: w, d_in: d, h_in: height });
  const [row] = await query<{ id: number }>(
    `insert into seller_drafts (photo_url, height_in, title, ask_usd, category, city, lat, lng, edit_token, item, w_in, d_in,
                                fair_price_usd, fair_low_usd, fair_high_usd, comps_n, price_source, price_basis)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id::int as id`,
    [url, Math.round(height * 10) / 10, title, ask, category ?? 'other', city,
      hasCoords ? Math.round(lat * 100) / 100 : (city ? null : env.ORIGIN_LAT),
      hasCoords ? Math.round(lng * 100) / 100 : (city ? null : env.ORIGIN_LNG), token, item, w, d,
      price.suggested_usd, price.low_usd, price.high_usd, price.comparables, price.source, price.basis],
    { branch: 'main' },
  );
  return NextResponse.json({ id: row.id, token, photo_url: url, status: 'new' });
});
