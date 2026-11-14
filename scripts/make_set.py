"""Build a corner set (several real items in one AR file) from listing ids.

    python -m scripts.make_set 12 15 31 --title "Study corner"
    python -m scripts.make_set 12 15 --queue        # only queue it; the worker's `sets` stage builds it

Every item needs a finished model (ready or fallback_ready). Prints the USDZ URL and writes previews/set-<id>.png.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from worker.context import Ctx
from worker.stages.sets import SetError, build


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", type=int, nargs="+")
    ap.add_argument("--title", default="Corner set")
    ap.add_argument("--queue", action="store_true")
    a = ap.parse_args()
    ctx = Ctx()
    db = ctx.db
    try:
        sid = db.one("insert into sets (title, status) values (%s, %s) returning id",
                     (a.title, "pending" if a.queue else "exporting"))["id"]
        for i, lid in enumerate(a.ids):
            db.x("insert into set_items (set_id, listing_id, pos) values (%s, %s, %s)", (sid, lid, i))
        if a.queue:
            print(f"set {sid} queued")
            return 0
        try:
            out = build(ctx, db.one("select * from sets where id = %s", (sid,)))
        except SetError as e:
            db.x("update sets set status = 'failed', error = %s where id = %s", (str(e), sid))
            print(f"set {sid} FAILED: {e}")
            return 1
        print(f"set {sid} ready: {out['w_in']} x {out['d_in']} x {out['h_in']} in")
        for p in out["placements"]:
            print(f"  #{p.listing_id}: x {p.x:.1f} y {p.y:.1f} z {p.z:.1f} yaw {p.yaw:.0f}  {p.note}")
        print(f"  USDZ: {out['usdz_url']}")
        Path("previews").mkdir(exist_ok=True)
        png = Path("previews") / f"set-{sid}.png"
        png.write_bytes(ctx.exporter.render_png(ctx.storage.get(out["glb_url"])))
        print(f"  preview: {png.resolve()}")
        return 0
    finally:
        ctx.close()


if __name__ == "__main__":
    sys.exit(main())
