// Seller fair price, shared by /api/seller/price and /api/seller/draft.
import { query, readBranch } from '@/lib/db';
import { estimateUsedPrice } from '@/lib/gemini';
import type { Category } from '@/lib/logic/categories';

export type Condition = 'like_new' | 'good' | 'fair';
export type SellerPrice = {
  /** 'comps' = from similar local listings in Neon; 'estimate' = Gemini's used-price estimate; null = no price */
  source: 'comps' | 'estimate' | null;
  category: Category | null; condition: Condition; comparables: number;
  suggested_usd: number | null; low_usd: number | null; high_usd: number | null; new_median_usd: number | null;
  basis: string | null;
};

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

async function fromComps(category: Category, condition: Condition) {
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
  ))[0] as { n: number; p40: number | null; p25: number | null; median: number | null; new_median: number | null } | undefined;
  let r = await comps([category]);
  const related = RELATED[category];
  if ((r?.n ?? 0) < WIDEN_BELOW && related) r = await comps([category, ...related]);
  return r;
}

/**
 * A price that sells in a few days. Known furniture with >= 3 local single-item comps (Craigslist + Marketplace):
 * suggested = 40th percentile, low = 25th ("quick sale"), high = median ("typical"). Anything else (a bottle, a
 * mirror) or too few comps: Gemini's used-price estimate for that exact item, labelled as an estimate.
 */
export async function sellerPrice(p: { item: string | null; category: Category | null; condition: Condition;
  title?: string | null; w_in?: number | null; d_in?: number | null; h_in?: number | null }): Promise<SellerPrice> {
  const base = { category: p.category, condition: p.condition, comparables: 0, new_median_usd: null, basis: null };
  if (p.category) {
    const r = await fromComps(p.category, p.condition);
    if ((r?.n ?? 0) >= 3 && r?.p40 != null) {
      const k = CONDITION_FACTOR[p.condition];
      const suggested = round5(r.p40 * k);
      const low = r.p25 != null ? round5(r.p25 * k) : null, high = r.median != null ? round5(r.median * k) : null;
      return { ...base, source: 'comps', comparables: r.n, new_median_usd: r.new_median ?? null,
        suggested_usd: suggested,
        low_usd: low != null ? Math.min(low, suggested) : null,
        high_usd: high != null ? Math.max(high, suggested) : null,
        basis: `${r.n} similar local listings on Craigslist and Marketplace` };
    }
    base.comparables = r?.n ?? 0;
  }
  const item = (p.item || p.title || '').trim();
  if (!item) return { ...base, source: null, suggested_usd: null, low_usd: null, high_usd: null };
  try {
    const e = await estimateUsedPrice({ item, condition: p.condition, title: p.title, w_in: p.w_in, d_in: p.d_in, h_in: p.h_in });
    return { ...base, source: 'estimate', suggested_usd: e.suggested_usd, low_usd: e.low_usd, high_usd: e.high_usd,
      new_median_usd: e.new_usd, basis: e.basis };
  } catch (e) {
    console.warn('[seller.price] estimate unavailable:', (e as Error).message);
    return { ...base, source: null, suggested_usd: null, low_usd: null, high_usd: null };
  }
}
