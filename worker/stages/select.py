"""Stage: select (spec 6.3). Queue an asset for every eligible_3d listing.

Order: demo_pin first, then ships or under 10 miles, then newest. The queue is drained in
updated_at order, so the order is encoded there.
"""
from __future__ import annotations

import logging

from ..context import Ctx

log = logging.getLogger("worker.select")

SQL = """
with ranked as (
  select l.id,
         row_number() over (
           order by l.demo_pin desc,
                    (l.ships or (l.lat is not null and
                       2 * 3958.8 * asin(sqrt(
                         power(sin(radians(l.lat - %(lat)s) / 2), 2) +
                         cos(radians(%(lat)s)) * cos(radians(l.lat)) * power(sin(radians(l.lng - %(lng)s) / 2), 2)
                       )) * 1.3 < 10)) desc,
                    coalesce(l.posted_at, l.scraped_at) desc, l.id
         ) as rn
  from listings l
  join listing_details d on d.listing_id = l.id
  left join assets a on a.listing_id = l.id
  where d.eligible_3d and l.is_active and a.listing_id is null
)
insert into assets (listing_id, status, updated_at)
select id, 'queued', now() + (rn * interval '1 millisecond') from ranked order by rn limit %(limit)s
on conflict (listing_id) do nothing
returning listing_id
"""

# A listing that got pinned after it fell back to a generic model deserves a real one.
UPGRADE_PINNED = """
update assets a set status = 'gen_pending', provider = null, provider_job = null, attempts = 0,
       gen_state = coalesce(a.gen_state, '{}'::jsonb) - 'tried' || '{"upgrade": true}'::jsonb,
       next_attempt_at = null, updated_at = now() - interval '1 hour'
from listings l
where l.id = a.listing_id and l.demo_pin and a.status = 'fallback_ready' and a.provider = 'generic'
  and a.cutout_url is not null and not coalesce((a.gen_state->>'upgrade')::boolean, false)
returning a.listing_id
"""


def run(ctx: Ctx, limit: int = 200) -> int:
    s = ctx.settings
    rows = ctx.db.q(SQL, {"lat": s.origin_lat, "lng": s.origin_lng, "limit": limit})
    for r in rows:
        ctx.db.event(r["listing_id"], None, "queued", "eligible for 3D")
    up = ctx.db.q(UPGRADE_PINNED)
    for r in up:
        ctx.db.event(r["listing_id"], "fallback_ready", "gen_pending", "pinned for the demo: trying a real 3D model")
    if rows or up:
        log.info("queued %d new assets, %d pinned upgrades", len(rows), len(up))
    return len(rows) + len(up)
