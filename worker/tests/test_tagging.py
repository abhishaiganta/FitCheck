"""Gemini JSON validation (spec section 9): never trust the model's output as-is."""
from __future__ import annotations

import pytest

from worker.tagging import (_map_genai_error, content_hash, dims_literally_in_text, embed_text, normalize_vec,
                            numbers_in_text, pick_views, validate_tag)


def raw(**over):
    base = {
        "category": "side_table", "style_tags": ["Warm Wood", "mid-century", "warm wood"], "condition": "good",
        "w_in": 18, "d_in": 14.25, "h_in": 26, "dims_source": "listing_text", "weight_lb_est": 18,
        "best_photo_idx": 0, "photo_ok": True, "summary": "Dark wood side table with a magazine shelf.",
        "views": [{"photo_idx": 0, "same_object": True, "angle": "front", "clean": True}],
    }
    base.update(over)
    return base


TEXT = "Hard dark wood side table\nH 26”\nW 14.25”\nL 18”"


def test_accepts_listing_text_when_numbers_are_literally_there():
    out = validate_tag(raw(), title="Side table", description=TEXT, n_photos=2)
    assert out["dims_source"] == "listing_text"
    assert (out["w_in"], out["d_in"], out["h_in"]) == (18.0, 14.2, 26.0)
    assert out["eligible_3d"] is True
    assert out["style_tags"] == ["warm wood", "mid-century"]          # lowercased, de-duplicated


def test_rejects_listing_text_when_numbers_are_not_in_the_text():
    out = validate_tag(raw(w_in=20, d_in=16, h_in=24), title="Side table", description="Nice table, must go.", n_photos=1)
    assert out["dims_source"] == "estimated"


def test_rejects_listing_text_when_only_some_numbers_are_in_the_text():
    out = validate_tag(raw(w_in=18, d_in=15, h_in=26), title="Side table", description="26 inches tall, 18 wide", n_photos=1)
    assert out["dims_source"] == "estimated"


def test_a_price_is_not_a_dimension_source():
    # 30 appears in the text only as the price-like number; d and h do not appear at all
    out = validate_tag(raw(w_in=30, d_in=17, h_in=22), title="Table $30", description="pick up only", n_photos=1)
    assert out["dims_source"] == "estimated"


@pytest.mark.parametrize("text,expected", [
    ("24 x 18 x 30 inches", {24.0, 18.0, 30.0}),
    ("14 1/4 wide", {14.25}),
    ("14-1/2\" deep", {14.5}),
    ("2 ft tall", {24.0}),
    ("61 cm high", {24.02}),
    ("2'6\" long", {30.0}),
    ("18½ in", {18.5}),
])
def test_numbers_in_text(text, expected):
    assert expected <= numbers_in_text(text)


def test_unit_conversions_count_as_literal():
    assert dims_literally_in_text("61cm x 46cm x 2 ft", [24.0, 18.1, 24.0])
    assert not dims_literally_in_text("around two feet", [24.0, 18.0, 24.0])
    assert not dims_literally_in_text("24 x 18", [24.0, 18.0, None])        # needs all three


def test_unknown_category_becomes_other_and_is_not_eligible():
    out = validate_tag(raw(category="sofa"), title="Couch", description=TEXT, n_photos=1)
    assert out["category"] == "other" and out["eligible_3d"] is False


def test_category_spelling_is_normalized():
    assert validate_tag(raw(category="Side Table"), title="t", description=TEXT, n_photos=1)["category"] == "side_table"


def test_bad_photo_is_not_eligible():
    assert validate_tag(raw(photo_ok=False), title="t", description=TEXT, n_photos=1)["eligible_3d"] is False


@pytest.mark.parametrize("field,value", [("h_in", 0), ("h_in", -4), ("h_in", 900), ("w_in", float("nan"))])
def test_absurd_dimensions_are_dropped(field, value):
    out = validate_tag(raw(**{field: value}), title="t", description=TEXT, n_photos=1)
    assert out[field] is None
    assert out["dims_source"] == "estimated"


def test_missing_height_is_not_eligible():
    assert validate_tag(raw(h_in=None), title="t", description=TEXT, n_photos=1)["eligible_3d"] is False


def test_out_of_range_photo_index_falls_back_to_first():
    out = validate_tag(raw(best_photo_idx=7, views=[{"photo_idx": 9, "same_object": True, "angle": "front", "clean": True}]),
                       title="t", description=TEXT, n_photos=2)
    assert out["best_photo_idx"] == 0 and out["views"] == []


def test_schema_violations_raise():
    with pytest.raises(ValueError):
        validate_tag({"category": "side_table"}, title="t", description="", n_photos=1)
    with pytest.raises(ValueError):
        validate_tag(raw(condition="mint"), title="t", description="", n_photos=1)
    with pytest.raises(ValueError):
        validate_tag(raw(summary="  "), title="t", description="", n_photos=1)


def test_absurd_weight_is_dropped():
    assert validate_tag(raw(weight_lb_est=5000), title="t", description=TEXT, n_photos=1)["weight_lb_est"] is None


