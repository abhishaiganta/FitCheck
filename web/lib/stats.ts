import { query } from './db';
import { providerHealth } from './limits';

const STATUSES = ['queued', 'cutout', 'gen_pending', 'gen_done', 'exporting', 'ready', 'fallback_ready', 'failed'] as const;

/** Pipeline board data. Always the main branch, so judges see the worker live even in DEMO_MODE. */
export async function getPipeline() {
  const o = { branch: 'main' as const, timeoutMs: 6000 };
  const [counts, events, totals, health, errors] = await Promise.all([
    query<{ status: string; n: number }>('select status::text as status, count(*)::int as n from assets group by 1', [], o),
    query<{ id: number; listing_id: number | null; from_status: string | null; to_status: string; note: string | null; at: string; title: string | null; provider: string | null }>(
      `select e.id::int as id, e.listing_id::int as listing_id, e.from_status, e.to_status, e.note, e.at, l.title,
              a.provider
         from asset_events e
         left join listings l on l.id = e.listing_id
         left join assets a on a.listing_id = e.listing_id
        order by e.at desc, e.id desc limit 30`, [], o),
    query(
      `select (select count(*) from listings)::int as listings,
              (select count(*) from listing_details)::int as tagged,
              (select count(*) from listing_details where eligible_3d)::int as eligible,
              (select count(*) from assets where status = 'ready' and not is_approx_model)::int as real_models,
              (select count(*) from assets where status = 'fallback_ready' or (status = 'ready' and is_approx_model))::int as approx_models,
              (select count(*) from listings where scraped_at > now() - interval '1 hour')::int as scraped_last_hour,
              (select max(scraped_at) from listings) as last_scrape`, [], o),
    providerHealth().catch(() => []),
    query(
      `select where_, code, message, at from error_log where at > now() - interval '6 hours' order by at desc limit 5`, [], o,
    ).catch(() => []),
  ]);
  const by = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
  const now = Date.now();
  return {
    at: new Date().toISOString(),
    columns: STATUSES.map((s) => ({ status: s, count: by[s] ?? 0 })),
    events: events.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    totals: { ...totals[0], last_scrape: totals[0]?.last_scrape ? new Date(totals[0].last_scrape).toISOString() : null },
    providers: health.map((h) => ({
      provider: h.provider,
      today: Number(h.today),
      cooling: !!h.cooldown_until && new Date(h.cooldown_until).getTime() > now,
      cooldown_until: h.cooldown_until ? new Date(h.cooldown_until).toISOString() : null,
      note: h.note,
    })),
    errors: errors.map((e: any) => ({ ...e, at: new Date(e.at).toISOString() })),
  };
}
export type PipelineData = Awaited<ReturnType<typeof getPipeline>>;

/** Impact dashboard numbers. Everything here is an estimate and the page labels it so. */
export async function getImpactStats() {
  const o = { branch: 'main' as const, timeoutMs: 6000 };
  const [a, b] = await Promise.all([
    query(
      `with item as (
         select l.id, l.price_usd, l.shipping_usd, l.ships, d.category, d.weight_lb_est,
                (select nb.median_usd from new_price_baselines nb where nb.category = d.category and nb.style_key = 'any') as baseline
           from listings l left join listing_details d on d.listing_id = l.id
          where l.is_active
       )
       select count(*)::int as listings,
              count(*) filter (where price_usd = 0)::int as free_items,
              coalesce(sum(greatest(0, baseline - (price_usd + case when ships then coalesce(shipping_usd, 0) else 0 end))), 0)::float8 as savings_available,
              coalesce(sum(weight_lb_est), 0)::float8 as lbs_listed,
              (select count(*) from listings where scraped_at > now() - interval '3 days')::int as indexed_this_weekend,
              (select count(*) from assets where status in ('ready', 'fallback_ready'))::int as models_ready,
              (select count(*) from searches)::int as searches
         from item`, [], o),
    query(
      `select count(*) filter (where kind = 'ar_view')::int as ar_views,
              count(*) filter (where kind = 'listing_open')::int as listing_opens,
              coalesce(sum(dollars_saved_est) filter (where kind = 'listing_open'), 0)::float8 as dollars_saved_opened,
              coalesce(sum(lbs_diverted_est) filter (where kind = 'listing_open'), 0)::float8 as lbs_diverted
         from impact_events`, [], o),
  ]);
  return { at: new Date().toISOString(), ...a[0], ...b[0] } as {
    at: string; listings: number; free_items: number; savings_available: number; lbs_listed: number;
    indexed_this_weekend: number; models_ready: number; searches: number;
    ar_views: number; listing_opens: number; dollars_saved_opened: number; lbs_diverted: number;
  };
}
