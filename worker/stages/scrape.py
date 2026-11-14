"""Stage: scrape (spec 6.1). Never blocks: each call either triggers a job, polls one, or ingests one.

Sources:
  fb_marketplace  Bright Data Marketplace scraper, discover_by=url with San Diego search URLs
  ebay            Bright Data eBay scraper, discover_by=keywords (used items only, filtered on ingest)
  craigslist      Web Unlocker fetch of the San Diego furniture search pages, parsed locally
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from ..config import SEARCH_KEYWORDS
from ..context import Ctx
from ..db import jsonb
from ..limits import ProviderError, QuotaExceeded
from ..normalize import Skip, normalize, normalize_craigslist, parse_craigslist_search

log = logging.getLogger("worker.scrape")
MAX_PRICE_USD = 600
JOB_TIMEOUT_MIN = 60

CRAIGSLIST_PAGES = [
    ("https://sandiego.craigslist.org/search/fuo?hasPic=1&max_price=200", False),   # furniture by owner
    ("https://sandiego.craigslist.org/search/zip?hasPic=1&query=table%7Cchair%7Clamp%7Cdresser%7Cshelf%7Cdesk%7Cstool%7Cottoman%7Cnightstand", True),  # free
    ("https://sandiego.craigslist.org/search/fuo?hasPic=1&max_price=200&query=lamp%7Cstool%7Cnightstand%7Cside+table", False),
]

UPSERT = """
insert into listings (source, external_id, url, title, description, price_usd, shipping_usd, ships,
                      city, lat, lng, photo_urls, raw, posted_at)
values (%(source)s, %(external_id)s, %(url)s, %(title)s, %(description)s, %(price_usd)s, %(shipping_usd)s,
        %(ships)s, %(city)s, %(lat)s, %(lng)s, %(photo_urls)s, %(raw)s, %(posted_at)s)
on conflict (source, external_id) do update set
  url = excluded.url, title = excluded.title,
  description = coalesce(excluded.description, listings.description),
  price_usd = excluded.price_usd, shipping_usd = excluded.shipping_usd, ships = excluded.ships,
  city = coalesce(excluded.city, listings.city),
  lat = coalesce(excluded.lat, listings.lat), lng = coalesce(excluded.lng, listings.lng),
  -- keep photos we already mirrored to Blob (marketplace CDN links expire)
  photo_urls = case when exists (select 1 from unnest(listings.photo_urls) u where u like '%%blob.vercel-storage.com%%')
                    then listings.photo_urls else excluded.photo_urls end,
  raw = excluded.raw, posted_at = coalesce(excluded.posted_at, listings.posted_at),
  scraped_at = now(), is_active = true
