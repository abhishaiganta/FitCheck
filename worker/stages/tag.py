"""Stage: tag (spec 6.2). Gemini vision -> listing_details, then embeddings in one batch call."""
from __future__ import annotations

import io
import logging

from ..context import Ctx
from ..db import jsonb, vec
from ..limits import ProviderError, QuotaExceeded
from ..storage import fetch_bytes
from ..tagging import content_hash, embed_text

log = logging.getLogger("worker.tag")
BATCH = 12
MAX_PHOTOS = 3
PHOTO_MAX_PX = 768

UPSERT = """
insert into listing_details (listing_id, category, style_tags, condition, w_in, d_in, h_in, dims_source,
    weight_lb_est, best_photo_idx, photo_ok, eligible_3d, summary, views, content_hash, model_used, dims_from_text, tagged_at)
values (%(listing_id)s, %(category)s, %(style_tags)s, %(condition)s, %(w_in)s, %(d_in)s, %(h_in)s, %(dims_source)s,
    %(weight_lb_est)s, %(best_photo_idx)s, %(photo_ok)s, %(eligible_3d)s, %(summary)s, %(views)s, %(content_hash)s,
    %(model_used)s, %(dims_source)s = 'listing_text', now())
on conflict (listing_id) do update set
    category = excluded.category, style_tags = excluded.style_tags, condition = excluded.condition,
    w_in = excluded.w_in, d_in = excluded.d_in, h_in = excluded.h_in, dims_source = excluded.dims_source,
    weight_lb_est = excluded.weight_lb_est, best_photo_idx = excluded.best_photo_idx, photo_ok = excluded.photo_ok,
    eligible_3d = excluded.eligible_3d, summary = excluded.summary, views = excluded.views,
    content_hash = excluded.content_hash, model_used = excluded.model_used,
    dims_from_text = excluded.dims_from_text, tagged_at = now(), embedding = null
"""


def shrink_photo(data: bytes, max_px: int = PHOTO_MAX_PX) -> tuple[bytes, str]:
    """Small JPEG for the vision request (fewer tokens, faster)."""
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=82)
    return buf.getvalue(), "image/jpeg"


def _untaggable(ctx: Ctx, listing: dict, chash: str, reason: str) -> None:
    """Record why a listing could not be tagged, so it is not retried forever."""
    ctx.db.x(UPSERT, {
        "listing_id": listing["id"], "category": "other", "style_tags": [], "condition": None,
        "w_in": None, "d_in": None, "h_in": None, "dims_source": "estimated", "weight_lb_est": None,
        "best_photo_idx": 0, "photo_ok": False, "eligible_3d": False, "summary": listing["title"][:200],
        "views": jsonb([]), "content_hash": chash, "model_used": f"none:{reason}"[:60]})


