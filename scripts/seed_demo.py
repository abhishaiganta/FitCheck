"""Seed the FAKE fixture rows for Person B (spec section 13, hour-0 handshake).

Exports three sample models (side table, desk lamp, accent chair) through the real exporter, uploads
USDZ (model/vnd.usdz+zip), GLB and a preview photo, then loads db/002_fixtures.sql with those URLs.

    python -m scripts.seed_demo            # load fixtures
    python -m scripts.seed_demo --embed    # also give fixtures real Gemini embeddings (style search works)
    python -m scripts.drop_fixtures        # remove them again (do this before making the demo branch)
"""
from __future__ import annotations

import argparse

from worker.config import ROOT
from worker.context import Ctx
from worker.db import vec
from worker.orient import priors
from worker.storage import GLB_MIME, USDZ_MIME
from worker.usd_validate import validate_usdz

SAMPLES = ["side_table", "desk_lamp", "accent_chair"]


def upload_samples(ctx: Ctx) -> dict[str, str]:
    urls: dict[str, str] = {}
    for cat in SAMPLES:
        glb = (ROOT / "assets" / "generic" / f"{cat}.glb").read_bytes()
        w, d, h = priors()[cat]
        res = ctx.exporter.export_item(glb, w_in=w, d_in=d, h_in=h, category=cat, orient_override="identity")
        rep = validate_usdz(res.usdz, expect_h_in=h)
        if not rep.ok:
            raise SystemExit(f"sample {cat} failed validation: {rep.errors}")
        key = cat.upper()
        urls[f"USDZ_{key}"] = ctx.storage.put(f"fixtures/{cat}.usdz", res.usdz, USDZ_MIME)
        urls[f"GLB_{key}"] = ctx.storage.put(f"fixtures/{cat}.glb", res.glb, GLB_MIME)
        urls[f"PHOTO_{key}"] = ctx.storage.put(f"fixtures/{cat}.png", ctx.exporter.render_png(res.glb, 640), "image/png")
        print(f"uploaded {cat}: {urls[f'USDZ_{key}']}")
    return urls


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", action="store_true", help="embed fixture summaries with Gemini instead of zero vectors")
    a = ap.parse_args()
    ctx = Ctx()
    try:
        if not ctx.storage.hosted:
            print("WARNING: BLOB_READ_WRITE_TOKEN is empty. Fixture URLs will be local:// and AR Quick Look "
                  "cannot open them. Set the token and run this again before Person B tests on a phone.")
        urls = upload_samples(ctx)
        sql = (ROOT / "db" / "002_fixtures.sql").read_text(encoding="utf-8")
        for k, v in urls.items():
            sql = sql.replace("{{" + k + "}}", v.replace("'", "''"))
        if "{{" in sql:
            raise SystemExit("unfilled placeholder in 002_fixtures.sql")
        with ctx.db.tx() as conn:
            conn.execute(sql)
        # re-running refreshes the URLs on existing fixture rows
        for cat in SAMPLES:
            key = cat.upper()
            ctx.db.x("""update assets a set usdz_url = %s, glb_url = %s from listings l, listing_details d
                        where l.id = a.listing_id and d.listing_id = l.id and l.external_id like 'fixture-%%'
                          and d.category = %s and a.status = 'ready'""", (urls[f"USDZ_{key}"], urls[f"GLB_{key}"], cat))
        if a.embed:
            from worker.tagging import embed_text
            rows = ctx.db.q("""select d.listing_id, d.summary, d.style_tags, d.category from listing_details d
                               join listings l on l.id = d.listing_id where l.external_id like 'fixture-%%' order by 1""")
            for r, v in zip(rows, ctx.gemini.embed([embed_text(r) for r in rows])):
                ctx.db.x("update listing_details set embedding = %s::vector where listing_id = %s", (vec(v), r["listing_id"]))
            print(f"embedded {len(rows)} fixture summaries")
        n = ctx.db.one("select count(*) n from listings where external_id like 'fixture-%%'")["n"]
        print(f"{n} fixture listings in place (3 ready, 1 fallback_ready, 8 in other statuses)")
    finally:
        ctx.close()


if __name__ == "__main__":
    main()
