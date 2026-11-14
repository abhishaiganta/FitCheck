"""Gemini vision tagging + embeddings (spec 6.2), with strict validation.

The model output is never trusted as-is:
- category must be in the allowlist or it becomes 'other'
- dims_source='listing_text' is rejected (set to 'estimated') unless every number literally
  appears in the listing text
- dimensions and weight are range-checked
"""
from __future__ import annotations

import hashlib
import logging
import math
import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, ValidationError, field_validator

from .config import CATEGORY_ALLOWLIST, Settings, get_settings
from .limits import Limits, ProviderError, QuotaExceeded

log = logging.getLogger("worker.tagging")

Angle = Literal["front", "side", "back", "three_quarter", "detail", "other"]
Condition = Literal["new", "like_new", "good", "fair", "poor"]


class PhotoView(BaseModel):
    photo_idx: int = Field(description="0-based index of the photo, in the order given")
    same_object: bool = Field(description="True if this photo shows the same main item being sold")
    angle: Angle
    clean: bool = Field(description="True if the item is fully in frame, unobstructed, not a close-up")


class TagOut(BaseModel):
    """Schema sent to Gemini as response_schema (structured output)."""
    category: str = Field(description="One of: " + ", ".join(CATEGORY_ALLOWLIST) + ", or other")
    style_tags: list[str] = Field(description="3 to 6 short lowercase style/material/color tags, e.g. warm wood, mid-century, white, metal")
    condition: Condition
    w_in: Optional[float] = Field(description="Width in inches (left to right)")
    d_in: Optional[float] = Field(description="Depth in inches (front to back)")
    h_in: Optional[float] = Field(description="Height in inches")
    dims_source: Literal["listing_text", "estimated"] = Field(
        description="listing_text ONLY if these exact numbers literally appear in the title or description; otherwise estimated")
    weight_lb_est: Optional[float] = Field(description="Estimated weight in pounds")
    best_photo_idx: int = Field(description="0-based index of the photo that shows the whole item most cleanly")
    photo_ok: bool = Field(description="True only if the best photo shows a single object, mostly in frame, not cluttered, and the item is not mostly glass, mirror or chrome")
    summary: str = Field(description="One line, under 140 characters, describing the item for a shopper")
    views: list[PhotoView] = Field(description="One entry per photo provided")

    @field_validator("style_tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        out = []
        for t in v or []:
            t = re.sub(r"\s+", " ", str(t).strip().lower())[:30]
            if t and t not in out:
                out.append(t)
        return out[:8]


PROMPT = """You are tagging a second-hand furniture listing for a marketplace search index.
Look at the photos (in order, index 0 first) and the text. Return JSON only.

Rules:
- category: choose from the allowed list. Use "other" for anything else (sofas, beds, mattresses, rugs, sets of many items, non-furniture).
- Dimensions are in inches. If the listing text states dimensions, copy those numbers (convert cm or feet to inches) and set dims_source="listing_text". If the text does not state all three, estimate realistic values for this exact item from the photo and typical furniture sizes and set dims_source="estimated". Never invent a "listing_text" source.
- weight_lb_est: a realistic estimate.
- photo_ok: false if the best photo is cluttered, shows several items, crops the item, is very dark or blurry, or the item is mostly glass, mirror or chrome (those cannot be turned into 3D reliably).
- views: one entry per photo. same_object=false for photos of other items, rooms, tape measures, or text screenshots. angle "detail" for close-ups.
- summary: one plain line a shopper would want, no seller info, no price.

Listing:
title: {title}
price_usd: {price}
description: {description}
number_of_photos: {n}
"""

_NUM = re.compile(r"(\d+(?:\.\d+)?)(?:\s+(\d+)\s*/\s*(\d+))?\s*(cm|centimeters?|mm|ft|feet|foot|'|′|m\b|meters?)?", re.I)
_FRAC = {"½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875}


def numbers_in_text(text: str) -> set[float]:
    """Every number that literally appears in the text, in inches, incl. fraction and unit conversions."""
    if not text:
        return set()
    for ch, val in _FRAC.items():
        text = re.sub(rf"(\d+)\s*{ch}", lambda m, val=val: str(int(m.group(1)) + val), text)
        text = text.replace(ch, f" {val} ")
    # 14-1/4 -> 14 1/4
    text = re.sub(r"(\d)-(\d+\s*/\s*\d+)", r"\1 \2", text)
    found: set[float] = set()
    for m in _NUM.finditer(text):
        n = float(m.group(1))
        if m.group(2) and m.group(3) and float(m.group(3)) != 0:
            n += float(m.group(2)) / float(m.group(3))
        unit = (m.group(4) or "").lower()
        found.add(round(n, 2))
        if unit in ("cm", "centimeter", "centimeters"):
            found.add(round(n / 2.54, 2))
        elif unit == "mm":
            found.add(round(n / 25.4, 2))
        elif unit in ("ft", "feet", "foot", "'", "′"):
            found.add(round(n * 12, 2))
        elif unit in ("m", "meter", "meters"):
            found.add(round(n * 39.37, 2))
    # 2'6" style
    for m in re.finditer(r"(\d+)\s*(?:'|′|ft)\s*(\d+(?:\.\d+)?)\s*(?:\"|″|in)?", text):
        found.add(round(float(m.group(1)) * 12 + float(m.group(2)), 2))
    return found


def dims_literally_in_text(text: str, dims: list[float | None]) -> bool:
    nums = numbers_in_text(text)
    vals = [d for d in dims if d is not None]
    if len(vals) < 3:
        return False
    return all(any(abs(d - n) <= 0.11 for n in nums) for d in vals)


def _clamp_dim(v: float | None) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v) or v < 2 or v > 120:
        return None
    return round(v, 1)


def validate_tag(out: TagOut | dict, *, title: str, description: str | None, n_photos: int) -> dict:
    """Turn model output into a listing_details row. Raises ValueError on unusable output."""
    if isinstance(out, dict):
        try:
            out = TagOut.model_validate(out)
        except ValidationError as e:
            raise ValueError(f"tag JSON failed schema validation: {e.errors()[:2]}") from e
    cat = re.sub(r"[\s-]+", "_", (out.category or "").strip().lower())
    if cat not in CATEGORY_ALLOWLIST:
        cat = "other"
    w, d, h = _clamp_dim(out.w_in), _clamp_dim(out.d_in), _clamp_dim(out.h_in)
    text = f"{title}\n{description or ''}"
    dims_source = out.dims_source
    if dims_source == "listing_text" and not dims_literally_in_text(text, [w, d, h]):
        dims_source = "estimated"            # the model claimed listing_text but the numbers are not there
    weight = out.weight_lb_est
    if weight is not None and (not math.isfinite(weight) or weight <= 0 or weight > 600):
        weight = None
    n = max(1, n_photos)
    best = out.best_photo_idx if 0 <= out.best_photo_idx < n else 0
    views = []
    seen = set()
    for v in out.views or []:
        if 0 <= v.photo_idx < n and v.photo_idx not in seen:
            seen.add(v.photo_idx)
            views.append(v.model_dump())
    photo_ok = bool(out.photo_ok)
    summary = re.sub(r"\s+", " ", out.summary or "").strip()[:200]
    if not summary:
        raise ValueError("tag has an empty summary")
    return {
        "category": cat, "style_tags": out.style_tags, "condition": out.condition,
        "w_in": w, "d_in": d, "h_in": h, "dims_source": dims_source,
        "weight_lb_est": round(weight, 1) if weight else None,
        "best_photo_idx": best, "photo_ok": photo_ok,
        "eligible_3d": cat in CATEGORY_ALLOWLIST and photo_ok and h is not None,
        "summary": summary, "views": views,
    }


def content_hash(title: str, description: str | None, first_photo: str | None) -> str:
    """Cache key: never call Gemini twice for the same listing content (spec 5)."""
    # fbcdn/ebay URLs carry rotating signatures: hash the path only
    photo = re.sub(r"\?.*$", "", first_photo or "")
    return hashlib.sha256(f"{title}\n{description or ''}\n{photo}".encode()).hexdigest()


def embed_text(row: dict) -> str:
    return f"{row['summary']} | {', '.join(row['style_tags'])} | {row['category'].replace('_', ' ')}"


def pick_views(views: list[dict], best_idx: int, max_views: int = 4) -> list[dict]:
    """Multi-photo mode (spec 6.4): at least 2 clean, same-object photos from different angles,
    never detail shots. Returns [] when single-photo mode should be used."""
    usable = [v for v in views if v.get("same_object") and v.get("clean") and v.get("angle") in
              ("front", "side", "back", "three_quarter")]
    by_angle: dict[str, dict] = {}
    for v in sorted(usable, key=lambda v: (v["photo_idx"] != best_idx, v["photo_idx"])):
        by_angle.setdefault(v["angle"], v)
    if len(by_angle) < 2:
        return []
    order = ["front", "three_quarter", "side", "back"]
    picked = [by_angle[a] for a in order if a in by_angle][:max_views]
    return [{"photo_idx": v["photo_idx"], "angle": v["angle"]} for v in picked]


# --------------------------------------------------------------------------- Gemini client
def _map_genai_error(e: Exception) -> ProviderError:
    code = getattr(e, "code", None) or getattr(e, "status_code", None)
    msg = str(getattr(e, "message", None) or e)
    low = msg.lower()
    try:
        code = int(code) if code is not None else None
    except (TypeError, ValueError):
        code = None
    if code == 429 or "resource_exhausted" in low or "quota" in low:
        kind = "day" if ("perday" in low.replace(" ", "").replace("_", "") or "per day" in low or "daily" in low) else "minute"
        ra = None
        m = re.search(r"retry in (\d+(?:\.\d+)?)s", low) or re.search(r"retrydelay['\"]?: ?['\"]?(\d+)", low)
        if m and kind == "minute":
            ra = float(m.group(1)) + 2
        return ProviderError(f"gemini quota ({kind}): {msg[:160]}", quota=True, quota_kind=kind, retry_after=ra, status=429)
    if code in (401, 403) or "api key" in low:
        return ProviderError(f"gemini auth: {msg[:160]}", quota=True, quota_kind="day", status=code)
    if code is None or code >= 500 or code == 408:
        return ProviderError(f"gemini {code}: {msg[:160]}", retryable=True, status=code)
    return ProviderError(f"gemini {code}: {msg[:160]}", retryable=False, status=code)


class Gemini:
    """Key-rotating Gemini wrapper. One listing per vision request (reliable JSON)."""

    def __init__(self, limits: Limits, settings: Settings | None = None):
        self.s = settings or get_settings()
        self.limits = limits
        self._clients: dict[str, object] = {}
        self.models = [m.strip() for m in self.s.gemini_vision.split(",") if m.strip()]
        self._benched: dict[str, float] = {}

    def _client(self, key: str):
        from google import genai
        if key not in self._clients:
            self._clients[key] = genai.Client(api_key=key)
        return self._clients[key]

    def tag(self, *, title: str, description: str | None, price: float | None,
            photos: list[tuple[bytes, str]]) -> tuple[dict, str]:
        """Returns (validated listing_details fields, model_used)."""
        from google.genai import types

        prompt = PROMPT.format(title=title, price=price if price is not None else "unknown",
                               description=(description or "(none)")[:2500], n=len(photos))
        parts = [types.Part.from_bytes(data=b, mime_type=m) for b, m in photos] + [types.Part.from_text(text=prompt)]

        def make(model: str):
            def run(key: str | None):
                try:
                    resp = self._client(key).models.generate_content(
                        model=model, contents=parts,
                        config=types.GenerateContentConfig(
                            response_mime_type="application/json", response_schema=TagOut, temperature=0.1,
                            http_options=types.HttpOptions(timeout=45_000)))
                except Exception as e:  # noqa: BLE001
                    raise _map_genai_error(e) from e
                parsed = getattr(resp, "parsed", None)
                if parsed is None:
                    import json
                    try:
                        parsed = json.loads(resp.text or "")
                    except (ValueError, TypeError) as e:
                        raise ProviderError(f"gemini returned non-JSON: {(resp.text or '')[:120]}", retryable=True) from e
                return parsed
            return run

        # Model fallback. Google's free quota is per model AND per key (live check, Nov 14: a key out of
        # gemini-3.6-flash quota still served gemini-3.5-flash-lite), so the ledger is keyed per model:
        # a daily 429 cools only that model on that key, and when a model is exhausted on every key the next
        # model in GEMINI_MODEL_VISION is used. Overloaded (503/504) or retired (404) models are benched 5 min.
        import time
        last: Exception | None = None
        for model in self.models:
            if self._benched.get(model, 0) > time.monotonic():
                continue
            try:
                parsed = self.limits.call(f"gemini/{model}", make(model), keys=self.s.gemini_keys,
                                          per_minute=self.s.gemini_vision_rpm, per_day=self.s.gemini_vision_rpd, tries=2)
            except QuotaExceeded as e:
                last = e
                continue
            except ProviderError as e:
                if e.status in (404, 500, 502, 503, 504) or e.status is None:
                    self._benched[model] = time.monotonic() + 300
                    log.warning("gemini model %s benched for 5 min: %s", model, str(e)[:120])
                    last = e
                    continue
                raise
            return validate_tag(parsed, title=title, description=description, n_photos=len(photos)), model
        if isinstance(last, QuotaExceeded):
            raise QuotaExceeded("gemini", f"every vision model is out of quota on every key ({last})")
        raise last or ProviderError("every Gemini vision model is benched (overloaded); retrying next cycle",
                                    retryable=True, status=503)

    def embed(self, texts: list[str], task_type: str = "RETRIEVAL_DOCUMENT") -> list[list[float]]:
        from google.genai import types

        def run(key: str | None):
            try:
                resp = self._client(key).models.embed_content(
                    model=self.s.gemini_embed, contents=texts,
                    config=types.EmbedContentConfig(output_dimensionality=self.s.embed_dim, task_type=task_type))
            except Exception as e:  # noqa: BLE001
                raise _map_genai_error(e) from e
            return [normalize_vec(list(e.values)) for e in resp.embeddings]

        # embeddings share the per-key ledger under their own provider name
        out = self.limits.call("gemini_embed", run, keys=self.s.gemini_keys,
                               per_minute=self.s.gemini_embed_rpm, per_day=self.s.gemini_embed_rpd, tries=3)
        for v in out:
            if len(v) != self.s.embed_dim:
                raise ProviderError(f"embedding has {len(v)} dims, expected {self.s.embed_dim}")
        return out


def normalize_vec(v: list[float]) -> list[float]:
    """Truncated Gemini embeddings are not unit length; normalize so cosine and dot agree."""
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]
