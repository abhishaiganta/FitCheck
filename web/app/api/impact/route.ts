import { NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { AppError, err, logError, route } from '@/lib/errors';
import { savingsVsNew } from '@/lib/logic/cost';
import { checkIpLimit } from '@/lib/ratelimit';
import { fetchRawItems } from '@/lib/search/sql';
import { getImpactStats } from '@/lib/stats';

export const dynamic = 'force-dynamic';

const Body = z.object({ listing_id: z.coerce.number().int().positive(), kind: z.enum(['ar_view', 'listing_open']) });

/** Records an AR view or a listing open. Savings and weight are computed here, not trusted from the client. */
export const POST = route('api.impact', async (req: Request) => {
  checkIpLimit(req, 'impact', 60);
  const { listing_id, kind } = Body.parse(await req.json());
  try {
    const [item] = await fetchRawItems([listing_id], 'main');
    if (!item) throw err.notFound('That listing');
    const total = item.price + (item.ships ? (item.shipping ?? 0) : 0);
    await query(
      'insert into impact_events (listing_id, kind, dollars_saved_est, lbs_diverted_est) values ($1, $2, $3, $4)',
      [listing_id, kind, savingsVsNew(item.baseline_usd, total), item.weight_lb],
      { branch: 'main', timeoutMs: 4000 },
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    // analytics must never break the buyer flow
    if (e instanceof AppError && e.code === 'db_unreachable') {
      logError('api.impact', e);
      return NextResponse.json({ ok: false, skipped: 'database unreachable' }, { status: 202 });
    }
    throw e;
  }
});

export const GET = route('api.impact.get', async () =>
  NextResponse.json(await getImpactStats(), { headers: { 'cache-control': 'no-store' } }),
);