returning (xmax = 0) as inserted
"""


def fb_inputs() -> list[dict]:
    return [{"url": f"https://www.facebook.com/marketplace/sandiego/search/?query={quote(k)}"} for k in SEARCH_KEYWORDS]


def ebay_inputs() -> list[dict]:
    return [{"keywords": f"used {k}"} for k in SEARCH_KEYWORDS]


def ingest(ctx: Ctx, source: str, records: list[dict], cap: int | None = None, **norm_kw) -> dict:
    """Normalize + upsert on (source, external_id). Idempotent. One bad record never stops the batch."""
    cap = cap or ctx.settings.scrape_cap_per_source
    stats = {"seen": len(records), "inserted": 0, "updated": 0, "skipped": 0, "errors": 0}
    seen_ids: set[str] = set()
    for rec in records:
        if stats["inserted"] + stats["updated"] >= cap:
            break
        try:
            row = normalize_craigslist(rec, **norm_kw) if source == "craigslist" else normalize(source, rec)
            if row["external_id"] in seen_ids:
                continue
            if row["price_usd"] is None or row["price_usd"] > MAX_PRICE_USD:
                raise Skip("no price or over budget range")
            seen_ids.add(row["external_id"])
            row["raw"] = jsonb(row["raw"])
            res = ctx.db.one(UPSERT, row)
            stats["inserted" if res and res["inserted"] else "updated"] += 1
        except Skip:
            stats["skipped"] += 1
        except Exception as e:  # noqa: BLE001
            stats["errors"] += 1
            ctx.db.error(f"worker.scrape.{source}", f"record failed: {e}", code="normalize")
    return stats


def _dataset_step(ctx: Ctx, source: str, dataset_id: str, inputs: list[dict], discover_by: str) -> int:
    db, s = ctx.db, ctx.settings
    job = db.one("select * from scrape_jobs where source=%s and kind='listings' and status='running' "
                 "order by triggered_at desc limit 1", (source,))
    if job:
        age = datetime.now(timezone.utc) - job["triggered_at"]
        try:
            prog = ctx.bd.progress(job["snapshot_id"])
        except ProviderError as e:
            db.error(f"worker.scrape.{source}", f"progress failed: {e}", code="progress")
            return 0
        status = prog.get("status")
        if status == "ready":
            try:
                records = ctx.bd.download(job["snapshot_id"])
            except ProviderError as e:
                if e.retryable:
                    return 0             # snapshot still being built: next cycle
                db.x("update scrape_jobs set status='failed', note=%s, finished_at=now() where id=%s", (str(e)[:300], job["id"]))
                db.error(f"worker.scrape.{source}", f"download failed: {e}", code="download")
                return 0
            stats = ingest(ctx, source, records)
            db.x("update scrape_jobs set status='ingested', records=%s, note=%s, finished_at=now() where id=%s",
                 (stats["inserted"] + stats["updated"], str(stats), job["id"]))
            log.info("%s ingested: %s", source, stats)
            return stats["inserted"] + stats["updated"]
        if status == "failed" or age > timedelta(minutes=JOB_TIMEOUT_MIN):
            # scrape job error: keep the old data and retry next cycle (spec 14)
            db.x("update scrape_jobs set status='failed', note=%s, finished_at=now() where id=%s",
                 (f"status={status} after {age}", job["id"]))
            db.error(f"worker.scrape.{source}", f"job {job['snapshot_id']} {status} after {age}", code="job_failed")
        return 0

    last = db.one("select triggered_at from scrape_jobs where source=%s and kind='listings' order by triggered_at desc limit 1", (source,))
    if last and datetime.now(timezone.utc) - last["triggered_at"] < timedelta(minutes=s.scrape_min_interval_min):
        return 0                          # at most 1 job per source per 30 min
    if not dataset_id:
        return 0
    try:
        ctx.limits.acquire("brightdata", per_minute=10, per_day=200)
        per_input = max(1, s.scrape_cap_per_source // len(inputs))
        sid = ctx.limits.with_retry(lambda: ctx.bd.trigger(dataset_id, inputs, discover_by=discover_by,
                                                           limit_per_input=per_input), pname="brightdata")
    except (ProviderError, QuotaExceeded) as e:
        db.error(f"worker.scrape.{source}", f"trigger failed: {e}", code="trigger")
        # record the attempt so a broken source is retried on the normal 30 min cadence, not every loop
        db.x("insert into scrape_jobs (source, kind, status, note, finished_at) values (%s,'listings','failed',%s,now())",
             (source, str(e)[:300]))
        return 0
    db.x("insert into scrape_jobs (source, kind, snapshot_id, input) values (%s,'listings',%s,%s)",
         (source, sid, jsonb(inputs)))
    log.info("%s job triggered: %s (%d inputs)", source, sid, len(inputs))
    return 0


def _craigslist_step(ctx: Ctx) -> int:
    db, s = ctx.db, ctx.settings
    if not s.bd_zone:
        return 0                          # no Web Unlocker zone configured: source disabled
    last = db.one("select triggered_at from scrape_jobs where source='craigslist' order by triggered_at desc limit 1")
    if last and datetime.now(timezone.utc) - last["triggered_at"] < timedelta(minutes=s.scrape_min_interval_min):
        return 0
    total = 0
    notes = []
    for url, free in CRAIGSLIST_PAGES:
        if ctx.stop.is_set():
            break
        try:
            ctx.limits.acquire("brightdata", per_minute=10, per_day=200)
            html = ctx.limits.with_retry(lambda u=url: ctx.bd.unlock(u), pname="brightdata", tries=3)
            recs = parse_craigslist_search(html)
            if not recs:
                raise ProviderError("0 results parsed (page layout changed or blocked)")
            stats = ingest(ctx, "craigslist", recs, cap=s.scrape_cap_per_source - total, free_section=free)
            total += stats["inserted"] + stats["updated"]
            notes.append(str(stats))
        except (ProviderError, QuotaExceeded) as e:
            db.error("worker.scrape.craigslist", f"{url}: {e}", code="unlock")
            notes.append(f"error: {e}"[:120])
    db.x("insert into scrape_jobs (source, kind, status, records, note, finished_at) values ('craigslist','listings',%s,%s,%s,now())",
         ("ingested" if total else "failed", total, "; ".join(notes)[:500]))
    return total


def run(ctx: Ctx) -> int:
    s = ctx.settings
    n = 0
    for source, fn in (
        ("fb_marketplace", lambda: _dataset_step(ctx, "fb_marketplace", s.bd_fb, fb_inputs(), "url")),
        ("ebay", lambda: _dataset_step(ctx, "ebay", s.bd_ebay, ebay_inputs(), "keywords")),
        ("craigslist", lambda: _craigslist_step(ctx)),
    ):
        if ctx.stop.is_set():
            break
        try:
            n += fn()
        except Exception as e:  # noqa: BLE001 - one source failing never blocks the others
            ctx.db.error(f"worker.scrape.{source}", f"unexpected: {e!r}", code="unexpected")
    return n
