import { NextResponse } from 'next/server';
import { route } from '@/lib/errors';
import { checkIpLimit } from '@/lib/ratelimit';
import { getPipeline } from '@/lib/stats';

export const dynamic = 'force-dynamic';

/** Status counts + last 30 asset_events. Always reads main (DATABASE_URL), even in DEMO_MODE. */
export const GET = route('api.pipeline', async (req: Request) => {
  checkIpLimit(req, 'pipeline', 60);
  return NextResponse.json(await getPipeline(), { headers: { 'cache-control': 'no-store' } });
});
