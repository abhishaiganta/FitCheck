import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { blobEnabled, blobPut } from '@/lib/blob';
import { query } from '@/lib/db';
import { err, route } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BYTES = 40 * 1024 * 1024;

/**
 * Upload a hand-made GLB for a listing. Stores it in Vercel Blob and marks the asset
 * provider='manual', status='gen_done' so the worker's exporter picks it up.
 */
export const POST = route('api.admin.upload-glb', async (req: Request) => {
  requireAdmin(req);
  if (!blobEnabled()) throw err.notConfigured('Vercel Blob (BLOB_READ_WRITE_TOKEN)');
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  const listingId = Number(form?.get('listing_id'));
  if (!Number.isInteger(listingId) || listingId <= 0) throw err.badRequest('listing_id is required.');
  if (!file || typeof file === 'string') throw err.badRequest('Attach the .glb as form field "file".');
  const blob = file as File;
  if (blob.size > MAX_BYTES) throw err.badRequest('GLB is over 40 MB. Decimate or compress it first.');
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (String.fromCharCode(...head) !== 'glTF') throw err.badRequest('That file is not a binary glTF (.glb).');

  const found = await query('select 1 from listings where id = $1', [listingId], { branch: 'main' });
  if (!found.length) throw err.notFound('That listing');

  const prev = await query<{ status: string; attempts: number }>(
    'select status::text as status, attempts from assets where listing_id = $1', [listingId], { branch: 'main' },
  );
  const version = (prev[0]?.attempts ?? 0) + 1;
  const url = await blobPut(`glb/${listingId}-manual-v${version}.glb`, blob, 'model/gltf-binary');
  await query(
    `insert into assets (listing_id, status, provider, glb_url, is_approx_model, attempts, updated_at)
     values ($1, 'gen_done', 'manual', $2, false, $3, now())
     on conflict (listing_id) do update
       set status = 'gen_done', provider = 'manual', glb_url = excluded.glb_url, usdz_url = null,
           is_approx_model = false, attempts = excluded.attempts, last_error = null,
           locked_by = null, locked_at = null, updated_at = now()`,
    [listingId, url, version], { branch: 'main' },
  );
  await query(
    'insert into asset_events (listing_id, from_status, to_status, note) values ($1, $2, $3, $4)',
    [listingId, prev[0]?.status ?? null, 'gen_done', 'manual GLB uploaded via /admin'], { branch: 'main' },
  );
  return NextResponse.json({ ok: true, glb_url: url, status: 'gen_done' });
});
