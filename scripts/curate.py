"""Demo curation from the command line (the /admin page does the same in a browser).

    python -m scripts.curate status                 # pipeline counts, provider cooldowns, recent errors
    python -m scripts.curate candidates [--n 30]    # real listings worth pinning (clean photo, near or ships)
    python -m scripts.curate pin 12 15 31           # demo_pin = true -> real 3D model is generated for them
    python -m scripts.curate unpin 12
    python -m scripts.curate previews [--out previews]   # render a PNG of every ready model for a human check
    python -m scripts.curate orient 12 x+90         # manual orientation override, then re-export
    python -m scripts.curate requeue 12             # try 3D generation again from the cutout
    python -m scripts.curate retry-failed           # put dead-lettered items back in the queue

demo_pin only marks REAL listings whose model a human has looked at. It never adds data.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from worker.context import Ctx
from worker.orient import ORIENTATIONS


def status(ctx: Ctx) -> None:
    db = ctx.db
    print("listings:", db.one("""select count(*) total, count(*) filter (where is_active) active,
                                        count(*) filter (where demo_pin) pinned from listings"""))
    print("by source:", {r["source"]: r["n"] for r in db.q("select source, count(*) n from listings group by 1 order by 1")})
    print("tagged:", db.one("""select count(*) tagged, count(*) filter (where eligible_3d) eligible,
                                      count(*) filter (where embedding is not null) embedded from listing_details"""))
    print("assets:", {r["status"]: r["n"] for r in db.q("select status::text, count(*) n from assets group by 1 order by 1")})
    print("models:", {r["provider"] or "-": r["n"] for r in db.q(
        "select provider, count(*) n from assets where status in ('ready','fallback_ready') group by 1")})
    for r in db.q("select provider, cooldown_until, left(note, 70) note from provider_state where cooldown_until > now() order by 1"):
        print(f"  cooling: {r['provider']} until {r['cooldown_until']:%m-%d %H:%M} UTC ({r['note']})")
    for r in db.q("select source, kind, status, records, triggered_at from scrape_jobs order by id desc limit 6"):
        print(f"  job: {r['source']:<15}{r['kind']:<9}{r['status']:<9}{r['records'] or '':<5}{r['triggered_at']:%H:%M}")
    for r in db.q("select at, where_, listing_id, left(message, 90) m from error_log order by id desc limit 8"):
        print(f"  error {r['at']:%H:%M} {r['where_']} #{r['listing_id']}: {r['m']}")


def candidates(ctx: Ctx, n: int) -> None:
    s = ctx.settings
    rows = ctx.db.q("""
        select l.id, l.source, l.price_usd, l.ships, l.city, d.category, d.dims_source, l.demo_pin,
               coalesce(a.status::text, '-') status, coalesce(a.provider, '-') provider, left(l.title, 44) title,
               case when l.lat is null then null else round((2 * 3958.8 * asin(sqrt(
                 power(sin(radians(l.lat - %(lat)s) / 2), 2) + cos(radians(%(lat)s)) * cos(radians(l.lat)) *
                 power(sin(radians(l.lng - %(lng)s) / 2), 2))) * 1.3)::numeric, 1) end mi
        from listings l join listing_details d on d.listing_id = l.id left join assets a on a.listing_id = l.id
        where l.is_active and d.eligible_3d and l.external_id not like 'fixture-%%'
        order by l.demo_pin desc, (d.dims_source = 'listing_text') desc, l.price_usd nulls last limit %(n)s""",
                    {"lat": s.origin_lat, "lng": s.origin_lng, "n": n})
    print(f"{'id':>5} {'pin':3} {'src':14} {'cat':13} {'$':>6} {'~mi':>5} {'dims':8} {'asset':15} title")
    for r in rows:
        print(f"{r['id']:>5} {'*' if r['demo_pin'] else '':3} {r['source']:14} {r['category']:13} "
              f"{float(r['price_usd'] or 0):>6.0f} {str(r['mi'] if r['mi'] is not None else 'ship'):>5} "
              f"{'text' if r['dims_source'] == 'listing_text' else 'est':8} {r['status'] + '/' + r['provider']:15} {r['title']}")


def previews(ctx: Ctx, out: str) -> None:
    folder = Path(out)
    folder.mkdir(parents=True, exist_ok=True)
    rows = ctx.db.q("""select a.listing_id, a.glb_url, a.provider, l.demo_pin from assets a join listings l on l.id = a.listing_id
                       where a.status in ('ready','fallback_ready') and a.glb_url is not null
                       order by l.demo_pin desc, a.listing_id""")
    for r in rows:
        try:
            png = ctx.exporter.render_png(ctx.storage.get(r["glb_url"]))
            name = f"{'pin-' if r['demo_pin'] else ''}{r['listing_id']}-{r['provider']}.png"
            (folder / name).write_bytes(png)
        except Exception as e:  # noqa: BLE001
            print(f"  {r['listing_id']}: preview failed: {e}")
    print(f"{len(rows)} previews in {folder.resolve()}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    c = sub.add_parser("candidates"); c.add_argument("--n", type=int, default=30)
    for name in ("pin", "unpin", "requeue"):
        p = sub.add_parser(name); p.add_argument("ids", type=int, nargs="+")
    p = sub.add_parser("previews"); p.add_argument("--out", default="previews")
    p = sub.add_parser("orient"); p.add_argument("id", type=int); p.add_argument("orientation", choices=ORIENTATIONS)
    p.add_argument("--yaw", type=float, default=None)
    sub.add_parser("retry-failed")
    a = ap.parse_args()
    ctx = Ctx()
    db = ctx.db
    try:
        if a.cmd == "status":
            status(ctx)
        elif a.cmd == "candidates":
            candidates(ctx, a.n)
        elif a.cmd in ("pin", "unpin"):
            n = db.x("update listings set demo_pin = %s where id = any(%s) and external_id not like 'fixture-%%'",
                     (a.cmd == "pin", a.ids))
            print(f"{a.cmd}ned {n} listing(s). The worker generates real 3D for pinned items on its next loop.")
        elif a.cmd == "requeue":
            for lid in a.ids:
                n = db.x("""update assets set status = (case when cutout_url is null then 'queued' else 'gen_pending' end)::asset_status,
                            provider = null, provider_job = null, attempts = 0, next_attempt_at = null, last_error = null,
                            gen_state = '{}'::jsonb, locked_by = null, locked_at = null, updated_at = now()
                            where listing_id = %s""", (lid,))
                if n:
                    db.event(lid, None, "gen_pending", "requeued by a human")
            print("requeued", a.ids)
        elif a.cmd == "orient":
            n = db.x("""update assets set orient_override = %s, yaw_override_deg = %s, status = 'gen_done', updated_at = now()
                        where listing_id = %s and status in ('ready','fallback_ready','failed') and glb_url is not null""",
                     (a.orientation, a.yaw, a.id))
            if n:
                db.event(a.id, None, "gen_done", f"orient_override = {a.orientation}: re-export")
            print("re-export queued" if n else "nothing to do (asset is not ready)")
        elif a.cmd == "retry-failed":
            rows = db.q("""update assets set status = (case when cutout_url is null then 'queued' else 'gen_pending' end)::asset_status,
                           attempts = 0, next_attempt_at = null, locked_by = null, locked_at = null, updated_at = now()
                           where status = 'failed' and last_error not like 'mask covers%%' returning listing_id""")
            for r in rows:
                db.event(r["listing_id"], "failed", "queued", "retry requested by a human")
            print(f"{len(rows)} failed item(s) back in the queue (bad-mask items stay failed)")
        elif a.cmd == "previews":
            previews(ctx, a.out)
    finally:
        ctx.close()


if __name__ == "__main__":
    main()
