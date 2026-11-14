"""Stage: sets (spec 11.1). Arrange 2-4 ready items as one corner and export a single USDZ.

Input: a `sets` row with status 'pending' and its `set_items` (inserted by the web app, the Mastra
furnishCorner workflow, or `python -m scripts.make_set`). Every item needs a finished model (ready or
fallback_ready). The worker uses each item's processed, true-scale GLB, so nothing is re-oriented or
re-scaled here: the layout from worker/arrange.py only moves and turns whole items.
"""
from __future__ import annotations

import logging
import time

from ..arrange import Item, arrange
from ..context import Ctx
from ..storage import GLB_MIME, USDZ_MIME
from ..usd_validate import validate_usdz

log = logging.getLogger("worker.sets")


class SetError(Exception):
    pass


CLAIM = """
update sets set status = 'exporting', updated_at = now()
where id = (select id from sets where status = 'pending'
               or (status = 'exporting' and updated_at < now() - interval '10 minutes')
            order by created_at limit 1 for update skip locked)
returning *
"""


def build(ctx: Ctx, set_row: dict) -> dict:
    db, sid = ctx.db, set_row["id"]
    rows = db.q("""select si.listing_id, si.pos, d.category, a.status::text as status, a.glb_url, a.final_w_in,
                          a.final_d_in, a.final_h_in, a.is_approx_model, l.price_usd, l.shipping_usd, l.ships
                   from set_items si join listings l on l.id = si.listing_id
                   join listing_details d on d.listing_id = si.listing_id
                   left join assets a on a.listing_id = si.listing_id
                   where si.set_id = %s order by si.pos, si.listing_id""", (sid,))
    if not rows:
        raise SetError("the set has no items")
    not_ready = [r["listing_id"] for r in rows if r["status"] not in ("ready", "fallback_ready") or not r["glb_url"]]
    if not_ready:
        raise SetError(f"items without a finished model: {not_ready}")
    items = [Item(r["listing_id"], r["category"], float(r["final_w_in"]), float(r["final_d_in"]),
                  float(r["final_h_in"])) for r in rows]
    try:
        lay = arrange(items)
    except ValueError as e:
        raise SetError(str(e)) from e

    payload = []
    for r, p in zip(rows, lay.placements):
        payload.append({"glb": ctx.storage.get(r["glb_url"]), "w_in": float(r["final_w_in"]),
                        "d_in": float(r["final_d_in"]), "h_in": float(r["final_h_in"]), "category": r["category"],
                        "dims_source": "listing_text", "orient_override": "identity",
                        "x_in": p.x, "y_in": p.y, "z_in": p.z, "yaw_deg": p.yaw})
    res = None
    for max_tex in (1024, 512, 256):
        res = ctx.exporter.export_set(payload, max_texture=max_tex)
        if len(res.usdz) <= ctx.settings.max_file_mb * 1024 * 1024:
            break
    assert res is not None
    rep = validate_usdz(res.usdz, expect_h_in=lay.h, tol_in=0.75, max_mb=ctx.settings.max_file_mb)
    if not rep.ok:
        raise SetError("USDZ validation failed: " + "; ".join(rep.errors[:3]))

    version = int(time.time())           # a new file name per rebuild, so Quick Look never shows a cached set
    usdz_url = ctx.storage.put(f"sets/{sid}-{version}.usdz", res.usdz, USDZ_MIME)
    glb_url = ctx.storage.put(f"sets/{sid}-{version}.glb", res.glb, GLB_MIME)
    for p in lay.placements:
        db.x("""update set_items set x_in = %s, y_in = %s, z_in = %s, yaw_deg = %s, placed = true
                where set_id = %s and listing_id = %s""", (round(p.x, 1), round(p.y, 1), round(p.z, 1), p.yaw, sid, p.listing_id))
    total = sum(float(r["price_usd"] or 0) for r in rows)
    # keep a total the planner already set: it includes shipping / pickup cost, the sum of prices does not
    db.x("""update sets set status = 'ready', usdz_url = %s, glb_url = %s, total_usd = coalesce(total_usd, %s), file_bytes = %s,
            w_in = %s, d_in = %s, h_in = %s, error = null, updated_at = now() where id = %s""",
         (usdz_url, glb_url, round(total, 2), len(res.usdz), lay.w, lay.d, lay.h, sid))
    log.info("set %s ready: %d items, %.0f x %.0f x %.0f in, %d KB", sid, len(rows), lay.w, lay.d, lay.h, len(res.usdz) // 1024)
    return {"id": sid, "usdz_url": usdz_url, "glb_url": glb_url, "w_in": lay.w, "d_in": lay.d, "h_in": lay.h,
            "placements": lay.placements}


def run(ctx: Ctx, batch: int = 2) -> int:
    db = ctx.db
    done = 0
    for _ in range(batch):
        if ctx.stop.is_set():
            break
        row = db.one(CLAIM)
        if not row:
            break
        try:
            build(ctx, row)
            done += 1
        except SetError as e:
            db.x("update sets set status = 'failed', error = %s, updated_at = now() where id = %s", (str(e)[:500], row["id"]))
            db.error("worker.sets", str(e), code="set_failed")
        except Exception as e:  # noqa: BLE001
            # transient (storage, browser): one more try next loop, then failed (row['error'] marks the retry)
            status = "failed" if row.get("error") else "pending"
            db.x("update sets set status = %s, error = %s, updated_at = now() where id = %s", (status, repr(e)[:500], row["id"]))
            db.error("worker.sets", f"set {row['id']}: {e!r}", code="set_retry")
    return done
