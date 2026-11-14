"""Bright Data record normalization for each source (spec section 9), on real sample records."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from worker import geo
from worker.normalize import (Skip, normalize, normalize_craigslist, normalize_ebay, normalize_fb, parse_craigslist_search,
                              parse_money, scrub_raw, scrub_text)

FIX = Path(__file__).parent / "fixtures"
FB = json.loads((FIX / "bd_fb_sample.json").read_text(encoding="utf-8"))
EBAY = json.loads((FIX / "bd_ebay_sample.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- Facebook Marketplace
def test_fb_real_record():
    row = normalize_fb(FB[0])
    assert row["source"] == "fb_marketplace"
    assert row["external_id"] == "1008467391603895"
    assert row["url"] == "https://www.facebook.com/marketplace/item/1008467391603895"
    assert row["title"] == "Side table"
    assert row["price_usd"] == 50.0
    assert row["ships"] is False and row["shipping_usd"] is None
    assert row["city"] == "San Diego, CA" and row["lat"] and row["lng"]
    assert "26" in row["description"]
    assert row["photo_urls"] and all(u.startswith("https://") for u in row["photo_urls"])
    assert row["posted_at"].year == 2026


def test_fb_la_jolla_gets_its_own_coordinates():
    row = normalize_fb(FB[1])
    assert row["city"] == "La Jolla, CA"
    assert abs(row["lat"] - 32.84) < 0.01


def test_fb_all_samples_normalize():
    assert len([normalize("fb_marketplace", r) for r in FB]) == len(FB)


@pytest.mark.parametrize("patch,reason", [
    ({"is_sold": True}, "sold"),
    ({"images": []}, "no photos"),
    ({"product_id": None}, "missing"),
    ({"error": "This content isn't available right now", "error_code": "dead_page"}, "error row"),
    ({"currency": "MXN"}, "non-USD"),
])
def test_fb_skips(patch, reason):
    with pytest.raises(Skip, match=reason):
        normalize_fb({**FB[0], **patch})


def test_free_item_price_is_zero():
    assert normalize_fb({**FB[0], "final_price": 0, "initial_price": 0})["price_usd"] == 0.0


# ---------------------------------------------------------------- privacy
def test_never_stores_seller_names_phones_or_emails():
    rec = {**FB[0], "profile_id": "123", "seller_name": "Jane Doe", "seller_phone": "619-555-0100",
           "description": "Call Jane at (619) 555-0100 or jane.doe@example.com. Solid wood."}
    row = normalize_fb(rec)
    blob = json.dumps(row, default=str)
    for secret in ("Jane Doe", "619", "555-0100", "jane.doe@example.com", "profile_id", "seller_name"):
        assert secret not in blob
    assert "Solid wood" in row["description"]


def test_scrub_helpers():
    assert scrub_text("text me 858.555.0199 thanks") == "text me [phone removed] thanks"
    assert scrub_text("a@b.co") == "[email removed]"
    assert scrub_text("26 x 18 x 14 inches, $1500 new") == "26 x 18 x 14 inches, $1500 new"     # dims survive
    out = scrub_raw({"title": "x", "seller_url": "u", "store_name": "s", "nested": {"owner_id": 1, "ok": 2},
                     "seller_description": "kept: it is the item description"})
    assert out == {"title": "x", "nested": {"ok": 2}, "seller_description": "kept: it is the item description"}


# ---------------------------------------------------------------- eBay
def test_ebay_real_record_with_shipping_price():
    rec = next(r for r in EBAY if r.get("shipping"))
    row = normalize_ebay(rec)
    assert row["source"] == "ebay" and row["ships"] is True
    assert row["shipping_usd"] == 106.60 and row["price_usd"] == 499.0
    assert row["url"].startswith("https://www.ebay.com/itm/") and "?" not in row["url"]
    assert row["lat"] is None            # shipped items have no pickup distance
    for key in ("seller_name", "seller_url", "store_name", "seller_rating", "seller_feedback"):
        assert key not in row["raw"]


def test_ebay_skips_new_items_and_unknown_shipping():
    new = next(r for r in EBAY if r.get("condition") == "New")
    with pytest.raises(Skip, match="new item"):
        normalize_ebay(new)
    used_no_ship = next(r for r in EBAY if r.get("condition") == "Used" and not r.get("shipping"))
    with pytest.raises(Skip, match="shipping cost unknown"):
        normalize_ebay(used_no_ship)


def test_ebay_free_shipping_and_local_item():
    base = next(r for r in EBAY if r.get("condition") == "Used")
    free = normalize_ebay({**base, "shipping": "Free Standard Shipping"})
    assert free["shipping_usd"] == 0.0 and free["ships"]
    local = normalize_ebay({**base, "shipping": None, "item_location": "La Jolla, California, United States"})
    assert local["ships"] is False and abs(local["lat"] - 32.84) < 0.01


@pytest.mark.parametrize("value,expected", [
    ("$53.00", 53.0), ("US $1,234.50", 1234.5), (25, 25.0), ("Free", 0.0), ("free shipping", 0.0),
    ("", None), (None, None), ("call for price", None), (True, None),
])
def test_parse_money(value, expected):
    assert parse_money(value) == expected


# ---------------------------------------------------------------- Craigslist
CL_HTML = """<html><body>
<script id="ld_searchpage_results" type="application/ld+json">
{"@type":"ItemList","itemListElement":[
 {"@type":"ListItem","position":0,"item":{"@type":"Product","name":"Mid century nightstand",
   "image":["https://images.craigslist.org/00a0a_abc_600x450.jpg","https://images.craigslist.org/00b0b_def_600x450.jpg"],
   "offers":{"@type":"Offer","price":"40.00","priceCurrency":"USD",
     "availableAtOrFrom":{"@type":"Place","geo":{"latitude":32.81234,"longitude":-117.23456},
       "address":{"addressLocality":"Pacific Beach","addressRegion":"CA"}}}}},
 {"@type":"ListItem","position":1,"item":{"@type":"Product","name":"Free floor lamp",
   "image":["https://images.craigslist.org/00c0c_ghi_600x450.jpg"],
   "offers":{"@type":"Offer","price":"0.00","availableAtOrFrom":{"@type":"Place","address":{"addressLocality":"La Jolla"}}}}}
]}
</script>
<ol class="cl-static-search-results">
 <li class="cl-static-search-result" title="Mid century nightstand">
  <a href="https://sandiego.craigslist.org/csd/fuo/d/san-diego-mid-century-nightstand/7801234567.html">
   <div class="title">Mid century nightstand</div>
   <div class="details"><div class="price">$40</div><div class="location">Pacific Beach</div></div></a></li>
 <li class="cl-static-search-result" title="Free floor lamp">
  <a href="/nsd/zip/d/la-jolla-free-floor-lamp/7807654321.html">
   <div class="title">Free floor lamp</div>
   <div class="details"><div class="location">La Jolla</div></div></a></li>
 <li class="cl-static-search-result"><a href="/about/help"><div class="title">not a listing</div></a></li>
