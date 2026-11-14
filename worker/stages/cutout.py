"""Stage: cutout (spec 6.3). rembg (u2net) -> crop to the alpha box -> pad 10% -> PNG in Blob."""
from __future__ import annotations

import io
import logging
import os

from ..context import Ctx
from ..db import jsonb
from ..limits import ProviderError
from ..storage import fetch_bytes
from ..tagging import pick_views

log = logging.getLogger("worker.cutout")
MIN_AREA, MAX_AREA = 0.08, 0.95
PAD = 0.10
MAX_INPUT_PX = 1280
OUT_PX = 1024


class BadMask(Exception):
    pass


def _session(ctx: Ctx):
    if ctx._rembg is None:
        from rembg import new_session
        ctx._rembg = new_session("u2net")
    return ctx._rembg


def remove_background(ctx: Ctx, photo: bytes):
    from PIL import Image, ImageOps
    from rembg import remove

    img = ImageOps.exif_transpose(Image.open(io.BytesIO(photo))).convert("RGB")
    img.thumbnail((MAX_INPUT_PX, MAX_INPUT_PX))
    return remove(img, session=_session(ctx))        # RGBA


def crop_and_pad(rgba, *, min_area: float = MIN_AREA, max_area: float = MAX_AREA, pad: float = PAD,
                 out_px: int = OUT_PX) -> tuple[bytes, float]:
    """Crop to the alpha bounding box, pad 10%, return (png bytes, alpha coverage of the source image).
    Raises BadMask when the mask covers under 8% or over 95% of the image."""
    import numpy as np
    from PIL import Image

    alpha = np.asarray(rgba.getchannel("A"))
    solid = alpha > 128
    coverage = float(solid.mean())
    if coverage < min_area:
        raise BadMask(f"mask covers {coverage:.0%} of the photo (under {min_area:.0%}): object too small or not found")
    if coverage > max_area:
        raise BadMask(f"mask covers {coverage:.0%} of the photo (over {max_area:.0%}): background was not removed")
    ys, xs = np.where(solid)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    crop = rgba.crop((x0, y0, x1, y1))
    w, h = crop.size
    side = int(round(max(w, h) * (1 + 2 * pad)))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(crop, ((side - w) // 2, (side - h) // 2), crop)
    if side > out_px:
        canvas = canvas.resize((out_px, out_px), Image.LANCZOS)
    buf = io.BytesIO()
    canvas.save(buf, "PNG", optimize=True)
    return buf.getvalue(), coverage


def process_one(ctx: Ctx, asset: dict) -> None:
    db, lid = ctx.db, asset["listing_id"]
    row = db.one("""select l.photo_urls, d.best_photo_idx, d.views from listings l
                    join listing_details d on d.listing_id = l.id where l.id = %s""", (lid,))
    if not row or not row["photo_urls"]:
        raise BadMask("listing has no photos")
    urls = row["photo_urls"]
    best = row["best_photo_idx"] if 0 <= row["best_photo_idx"] < len(urls) else 0

    # multi-photo mode when >= 2 clean same-object photos from different angles exist (spec 6.4)
    # Opt-in (MULTI_PHOTO=1): in our one live comparison the second photo added an artifact, see NOTES.md.
    multi = pick_views(row["views"] or [], best) if os.getenv("MULTI_PHOTO", "0") == "1" else []
    wanted = multi or [{"photo_idx": best, "angle": "front"}]
    if not any(v["photo_idx"] == best for v in wanted):
        wanted.insert(0, {"photo_idx": best, "angle": "front"})

    views_used: list[dict] = []
    best_cutout = None
    for v in wanted:
        idx = v["photo_idx"]
        if idx >= len(urls):
            continue
        try:
            photo = fetch_bytes(urls[idx], timeout=40, max_mb=25)
            png, cov = crop_and_pad(remove_background(ctx, photo))
        except (BadMask, ProviderError) as e:
            if idx == best:
                raise                                 # the main photo must work (a transient download error is retried)
            log.info("listing %s: dropping extra view %s: %s", lid, idx, e)
            continue
        url = ctx.storage.put(f"cutout/{lid}-{idx}.png", png, "image/png")
        views_used.append({"photo_idx": idx, "angle": v["angle"], "url": url, "coverage": round(cov, 3)})
        if idx == best:
            best_cutout = url
            # marketplace CDN links expire within days: keep our own copy of the main photo
            if ctx.storage.hosted and "blob.vercel-storage.com" not in urls[idx]:
                try:
                    mirror = ctx.storage.put(f"photo/{lid}-{idx}.jpg", _jpeg(photo), "image/jpeg")
                    db.x("update listings set photo_urls[%s] = %s where id = %s", (idx + 1, mirror, lid))
                except Exception as e:  # noqa: BLE001 - mirroring is best effort
                    log.warning("listing %s: photo mirror failed: %s", lid, e)
    if not best_cutout:
        raise BadMask("main photo cutout missing")
    if len(views_used) < 2:
        views_used = [v for v in views_used if v["photo_idx"] == best]
    db.advance(lid, "cutout", "gen_pending", f"cutout ok ({len(views_used)} view{'s' if len(views_used) != 1 else ''})",
               cutout_url=best_cutout, views_used=views_used)


def _jpeg(photo: bytes) -> bytes:
    from PIL import Image, ImageOps

    img = ImageOps.exif_transpose(Image.open(io.BytesIO(photo))).convert("RGB")
    img.thumbnail((1280, 1280))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def run(ctx: Ctx, batch: int = 4) -> int:
    db, s = ctx.db, ctx.settings
    db.reclaim_stale("cutout", "queued", s.lock_minutes)
    done = 0
    for _ in range(batch):
        if ctx.stop.is_set():
            break
        asset = db.claim("queued", "cutout", lock_minutes=s.lock_minutes)
        if not asset:
            break
        lid = asset["listing_id"]
        try:
            process_one(ctx, asset)
            done += 1
        except BadMask as e:
            db.fail(lid, "cutout", "worker.cutout", str(e), code="bad_mask", permanent=True)
        except ProviderError as e:
            db.fail(lid, "cutout", "worker.cutout", str(e), retry_to="queued" if e.retryable else None,
                    max_attempts=s.max_attempts, code="download")
        except Exception as e:  # noqa: BLE001
            db.fail(lid, "cutout", "worker.cutout", f"unexpected: {e!r}", retry_to="queued",
                    max_attempts=s.max_attempts, code="unexpected")
    return done
