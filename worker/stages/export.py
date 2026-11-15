"""Stage: export (spec 6.5). GLB -> headless Chromium + three.js -> USDZ + true-scale GLB -> validate -> Blob."""
from __future__ import annotations

import logging

from ..context import Ctx
from ..exporter_driver import ExportError
from ..limits import ProviderError
from ..orient import dims_match_listing, priors
from ..storage import GLB_MIME, USDZ_MIME
from ..usd_validate import validate_usdz

log = logging.getLogger("worker.export")


class InvalidModel(Exception):
    pass


def export_one(ctx: Ctx, asset: dict) -> None:
    db, s, lid = ctx.db, ctx.settings, asset["listing_id"]
    d = db.one("select category, w_in, d_in, h_in, dims_source, dims_from_text from listing_details where listing_id=%s", (lid,))
    if not d:
        raise InvalidModel("listing has no details")
    state = dict(asset.get("gen_state") or {})
    # Re-exports (orient_override changed in /admin) must start from the raw model, not from our own
    # already-processed GLB. A GLB uploaded by hand through /admin replaces glb_url and becomes the new raw.
    if asset.get("glb_url") and asset["glb_url"] != state.get("processed_glb_url"):
        state["raw_glb_url"] = asset["glb_url"]
    raw_url = state.get("raw_glb_url") or asset.get("glb_url")
    if not raw_url:
        raise InvalidModel("no GLB to export")
    glb = ctx.storage.get(raw_url)
    if asset.get("provider") == "manual":
        # hand-made models uploaded through /admin skip scripts.import_model's shrink: do it here
        # (a no-op for models already under budget)
        from ..shrink import ShrinkError, shrink_glb
        try:
            glb, stats = shrink_glb(glb)
            if stats.get("triangles_before") != stats.get("triangles_after"):
                log.info("listing %s: manual model shrunk %s", lid, stats)
        except ShrinkError as e:
            log.warning("listing %s: could not shrink manual model (%s); exporting as is", lid, e)

    f = lambda v: float(v) if v is not None else None  # noqa: E731
    w_in, d_in, h_in = f(d["w_in"]), f(d["d_in"]), f(d["h_in"])
    params = dict(w_in=w_in, d_in=d_in, h_in=h_in, category=d["category"],
                  # the tagger's original verdict: a previous export may have downgraded dims_source for the UI
                  dims_source="listing_text" if d["dims_from_text"] else "estimated",
                  orient_override=asset.get("orient_override"), yaw_deg=f(asset.get("yaw_override_deg")))
    approx = asset.get("provider") == "generic"
    if asset.get("provider") == "hf" and not params["orient_override"]:
        # TRELLIS always returns the object upright (y-up, from an upright photo). Guessed dimensions are not a
        # good enough reason to turn it: a square side table "estimated" wider than tall got tipped on its side.
        params["orient_override"] = "identity"
    if approx:
        # our own generic models are built upright: never auto-rotate them, and stretch the footprint
        # to the listing's W x D so the space they take up in AR is honest
        params["orient_override"] = params["orient_override"] or "identity"
        params["fit_box"] = True
    target_h = h_in or priors().get(d["category"], priors()["other"])[2]

    res = None
    for max_tex in (1024, 512, 256):                      # keep the file under 15 MB
        try:
            res = ctx.exporter.export_item(glb, max_texture=max_tex, **params)
        except ExportError as e:
            raise InvalidModel(str(e)) from e
        if len(res.usdz) <= s.max_file_mb * 1024 * 1024:
            break
    assert res is not None
    rep = validate_usdz(res.usdz, expect_w_in=res.final_w_in, expect_d_in=res.final_d_in, expect_h_in=target_h,
                        tol_in=0.5, max_mb=s.max_file_mb)
    if not rep.ok:
        raise InvalidModel("USDZ validation failed: " + "; ".join(rep.errors[:3]))

    version = (asset.get("version") or 1) + (1 if asset.get("usdz_url") else 0)
    usdz_url = ctx.storage.put(f"usdz/{lid}-v{version}.usdz", res.usdz, USDZ_MIME)
    glb_url = ctx.storage.put(f"glb/{lid}-v{version}.glb", res.glb, GLB_MIME)
    state["processed_glb_url"] = glb_url
    state["export"] = {"orientation_scores": res.info.get("orientation_scores"), "used_prior": res.info.get("used_prior"),
                       "stats": res.info.get("stats"), "textures": len(rep.textures), "warnings": rep.warnings[:3]}

    # Spec 6.5 step 5: if the model's W or D is more than 2 in off the listing, dimensions are 'estimated'.
    if d["dims_source"] == "listing_text" and not approx and not dims_match_listing(res.final_w_in, res.final_d_in, w_in, d_in):
        db.x("update listing_details set dims_source = 'estimated' where listing_id = %s", (lid,))

    # report W/D in the same order as the listing (the model may sit turned 90 degrees)
    fw, fd = res.final_w_in, res.final_d_in
    if w_in and d_in and (w_in >= d_in) != (fw >= fd):
        fw, fd = fd, fw
    db.advance(lid, "exporting", "fallback_ready" if approx else "ready",
               f"USDZ {len(res.usdz) // 1024} KB, {fw:.1f} x {fd:.1f} x {res.final_h_in:.1f} in, orient {res.orientation}",
               usdz_url=usdz_url, glb_url=glb_url, is_approx_model=approx, version=version,
               final_w_in=round(fw, 1), final_d_in=round(fd, 1), final_h_in=round(res.final_h_in, 1),
               orientation_used=res.orientation, file_bytes=len(res.usdz), gen_state=state, last_error=None)