</ol></body></html>"""


def test_craigslist_search_page_parses():
    recs = parse_craigslist_search(CL_HTML)
    assert len(recs) == 2
    a = normalize_craigslist(recs[0])
    assert a["source"] == "craigslist" and a["external_id"] == "7801234567"
    assert a["price_usd"] == 40.0 and a["city"] == "Pacific Beach"
    assert (a["lat"], a["lng"]) == (32.81, -117.23)         # rounded: never an exact address point
    assert len(a["photo_urls"]) == 2
    b = normalize_craigslist(recs[1], free_section=True)
    assert b["price_usd"] == 0.0
    assert b["url"] == "https://sandiego.craigslist.org/nsd/zip/d/la-jolla-free-floor-lamp/7807654321.html"
    assert abs(b["lat"] - 32.84) < 0.01                     # no geo in the page: neighbourhood lookup


def test_craigslist_without_photos_is_skipped():
    with pytest.raises(Skip):
        normalize_craigslist({"url": "https://sandiego.craigslist.org/x/7801234567.html", "title": "t", "price": "$5"})


def test_craigslist_empty_or_blocked_page_gives_no_rows():
    assert parse_craigslist_search("<html><body>blocked</body></html>") == []


# ---------------------------------------------------------------- geo lookup
@pytest.mark.parametrize("text,name", [
    ("La Jolla, CA", "La Jolla"), ("San Diego, CA", "San Diego"), ("Pacific Beach", "Pacific Beach"),
    ("pepper canyon", "Pepper Canyon"), ("92093", "UC San Diego"), ("Chula Vista, California", "Chula Vista"),
    ("Mira Mesa, San Diego, CA", "Mira Mesa"),
])
def test_geo_lookup(text, name):
    assert geo.lookup(text)["name"] == name


def test_geo_lookup_never_guesses():
    assert geo.lookup("Irving, Texas, United States") is None
    assert geo.lookup("") is None and geo.lookup(None) is None


def test_road_distance_estimate():
    ucsd, lj = geo.lookup("ucsd"), geo.lookup("la jolla")
    d = geo.road_mi(ucsd["lat"], ucsd["lng"], lj["lat"], lj["lng"])
    assert 3 < d < 6


def test_craigslist_real_page_new_url_format():
    """Trimmed from a real Web Unlocker fetch (Nov 14 2026): /view/d/<slug>/<base62 id> links, and the ld+json
    list (images, coordinates) is shorter than the static list, so the 4th row has no photo and is skipped."""
    from pathlib import Path
    html = (Path(__file__).parent / "fixtures" / "cl_search_sample.html").read_text(encoding="utf-8")
    recs = parse_craigslist_search(html)
    assert len(recs) == 4
    a = normalize_craigslist(recs[0])
    assert a["external_id"] == "88fnGUEBYr7wGWiJqHCHLA" and "/view/d/" in a["url"]
    assert a["price_usd"] == 70.0 and a["photo_urls"][0].startswith("https://images.craigslist.org/")
    assert a["lat"] == 32.75 and a["lng"] == -117.13          # rounded to ~1 km
    with pytest.raises(Skip):
        normalize_craigslist(recs[3])
