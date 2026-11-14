-- Distance, total cost and delivery for result cards (spec 7, "Distance and drive time" / totalCost).
-- One definition in the database so the search route, the cards and the spoken reply never disagree.
-- Idempotent.
--
--   select * from listing_cards(32.8801, -117.2376)                 -- origin = UCSD Price Center
--   where category = any('{side_table,desk_lamp}') and total_usd <= 40
--     and (ships or est_miles <= 10)
--   order by embedding <=> $1::vector limit 20;
--
-- All distances are estimates: marketplace locations are city or neighbourhood level, so the UI shows "~".
-- 138 of 181 Marketplace listings (Nov 14) say only "San Diego, CA": loc_precise = false for those.

-- straight-line (haversine) miles x 1.3 road factor; null when either point is unknown
create or replace function est_miles(lat1 double precision, lng1 double precision,
                                     lat2 double precision, lng2 double precision)
returns double precision language sql immutable parallel safe as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null else
    2 * 3958.8 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))) * 1.3 end
$$;

drop function if exists listing_cards(double precision, double precision, numeric);
create or replace function listing_cards(origin_lat double precision, origin_lng double precision,
                                         fuel_usd_per_mile numeric default 0.15)
returns table (
  id bigint, source text, url text, title text, city text, photo_url text,
  price_usd numeric, shipping_usd numeric, ships boolean,
  can_pickup boolean,               -- has a location we can drive to
  est_miles numeric,                -- ~road miles from the origin (null when it only ships)
  est_drive_min int,                -- at an average 25 mph
  pickup_cost_est numeric,          -- round trip x fuel cost per mile, "est."
  total_ship_usd numeric,           -- price + shipping (null if it does not ship)
  total_pickup_usd numeric,         -- price + estimated pickup cost (null if no location)
  total_usd numeric,                -- the cheaper of the two: what the card shows
  delivery text,                    -- 'pickup' | 'ships' (the cheaper way)
  category text, style_tags text[], condition text,
  w_in numeric, d_in numeric, h_in numeric, dims_source text, weight_lb_est numeric,
  summary text, embedding vector(768),
  asset_status text, ar_ready boolean, usdz_url text, glb_url text, is_approx_model boolean,
  posted_at timestamptz, demo_pin boolean,
  loc_precise boolean               -- false: the listing only says "San Diego" (a big city), so est_miles is a
                                    -- guess from downtown; show "San Diego, area unknown" instead of a distance
) language sql stable as $$
  with base as (
    select l.*, d.category, d.style_tags, d.condition, d.w_in, d.d_in, d.h_in, d.dims_source, d.weight_lb_est,
           d.summary, d.embedding, d.best_photo_idx,
           a.status::text as asset_status, a.usdz_url, a.glb_url, a.is_approx_model,
           est_miles(origin_lat, origin_lng, l.lat, l.lng) as mi
    from listings l
    join listing_details d on d.listing_id = l.id
    left join assets a on a.listing_id = l.id
    where l.is_active and d.model_used not like 'none:%'
  ), costed as (
    select b.*,
           case when b.ships and b.shipping_usd is not null then b.price_usd + b.shipping_usd end as t_ship,
           case when b.mi is not null and b.source <> 'ebay'
                then b.price_usd + round((2 * b.mi * fuel_usd_per_mile)::numeric, 2) end as t_pick
    from base b
  )
  select c.id, c.source, c.url, c.title, c.city,
         coalesce(c.photo_urls[c.best_photo_idx + 1], c.photo_urls[1]),
         c.price_usd, c.shipping_usd, c.ships,
         c.t_pick is not null,
         case when c.t_pick is not null then round(c.mi::numeric, 1) end,
         case when c.t_pick is not null then ceil(c.mi / 25.0 * 60)::int end,
         case when c.t_pick is not null then round((2 * c.mi * fuel_usd_per_mile)::numeric, 2) end,
         c.t_ship, c.t_pick,
         least(c.t_ship, c.t_pick),
         case when c.t_pick is null then 'ships' when c.t_ship is null or c.t_pick <= c.t_ship then 'pickup' else 'ships' end,
         c.category, c.style_tags, c.condition, c.w_in, c.d_in, c.h_in, c.dims_source, c.weight_lb_est,
         c.summary, c.embedding,
         c.asset_status, coalesce(c.asset_status in ('ready', 'fallback_ready') and c.usdz_url is not null, false),
         c.usdz_url, c.glb_url, c.is_approx_model,
         c.posted_at, c.demo_pin,
         c.lat is not null and lower(regexp_replace(coalesce(c.city, ''), '[^a-zA-Z]', '', 'g'))
           not in ('sandiego', 'sandiegoca', 'sandiegocalifornia', '')
  from costed c
  where c.t_ship is not null or c.t_pick is not null      -- no honest total = not shown
$$;
