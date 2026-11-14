"""Exporter test (spec section 9): pytest + Playwright.

Builds a deliberately messy textured GLB (off-centre, wrong units, lying sideways, metallic = 1),
exports it through the real headless-Chromium page, then checks the USDZ with usd-core.
"""
from __future__ import annotations

import io
import zipfile

import pytest

from worker.exporter_driver import Exporter, ExportError
from worker.glbtools import inspect_glb
from worker.orient import choose_orientation, target_dims
from worker.tests.fixtures_glb import messy_table_glb, upright_lamp_glb
from worker.usd_validate import validate_usdz

W, D, H = 20.0, 16.0, 24.0


@pytest.fixture(scope="module")
def exporter():
    try:
        ex = Exporter()
        ex.start()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"Chromium not available (run `playwright install chromium`): {e}")
    yield ex
    ex.close()


@pytest.fixture(scope="module")
def messy(exporter):
    return exporter.export_item(messy_table_glb(), w_in=W, d_in=D, h_in=H, category="nightstand",
                                dims_source="listing_text")


def test_usd_validators_report_zero_errors(messy):
    rep = validate_usdz(messy.usdz, expect_w_in=W, expect_d_in=D, expect_h_in=H, tol_in=0.5, require_texture=True)
    assert rep.errors == []
    assert rep.ok and rep.meshes == 1 and rep.materials == 1


def test_size_matches_target_within_half_an_inch(messy):
    rep = validate_usdz(messy.usdz)
    w, h, d = rep.size_in
    assert abs(h - H) < 0.5 and abs(w - W) < 0.5 and abs(d - D) < 0.5
    assert abs(messy.final_h_in - H) < 0.01 and abs(messy.final_w_in - W) < 0.01 and abs(messy.final_d_in - D) < 0.01


def test_base_at_y_zero_and_pivot_at_footprint_centre(messy):
    rep = validate_usdz(messy.usdz)
    assert abs(rep.base_y_in) < 0.01
    assert abs(rep.center_xz_in[0]) < 0.01 and abs(rep.center_xz_in[1]) < 0.01      # the fixture's pivot was ~1000 units away


def test_texture_is_in_the_package(messy):
    rep = validate_usdz(messy.usdz)
    assert len(rep.textures) == 1
    with zipfile.ZipFile(io.BytesIO(messy.usdz)) as z:
        png = z.read(rep.textures[0])
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 200


def test_metallic_is_zero(messy):
    rep = validate_usdz(messy.usdz)
    assert rep.metallic_values == [0.0]                 # the fixture omits metallicFactor (glTF default 1.0)
    assert messy.info["stats"]["max_metalness"] == 0
    assert messy.info["stats"]["min_roughness"] >= 0.6


def test_sideways_model_was_stood_up_and_matches_the_python_mirror(messy):
    assert messy.orientation in ("z+90", "z-90")
    t = target_dims(W, D, H, "nightstand", "listing_text")
    py = choose_orientation(tuple(messy.info["native_size"]), t["ratio"], used_prior=t["used_prior"])
    assert py["name"] == messy.orientation
    for name, score in py["scores"].items():
        assert messy.info["orientation_scores"][name] == pytest.approx(score, abs=1e-9)


def test_true_scale_glb_is_also_produced(messy):
    info = inspect_glb(messy.glb)
    assert info["meshes"] == 1 and info["textures"] == 1


def test_orient_override_and_yaw(exporter):
    forced = exporter.export_item(messy_table_glb(), w_in=W, d_in=D, h_in=H, category="nightstand",
                                  dims_source="listing_text", orient_override="identity")
    assert forced.orientation == "identity" and forced.info["overridden"]
    assert abs(forced.final_h_in - H) < 0.01              # still scaled by height
    assert abs(forced.final_w_in - 28.8) < 0.1            # 240:200:160 left lying down
    turned = exporter.export_item(messy_table_glb(), w_in=W, d_in=D, h_in=H, category="nightstand",
                                  dims_source="listing_text", yaw_deg=90)
    assert abs(turned.final_w_in - D) < 0.01 and abs(turned.final_d_in - W) < 0.01
    assert validate_usdz(turned.usdz, expect_h_in=H).ok


def test_untextured_metallic_model_and_category_prior_height(exporter):
    res = exporter.export_item(upright_lamp_glb(), w_in=None, d_in=None, h_in=None, category="desk_lamp")
    assert res.orientation == "identity" and res.info["used_prior"]
    assert abs(res.final_h_in - 18) < 0.01                # desk lamp prior height
    rep = validate_usdz(res.usdz, expect_h_in=18)
    assert rep.ok and rep.metallic_values == [0.0] and rep.textures == []


def test_generic_fit_box_matches_listing_footprint(exporter):
    from worker.config import ROOT
    glb = (ROOT / "assets" / "generic" / "side_table.glb").read_bytes()
    res = exporter.export_item(glb, w_in=26, d_in=14, h_in=26, category="side_table", orient_override="identity",
                               fit_box=True)
    assert (round(res.final_w_in, 1), round(res.final_d_in, 1), round(res.final_h_in, 1)) == (26.0, 14.0, 26.0)
    assert validate_usdz(res.usdz, expect_w_in=26, expect_d_in=14, expect_h_in=26).ok


def test_corner_set_is_one_file_with_every_item(exporter):
    from worker.config import ROOT
    table = (ROOT / "assets" / "generic" / "side_table.glb").read_bytes()
    lamp = (ROOT / "assets" / "generic" / "desk_lamp.glb").read_bytes()
    res = exporter.export_set([
        {"glb": table, "w_in": 20, "d_in": 18, "h_in": 22, "category": "side_table", "orient_override": "identity"},
        {"glb": lamp, "w_in": 8, "d_in": 8, "h_in": 18, "category": "desk_lamp", "orient_override": "identity",
         "y_in": 22},                                    # the lamp stands on the table
    ])
    rep = validate_usdz(res.usdz)
    assert rep.errors == []
    assert rep.meshes == 6 + 3
    assert abs(rep.size_in[1] - 40) < 0.5 and abs(rep.base_y_in) < 0.01


def test_garbage_input_raises_and_the_page_recovers(exporter):
    with pytest.raises(ExportError):
        exporter.export_item(b"not a glb at all", w_in=1, d_in=1, h_in=1, category="stool")
    ok = exporter.export_item(upright_lamp_glb(), w_in=8, d_in=8, h_in=18, category="desk_lamp")
    assert validate_usdz(ok.usdz, expect_h_in=18).ok


def test_validator_catches_bad_files():
    assert "not a zip package" in validate_usdz(b"nope").errors
    rep = validate_usdz(b"PK\x05\x06" + b"\x00" * 18)
    assert not rep.ok


def test_validator_catches_wrong_size(messy):
    rep = validate_usdz(messy.usdz, expect_h_in=30)
    assert not rep.ok and any("H is" in e for e in rep.errors)
