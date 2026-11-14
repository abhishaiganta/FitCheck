"""Re-pivot and scale math, auto-orientation choice on fixtures with known ratios (spec section 9)."""
from __future__ import annotations

import math

import pytest

from worker.orient import (IN_TO_M, ORIENTATIONS, choose_orientation, dims_match_listing, pivot_and_scale, priors,
                           ratio_score, rotated_size, target_dims)


def test_rotated_size_swaps_the_right_axes():
    s = (1.0, 2.0, 3.0)
    assert rotated_size(s, "identity") == (1, 2, 3)
    assert rotated_size(s, "x180") == (1, 2, 3)
    assert rotated_size(s, "x+90") == rotated_size(s, "x-90") == (1, 3, 2)
    assert rotated_size(s, "z+90") == rotated_size(s, "z-90") == (2, 1, 3)


def test_ratio_score_is_zero_for_a_match_and_ignores_w_d_order_and_units():
    assert ratio_score((20, 24, 16), (20, 16, 24)) == pytest.approx(0)
    assert ratio_score((16, 24, 20), (20, 16, 24)) == pytest.approx(0)          # turned 90 degrees
    assert ratio_score((2000, 2400, 1600), (20, 16, 24)) == pytest.approx(0)    # wrong units
    assert ratio_score((0, 1, 1), (1, 1, 1)) == math.inf


# model native size (x, y, z) -> listing W x D x H -> expected orientation
@pytest.mark.parametrize("size,dims,expected", [
    ((20, 24, 16), (20, 16, 24), "identity"),         # already upright
    ((240, 200, 160), (20, 16, 24), "z+90"),          # lying on its side along X
    ((20, 16, 24), (20, 16, 24), "x+90"),             # lying on its back (height along Z)
    ((60, 12, 12), (12, 12, 60), "z+90"),             # floor lamp on the floor
    ((12, 12, 60), (12, 12, 60), "x+90"),
    ((30, 65, 12), (30, 12, 65), "identity"),         # bookshelf, upright
    ((65, 30, 12), (30, 12, 65), "z+90"),
])
def test_orientation_choice_with_listing_dimensions(size, dims, expected):
    got = choose_orientation(size, dims)
    assert got["name"] == expected
    assert set(got["scores"]) == set(ORIENTATIONS)


def test_upright_model_with_slightly_off_proportions_is_left_alone():
    # a real generated model is never exactly the listing's ratio: do not turn it for a small gain
    assert choose_orientation((10.5, 26, 13), (14.2, 18, 26))["name"] == "identity"
    assert choose_orientation((22, 20, 21), (22, 22, 18))["name"] == "identity"


def test_category_prior_never_tips_over_an_unusual_but_upright_item():
    # tall slim side table vs the "side table" prior (20 x 18 x 22): stays upright
    t = target_dims(14.2, 18, 26, "side_table", "estimated")
    assert t["used_prior"] and t["ratio"] == tuple(priors()["side_table"])
    assert choose_orientation((10.5, 26, 13), t["ratio"], used_prior=True)["name"] == "identity"
    # ...but a floor lamp lying flat is obvious even from the prior
    lamp = target_dims(None, None, 58, "floor_lamp", "estimated")
    assert choose_orientation((58, 11, 11), lamp["ratio"], used_prior=True)["name"] == "z+90"


def test_override_wins_and_upside_down_is_override_only():
    assert choose_orientation((20, 24, 16), (20, 16, 24), "x180") == {
        "name": "x180", "scores": choose_orientation((20, 24, 16), (20, 16, 24))["scores"], "overridden": True}
    assert choose_orientation((20, 24, 16), (20, 16, 24), "bogus")["name"] == "identity"
    for size in ((20, 24, 16), (240, 200, 160), (12, 12, 60)):
        assert choose_orientation(size, (20, 16, 24))["name"] != "x180"


def test_target_dims_uses_listing_text_ratio_and_prior_height_fallback():
    t = target_dims(20, 16, 24, "nightstand", "listing_text")
    assert t == {"ratio": (20.0, 16.0, 24.0), "height_in": 24.0, "used_prior": False}
    t = target_dims(None, None, None, "desk_lamp", "estimated")
    assert t["height_in"] == priors()["desk_lamp"][2] and t["used_prior"]
    assert target_dims(None, None, 30, "unknown_category", None)["ratio"] == tuple(priors()["other"])


def test_pivot_and_scale_math():
    # a box far from the origin, in arbitrary units, 240 units tall -> 24 in tall
    out = pivot_and_scale((800.0, 250.0, -780.0), (1000.0, 490.0, -620.0), 24.0)
    assert out["translate"] == (-900.0, -250.0, 700.0)            # footprint centre -> origin, base -> y = 0
    assert out["scale"] == pytest.approx(24 * IN_TO_M / 240)
    assert out["final_in"]["h"] == pytest.approx(24.0)
    assert out["final_in"]["w"] == pytest.approx(20.0)
    assert out["final_in"]["d"] == pytest.approx(16.0)
    # applying it puts the base on the ground and the centre over the origin
    tx, ty, tz = out["translate"]
    s = out["scale"]
    assert (250.0 + ty) * s == pytest.approx(0)
    assert ((800.0 + tx) * s + (1000.0 + tx) * s) / 2 == pytest.approx(0)
    assert ((-780.0 + tz) * s + (-620.0 + tz) * s) / 2 == pytest.approx(0)


def test_pivot_and_scale_rejects_flat_models():
    with pytest.raises(ValueError):
        pivot_and_scale((0, 1, 0), (1, 1, 1), 10)


def test_dims_match_listing_tolerance_and_order():
    assert dims_match_listing(19.0, 17.5, 20, 16)             # within 2 in
    assert dims_match_listing(16.5, 21.0, 20, 16)             # turned 90 degrees still matches
    assert not dims_match_listing(10.5, 13.0, 14.2, 18)       # generator made it too slim
    assert not dims_match_listing(20, 16, None, 16)
