import { NextResponse } from 'next/server';
import { z } from 'zod';
import { query, readBranch } from '@/lib/db';
import { route } from '@/lib/errors';
import { CATEGORIES } from '@/lib/logic/categories';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const Body = z.object({ category: z.enum(CATEGORIES), condition: z.enum(['like_new', 'good', 'fair']).default('good') });
const CONDITION_FACTOR = { like_new: 1.15, good: 1, fair: 0.75 } as const;

// Sets ("set of 4 bar stools", "table with 6 chairs") are priced for the whole set; eBay is mostly new or shipped
// stock. Both inflate a one-item, local, second-hand price. Same rule as worker/stages/seller.py fair_price.
const SET_TITLE = String.raw`(set of|pair of|\m(2|3|4|5|6|two|three|four|five|six)\s*(x\s*)?(pc|pcs|pieces|stools|chairs|tables|nightstands|lamps)\M|\mset\M|table\M.*\mchairs|chairs\M.*\mtable)`;
// Fewer than WIDEN_BELOW comps in the category: borrow from the closest categories.
const WIDEN_BELOW = 5;
const RELATED: Partial<Record<string, string[]>> = {
  dining_chair: ['accent_chair', 'stool'], accent_chair: ['dining_chair'], stool: ['dining_chair', 'ottoman'],
  ottoman: ['stool'], side_table: ['nightstand'], nightstand: ['side_table'], coffee_table: ['side_table'],
  desk_lamp: ['floor_lamp'], floor_lamp: ['desk_lamp'], desk: ['side_table'], bookshelf: ['dresser'], dresser: ['nightstand'],
};
const round5 = (v: number) => Math.max(5, Math.round(v / 5) * 5);

/** Seller flow: a price that sells in a few days. Local single-item comps (Craigslist + Marketplace) in Neon:
 *  suggested = 40th percentile, low = 25th ("quick sale"), high = median ("typical"). Estimate only. */
export const POST = route('api.seller.price', async (req: Request) => {
  checkIpLimit(req, 'seller', 20);
  const { category, condition } = Body.parse(await req.json());
  const comps = async (cats: string[]) => (await query(
    `select count(*)::int as n,
            percentile_cont(0.4) within group (order by l.price_usd)::float8 as p40,
            percentile_cont(0.25) within group (order by l.price_usd)::float8 as p25,
            percentile_cont(0.5) within group (order by l.price_usd)::float8 as median,
            (select median_usd::float8 from new_price_baselines where category = $3 and style_key = 'any') as new_median
       from listings l join listing_details d on d.listing_id = l.id
      where d.category = any($1::text[]) and l.price_usd > 0 and l.is_active
        and l.source in ('craigslist', 'fb_marketplace') and l.title !~* $2`,
    [cats, SET_TITLE, category], { branch: readBranch() },
  ))[0];
  let r = await comps([category]);
  const related = RELATED[category];
  if ((r?.n ?? 0) < WIDEN_BELOW && related) r = await comps([category, ...related]);
  const k = CONDITION_FACTOR[condition];
  const enough = (r?.n ?? 0) >= 3;                     // fewer than 3 comps: no made-up price
  const round = (v: number | null) => (v == null || !enough ? null : round5(v * k));
  const suggested = round(r?.p40 ?? null);
  const low = round(r?.p25 ?? null), high = round(r?.median ?? null);
  return NextResponse.json({
    category, condition, comparables: r?.n ?? 0,
    suggested_usd: suggested,
    low_usd: low != null && suggested != null ? Math.min(low, suggested) : low,
    high_usd: high != null && suggested != null ? Math.max(high, suggested) : high,
    new_median_usd: r?.new_median ?? null,
  });
});
