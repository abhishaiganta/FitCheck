// The single hybrid search query (spec section 7): SQL filters + pgvector similarity + cost ranking.
import { query, readBranch, toVector, type Branch } from '../db';
import type { Car } from '../logic/carFit';
import { CITY_ONLY_MIN_RADIUS_MI, maxRoadMiles } from '../logic/cost';
import type { Origin } from '../logic/geo';
import { DEMO_PIN_BOOST, REAL_MODEL_BOOST, RESULT_LIMIT, TOO_BIG_PENALTY, styleWords, toCard } from './evaluate';
import type { SearchArgs } from './schema';
import type { Card, RawItem } from './types';

/** Columns every item query returns, so cards are shaped the same way everywhere. */
export const ITEM_COLUMNS = `
  l.id::int as id, l.source, l.url, l.title, l.price_usd::float8 as price, l.shipping_usd::float8 as shipping,
  l.ships, l.city, l.lat, l.lng, l.photo_urls, l.scraped_at, l.is_active, l.demo_pin,
  d.category, d.style_tags, d.condition, d.dims_source, d.weight_lb_est::float8 as weight_lb,
  d.best_photo_idx, d.summary,
  coalesce(a.final_w_in, d.w_in)::float8 as w, coalesce(a.final_d_in, d.d_in)::float8 as d,
  coalesce(a.final_h_in, d.h_in)::float8 as h,
  d.w_in::float8 as listed_w, d.d_in::float8 as listed_d,
  a.status::text as asset_status, a.glb_url, a.usdz_url, coalesce(a.is_approx_model, false) as is_approx_model,
  -- false when the listing only says "San Diego": its lat/lng is the city centroid, not where the item is
  (l.lat is not null and lower(regexp_replace(coalesce(l.city, ''), '[^a-zA-Z]', '', 'g'))
     not in ('sandiego', 'sandiegoca', 'sandiegocalifornia', '')) as loc_precise`;

export const BASELINE_JOIN = `
  left join lateral (
    select nb.median_usd from new_price_baselines nb
     where nb.category = d.category and (nb.style_key = 'any' or nb.style_key = any(d.style_tags))
     order by (nb.style_key <> 'any') desc limit 1
  ) nb on true`;

export const SEARCH_SQL = `
with car as (
  select * from cars
   where $13::text is not null and (
     regexp_replace(lower(make_model), '[^a-z0-9]', '', 'g') like '%' || regexp_replace(lower($13::text), '[^a-z0-9]', '', 'g') || '%'
     or regexp_replace(lower($13::text), '[^a-z0-9]', '', 'g') like '%' || regexp_replace(lower(regexp_replace(make_model, '^\\S+\\s+', '')), '[^a-z0-9]', '', 'g') || '%')
   order by (lower(make_model) = lower($13::text)) desc, length(make_model) limit 1
),
base as (
  select ${ITEM_COLUMNS},
    nb.median_usd::float8 as baseline_usd,
    case when l.lat is null or l.lng is null or l.source = 'ebay' then null
         else 1.3 * 2 * 3958.8 * asin(least(1, sqrt(
                power(sin(radians(l.lat - $1::float8) / 2), 2) +
                cos(radians($1::float8)) * cos(radians(l.lat)) * power(sin(radians(l.lng - $2::float8) / 2), 2))))
    end as road_mi,
    case when $8::text is null or d.embedding is null then null
         else nullif(1 - (d.embedding <=> $8::vector), 'NaN'::float8) end as vec_sim,
    (select count(*) from unnest($9::text[]) as sw(word)
      where lower(l.title || ' ' || array_to_string(d.style_tags, ' ') || ' ' || coalesce(d.summary, '')) like '%' || sw.word || '%')::float8
      / greatest(cardinality($9::text[]), 1) as kw_sim
  from listings l
  join listing_details d on d.listing_id = l.id
  join assets a on a.listing_id = l.id and a.status = 'ready' and not coalesce(a.is_approx_model, false)
  ${BASELINE_JOIN}
  where l.is_active and l.price_usd is not null
    and (cardinality($3::text[]) = 0 or d.category = any($3::text[]))
    and (not $15::bool or l.price_usd = 0)
    and ($10::float8 is null or coalesce(a.final_w_in, d.w_in) <= $10::float8)
    and ($11::float8 is null or coalesce(a.final_d_in, d.d_in) <= $11::float8)
    and ($12::float8 is null or coalesce(a.final_h_in, d.h_in) <= $12::float8)
),
opts as (
  select b.*,
    case when b.road_mi is null or $18::bool then null
         when not $7::bool then case when b.road_mi <= 1 and coalesce(b.weight_lb, 999) <= 15 then b.price end
         when b.road_mi <= $5::float8 or (not b.loc_precise and $5::float8 >= ${CITY_ONLY_MIN_RADIUS_MI}) then round((b.price + b.road_mi * 2 * $14::float8)::numeric, 2)::float8
    end as pickup_total,
    case when b.ships and ($6::bool or $18::bool) then b.price + coalesce(b.shipping, 0) end as ship_total
  from base b
),
costed as (
  select o.*, least(o.pickup_total, o.ship_total) as total,
    case when o.ship_total is not null and (o.pickup_total is null or o.ship_total < o.pickup_total) then 'ship'
         when not $7::bool then 'walk' else 'pickup' end as mode
  from opts o
  where coalesce(o.pickup_total, o.ship_total) is not null
),
fit as (
  select f.*, c.make_model as car_name,
    case when c.make_model is null or f.w is null or f.d is null or f.h is null then null
         when exists (select 1 from (values (f.w,f.h,f.d),(f.h,f.w,f.d),(f.d,f.h,f.w),(f.h,f.d,f.w),(f.w,f.d,f.h),(f.d,f.w,f.h)) p(a, b, along)
                       where p.a <= c.cargo_w_in and p.b <= c.cargo_h_in and p.along <= c.cargo_d_in) then 'fits'
         when exists (select 1 from (values (f.w,f.h,f.d),(f.h,f.w,f.d),(f.d,f.h,f.w),(f.h,f.d,f.w),(f.w,f.d,f.h),(f.d,f.w,f.h)) p(a, b, along)
                       where p.a <= c.cargo_w_in and p.b <= c.cargo_h_in and p.along <= c.seats_folded_d_in) then 'seats_folded'
         else 'too_big' end as car_fit
  from costed f left join car c on true
  where $4::float8 is null or f.total <= $4::float8
),
scored as (
  select f.*,
    0.6 * coalesce(f.vec_sim, f.kw_sim)
    + 0.4 * (1 - coalesce(f.total / nullif(max(f.total) over (), 0), 0))
    + case when f.demo_pin then ${DEMO_PIN_BOOST} else 0 end
    + case when f.asset_status = 'ready' and not f.is_approx_model then ${REAL_MODEL_BOOST} else 0 end
    - case when f.car_fit = 'too_big' then ${TOO_BIG_PENALTY} else 0 end as score
  from fit f
),
ranked as (
  select s.*, row_number() over (partition by s.category order by s.score desc, s.id) as cat_rank from scored s
)
select * from ranked
order by case when $17::bool then cat_rank else 0 end, score desc, id
limit $16::int`;

