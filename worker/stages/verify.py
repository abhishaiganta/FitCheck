"""Stage: verify (pitfall 17: listings sell). Optional, not in the default stage list.

Re-checks demo-pinned Marketplace listings with a synchronous Bright Data fetch (<= 20 URLs) and
marks them inactive when the page is gone or sold. Run it before the demo freeze:

    python -m worker.run --stages verify
"""
from __future__ import annotations

import logging

from ..context import Ctx
from ..limits import ProviderError, QuotaExceeded

log = logging.getLogger("worker.verify")
GONE_CODES = {"dead_page", "not_found", "removed", "page_not_found"}


def is_gone(rec: dict) -> bool:
    if rec.get("is_sold") or rec.get("sold_date"):
        return True
    code = str(rec.get("error_code") or "").lower()
    if code in GONE_CODES:
        return True
    return "isn't available" in str(rec.get("error") or "").lower()


def run(ctx: Ctx, limit: int = 20) -> int:
    db, s = ctx.db, ctx.settings
    rows = db.q("""select id, source, url from listings
                   where is_active and demo_pin and source in ('fb_marketplace','ebay')
                     and (last_checked_at is null or last_checked_at < now() - interval '30 minutes')
                   order by last_checked_at nulls first limit %s""", (limit,))
    changed = 0
    for source, dataset in (("fb_marketplace", s.bd_fb), ("ebay", s.bd_ebay)):
        batch = [r for r in rows if r["source"] == source]
        if not batch or not dataset:
            continue
        try:
            ctx.limits.acquire("brightdata", per_minute=10, per_day=200)
            recs = ctx.bd.scrape_sync(dataset, [{"url": r["url"]} for r in batch])
        except (ProviderError, QuotaExceeded) as e:
            db.error("worker.verify", f"{source}: {e}", code="verify")   # keep the old data, retry next time
            continue
        by_url = {}
        for rec in recs:
            u = (rec.get("input") or {}).get("url") or rec.get("url")
            if u:
                by_url[u.rstrip("/")] = rec
        for r in batch:
            rec = by_url.get(r["url"].rstrip("/"))
            if rec is None:
                continue                               # no answer for this URL: do not guess
            gone = is_gone(rec)
            db.x("update listings set last_checked_at = now(), is_active = %s where id = %s", (not gone, r["id"]))
            if gone:
                changed += 1
                log.info("listing %s is gone (sold or removed): marked inactive", r["id"])
    return changed
