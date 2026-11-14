import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { err, route } from '@/lib/errors';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

/** Corner-set build status for polling: pending -> exporting -> ready (usdz_url, glb_url) | failed. */
export const GET = route('api.corner.get', async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  checkIpLimit(req, 'corner-get', 120);
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) throw err.notFound('That corner');
  const [row] = await query(
    `select id::int as id, title, status, usdz_url, glb_url, total_usd::float8 as total_usd, error,
            w_in::float8 as w_in, d_in::float8 as d_in, h_in::float8 as h_in
       from sets where id = $1`, [id], { branch: 'main' },
  );
  if (!row) throw err.notFound('That corner');
  return NextResponse.json(row, { headers: { 'cache-control': 'no-store' } });
});
