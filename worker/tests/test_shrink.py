"""shrink_glb: heavy hand-made exports are reduced to a phone-friendly triangle budget, textures kept."""
from __future__ import annotations

import numpy as np
import pytest

from worker.glbtools import build_glb, cylinder, inspect_glb, part
from worker.shrink import HERE, ShrinkError, shrink_glb
from worker.tests.fixtures_glb import checker_png

pytestmark = pytest.mark.skipif(not (HERE / "node_modules").exists(),
                                reason="run `npm install --prefix worker/meshtools`")


def dense_blob(n: int = 160) -> bytes:
    """Welded, textured lumpy sphere of 2*n*n triangles: what a Tripo HD website export looks like."""
    th, ph = np.meshgrid(np.linspace(0, np.pi, n + 1), np.linspace(0, 2 * np.pi, n + 1), indexing="ij")
    r = 0.25 + 0.02 * np.sin(8 * th) * np.cos(6 * ph)
    pos = np.stack([r * np.sin(th) * np.cos(ph), r * np.cos(th) + 0.3, r * np.sin(th) * np.sin(ph)], -1).reshape(-1, 3)
    nor = pos - np.array([0, 0.3, 0])
    nor /= np.linalg.norm(nor, axis=1, keepdims=True)
    uv = np.stack([ph / (2 * np.pi), th / np.pi], -1).reshape(-1, 2)
    a = (np.arange(n)[:, None] * (n + 1) + np.arange(n)[None, :]).ravel()
    b = a + n + 1
    idx = np.stack([a, b, a + 1, a + 1, b, b + 1], -1).ravel()
    return build_glb([part((pos.astype(np.float32), nor.astype(np.float32), idx.astype(np.uint32), uv.astype(np.float32)),
                           texture_png=checker_png(), name="blob")])


def flat_vase(textured: bool) -> bytes:
    """Every face has its own vertices (flat shaded): ordinary edge collapse cannot reduce it."""
    return build_glb([part(cylinder(0.2, 0.12, 0.6, center=(0, 0.3, 0), segments=4000),
                           texture_png=checker_png() if textured else None, name="vase")])


def test_welded_textured_model_reaches_the_budget_and_keeps_its_texture():
    src = dense_blob()
    assert inspect_glb(src)["triangles"] == 2 * 160 * 160
    out, stats = shrink_glb(src, max_tris=5000, max_tex=256)
    info = inspect_glb(out)
    assert info["triangles"] <= 5000 * 1.15 and not stats["sloppy"]
    assert info["textures"] == 1
    assert len(out) < len(src)


def test_untextured_seam_heavy_model_uses_sloppy_fallback():
    out, stats = shrink_glb(flat_vase(textured=False), max_tris=2000)
    assert stats["sloppy"] and inspect_glb(out)["triangles"] <= 2000 * 1.3


def test_textured_seam_heavy_model_is_not_smeared():
    out, stats = shrink_glb(flat_vase(textured=True), max_tris=2000, max_tex=256)
    assert not stats["sloppy"]                       # left heavy rather than garbling the texture
    assert inspect_glb(out)["textures"] == 1


def test_small_models_are_left_alone():
    _, stats = shrink_glb(dense_blob(40), max_tris=1_000_000)
    assert stats["triangles_after"] == stats["triangles_before"]


def test_garbage_is_rejected():
    with pytest.raises(ShrinkError):
        shrink_glb(b"not a glb at all")