def _next_provider_or_fail(ctx: Ctx, asset: dict, reason: str) -> None:
    """Invalid GLB / exporter validation failure -> next provider, then generic fallback (spec 14)."""
    db, lid = ctx.db, asset["listing_id"]
    provider = asset.get("provider") or "unknown"
    if provider in ("generic",):
        db.fail(lid, "exporting", "worker.export", f"generic model failed to export: {reason}", permanent=True,
                code="export_invalid")
        return
    state = dict(asset.get("gen_state") or {})
    state["tried"] = sorted(set(state.get("tried", [])) | {provider})
    state.pop("raw_glb_url", None)
    db.error("worker.export", f"{provider} model rejected: {reason}", listing_id=lid, code="export_invalid")
    if provider == "manual" or not asset.get("cutout_url"):
        # nothing to regenerate from: dead-letter so a human sees it on the board
        db.fail(lid, "exporting", "worker.export", f"{provider} model rejected: {reason}", permanent=True)
        return
    db.advance(lid, "exporting", "gen_pending", f"{provider} model rejected ({reason[:120]}): trying next provider",
               provider=None, provider_job=None, glb_url=None, gen_state=state, last_error=reason[:1000])


def run(ctx: Ctx, batch: int = 3) -> int:
    db, s = ctx.db, ctx.settings
    db.reclaim_stale("exporting", "gen_done", s.lock_minutes)
    done = 0
    for _ in range(batch):
        if ctx.stop.is_set():
            break
        asset = db.claim("gen_done", "exporting", lock_minutes=s.lock_minutes, count_attempt=False)
        if not asset:
            break
        lid = asset["listing_id"]
        try:
            export_one(ctx, asset)
            done += 1
        except InvalidModel as e:
            _next_provider_or_fail(ctx, asset, str(e))
        except ProviderError as e:               # storage / download trouble: retry the export later
            db.fail(lid, "exporting", "worker.export", str(e), retry_to="gen_done" if e.retryable else None,
                    max_attempts=s.max_attempts + 2, code="storage")
        except Exception as e:  # noqa: BLE001
            db.fail(lid, "exporting", "worker.export", f"unexpected: {e!r}", retry_to="gen_done",
                    max_attempts=s.max_attempts + 2, code="unexpected")
    return done