def tag_one(ctx: Ctx, listing: dict) -> bool:
    db = ctx.db
    photos_urls = (listing["photo_urls"] or [])[:MAX_PHOTOS]
    chash = content_hash(listing["title"], listing["description"], photos_urls[0] if photos_urls else None)

    # cache: identical content (cross-posts, re-scrapes) is never sent to Gemini twice
    twin = db.one("""select d.* from listing_details d where d.content_hash = %s and d.listing_id <> %s
                     and d.model_used not like 'none:%%' limit 1""", (chash, listing["id"]))
    if twin:
        row = {k: twin[k] for k in ("category", "style_tags", "condition", "w_in", "d_in", "h_in", "dims_source",
                                    "weight_lb_est", "best_photo_idx", "photo_ok", "eligible_3d", "summary")}
        row.update(listing_id=listing["id"], views=jsonb(twin["views"] or []), content_hash=chash,
                   model_used=f"cache:{twin['model_used']}"[:60])
        db.x(UPSERT, row)
        return True

    photos: list[tuple[bytes, str]] = []
    kept_idx: list[int] = []
    for i, url in enumerate(photos_urls):
        try:
            photos.append(shrink_photo(fetch_bytes(url, timeout=30, max_mb=25)))
            kept_idx.append(i)
        except Exception as e:  # noqa: BLE001 - a dead photo link is normal for old listings
            log.info("listing %s photo %d unavailable: %s", listing["id"], i, e)
    if not photos:
        _untaggable(ctx, listing, chash, "photo_unavailable")
        db.error("worker.tag", "no photo could be downloaded", listing_id=listing["id"], code="photo_unavailable")
        return False

    fields, model = ctx.gemini.tag(title=listing["title"], description=listing["description"],
                                   price=float(listing["price_usd"]) if listing["price_usd"] is not None else None,
                                   photos=photos)
    # map indexes back to the listing's own photo order (some photos may have failed to download)
    remap = dict(enumerate(kept_idx))
    fields["best_photo_idx"] = remap.get(fields["best_photo_idx"], kept_idx[0])
    for v in fields["views"]:
        v["photo_idx"] = remap.get(v["photo_idx"], v["photo_idx"])
    fields.update(listing_id=listing["id"], views=jsonb(fields["views"]), content_hash=chash, model_used=model)
    db.x(UPSERT, fields)
    return True


def embed_missing(ctx: Ctx, limit: int = 40) -> int:
    rows = ctx.db.q("""select listing_id, summary, style_tags, category from listing_details
                       where embedding is null and model_used not like 'none:%%' order by tagged_at limit %s""", (limit,))
    if not rows:
        return 0
    vectors = ctx.gemini.embed([embed_text(r) for r in rows])
    for r, v in zip(rows, vectors):
        ctx.db.x("update listing_details set embedding = %s::vector where listing_id = %s", (vec(v), r["listing_id"]))
    return len(rows)


def run(ctx: Ctx, batch: int = BATCH) -> int:
    db = ctx.db
    if not ctx.settings.gemini_keys:
        return 0
    listings = db.q("""
        select l.id, l.title, l.description, l.price_usd, l.photo_urls
        from listings l left join listing_details d on d.listing_id = l.id
        where d.listing_id is null and l.is_active
        order by l.demo_pin desc, l.scraped_at desc, l.id limit %s""", (batch,))
    done = 0
    for listing in listings:
        if ctx.stop.is_set():
            break
        try:
            done += 1 if tag_one(ctx, listing) else 0
        except QuotaExceeded as e:
            log.info("gemini quota reached, tagging pauses: %s", e)
            break
        except ProviderError as e:
            db.error("worker.tag", str(e), listing_id=listing["id"], code="tag_api")
            if e.status in (400, 401, 403, 404):
                # configuration problem (wrong model id, bad key): the same call would fail for every
                # listing, so stop this batch instead of burning quota. Nothing is parked.
                log.error("tagging stopped: fix GEMINI_MODEL_VISION / GEMINI_API_KEYS (%s)", e)
                break
        except ValueError as e:
            # the model returned JSON we cannot use: retried next cycle, parked after 3 bad answers
            db.error("worker.tag", str(e), listing_id=listing["id"], code="tag_invalid")
            fails = db.one("select count(*) n from error_log where where_='worker.tag' and code='tag_invalid' and listing_id=%s",
                           (listing["id"],))
            if fails and fails["n"] >= 3:
                _untaggable(ctx, listing, content_hash(listing["title"], listing["description"],
                                                       (listing["photo_urls"] or [None])[0]), "tag_invalid")
        except Exception as e:  # noqa: BLE001
            db.error("worker.tag", f"unexpected: {e!r}", listing_id=listing["id"], code="unexpected")
    try:
        embed_missing(ctx)
    except QuotaExceeded as e:
        log.info("embedding quota reached: %s", e)
    except (ProviderError, ValueError) as e:
        db.error("worker.tag.embed", str(e), code="embed_failed")
    return done
