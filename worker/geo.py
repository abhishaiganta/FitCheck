"""Approximate geocoding from a small lookup table (data/geo_sd.json). No routing or geocoding API."""
from __future__ import annotations

import json
import math
import re
from functools import lru_cache

from .config import ROOT

GEO_PATH = ROOT / "data" / "geo_sd.json"
ROAD_FACTOR = 1.3


@lru_cache(maxsize=1)
def _table() -> list[tuple[str, dict]]:
    data = json.loads(GEO_PATH.read_text(encoding="utf-8"))
    pairs: list[tuple[str, dict]] = []
    for p in data["places"]:
        for alias in {p["name"].lower(), *[a.lower() for a in p.get("aliases", [])]}:
            pairs.append((alias, p))
    # longest alias first, so "la jolla shores" wins over "la jolla" and "san diego" is the last resort
    pairs.sort(key=lambda t: -len(t[0]))
    return pairs


def lookup(text: str | None) -> dict | None:
    """'La Jolla, CA' -> {name, lat, lng}. Returns None when nothing matches (never guesses)."""
    if not text:
        return None
    t = re.sub(r"\s+", " ", text.lower()).strip()
    t = re.sub(r",?\s*(ca|california|united states|usa)\b\.?", "", t).strip(" ,")
    generic = None
    for alias, p in _table():
        if len(alias) <= 3 and not alias.isdigit():
            hit = re.search(rf"(?<![a-z]){re.escape(alias)}(?![a-z])", t) is not None and t == alias
        else:
            hit = re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", t) is not None
        if hit:
            if p["name"] == "San Diego":
                generic = p
                continue
            return {"name": p["name"], "lat": p["lat"], "lng": p["lng"]}
    if generic:
        return {"name": generic["name"], "lat": generic["lat"], "lng": generic["lng"]}
    return None


def haversine_mi(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def road_mi(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Straight-line distance x 1.3 road factor (est.)."""
    return haversine_mi(lat1, lng1, lat2, lng2) * ROAD_FACTOR