# ---------------------------------------------------------------- views / multi-photo mode
def v(i, angle, same=True, clean=True):
    return {"photo_idx": i, "same_object": same, "angle": angle, "clean": clean}


def test_pick_views_needs_two_clean_angles():
    assert pick_views([v(0, "front"), v(1, "front")], 0) == []
    assert pick_views([v(0, "front")], 0) == []
    got = pick_views([v(0, "front"), v(1, "side"), v(2, "back")], 0)
    assert [g["angle"] for g in got] == ["front", "side", "back"]


def test_pick_views_never_sends_details_other_objects_or_dirty_photos():
    views = [v(0, "front"), v(1, "detail"), v(2, "side", same=False), v(3, "back", clean=False)]
    assert pick_views(views, 0) == []
    assert [g["photo_idx"] for g in pick_views(views + [v(4, "side")], 0)] == [0, 4]


def test_pick_views_caps_at_four():
    views = [v(0, "front"), v(1, "three_quarter"), v(2, "side"), v(3, "back"), v(4, "side")]
    assert len(pick_views(views, 0)) == 4


# ---------------------------------------------------------------- cache key / embedding text
def test_content_hash_ignores_rotating_cdn_signatures():
    a = content_hash("Lamp", "nice", "https://cdn.example/x.jpg?sig=1&oe=AAA")
    b = content_hash("Lamp", "nice", "https://cdn.example/x.jpg?sig=2&oe=BBB")
    assert a == b
    assert a != content_hash("Lamp", "nicer", "https://cdn.example/x.jpg")


def test_embed_text_and_unit_vectors():
    out = validate_tag(raw(), title="t", description=TEXT, n_photos=1)
    assert embed_text(out) == "Dark wood side table with a magazine shelf. | warm wood, mid-century | side table"
    n = normalize_vec([3.0, 4.0])
    assert n == [0.6, 0.8]


# ---------------------------------------------------------------- Gemini error mapping
class FakeApiError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def test_gemini_error_mapping():
    day = _map_genai_error(FakeApiError(429, "RESOURCE_EXHAUSTED: quota GenerateRequestsPerDayPerProjectPerModel-FreeTier"))
    assert day.quota and day.quota_kind == "day"
    minute = _map_genai_error(FakeApiError(429, "RESOURCE_EXHAUSTED ... Please retry in 21.5s."))
    assert minute.quota and minute.quota_kind == "minute" and minute.retry_after == 23.5
    assert _map_genai_error(FakeApiError(503, "overloaded")).retryable
    bad = _map_genai_error(FakeApiError(400, "invalid argument"))
    assert not bad.retryable and not bad.quota
    assert _map_genai_error(TimeoutError("timed out")).retryable


def test_quota_is_per_model_so_the_next_model_is_used(clock, monkeypatch):
    """Live finding (Nov 14): a key out of gemini-3.6-flash quota still serves gemini-3.5-flash-lite.
    A daily 429 must cool only that model on that key, and tagging must move on to the next model."""
    import types as pytypes

    from worker import tagging
    from worker.config import Settings
    from worker.limits import Limits, MemoryStore, ProviderError, QuotaExceeded

    calls = []

    def generate_content(model, contents, config):
        calls.append(model)
        if model == "big-flash":
            raise ProviderError("gemini 429 quota: per day", quota=True, quota_kind="day", status=429)
        return pytypes.SimpleNamespace(parsed={
            "category": "side_table", "style_tags": ["wood"], "condition": "good", "w_in": 20, "d_in": 16, "h_in": 24,
            "dims_source": "estimated", "weight_lb_est": 15, "best_photo_idx": 0, "photo_ok": True, "summary": "x",
            "views": [{"photo_idx": 0, "same_object": True, "angle": "front", "clean": True}]}, text="")

    monkeypatch.setattr(tagging, "_map_genai_error", lambda e: e if isinstance(e, ProviderError) else ProviderError(str(e)))
    s = Settings()
    s.gemini_keys, s.gemini_vision = ["k1", "k2"], "big-flash,lite-flash"
    lim = Limits(MemoryStore(), clock=clock, sleep=clock.sleep, rng=lambda: 0.0)
    g = tagging.Gemini(lim, s)
    monkeypatch.setattr(g, "_client", lambda key: pytypes.SimpleNamespace(models=pytypes.SimpleNamespace(
        generate_content=generate_content)))
    photo = [(b"\xff\xd8jpeg", "image/jpeg")]
    out, model = g.tag(title="Side table", description=None, price=10, photos=photo)
    assert model == "lite-flash" and out["category"] == "side_table"
    assert calls == ["big-flash", "big-flash", "lite-flash"]       # both keys tried on the big model, then moved on
    calls.clear()
    out, model = g.tag(title="Side table", description=None, price=10, photos=photo)
    assert calls == ["lite-flash"]                                 # big-flash stays cooled on both keys
    # lite-flash on both keys is fine: nothing else was cooled down
    lim.acquire("gemini/lite-flash", keys=["k1", "k2"])

    s.gemini_vision = "big-flash"
    with pytest.raises(QuotaExceeded):
        tagging.Gemini(lim, s).tag(title="t", description=None, price=1, photos=photo)
