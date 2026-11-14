"""listing_cards(): distance, pickup cost, total cost and delivery mode, computed in Neon (db/004)."""
from __future__ import annotations

from decimal import Decimal

UCSD = (32.8801, -117.2376)


def add(db, ext, source, price, *, ships=False, shipping=None, lat=None, lng=None, tagged=True, asset=None):
    lid = db.one("""insert into listings (source, external_id, url, title, price_usd, shipping_usd, ships, lat, lng,
                                          photo_urls, raw)
                    values (%s,%s,'https://x/' || %s,'t ' || %s,%s,%s,%s,%s,%s,array['p0','p1'],'{}') returning id""",
                 (source, ext, ext, ext, price, shipping, ships, lat, lng))["id"]
    if tagged:
        db.x("""insert into listing_details (listing_id, category, dims_source, best_photo_idx, photo_ok, eligible_3d, model_used)
                values (%s, 'side_table', 'estimated', 1, true, true, 'test')""", (lid,))
    if asset:
        db.x("insert into assets (listing_id, status, usdz_url) values (%s, %s, %s)", (lid, asset[0], asset[1]))
    return lid


def cards(db):
    return {r["title"]: r for r in db.q("select * from listing_cards(%s, %s)", UCSD)}


def test_local_pickup_distance_and_cost(db):
    add(db, "a", "fb_marketplace", 10, lat=32.7157, lng=-117.1611, asset=("ready", "https://b/x.usdz"))  # downtown
    c = cards(db)["t a"]
    assert 15 < float(c["est_miles"]) < 17                      # ~12.3 mi straight line x 1.3
    assert 36 <= c["est_drive_min"] <= 41                       # at 25 mph, rounded up
    assert abs(float(c["pickup_cost_est"]) - 2 * float(c["est_miles"]) * 0.15) < 0.02   # round trip x $0.15/mi
    assert c["total_usd"] == c["total_pickup_usd"] and c["delivery"] == "pickup"
    assert c["total_ship_usd"] is None and c["can_pickup"]
    assert c["ar_ready"] and c["photo_url"] == "p1"             # best photo, not just the first


def test_shipping_only_and_cheaper_way_wins(db):
    add(db, "e", "ebay", 20, ships=True, shipping=9)
    add(db, "both", "fb_marketplace", 30, ships=True, shipping=25, lat=32.88, lng=-117.24)   # next door
    c = cards(db)
    assert c["t e"]["delivery"] == "ships" and c["t e"]["total_usd"] == Decimal("29.00")
    assert c["t e"]["est_miles"] is None and not c["t e"]["can_pickup"]
    assert c["t both"]["delivery"] == "pickup" and c["t both"]["total_usd"] < Decimal("31")
    assert c["t both"]["total_ship_usd"] == Decimal("55.00")


def test_no_honest_total_or_untagged_is_hidden(db):
    add(db, "noloc", "fb_marketplace", 5)                         # no location, does not ship
    add(db, "ship_unknown", "ebay", 5, ships=True)                # ships but shipping price unknown
    add(db, "untagged", "fb_marketplace", 5, lat=32.88, lng=-117.24, tagged=False)
    assert cards(db) == {}
