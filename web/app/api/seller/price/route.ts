import { NextResponse } from 'next/server';
import { z } from 'zod';
import { query, readBranch } from '@/lib/db';
import { route } from '@/lib/errors';
import { CATEGORIES } from '@/lib/logic/categories';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const Body = z.object({ category: z.enum(CATEGORIES), condition: z.enum(['like_new', 'good', 'fair']).default('good') });
const CONDITION_FACTOR = { like_new: 1.15, good: 1, fair: 0.75 } as const;

/** Seller flow (stretch): fair-price suggestion = median of comparable used listings in Neon. Estimate only. */
export const POST = route('api.seller.price', async (req: Request) => {
  checkIpLimit(req, 'seller', 20);
  const { category, condition } = Body.parse(await req.json());
  const [r] = await query(
    `select count(*)::int as n,
            percentile_cont(0.5) within group (order by l.price_usd)::float8 as median,
            percentile_cont(0.25) within group (order by l.price_usd)::float8 as p25,
            percentile_cont(0.75) within group (order by l.price_usd)::float8 as p75,
            (select median_usd::float8 from new_price_baselines where category = $1 and style_key = 'any') as new_median
       from listings l join listing_details d on d.listing_id = l.id
      where d.category = $1 and l.price_usd > 0`,
    [category], { branch: readBranch() },
  );
  const k = CONDITION_FACTOR[condition];
  const round = (v: number | null) => (v == null ? null : Math.max(1, Math.round(v * k)));
  return NextResponse.json({
    category, condition, comparables: r?.n ?? 0,
    suggested_usd: round(r?.median ?? null), low_usd: round(r?.p25 ?? null), high_usd: round(r?.p75 ?? null),
    new_median_usd: r?.new_median ?? null,
  });
});