export function searchParams(f: SearchArgs, origin: Origin, embedding: number[] | null, fuel: number, limit = RESULT_LIMIT) {
  return [
    origin.lat, origin.lng, f.categories, f.max_total_usd, maxRoadMiles(f), f.ships_ok, f.has_car,
    embedding ? toVector(embedding) : null, styleWords(f.style_text),
    f.max_w_in, f.max_d_in, f.max_h_in, f.has_car ? f.car_make_model : null, fuel, f.free_only, limit,
    f.categories.length > 1, f.ships_only,
  ];
}

export function rowToCard(row: any, now = new Date()): Card {
  return toCard(row as RawItem, {
    mode: row.mode, total: Number(row.total), extra: Math.round((Number(row.total) - Number(row.price)) * 100) / 100,
    road_mi: row.road_mi == null ? null : Number(row.road_mi),
    car_fit: row.car_fit ?? null, car_name: row.car_name ?? null, score: Number(row.score ?? 0),
  }, now);
}

export async function searchListingsSql(
  f: SearchArgs, origin: Origin, embedding: number[] | null, fuel: number,
  opts: { branch?: Branch; limit?: number } = {},
): Promise<Card[]> {
  const rows = await query(SEARCH_SQL, searchParams(f, origin, embedding, fuel, opts.limit), {
    branch: opts.branch ?? readBranch(),
  });
  return rows.map((r) => rowToCard(r));
}

/** Raw items by id (any asset status) for /item/[id], the agent tools and the snapshot builder. */
export async function fetchRawItems(ids: number[] | 'all-with-models', branch: Branch = readBranch()): Promise<RawItem[]> {
  const where = ids === 'all-with-models' ? `a.status = 'ready' and not coalesce(a.is_approx_model, false) and l.is_active` : `l.id = any($1::bigint[])`;
  const rows = await query(
    `select ${ITEM_COLUMNS}, nb.median_usd::float8 as baseline_usd
       from listings l
       join listing_details d on d.listing_id = l.id
       left join assets a on a.listing_id = l.id
       ${BASELINE_JOIN}
      where ${where}
      order by l.demo_pin desc, l.id
      limit 300`,
    ids === 'all-with-models' ? [] : [ids],
    { branch },
  );
  return rows.map((r) => ({ ...r, scraped_at: new Date(r.scraped_at).toISOString() })) as RawItem[];
}

export async function fetchCars(branch: Branch = readBranch()): Promise<Car[]> {
  const rows = await query(
    `select make_model, cargo_w_in::float8 as cargo_w_in, cargo_h_in::float8 as cargo_h_in,
            cargo_d_in::float8 as cargo_d_in, seats_folded_d_in::float8 as seats_folded_d_in from cars order by 1`,
    [], { branch },
  );
  return rows as Car[];
}
