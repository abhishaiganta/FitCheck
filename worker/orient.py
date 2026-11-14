"""Python mirror of exporter/orient.js (same names, same math). The exporter page is what runs in
production; this module exists so the math is unit-tested and so Python can cross-check the page."""
from __future__ import annotations

import json
import math
from functools import lru_cache

from .config import WORKER_DIR

IN_TO_M = 0.0254
IDENTITY_BIAS = 0.35
IDENTITY_BIAS_PRIOR = 0.6
ORIENTATIONS = ["identity", "x+90", "x-90", "z+90", "z-90", "x180"]


@lru_cache(maxsize=1)
def priors() -> dict[str, list[float]]:
    data = json.loads((WORKER_DIR / "exporter" / "priors.json").read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def rotated_size(size: tuple[float, float, float], name: str) -> tuple[float, float, float]:
    sx, sy, sz = size
    if name in ("x+90", "x-90"):
        return (sx, sz, sy)
    if name in ("z+90", "z-90"):
        return (sy, sx, sz)
    return (sx, sy, sz)


def ratio_score(size: tuple[float, float, float], target: tuple[float, float, float]) -> float:
    w, h, d = size
    tw, td, th = target
    if not (w > 0 and h > 0 and d > 0 and tw > 0 and td > 0 and th > 0):
        return math.inf
    ma, mb = max(w, d) / h, min(w, d) / h
    ta, tb = max(tw, td) / th, min(tw, td) / th
    return abs(math.log(ma / ta)) + abs(math.log(mb / tb))


def target_dims(w_in: float | None, d_in: float | None, h_in: float | None, category: str,
                dims_source: str | None) -> dict:
    prior = priors().get(category) or priors()["other"]
    have = bool(w_in and d_in and h_in and w_in > 0 and d_in > 0 and h_in > 0)
    from_text = have and dims_source == "listing_text"
    ratio = (float(w_in), float(d_in), float(h_in)) if from_text else tuple(prior)
    height = float(h_in) if h_in and h_in > 0 else float(prior[2])
    return {"ratio": ratio, "height_in": height, "used_prior": not from_text}


def choose_orientation(size: tuple[float, float, float], ratio: tuple[float, float, float],
                       override: str | None = None, used_prior: bool = False) -> dict:
    """Turn the model only when 'as generated' is clearly implausible: another orientation must beat
    it by a margin AND at least halve the mismatch (see exporter/orient.js)."""
    scores = {name: ratio_score(rotated_size(size, name), ratio) for name in ORIENTATIONS}
    if override and override in scores:
        return {"name": override, "scores": scores, "overridden": True}
    bias = IDENTITY_BIAS_PRIOR if used_prior else IDENTITY_BIAS
    best, best_score = "identity", scores["identity"]
    for name in ORIENTATIONS:
        if name in ("identity", "x180"):
            continue
        if scores[name] < best_score - 1e-9:
            best, best_score = name, scores[name]
    if best != "identity" and not (scores["identity"] - best_score > bias and best_score < 0.5 * scores["identity"]):
        best = "identity"
    return {"name": best, "scores": scores, "overridden": False}


def pivot_and_scale(box_min: tuple[float, float, float], box_max: tuple[float, float, float],
                    height_in: float) -> dict:
    size = [box_max[i] - box_min[i] for i in range(3)]
    if not size[1] > 0:
        raise ValueError("model has zero height")
    translate = (-(box_min[0] + box_max[0]) / 2, -box_min[1], -(box_min[2] + box_max[2]) / 2)
    scale = (height_in * IN_TO_M) / size[1]
    fin = [s * scale / IN_TO_M for s in size]
    return {"translate": translate, "scale": scale, "final_in": {"w": fin[0], "h": fin[1], "d": fin[2]}}


def dims_match_listing(final_w: float, final_d: float, w_in: float | None, d_in: float | None,
                       tol_in: float = 2.0) -> bool:
    """Spec 6.5 step 5: if W or D is more than 2 in off the listing, dims go back to 'estimated'.
    Width/depth are compared as an unordered pair (the model may be turned 90 degrees)."""
    if not (w_in and d_in):
        return False
    a, b = sorted((final_w, final_d))
    c, d = sorted((float(w_in), float(d_in)))
    return abs(a - c) <= tol_in and abs(b - d) <= tol_in
