"""Delete every FAKE fixture row. Run before the demo branch is made: every item shown at judging
must be a real scraped listing (spec section 4).

    python -m scripts.drop_fixtures
"""
from __future__ import annotations

from worker.db import DB


def drop(db: DB) -> dict:
    listings = db.x("delete from listings where external_id like 'fixture-%%'")       # cascades to details/assets/events
    baselines = db.x("delete from new_price_baselines where 'https://example.com/fixture/baseline' = any(sample_urls)")
    return {"listings": listings, "baselines": baselines}


if __name__ == "__main__":
    d = DB()
    try:
        print("removed", drop(d))
        left = d.one("select count(*) n from listings where raw @> '{\"fixture\": true}'")["n"]
        print("fixture rows left:", left)
    finally:
        d.close()
