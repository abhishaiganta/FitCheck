import { NextResponse } from 'next/server';
import { z } from 'zod';
import { query, readBranch } from '@/lib/db';
import { route } from '@/lib/errors';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const Body = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(12) });
type G = typeof globalThis & { __lr_model_ok?: Map<string, { at: number; ok: boolean }> };
const g = globalThis as G;

/**
 * Tells the client which USDZ links are definitely broken (404/410/403), so it can hide the AR
 * button and show the 3D preview instead. Timeouts and network errors count as "unknown = fine".
 */
export const POST = route('api.models.check', async (req: Request) => {
  checkIpLimit(req, 'models', 60);
  const { ids } = Body.parse(await req.json());
  const rows = await query<{ id: number; usdz_url: string | null }>(
    'select listing_id::int as id, usdz_url from assets where listing_id = any($1::bigint[])', [ids], { branch: readBranch() },
  );
  g.__lr_model_ok ??= new Map();
  const cache = g.__lr_model_ok;
  const out: Record<number, boolean> = {};
  await Promise.all(rows.map(async (r) => {
    if (!r.usdz_url || !/^https:\/\//.test(r.usdz_url)) { out[r.id] = false; return; }
    const hit = cache.get(r.usdz_url);
    if (hit && Date.now() - hit.at < 10 * 60_000) { out[r.id] = hit.ok; return; }
    let ok = true;
    try {
      const res = await fetch(r.usdz_url, { method: 'HEAD', signal: AbortSignal.timeout(2500) });
      ok = ![403, 404, 410].includes(res.status);
      cache.set(r.usdz_url, { at: Date.now(), ok });
    } catch { /* unknown: leave the AR button alone */ }
    out[r.id] = ok;
  }));
  return NextResponse.json({ ok: out });
});
